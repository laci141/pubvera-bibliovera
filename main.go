// Command bibliovera-web serves a single-page UI plus six JSON endpoints:
// GET /affiliations, /authors, /drift, /curate, /mesh, and /check, that mirror
// the journal-analytics CLI's commands. The /check endpoint integrates the
// retraction-checker CLI for batch verification. All endpoints are read-only and
// keyless (analytics take no LLM key). Query params are whitelisted and passed
// as discrete argv elements (no shell).
//
// GET /config.json is the one non-analytics endpoint: it hands the page the
// public Supabase settings it needs to offer Google sign-in. It sits outside
// the auth-protected paths on purpose — see handleRoot.
//
// Bibliovera is the journal-analytics app of the Pubvera bundle. Note that the
// CLI binary name (thelancet-pp-cli) and the THELANCET_DB environment variable
// keep their original names on purpose: they refer to the upstream tool and to
// the Docker and docker-compose configuration, and renaming them would break the deploy.
//
// Post-processing (done here, not in the CLI):
//   - /authors:      minWorks filter removes single-consortium-paper authors.
//   - /affiliations: minPrior grouping moves institutions with tiny prior base
//     to the end of the list; it never drops a row, and every row is flagged.
//   - /drift:        passes through topic-share deltas between year windows.
//   - /curate:       ranked reading lists for a topic, optionally scoped to a
//     journal; also feeds the Rising Papers view (citations-per-year is computed
//     client-side from the year + cited_by_count fields).
//   - /mesh:         co-authorship pairs within an institution (feeds the D3
//     force-directed collaboration graph, which is built client-side).
//   - /check:        verifies retraction status via the retraction-checker CLI.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

func cliBinaryPath() string {
	if p := strings.TrimSpace(os.Getenv("CLI_BIN")); p != "" {
		return p
	}
	name := "thelancet-pp-cli"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join("bin", name)
}

func retractionCheckerBinaryPath() string {
	if p := strings.TrimSpace(os.Getenv("RETRACTION_CHECKER_BIN")); p != "" {
		return p
	}
	name := "retraction-checker-pp-cli"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	// Try local submodule path first, then system PATH.
	local := filepath.Join("bin", name)
	if _, err := os.Stat(local); err == nil {
		return local
	}
	return name // Fall back to PATH.
}

// dbPath is the mirror the analytics commands read (populated by `refresh`).
func dbPath() string {
	if p := strings.TrimSpace(os.Getenv("THELANCET_DB")); p != "" {
		return p
	}
	return "data.db"
}

// crossrefMailto returns the contact address for Crossref's polite pool, or an
// empty string when CROSSREF_MAILTO is unset.
//
// Measured: an anonymous Crossref request reports x-rate-limit-limit 5, the
// same request with a mailto reports 10. Only the retraction-checker talks to
// Crossref, and only that binary has a --mailto flag — the analytics CLI
// (thelancet-pp-cli) does not, so adding the flag to runCLIRaw would fail every
// analytics endpoint with "unknown flag".
//
// Unset is not an error: /check keeps working on the anonymous pool, which is
// what local development and any deployment without the variable rely on.
func crossrefMailto() string {
	return strings.TrimSpace(os.Getenv("CROSSREF_MAILTO"))
}

// The two CLI paths get different budgets because they do different work: the
// retraction check is a single lookup, the analytics runs are heavier. Both
// were written inline at their call sites; naming them here is what lets
// srvWriteTimeout below be derived from the longer of the two rather than
// guessed.
//
// They do not stack. Each handler takes exactly one path, and the five
// analytics handlers each call runCLIRaw once, so the longest legitimate
// request is analyticsBudget, not the sum.
const (
	retractionCheckBudget = 10 * time.Second
	analyticsBudget       = 60 * time.Second
)

// Server-side timeouts. ReadHeaderTimeout was the only one set, which left the
// request BODY with no deadline at all: a size limit is not a time limit, and a
// client that sends its body one byte per minute holds a handler goroutine for
// as long as it likes. Caddy fronts this app in production and sets no request
// timeout of its own, so this is the only place the limit exists.
//
// WriteTimeout is the one that must not be guessed. It covers the whole
// response, and the longest request is allowed analyticsBudget to produce it,
// so anything at or below that would cut off legitimate slow analyses rather
// than attacks — and only the slowest ones, intermittently, which is far
// harder to diagnose than the exposure being closed.
const (
	srvReadHeaderTimeout = 10 * time.Second
	// The body is a small JSON object. Thirty seconds is far more than a real
	// client needs and far less than a slow-loris attacker wants.
	srvReadTimeout = 30 * time.Second
	// The longest CLI budget plus room to write the response.
	srvWriteTimeout = analyticsBudget + 30*time.Second
	// Keep-alive connections that go quiet are released rather than held.
	srvIdleTimeout = 120 * time.Second
)

// Caps on what a child CLI may hand back. Vars, not consts, so a test can
// lower them.
//
// Measured 2026-10-04 against the real thelancet-pp-cli on data.db at every
// endpoint's maximum limit: the largest response was 79,242 bytes
// (rank-authors --limit 500); mesh 500 = 51,350, affiliation-growth 500 =
// 63,509, curate 100 = 35,093, drift topN 40 = 9,459. 16 MiB is ~200x that
// and still small enough that a runaway child cannot exhaust memory.
//
// stderr is only ever logged (300 runes at most), so 64 KiB is generous.
var (
	cliStdoutCap = 16 << 20
	cliStderrCap = 64 << 10
)

// errOutputTooLarge is what the client sees when a CLI exceeds cliStdoutCap.
// writeErr reports it as 502: the upstream misbehaved, not the client.
var errOutputTooLarge = errors.New("upstream output too large")

// limitedWriter is a bytes.Buffer with a ceiling. With onOver set (stdout) an
// overflow cancels the child and fails the write, which also stops exec's copy
// goroutine from reading. Without it (stderr) the excess is silently dropped
// and the writer keeps accepting, so a chatty child never blocks on a full pipe.
type limitedWriter struct {
	buf    bytes.Buffer
	max    int
	over   bool
	onOver func()
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	room := w.max - w.buf.Len()
	if len(p) <= room {
		return w.buf.Write(p)
	}
	w.over = true
	w.buf.Write(p[:room])
	if w.onOver == nil {
		return len(p), nil
	}
	w.onOver()
	return 0, errOutputTooLarge
}

// runCapped runs bin with both output streams capped. cancel must be the cancel
// func of ctx: it is how a stdout overflow kills the child. A stdout overflow
// returns errOutputTooLarge; stderr overflow only truncates stderr.
func runCapped(ctx context.Context, cancel context.CancelFunc, bin string, args []string) (stdout []byte, stderr string, err error) {
	// #nosec G204 -- callers pass a fixed subcommand; user text is argv, not shell.
	cmd := exec.CommandContext(ctx, bin, args...)
	out := &limitedWriter{max: cliStdoutCap, onOver: cancel}
	errOut := &limitedWriter{max: cliStderrCap}
	cmd.Stdout = out
	cmd.Stderr = errOut
	// A killed child's pipes can stay open through a grandchild; do not let
	// Wait hang on them.
	cmd.WaitDelay = 2 * time.Second
	err = cmd.Run()
	if out.over {
		err = errOutputTooLarge
	}
	return out.buf.Bytes(), errOut.buf.String(), err
}

// stderrForLog makes a CLI's stderr safe for one log line. It is for the
// server log only: stderr can carry file paths and upstream details and is never
// sent to the client.
func stderrForLog(s string) string {
	return truncate(strings.Join(strings.Fields(s), " "), 300)
}

// docker stop and Watchtower wait 10 s after SIGTERM before SIGKILL, so 9 s
// finishes in-flight requests and still exits cleanly.
const shutdownGrace = 9 * time.Second

// serveUntil runs listen and, when ctx is done first, drains the server with
// srv.Shutdown for up to grace. It returns nil when listen ends with
// http.ErrServerClosed, listen's error otherwise, or Shutdown's error
// (context.DeadlineExceeded when the grace expires) after a signal.
func serveUntil(ctx context.Context, srv *http.Server, listen func() error, grace time.Duration) error {
	errCh := make(chan error, 1)
	go func() { errCh <- listen() }()
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	// Logged here, before Shutdown, so it always precedes main's
	// "shutdown complete"; a goroutine in main lost that race on an idle server.
	log.Printf("shutdown: signal received, draining for up to %s", grace)
	sctx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	shutdownErr := srv.Shutdown(sctx)
	<-errCh
	return shutdownErr
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", handleRoot)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/affiliations", handleAffiliations)
	mux.HandleFunc("/authors", handleAuthors)
	mux.HandleFunc("/drift", handleDrift)
	mux.HandleFunc("/curate", handleCurate)
	mux.HandleFunc("/mesh", handleMesh)
	mux.HandleFunc("/check", handleCheck)

	addr := "127.0.0.1:8080"
	if a := strings.TrimSpace(os.Getenv("ADDR")); a != "" {
		addr = a
	} else if p := strings.TrimSpace(os.Getenv("PORT")); p != "" {
		addr = "0.0.0.0:" + p
	}
	// polite=on/off rather than the address itself: whether the variable took
	// effect is the operational question, and the value is already in the
	// compose file.
	polite := "off"
	if crossrefMailto() != "" {
		polite = "on"
	}
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: srvReadHeaderTimeout,
		ReadTimeout:       srvReadTimeout,
		WriteTimeout:      srvWriteTimeout,
		IdleTimeout:       srvIdleTimeout,
	}
	log.Printf("bibliovera-web listening on %s (CLI: %s, DB: %s, slots=%d, crossref_polite=%s)", addr, cliBinaryPath(), dbPath(), cliSem.capacity(), polite)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	if err := serveUntil(ctx, srv, srv.ListenAndServe, shutdownGrace); err != nil {
		log.Fatalf("server error: %v", err)
	}
	log.Printf("shutdown complete")
}

// browserConfig is the bootstrap payload /config.json hands to the page so it
// can build its Supabase client. SupabaseAnonKey is the PUBLISHABLE
// (browser-side) key, never the secret one: it is designed to be visible in a
// browser and Row Level Security is what protects the data. It is still never
// logged.
type browserConfig struct {
	SupabaseURL     string `json:"supabase_url"`
	SupabaseAnonKey string `json:"supabase_anon_key"`
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/config.json":
		// Deliberately NOT behind the auth layer: Caddy protects the API paths
		// with forward_auth, and the page needs this config BEFORE it can sign
		// anyone in. Serving it from a protected path would make the
		// requirement circular and force a special-case exception into the
		// Caddy matcher.
		//
		// A missing variable is not an error. An empty pair with status 200 is
		// a valid answer that puts the page into unauthenticated mode, which is
		// what keeps local development and the current deployment working until
		// the environment is set.
		supaURL := strings.TrimSpace(os.Getenv("SUPABASE_URL"))
		supaKey := strings.TrimSpace(os.Getenv("SUPABASE_PUBLISHABLE_KEY"))
		if supaURL == "" || supaKey == "" {
			supaURL, supaKey = "", ""
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		// Never cache: a stale key surviving a key rotation would be hard to
		// diagnose from the browser side.
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(browserConfig{SupabaseURL: supaURL, SupabaseAnonKey: supaKey})
	case "/", "/index.html":
		data, err := os.ReadFile("index.html")
		if err != nil {
			// A missing index.html is a broken image, not a healthy app. Answering
			// 200 "ok" here hid that from anything that checks "/". /healthz stays
			// the liveness probe the container healthcheck uses.
			log.Printf("root: index.html unavailable: %v", err)
			http.Error(w, "UI unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(data)
	default:
		http.NotFound(w, r)
	}
}

// handleAffiliations mirrors GET /affiliations?journal=&years=&threshold=&limit=&minPrior=.
func handleAffiliations(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	minPrior, err := optInt(q.Get("minPrior"), 5, 0, 20)
	if err != nil {
		writeErr(w, err)
		return
	}
	args := []string{"affiliation-growth", "--json", "--db", dbPath()}
	journal, err := textParam(q, "journal", maxJournalChars)
	if err != nil {
		writeErr(w, err)
		return
	}
	if journal != "" {
		args = append(args, "--journal", journal)
	}
	if a, err := intFlag(q.Get("years"), "years", 1, 100); err != nil {
		writeErr(w, err)
		return
	} else {
		args = append(args, a...)
	}
	if a, err := intFlag(q.Get("threshold"), "threshold", 1, 1000); err != nil {
		writeErr(w, err)
		return
	} else {
		args = append(args, a...)
	}
	if a, err := intFlag(q.Get("limit"), "limit", 1, 500); err != nil {
		writeErr(w, err)
		return
	} else {
		args = append(args, a...)
	}

	raw, err := runCLIRaw(r.Context(), args)
	if err != nil {
		writeErr(w, err)
		return
	}

	var rows []map[string]any
	if json.Unmarshal(raw, &rows) != nil {
		writeRaw(w, raw)
		return
	}
	normal := make([]map[string]any, 0, len(rows))
	lowBase := make([]map[string]any, 0)
	for _, row := range rows {
		prior := jsonInt(row["prior_count"])
		// low_base is a claim about where the row sits relative to the
		// slider, so every row carries it. A key present on some rows only
		// becomes an empty cell in a spreadsheet, and empty reads as "no
		// data", not as false.
		//
		// There is no is_new here any more. It asserted "this institution is
		// new" from prior_count == 0, which the number does not support: the
		// institution may have published nothing in this journal, or predate
		// the mirror. It was also set inside this branch only, so with the
		// slider at 0 it was never set at all and the exported file silently
		// lost a column. prior_count already carries the fact exactly.
		if prior >= minPrior {
			row["low_base"] = false
			normal = append(normal, row)
			continue
		}
		row["low_base"] = true
		lowBase = append(lowBase, row)
	}
	writeJSONValue(w, append(normal, lowBase...))
}

// handleAuthors mirrors GET /authors?institution=&journal=&limit=&minWorks=.
func handleAuthors(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	minWorks, err := optInt(q.Get("minWorks"), 2, 1, 10)
	if err != nil {
		writeErr(w, err)
		return
	}
	limit, err := optInt(q.Get("limit"), 25, 1, 500)
	if err != nil {
		writeErr(w, err)
		return
	}
	cliLimit := limit * 5
	if cliLimit > 500 {
		cliLimit = 500
	}

	args := []string{"rank-authors", "--json", "--db", dbPath()}
	institution, err := textParam(q, "institution", maxNameChars)
	if err != nil {
		writeErr(w, err)
		return
	}
	journal, err := textParam(q, "journal", maxJournalChars)
	if err != nil {
		writeErr(w, err)
		return
	}
	if institution != "" {
		args = append(args, "--institution", institution)
	}
	if journal != "" {
		args = append(args, "--journal", journal)
	}
	args = append(args, "--limit", strconv.Itoa(cliLimit))

	raw, err := runCLIRaw(r.Context(), args)
	if err != nil {
		writeErr(w, err)
		return
	}

	var rows []map[string]any
	if json.Unmarshal(raw, &rows) != nil {
		writeRaw(w, raw)
		return
	}
	filtered := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		if jsonInt(row["works"]) >= minWorks {
			filtered = append(filtered, row)
		}
	}
	if len(filtered) > limit {
		filtered = filtered[:limit]
	}
	writeJSONValue(w, filtered)
}

// handleDrift mirrors GET /drift?journal=&window1=&window2=&topN=.
func handleDrift(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	w1 := strings.TrimSpace(q.Get("window1"))
	w2 := strings.TrimSpace(q.Get("window2"))
	if !validYearWindow(w1) || !validYearWindow(w2) {
		writeErr(w, badRequest("window1 and window2 must be YYYY:YYYY (e.g. 2015:2019)"))
		return
	}

	topN, err := optInt(q.Get("topN"), 15, 1, 40)
	if err != nil {
		writeErr(w, err)
		return
	}

	args := []string{"drift", "--json", "--db", dbPath(),
		"--window1", w1, "--window2", w2, "--top-n", strconv.Itoa(topN)}
	journal, err := textParam(q, "journal", maxJournalChars)
	if err != nil {
		writeErr(w, err)
		return
	}
	if journal != "" {
		args = append(args, "--journal", journal)
	}

	raw, err := runCLIRaw(r.Context(), args)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeRaw(w, raw)
}

// handleCurate mirrors GET /curate?topic=&journal=&sort=&limit=.
// Returns a ranked reading list (title, DOI, year, citations, etc) for a topic,
// optionally scoped to a single journal. Powers both the Reading List module
// and the Rising Papers module (sort=per-year, ranked by the CLI in SQL).
func handleCurate(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	topic, err := textParam(q, "topic", maxNameChars)
	if err != nil {
		writeErr(w, err)
		return
	}
	if topic == "" {
		writeErr(w, badRequest("topic parameter required"))
		return
	}

	journal, err := textParam(q, "journal", maxJournalChars)
	if err != nil {
		writeErr(w, err)
		return
	}

	limit, err := optInt(q.Get("limit"), 25, 1, 100)
	if err != nil {
		writeErr(w, err)
		return
	}

	// --data-source local: curate never calls the live OpenAlex API, and
	// --sort per-year needs the local store.
	args := []string{"curate", "--topic", topic, "--json", "--db", dbPath(),
		"--limit", strconv.Itoa(limit), "--data-source", "local"}
	if journal != "" {
		args = append(args, "--journal", journal)
	}
	if s := strings.TrimSpace(q.Get("sort")); s != "" {
		switch s {
		case "citations", "date", "per-year":
		default:
			writeErr(w, badRequest("sort must be citations, date or per-year"))
			return
		}
		args = append(args, "--sort", s)
	}

	raw, err := runCLIRaw(r.Context(), args)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeRaw(w, raw)
}

// maxMeshPairs is the ceiling /mesh offers for limit. Measured against
// the CLI on 2026-09-22: `thelancet mesh --org Oxford --limit 500`
// returns 500 pairs in ~50 KB, and the page draws them as a force
// graph, so 500 is what the UI can actually ask for. The CLI has no
// ceiling of its own — this constant is the only one.
const maxMeshPairs = 500

// handleMesh mirrors GET /mesh?org=&limit=.
// Returns co-authorship pairs within an institution ranked by shared works.
// Each row is {author_a, author_b, shared_works}; the client builds a graph
// (nodes = authors, links = shared_works) from these pairs.
func handleMesh(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	org, err := textParam(q, "org", maxNameChars)
	if err != nil {
		writeErr(w, err)
		return
	}
	if org == "" {
		writeErr(w, badRequest("org parameter required"))
		return
	}

	limit, err := optInt(q.Get("limit"), 25, 1, maxMeshPairs)
	if err != nil {
		writeErr(w, err)
		return
	}

	args := []string{"mesh", "--json", "--db", dbPath(),
		"--org", org, "--limit", strconv.Itoa(limit)}

	raw, err := runCLIRaw(r.Context(), args)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeRaw(w, raw)
}

// handleCheck mirrors GET /check?doi= or /check?pmid=.
// Calls the retraction-checker CLI and returns retraction status.
func handleCheck(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	doi, err := textParam(q, "doi", maxDOIChars)
	if err != nil {
		writeErr(w, err)
		return
	}
	pmid, err := textParam(q, "pmid", maxPMIDChars)
	if err != nil {
		writeErr(w, err)
		return
	}

	if doi == "" && pmid == "" {
		writeErr(w, badRequest("doi or pmid parameter required"))
		return
	}

	args := []string{"check", "--json"}
	if doi != "" {
		args = append(args, doi)
	} else {
		args = append(args, pmid)
	}
	// Appended last, never in front: cliCmdLabel reads args[0] for the log
	// label, and a flag there would turn every /check line into cmd=?.
	if m := crossrefMailto(); m != "" {
		args = append(args, "--mailto", m)
	}

	label := cliCmdLabel(args)

	// The retraction check shares the same slot pool as the analytics CLI:
	// both are child processes on the same two cores. On exhaustion it answers
	// 503 with Retry-After. index.html reads any non-2xx /check as "unverified",
	// so the page does not break; a 200 here made a full server look like a
	// successful lookup.
	waitStart := time.Now()
	err = cliSem.acquire(r.Context())
	waitMS := time.Since(waitStart).Milliseconds()
	if err != nil {
		log.Printf("cli: busy bin=retraction cmd=%s wait_ms=%d err=%v", label, waitMS, err)
		w.Header().Set("Retry-After", strconv.Itoa(cliSlotRetryAfter))
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "retraction checker busy; retry shortly"})
		return
	}
	defer cliSem.release()

	// 10-second timeout for retraction check (faster than CLI analytics).
	ctx, cancel := context.WithTimeout(r.Context(), retractionCheckBudget)
	defer cancel()

	runStart := time.Now()
	stdout, stderr, err := runCapped(ctx, cancel, retractionCheckerBinaryPath(), args)
	elapsed := time.Since(runStart).Milliseconds()
	if errors.Is(err, errOutputTooLarge) {
		log.Printf("cli: fail bin=retraction cmd=%s wait_ms=%d elapsed_ms=%d err=%v (cap %d bytes), child killed", label, waitMS, elapsed, err, cliStdoutCap)
		writeErr(w, err)
		return
	}
	if err != nil {
		log.Printf("cli: fail bin=retraction cmd=%s wait_ms=%d elapsed_ms=%d err=%v — stderr: %s", label, waitMS, elapsed, err, stderrForLog(stderr))
		// If retraction-checker is not found or fails, return a safe fallback.
		writeJSONValue(w, map[string]any{
			"retracted": false,
			"error":     "retraction-checker unavailable",
		})
		return
	}

	raw := bytes.TrimSpace(stdout)
	if !json.Valid(raw) {
		log.Printf("cli: fail bin=retraction cmd=%s wait_ms=%d elapsed_ms=%d err=non-json bytes=%d", label, waitMS, elapsed, len(raw))
		writeJSONValue(w, map[string]any{
			"retracted": false,
			"error":     "invalid JSON from checker",
		})
		return
	}
	// A successful run can still have written to stderr, and those messages are
	// the ones worth seeing: the CLI warns there when the OpenAlex per-IP quota
	// is nearly spent, and prints its rate-limit and server-error retries the
	// same way. All of them happen while the command goes on to succeed, so
	// logging stderr only on failure discarded exactly the warnings that arrive
	// early enough to act on. Operator information — never sent to the client.
	if w := stderrForLog(stderr); w != "" {
		log.Printf("cli: ok bin=retraction cmd=%s wait_ms=%d elapsed_ms=%d bytes=%d — stderr: %s", label, waitMS, elapsed, len(raw), w)
	} else {
		log.Printf("cli: ok bin=retraction cmd=%s wait_ms=%d elapsed_ms=%d bytes=%d", label, waitMS, elapsed, len(raw))
	}
	writeRaw(w, raw)
}

// validYearWindow accepts exactly YYYY:YYYY with 4-digit years and start <= end.
func validYearWindow(s string) bool {
	parts := strings.Split(s, ":")
	if len(parts) != 2 {
		return false
	}
	a, err1 := strconv.Atoi(parts[0])
	b, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return false
	}
	if a < 1900 || a > 2100 || b < 1900 || b > 2100 {
		return false
	}
	return a <= b
}

// intFlag validates an optional integer query param and returns it as a
// ["--name", "v"] pair, or an empty slice when the param was absent.
func intFlag(raw, name string, min, max int) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return nil, badRequest("%s must be an integer", name)
	}
	if n < min || n > max {
		return nil, badRequest("%s must be between %d and %d", name, min, max)
	}
	return []string{"--" + name, strconv.Itoa(n)}, nil
}

// Maximum lengths, in characters, for free-text query params. Over-long input
// is rejected with 400, never truncated: a silently shortened DOI or journal
// would query something the caller did not ask for. Each limit is generous
// for real names and DOIs (OWASP Input Validation: enforce a maximum length on
// every input) while keeping megabyte values out of CLI args and logs.
const (
	maxNameChars    = 200 // topic, institution, org
	maxJournalChars = 100
	maxDOIChars     = 300
	maxPMIDChars    = 20
)

// textParam returns the trimmed query value, or a 400 when it has more than
// max characters (runes, not bytes). Callers run it before the value reaches
// CLI args or a log line.
func textParam(q url.Values, name string, max int) (string, error) {
	v := strings.TrimSpace(q.Get(name))
	if utf8.RuneCountInString(v) > max {
		return "", badRequest("%s is too long (max %d characters)", name, max)
	}
	return v, nil
}

// optInt parses an optional integer query param into a value (not a flag),
// falling back to def when absent and range-checking otherwise.
func optInt(raw string, def, min, max int) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, badRequest("parameter must be an integer")
	}
	if n < min || n > max {
		return 0, badRequest("parameter must be between %d and %d", min, max)
	}
	return n, nil
}

// jsonInt reads an integer out of a decoded JSON value (numbers arrive as
// float64 from encoding/json; tolerate numeric strings too).
func jsonInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case string:
		i, _ := strconv.Atoi(strings.TrimSpace(n))
		return i
	}
	return 0
}

// cliCmdLabel names the subcommand for the log without leaking user input.
// Every args slice in this file starts with a literal verb and puts user text
// (a DOI, a PMID, a topic) later, so only the first element is safe to log.
func cliCmdLabel(args []string) string {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return "?"
	}
	return args[0]
}

// runCLIRaw executes the analytics CLI and returns its validated JSON stdout.
//
// wait_ms and elapsed_ms are logged apart because wait_ms is the only way to
// tell a saturated slot pool from a slow upstream — from outside, both look
// like one slow page. bin= is on every line because the two binaries share a
// single slot pool, so one can starve the other.
func runCLIRaw(parent context.Context, args []string) ([]byte, error) {
	label := cliCmdLabel(args)

	waitStart := time.Now()
	err := cliSem.acquire(parent)
	waitMS := time.Since(waitStart).Milliseconds()
	if err != nil {
		log.Printf("cli: busy bin=analytics cmd=%s wait_ms=%d err=%v", label, waitMS, err)
		return nil, err
	}
	defer cliSem.release()

	ctx, cancel := context.WithTimeout(parent, analyticsBudget)
	defer cancel()
	runStart := time.Now()
	stdout, stderr, err := runCapped(ctx, cancel, cliBinaryPath(), args)
	elapsed := time.Since(runStart).Milliseconds()
	if errors.Is(err, errOutputTooLarge) {
		log.Printf("cli: fail bin=analytics cmd=%s wait_ms=%d elapsed_ms=%d err=%v (cap %d bytes), child killed", label, waitMS, elapsed, err, cliStdoutCap)
		return nil, err
	}
	if err != nil {
		// The client gets a fixed message: stderr (and err, which can name a
		// path) are for the log only.
		log.Printf("cli: fail bin=analytics cmd=%s wait_ms=%d elapsed_ms=%d err=%v — stderr: %s", label, waitMS, elapsed, err, stderrForLog(stderr))
		return nil, errors.New("analytics failed")
	}
	raw := bytes.TrimSpace(stdout)
	if !json.Valid(raw) {
		log.Printf("cli: fail bin=analytics cmd=%s wait_ms=%d elapsed_ms=%d err=non-json bytes=%d", label, waitMS, elapsed, len(raw))
		return nil, errors.New("CLI returned non-JSON output")
	}
	// A successful run can still have written to stderr, and those messages are
	// the ones worth seeing: the CLI warns there when the OpenAlex per-IP quota
	// is nearly spent, and prints its rate-limit and server-error retries the
	// same way. All of them happen while the command goes on to succeed, so
	// logging stderr only on failure discarded exactly the warnings that arrive
	// early enough to act on. Operator information — never sent to the client.
	if w := stderrForLog(stderr); w != "" {
		log.Printf("cli: ok bin=analytics cmd=%s wait_ms=%d elapsed_ms=%d bytes=%d — stderr: %s", label, waitMS, elapsed, len(raw), w)
	} else {
		log.Printf("cli: ok bin=analytics cmd=%s wait_ms=%d elapsed_ms=%d bytes=%d", label, waitMS, elapsed, len(raw))
	}
	return decodeEntities(raw), nil
}

// entityFields are the display-text keys the CLI can return with HTML
// entities already in them (the mirror stores titles as the publisher sent
// them, e.g. "Bile Acid &amp; Tryptophan"). Identifiers such as doi, author_id
// and every non-string value are left alone.
var entityFields = map[string]bool{
	"title": true, "display_name": true, "journal": true, "source": true,
	"topic": true, "author_name": true, "institution": true,
	"author_a": true, "author_b": true,
}

// decodeEntities returns raw with html.UnescapeString applied exactly once to
// every string under an entityFields key. The JSON is returned byte for byte
// when it has no ampersand (Go's encoder writes it as a backslash-u0026 escape), cannot be
// decoded, or nothing changed. Numbers keep their exact text (UseNumber), and
// object keys keep the order the CLI wrote them in: index.html builds the
// CSV/Excel columns from the row keys in order, so a re-marshalled map (sorted
// keys) would move "title" out of the first column.
// The page escapes every one of these fields before it renders, so "<b>" that
// comes out of a decoded "&lt;b&gt;" is still shown as text.
func decodeEntities(raw []byte) []byte {
	// jsonAmp is a backslash followed by u0026: how Go's JSON encoder writes &.
	jsonAmp := []byte("\\" + "u0026")
	if !bytes.Contains(raw, []byte("&")) && !bytes.Contains(raw, jsonAmp) {
		return raw
	}
	// One frame per open container; the walk writes every token back in order.
	type frame struct {
		obj     bool
		wantKey bool
		key     string
		n       int
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var out bytes.Buffer
	var stack []frame
	changed := false
	for {
		tok, err := dec.Token()
		if err != nil {
			return raw
		}
		if d, ok := tok.(json.Delim); ok && (d == '}' || d == ']') {
			stack = stack[:len(stack)-1]
			out.WriteByte(byte(d))
		} else {
			var top *frame
			if n := len(stack); n > 0 {
				top = &stack[n-1]
			}
			if top != nil && top.obj && top.wantKey {
				key, ok := tok.(string)
				if !ok {
					return raw
				}
				if top.n > 0 {
					out.WriteByte(',')
				}
				top.n++
				top.key, top.wantKey = key, false
				kb, _ := json.Marshal(key)
				out.Write(kb)
				out.WriteByte(':')
				continue
			}
			if top != nil && !top.obj {
				if top.n > 0 {
					out.WriteByte(',')
				}
				top.n++
			}
			switch v := tok.(type) {
			case json.Delim:
				stack = append(stack, frame{obj: v == '{', wantKey: v == '{'})
				out.WriteByte(byte(v))
				continue
			case string:
				if top != nil && top.obj && entityFields[top.key] {
					if u := html.UnescapeString(v); u != v {
						v, changed = u, true
					}
				}
				sb, _ := json.Marshal(v)
				out.Write(sb)
			case json.Number:
				out.WriteString(v.String())
			case bool:
				out.WriteString(strconv.FormatBool(v))
			default: // null
				out.WriteString("null")
			}
			if top != nil && top.obj {
				top.wantKey = true
			}
		}
		if len(stack) == 0 {
			break
		}
		if top := &stack[len(stack)-1]; top.obj {
			top.wantKey = true
		}
	}
	if !changed {
		return raw
	}
	return out.Bytes()
}

func writeRaw(w http.ResponseWriter, raw []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(raw)
}

func writeJSONValue(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

// badRequestError marks an error caused by the client's input.
//
// The HTTP status is decided by the error's type, not at each call site:
// validation happens inside helpers (optInt, intFlag) whose errors pass
// through the same writeErr as upstream failures, so a status chosen per
// call site would have to be repeated at every one of them and could drift.
// The helper that knows the input was bad marks it once, here.
type badRequestError struct{ msg string }

func (e badRequestError) Error() string { return e.msg }

func badRequest(format string, a ...any) error {
	return badRequestError{msg: fmt.Sprintf(format, a...)}
}

// writeErr reports err as JSON. 502 stays the default: anything not
// explicitly marked as client input is treated as an upstream failure, so an
// unclassified error can never be reported as the client's fault.
func writeErr(w http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	var bre badRequestError
	if errors.As(err, &bre) {
		status = http.StatusBadRequest
	} else if errors.Is(err, errCLIBusy) {
		// A full slot pool is the server being busy, not the CLI breaking: the
		// same request will work shortly. A 503 without Retry-After is not
		// actionable, so the header is sent with it.
		status = http.StatusServiceUnavailable
		w.Header().Set("Retry-After", strconv.Itoa(cliSlotRetryAfter))
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

// truncate caps a log line at max runes. Rune-based, not byte-based: a
// stderr message can carry UTF-8, and slicing bytes would split a character
// and put an invalid sequence in the log. Same shape as pubvera-corpova's,
// so a line from either app reads identically.
func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "..."
}
