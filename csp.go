package main

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// Content-Security-Policy: every <script> tag in index.html carries
// nonce="__CSP_NONCE__", and each index response replaces that marker with a
// fresh nonce named in the policy header. The policy is enforced: a script
// without the response's nonce is blocked.
//
// connect-src is enforced in the same header: 'self', plus the Supabase origin
// when /config.json hands the page a Supabase config, so fetch, XHR, WebSocket
// and beacon requests to any other host are refused. Violations are reported
// to POST /csp-report (handleCSPReport).
//
// Style S2: the one <style> block carries the same marker, and the same header
// enforces style-src with that nonce and style-src-attr 'none', so a <style>
// without the nonce and every style="" attribute are blocked. There is no
// Report-Only header.
const (
	nonceMarker   = "__CSP_NONCE__"
	cspHeaderName = "Content-Security-Policy"

	reportingEndpointsName = "Reporting-Endpoints"
	// The endpoint URL is relative; the browser resolves it against the
	// response URL.
	reportingEndpointsValue = `csp="/csp-report"`
)

// nonceRandRead is the random source for the CSP nonce. It is a variable only
// so a test can make it fail.
var nonceRandRead = rand.Read

// contentSecurityPolicy is the policy for the index page. 'unsafe-inline' and
// https: are the backward-compatibility fallback for browsers that predate
// nonces and 'strict-dynamic'; browsers that understand nonce plus
// 'strict-dynamic' (Chrome 52+, Firefox 52+, Safari 15.4+) ignore both.
// style-src has no such fallback: the <style> block carries the nonce, and a
// style="" attribute or a <style> without it is blocked (style S2).
// origin is the Supabase origin from supabaseConfig, or "".
func contentSecurityPolicy(nonce, origin string) string {
	return "script-src 'nonce-" + nonce + "' 'strict-dynamic' https: 'unsafe-inline'; script-src-attr 'none'; style-src 'nonce-" + nonce + "'; style-src-attr 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" + cspConnectSrc(origin)
}

// cspConnectSrc is the tail of the enforcing policy for one index response:
// connect-src ('self', plus origin when non-empty) and the report directives.
func cspConnectSrc(origin string) string {
	src := "; connect-src 'self'"
	if origin != "" {
		src += " " + origin
	}
	return src + "; report-to csp; report-uri /csp-report"
}

// supabaseConfig is the one place that decides whether the page has a Supabase
// config. /config.json hands url and key to the page; the index response puts
// origin into the enforced connect-src. Both call this per request,
// so the page and the header cannot disagree, and an environment change needs
// no restart.
//
// url and key keep the old /config.json rule exactly: TrimSpace both, and if
// either is empty both are empty. origin is scheme://host[:port] of url, and
// only when url is https with a plain host name; anything else (http, a parse
// error, no host, characters that could end the directive) gives "", so the
// header falls back to connect-src 'self'. Path, query, fragment and userinfo
// never reach the header.
func supabaseConfig() (supaURL, supaKey, origin string) {
	supaURL = strings.TrimSpace(os.Getenv("SUPABASE_URL"))
	supaKey = strings.TrimSpace(os.Getenv("SUPABASE_PUBLISHABLE_KEY"))
	if supaURL == "" || supaKey == "" {
		return "", "", ""
	}
	u, err := url.Parse(supaURL)
	if err != nil || u.Scheme != "https" || !cspHostRE.MatchString(u.Host) {
		return supaURL, supaKey, ""
	}
	return supaURL, supaKey, u.Scheme + "://" + u.Host
}

// A DNS name with an optional port. url.Parse accepts sub-delims such as ';'
// in a host, which inside a CSP header would start a new directive.
var cspHostRE = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$`)

// Limits for POST /csp-report. A browser sends one small JSON document per
// batch; 16 KiB holds many reports. The endpoint is unauthenticated, so one
// body yields at most cspMaxReports reports, and the log gets at most
// cspLogMaxLines lines per cspLogWindow for the whole process.
const (
	cspReportMaxBytes = 16 << 10
	cspMaxReports     = 20
	cspLogMaxLines    = 60
	cspLogWindow      = time.Minute
	cspLogMaxValue    = 200
)

// cspLogGate is a fixed-window counter over every csp-violation log line.
// Lines over the cap are counted, not written; the count is logged once as
// "csp-violation dropped=<n>" when the first report of a later window arrives
// (there is no timer, so a quiet process reports its last drop late).
type cspLogGate struct {
	mu      sync.Mutex
	now     func() time.Time
	start   time.Time
	lines   int
	dropped int
}

func newCSPLogGate(now func() time.Time) *cspLogGate {
	return &cspLogGate{now: now}
}

// cspGate is the process-wide gate; a test swaps it for one on its own clock.
var cspGate = newCSPLogGate(time.Now)

func (g *cspLogGate) logLine(line string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	t := g.now()
	if g.start.IsZero() || t.Sub(g.start) >= cspLogWindow || t.Before(g.start) {
		if g.dropped > 0 {
			log.Printf("csp-violation dropped=%d", g.dropped)
		}
		g.start, g.lines, g.dropped = t, 0, 0
	}
	if g.lines >= cspLogMaxLines {
		g.dropped++
		return
	}
	g.lines++
	log.Print(line)
}

// One violation, from either report format.
type cspViolation struct {
	disposition, directive, blocked, document string
}

// handleCSPReport receives Content-Security-Policy violation reports: report-to
// (application/reports+json, an array of reports) and report-uri
// (application/csp-report, one object). It logs one line per violation with
// the blocked origin and the page path only: no query, fragment, header,
// cookie, IP or user agent.
func handleCSPReport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// mime.ParseMediaType lower-cases the media type.
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || (mt != "application/reports+json" && mt != "application/csp-report") {
		http.Error(w, "unsupported media type", http.StatusUnsupportedMediaType)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, cspReportMaxBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	var vs []cspViolation
	if mt == "application/reports+json" {
		var reports []struct {
			Type string `json:"type"`
			Body struct {
				EffectiveDirective string `json:"effectiveDirective"`
				BlockedURL         string `json:"blockedURL"`
				DocumentURL        string `json:"documentURL"`
				Disposition        string `json:"disposition"`
			} `json:"body"`
		}
		if err := json.Unmarshal(body, &reports); err != nil {
			http.Error(w, "invalid JSON", http.StatusBadRequest)
			return
		}
		if len(reports) > cspMaxReports {
			reports = reports[:cspMaxReports]
		}
		for _, rep := range reports {
			if rep.Type == "csp-violation" {
				vs = append(vs, cspViolation{rep.Body.Disposition, rep.Body.EffectiveDirective, rep.Body.BlockedURL, rep.Body.DocumentURL})
			}
		}
	} else {
		var rep struct {
			Report *struct {
				EffectiveDirective string `json:"effective-directive"`
				BlockedURI         string `json:"blocked-uri"`
				DocumentURI        string `json:"document-uri"`
				Disposition        string `json:"disposition"`
			} `json:"csp-report"`
		}
		if err := json.Unmarshal(body, &rep); err != nil {
			http.Error(w, "invalid JSON", http.StatusBadRequest)
			return
		}
		if rep.Report != nil {
			vs = append(vs, cspViolation{rep.Report.Disposition, rep.Report.EffectiveDirective, rep.Report.BlockedURI, rep.Report.DocumentURI})
		}
	}

	for _, v := range vs {
		cspGate.logLine("csp-violation disposition=" + cspLogValue(v.disposition) +
			" directive=" + cspLogValue(v.directive) +
			" blocked=" + cspLogValue(cspBlockedOrigin(v.blocked)) +
			" page=" + cspLogValue(cspDocumentPath(v.document)))
	}
	w.WriteHeader(http.StatusNoContent)
}

// cspBlockedOrigin keeps scheme://host[:port] of a URL, the scheme alone for a
// URL without a host (data:, blob:), and a keyword such as inline, eval or
// self as it is, cut at any '?' or '#' in case it is a relative URL.
func cspBlockedOrigin(s string) string {
	if u, err := url.Parse(s); err == nil && u.Scheme != "" {
		if u.Host != "" {
			return u.Scheme + "://" + u.Host
		}
		return u.Scheme
	}
	if i := strings.IndexAny(s, "?#"); i >= 0 {
		s = s[:i]
	}
	return s
}

// cspDocumentPath keeps only the (escaped) path of the page URL.
func cspDocumentPath(s string) string {
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	return u.EscapedPath()
}

// cspLogValue drops control characters (so a value cannot start a second log
// line) and caps the value at cspLogMaxValue bytes on a rune boundary.
func cspLogValue(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.ToValidUTF8(s, ""))
	if len(s) > cspLogMaxValue {
		cut := cspLogMaxValue
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut]
	}
	return s
}
