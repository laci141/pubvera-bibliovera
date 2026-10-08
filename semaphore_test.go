package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func buildConcurrencyStubCLI(t *testing.T, logPath string, delay time.Duration) {
	t.Helper()
	dir := t.TempDir()
	src := `package main
import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)
func mark(p, s string) {
	if p == "" {
		return
	}
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err == nil {
		fmt.Fprintln(f, s)
		f.Close()
	}
}
func main() {
	p := os.Getenv("CONC_STUB_LOG")
	mark(p, "S")
	d, _ := time.ParseDuration(os.Getenv("CONC_STUB_DELAY"))
	time.Sleep(d)
	out, _ := json.Marshal([]any{})
	fmt.Println(string(out))
	mark(p, "E")
}
`
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte(src), 0o600); err != nil {
		t.Fatalf("write stub source: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module concstub\n\ngo 1.26\n"), 0o600); err != nil {
		t.Fatalf("write stub go.mod: %v", err)
	}
	bin := filepath.Join(dir, "concstub")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	cmd := exec.Command("go", "build", "-o", bin, ".")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build concurrency stub CLI: %v\n%s", err, out)
	}
	t.Setenv("CLI_BIN", bin)
	t.Setenv("CONC_STUB_LOG", logPath)
	t.Setenv("CONC_STUB_DELAY", delay.String())
}

func peakConcurrency(t *testing.T, logPath string) int {
	t.Helper()
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read stub log: %v", err)
	}
	cur, peak := 0, 0
	for _, line := range strings.Split(string(raw), "\n") {
		switch strings.TrimSpace(line) {
		case "S":
			cur++
			if cur > peak {
				peak = cur
			}
		case "E":
			cur--
		}
	}
	return peak
}

// getMesh drives the real handleMesh handler, which goes through runCLIRaw.
func getMesh(t *testing.T, org string) (int, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/mesh?org="+org, nil)
	rec := httptest.NewRecorder()
	handleMesh(rec, req)
	return rec.Code, rec.Body.String()
}

func fireDistinctMeshRequests(t *testing.T, n int) []int {
	t.Helper()
	codes := make([]int, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			code, _ := getMesh(t, fmt.Sprintf("org%d", i))
			codes[i] = code
		}(i)
	}
	close(start)
	wg.Wait()
	return codes
}

func useSemaphore(t *testing.T, slots int, wait time.Duration) {
	t.Helper()
	prevSem, prevWait := cliSem, cliSlotWait
	cliSem, cliSlotWait = newCLISemaphore(slots), wait
	t.Cleanup(func() { cliSem, cliSlotWait = prevSem, prevWait })
}

func TestCLISemaphoreBoundsChildRuns(t *testing.T) {
	const requests = 12

	unboundedLog := filepath.Join(t.TempDir(), "unbounded.log")
	buildConcurrencyStubCLI(t, unboundedLog, 400*time.Millisecond)

	useSemaphore(t, 0, 10*time.Second)
	fireDistinctMeshRequests(t, requests)
	unbounded := peakConcurrency(t, unboundedLog)

	boundedLog := filepath.Join(t.TempDir(), "bounded.log")
	t.Setenv("CONC_STUB_LOG", boundedLog)

	useSemaphore(t, 4, 10*time.Second)
	codes := fireDistinctMeshRequests(t, requests)
	bounded := peakConcurrency(t, boundedLog)

	t.Logf("MEASURED peak concurrent child processes for %d distinct requests: unbounded=%d bounded=%d",
		requests, unbounded, bounded)

	if unbounded <= 4 {
		t.Fatalf("unbounded peak was %d, expected more than 4 — harness not producing concurrency", unbounded)
	}
	if bounded > 4 {
		t.Errorf("bounded peak = %d, want at most 4", bounded)
	}
	for i, c := range codes {
		if c != http.StatusOK {
			t.Errorf("request %d got %d, want 200", i, c)
		}
	}
}

// TestCheckBusyIs503WithRetryAfter pins the /check behaviour under slot
// exhaustion. It used to answer 200 with a fallback body, which made a full
// server look like a successful lookup. It is now a 503 with Retry-After in the
// same {"error": ...} shape every other error uses; index.html already turns
// any non-2xx /check into "unverified" (readJSON throws, checkRetractions
// catches), so the page does not break.
func TestCheckBusyIs503WithRetryAfter(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "check.log")
	buildConcurrencyStubCLI(t, logPath, 2*time.Second)
	t.Setenv("RETRACTION_CHECKER_BIN", os.Getenv("CLI_BIN"))

	useSemaphore(t, 1, 150*time.Millisecond)

	if err := cliSem.acquire(context.Background()); err != nil {
		t.Fatalf("first acquire failed: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/check?doi=10.1234/x", nil)
	rec := httptest.NewRecorder()
	handleCheck(rec, req)
	cliSem.release()

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	ra := rec.Header().Get("Retry-After")
	if n, err := strconv.Atoi(ra); err != nil || n <= 0 {
		t.Errorf("Retry-After = %q, want a positive number of seconds", ra)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q is not JSON: %v", rec.Body.String(), err)
	}
	if !strings.Contains(body.Error, "busy") {
		t.Errorf("error = %q, want it to mention busy", body.Error)
	}
}

func TestCLISemaphoreDisabledIsANoOp(t *testing.T) {
	t.Setenv("CLI_MAX_CONCURRENT", "0")
	if got := cliSlotsFromEnv(); got != 0 {
		t.Fatalf("cliSlotsFromEnv() = %d, want 0", got)
	}
	s := newCLISemaphore(0)
	if got := s.capacity(); got != 0 {
		t.Errorf("capacity() = %d, want 0", got)
	}
	for i := 0; i < 50; i++ {
		if err := s.acquire(context.Background()); err != nil {
			t.Fatalf("acquire %d on disabled semaphore: %v", i, err)
		}
	}
	if got := s.inUse(); got != 0 {
		t.Errorf("inUse() = %d on disabled semaphore, want 0", got)
	}
	t.Setenv("CLI_MAX_CONCURRENT", "")
	if got := cliSlotsFromEnv(); got != defaultCLISlots {
		t.Errorf("empty env gave %d, want %d", got, defaultCLISlots)
	}
}

// TestMain lets the test binary double as the fake CLI: the tests point CLI_BIN
// at os.Executable() and set FAKE_CLI_MODE, so no shell script or second build
// is needed.
func TestMain(m *testing.M) {
	if mode := os.Getenv("FAKE_CLI_MODE"); mode != "" {
		runFakeCLI(mode)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// runFakeCLI modes: ok (small JSON), bytes (FAKE_CLI_BYTES of stdout, then
// sleep FAKE_CLI_SLEEP), secret (secret-looking stderr, exit 1), bigerr (1 MiB
// of stderr, small JSON, exit 0).
func runFakeCLI(mode string) {
	switch mode {
	case "ok":
		fmt.Print(`[{"a":1}]`)
	case "json":
		// Print FAKE_CLI_JSON verbatim as the CLI's stdout.
		fmt.Print(os.Getenv("FAKE_CLI_JSON"))
	case "args":
		// Echo the CLI arguments back as the JSON body so a test can assert them.
		b, _ := json.Marshal(os.Args[1:])
		fmt.Print(string(b))
	case "curate":
		runFakeCurate()
	case "bytes":
		n, _ := strconv.Atoi(os.Getenv("FAKE_CLI_BYTES"))
		chunk := bytes.Repeat([]byte("x"), 64<<10)
		for n > 0 {
			k := min(n, len(chunk))
			if _, err := os.Stdout.Write(chunk[:k]); err != nil {
				os.Exit(3)
			}
			n -= k
		}
		d, _ := time.ParseDuration(os.Getenv("FAKE_CLI_SLEEP"))
		time.Sleep(d)
	case "secret":
		fmt.Fprint(os.Stderr, "SECRET_PATH /root/x\nsecond line")
		os.Exit(1)
	case "bigerr":
		chunk := bytes.Repeat([]byte("e"), 64<<10)
		for range 16 {
			_, _ = os.Stderr.Write(chunk)
		}
		fmt.Print(`[]`)
	}
}

// runFakeCurate imitates thelancet-pp-cli curate for the velocity tests. Any
// sort other than velocity answers with one per-year row. For --sort velocity,
// FAKE_CURATE_VEL picks the behaviour: rows (velocity rows, silent), partial
// (rows plus the "no current yearly citation counts" stderr line), refresh
// (exit 1 with the real refresh hint) or fail (exit 1 with an unrelated error).
func runFakeCurate() {
	if !slices.Contains(os.Args[1:], "velocity") {
		fmt.Print(`[{"doi":"10.1/per-year","citations_per_year":3}]`)
		return
	}
	const rows = `[{"doi":"10.1/a","velocity":2.5},{"doi":"10.1/b","velocity":null}]`
	switch os.Getenv("FAKE_CURATE_VEL") {
	case "partial":
		fmt.Fprint(os.Stderr, "4683 of 7997 matched works have no current yearly citation counts; run thelancet-pp-cli refresh to include them\n")
		fmt.Print(rows)
	case "refresh":
		fmt.Fprint(os.Stderr, "Error: curating: --sort velocity needs yearly citation counts, which this local store does not have yet; run 'thelancet-pp-cli refresh' to fetch them, or sort by citations, date or per-year\n")
		os.Exit(1)
	case "fail":
		fmt.Fprint(os.Stderr, "Error: curating: database is locked\n")
		os.Exit(1)
	default:
		fmt.Print(rows)
	}
}

func useFakeCLI(t *testing.T, mode string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	t.Setenv("CLI_BIN", exe)
	t.Setenv("RETRACTION_CHECKER_BIN", exe)
	t.Setenv("FAKE_CLI_MODE", mode)
	useSemaphore(t, 4, time.Second)
}

// captureLog collects what log.Printf writes for the duration of the test.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return &buf
}

var cliEndpoints = []struct {
	name   string
	h      http.HandlerFunc
	target string
}{
	{"analytics /mesh", handleMesh, "/mesh?org=Oxford"},
	{"retraction /check", handleCheck, "/check?doi=10.1234/x"},
}

func serve(h http.HandlerFunc, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}

// TestStdoutOverCapIs502AndKillsChild: the child writes cap+1 bytes and then
// sleeps for 20s. The handler must stop reading, kill it, and answer 502 with a
// generic body; a handler that waits for the child would take ~20s.
func TestStdoutOverCapIs502AndKillsChild(t *testing.T) {
	for _, ep := range cliEndpoints {
		t.Run(ep.name, func(t *testing.T) {
			useFakeCLI(t, "bytes")
			t.Setenv("FAKE_CLI_BYTES", strconv.Itoa(cliStdoutCap+1))
			t.Setenv("FAKE_CLI_SLEEP", "20s")
			logs := captureLog(t)

			start := time.Now()
			rec := serve(ep.h, ep.target)
			elapsed := time.Since(start)

			if rec.Code != http.StatusBadGateway {
				t.Errorf("status = %d, want 502", rec.Code)
			}
			const want = `{"error":"upstream output too large"}` + "\n"
			if got := rec.Body.String(); got != want {
				t.Errorf("body length %d, want %q", len(got), want)
			}
			if elapsed > 10*time.Second {
				t.Errorf("took %v: the child was not killed", elapsed)
			}
			if !strings.Contains(logs.String(), "output too large") {
				t.Errorf("overflow was not logged: %q", logs.String())
			}
		})
	}
}

// TestCLIStderrNeverReachesClient: stderr text must stay in the server log.
// Status codes are unchanged: 502 for analytics, the 200 fallback for /check.
func TestCLIStderrNeverReachesClient(t *testing.T) {
	cases := []struct {
		name   string
		h      http.HandlerFunc
		target string
		want   int
	}{
		{"analytics /mesh", handleMesh, "/mesh?org=Oxford", http.StatusBadGateway},
		{"retraction /check", handleCheck, "/check?doi=10.1234/x", http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			useFakeCLI(t, "secret")
			logs := captureLog(t)

			rec := serve(tc.h, tc.target)

			if rec.Code != tc.want {
				t.Errorf("status = %d, want %d", rec.Code, tc.want)
			}
			if b := rec.Body.String(); strings.Contains(b, "SECRET_PATH") || strings.Contains(b, "/root/x") {
				t.Errorf("client body leaks stderr: %q", b)
			}
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["error"] == nil {
				t.Errorf("body %q is not a JSON error: %v", rec.Body.String(), err)
			}
			l := logs.String()
			if !strings.Contains(l, "SECRET_PATH /root/x second line") {
				t.Errorf("stderr missing (or not single-line) in the server log: %q", l)
			}
			if !strings.Contains(l, "cmd=") {
				t.Errorf("log line carries no cmd label: %q", l)
			}
		})
	}
}

// TestCLIStderrOverCapOnlyTruncates: a chatty stderr must not fail a run that
// otherwise succeeded, and must not flood the log.
func TestCLIStderrOverCapOnlyTruncates(t *testing.T) {
	useFakeCLI(t, "bigerr")
	logs := captureLog(t)

	rec := serve(handleMesh, "/mesh?org=Oxford")

	if rec.Code != http.StatusOK || rec.Body.String() != "[]" {
		t.Errorf("got %d %q, want 200 []", rec.Code, rec.Body.String())
	}
	if n := logs.Len(); n > 2000 {
		t.Errorf("log grew by %d bytes for a 1 MiB stderr", n)
	}
}

// TestSmallOutputIsUnchanged is the control for the caps: normal output still
// comes back verbatim with 200.
func TestSmallOutputIsUnchanged(t *testing.T) {
	for _, ep := range cliEndpoints {
		t.Run(ep.name, func(t *testing.T) {
			useFakeCLI(t, "ok")
			rec := serve(ep.h, ep.target)
			if rec.Code != http.StatusOK {
				t.Errorf("status = %d, want 200", rec.Code)
			}
			if got, want := rec.Body.String(), `[{"a":1}]`; got != want {
				t.Errorf("body = %q, want %q", got, want)
			}
		})
	}
}

// TestAnalyticsBusyIs503WithRetryAfter: a full slot pool on an analytics
// endpoint is the server being full, not the CLI breaking. It used to surface
// as 502 because writeErr treats every unmarked error as an upstream failure.
// index.html shows a 503 as the "Temporarily unavailable" error card.
func TestAnalyticsBusyIs503WithRetryAfter(t *testing.T) {
	useFakeCLI(t, "ok")
	useSemaphore(t, 1, 150*time.Millisecond)

	if err := cliSem.acquire(context.Background()); err != nil {
		t.Fatalf("first acquire failed: %v", err)
	}
	rec := serve(handleMesh, "/mesh?org=Oxford")
	cliSem.release()

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	ra := rec.Header().Get("Retry-After")
	if n, err := strconv.Atoi(ra); err != nil || n != cliSlotRetryAfter {
		t.Errorf("Retry-After = %q, want %d", ra, cliSlotRetryAfter)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q is not JSON: %v", rec.Body.String(), err)
	}
	if body.Error != errCLIBusy.Error() {
		t.Errorf("error = %q, want %q", body.Error, errCLIBusy.Error())
	}
}
