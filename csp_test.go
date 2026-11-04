package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// CSP: every <script> tag in index.html carries nonce="__CSP_NONCE__", and
// each index response replaces that marker with a fresh nonce named in the
// enforced Content-Security-Policy header, which also enforces connect-src.
// There is no Report-Only header. All requests go through handleRoot
// in-process (httptest), like root_cache_test.go.

// wantPolicy is written out here rather than taken from contentSecurityPolicy,
// so a change to any directive in csp.go fails a test. tail is the connect-src
// part, such as wantTailSelf or wantTailSupa.
func wantPolicy(nonce, tail string) string {
	return "script-src 'nonce-" + nonce + "' 'strict-dynamic' https: 'unsafe-inline'; script-src-attr 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" + tail
}

// The header names and the marker are spelled out so a renamed constant cannot
// agree with itself.
const (
	reportOnlyHeader = "Content-Security-Policy-Report-Only"
	enforcingHeader  = "Content-Security-Policy"
	nonceMarkerText  = "__CSP_NONCE__"
)

// index.html has 5 <script> tags: the external d3 and xlsx-js-style bundles,
// two classic inline scripts and one module.
const wantScriptTags = 5

// 16 random bytes in raw standard base64 are exactly 22 characters.
var cspNonceRE = regexp.MustCompile(`^script-src 'nonce-([A-Za-z0-9+/]{22})' `)

var scriptOpenRE = regexp.MustCompile(`<script\b[^>]*>`)

var bodyNonceRE = regexp.MustCompile(`nonce="([^"]*)"`)

// indexNonce fetches path and returns the header nonce, body and headers. It
// stops the test when there is no nonce to compare against; the header checks
// themselves live in the tests below.
func indexNonce(t *testing.T, path string) (string, string, http.Header) {
	t.Helper()
	rec := getRoot(t, path)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s: status = %d, want 200", path, rec.Code)
	}
	csp := rec.Header().Get(enforcingHeader)
	m := cspNonceRE.FindStringSubmatch(csp)
	if m == nil {
		t.Fatalf("GET %s: %s = %q, want a policy with a 22-character nonce", path, enforcingHeader, csp)
	}
	return m[1], rec.Body.String(), rec.Header()
}

func TestCSPMarkerReplacedInResponse(t *testing.T) {
	for _, path := range []string{"/", "/index.html"} {
		nonce, body, _ := indexNonce(t, path)
		if strings.Contains(body, nonceMarkerText) {
			t.Errorf("GET %s: body still contains %s", path, nonceMarkerText)
		}
		if n := strings.Count(body, `nonce="`+nonce+`"`); n != wantScriptTags {
			t.Errorf("GET %s: %d tags carry the header nonce, want %d", path, n, wantScriptTags)
		}
	}
}

func TestCSPNonceIsFreshPerResponse(t *testing.T) {
	a, _, _ := indexNonce(t, "/")
	b, _, _ := indexNonce(t, "/")
	if a == b {
		t.Errorf("two responses carried the same nonce %q", a)
	}
}

func TestCSPHeaderNonceMatchesEveryBodyNonce(t *testing.T) {
	nonce, body, _ := indexNonce(t, "/")
	tags := scriptOpenRE.FindAllString(body, -1)
	if len(tags) != wantScriptTags {
		t.Errorf("GET /: %d <script> tags, want %d", len(tags), wantScriptTags)
	}
	for _, tag := range tags {
		if !strings.Contains(tag, ` nonce="`+nonce+`"`) {
			t.Errorf("GET /: tag %s does not carry the header nonce %q", tag, nonce)
		}
	}
	for _, m := range bodyNonceRE.FindAllStringSubmatch(body, -1) {
		if m[1] != nonce {
			t.Errorf("GET /: body nonce %q differs from header nonce %q", m[1], nonce)
		}
	}
}

func TestCSPHeaderIsEnforcedWithExactPolicy(t *testing.T) {
	t.Setenv("SUPABASE_URL", "")
	t.Setenv("SUPABASE_PUBLISHABLE_KEY", "")
	nonce, _, h := indexNonce(t, "/")
	if got := h.Values(enforcingHeader); len(got) != 1 || got[0] != wantPolicy(nonce, wantTailSelf) {
		t.Errorf("%s = %q, want [%q]", enforcingHeader, got, wantPolicy(nonce, wantTailSelf))
	}
	if cspHeaderName != enforcingHeader {
		t.Errorf("cspHeaderName = %q, want %q", cspHeaderName, enforcingHeader)
	}
}

// TestCSPIndexHasOneEnforcingPolicyAndNoReportOnly does not use indexNonce, so
// a missing enforcing header does not hide the Report-Only check. connect-src
// lives in the one enforcing header; a Report-Only header must not come back.
func TestCSPIndexHasOneEnforcingPolicyAndNoReportOnly(t *testing.T) {
	t.Setenv("SUPABASE_URL", "")
	t.Setenv("SUPABASE_PUBLISHABLE_KEY", "")
	for _, path := range []string{"/", "/index.html"} {
		rec := getRoot(t, path)
		csp := rec.Header().Values(enforcingHeader)
		if len(csp) != 1 {
			t.Errorf("GET %s: %s = %q, want exactly one policy", path, enforcingHeader, csp)
		} else if m := cspNonceRE.FindStringSubmatch(csp[0]); m == nil || csp[0] != wantPolicy(m[1], wantTailSelf) {
			t.Errorf("GET %s: %s = %q, want the policy ending %q", path, enforcingHeader, csp[0], wantTailSelf)
		}
		if ro := rec.Header().Values(reportOnlyHeader); len(ro) != 0 {
			t.Errorf("GET %s: %s = %q, want none", path, reportOnlyHeader, ro)
		}
		if got := rec.Header().Get(reportingEndpointsHeader); got != wantReportingEndpoints {
			t.Errorf("GET %s: %s = %q, want %q", path, reportingEndpointsHeader, got, wantReportingEndpoints)
		}
	}
}

const (
	reportingEndpointsHeader = "Reporting-Endpoints"
	wantReportingEndpoints   = `csp="/csp-report"`
	wantTailSelf             = "; connect-src 'self'; report-to csp; report-uri /csp-report"
	wantTailSupa             = "; connect-src 'self' https://abc.supabase.co; report-to csp; report-uri /csp-report"
	emptyConfigJSON          = `{"supabase_url":"","supabase_anon_key":""}` + "\n"
)

// Enforced connect-src. supabaseConfig feeds both /config.json and the header,
// so each case pins the helper, the one exact enforcing policy with its
// connect-src part, the absent Report-Only header and the /config.json body
// byte for byte. The /config.json bodies are the output of the code before
// supabaseConfig existed (they pass on that code).
func TestCSPEnforcedConnectSrcTable(t *testing.T) {
	const key = "sb_publishable_k"
	cfg := func(u string) string {
		return `{"supabase_url":"` + u + `","supabase_anon_key":"` + key + `"}` + "\n"
	}
	for _, tc := range []struct {
		name, url, key           string
		wantURL, wantKey, origin string
		wantTail, wantCfg        string
	}{
		{"both unset", "", "", "", "", "", wantTailSelf, emptyConfigJSON},
		{"both set with a path", "https://abc.supabase.co/rest/v1?x=1#f", key,
			"https://abc.supabase.co/rest/v1?x=1#f", key, "https://abc.supabase.co", wantTailSupa, cfg("https://abc.supabase.co/rest/v1?x=1#f")},
		{"both set, padded with spaces", "  https://abc.supabase.co  ", " " + key + " ",
			"https://abc.supabase.co", key, "https://abc.supabase.co", wantTailSupa, cfg("https://abc.supabase.co")},
		{"only URL set", "https://abc.supabase.co", "", "", "", "", wantTailSelf, emptyConfigJSON},
		{"only key set", "", key, "", "", "", wantTailSelf, emptyConfigJSON},
		{"http URL", "http://abc.supabase.co", key, "http://abc.supabase.co", key, "", wantTailSelf, cfg("http://abc.supabase.co")},
		{"garbage URL", "not a url", key, "not a url", key, "", wantTailSelf, cfg("not a url")},
		{"unparseable URL", "https://%zz", key, "https://%zz", key, "", wantTailSelf, cfg("https://%zz")},
		{"space in the host", "https://abc .supabase.co", key, "https://abc .supabase.co", key, "", wantTailSelf, cfg("https://abc .supabase.co")},
		{"port", "https://abc.supabase.co:8443/x", key, "https://abc.supabase.co:8443/x", key, "https://abc.supabase.co:8443",
			"; connect-src 'self' https://abc.supabase.co:8443; report-to csp; report-uri /csp-report", cfg("https://abc.supabase.co:8443/x")},
		{"userinfo", "https://u:p@abc.supabase.co/", key, "https://u:p@abc.supabase.co/", key, "https://abc.supabase.co", wantTailSupa, cfg("https://u:p@abc.supabase.co/")},
		{"';' injection", "https://abc.supabase.co;script-src", key, "https://abc.supabase.co;script-src", key, "", wantTailSelf, cfg("https://abc.supabase.co;script-src")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SUPABASE_URL", tc.url)
			t.Setenv("SUPABASE_PUBLISHABLE_KEY", tc.key)
			gotURL, gotKey, gotOrigin := supabaseConfig()
			if gotURL != tc.wantURL || gotKey != tc.wantKey || gotOrigin != tc.origin {
				t.Errorf("supabaseConfig() = (%q, %q, %q), want (%q, %q, %q)", gotURL, gotKey, gotOrigin, tc.wantURL, tc.wantKey, tc.origin)
			}

			rec := httptest.NewRecorder()
			newMux().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("GET /: status = %d, want 200", rec.Code)
			}
			csp := rec.Header().Values(enforcingHeader)
			if len(csp) != 1 {
				t.Errorf("GET /: %s = %q, want exactly one policy", enforcingHeader, csp)
			} else if m := cspNonceRE.FindStringSubmatch(csp[0]); m == nil || csp[0] != wantPolicy(m[1], tc.wantTail) {
				t.Errorf("GET /: %s = %q, want the policy ending %q", enforcingHeader, csp[0], tc.wantTail)
			}
			if ro := rec.Header().Values(reportOnlyHeader); len(ro) != 0 {
				t.Errorf("GET /: %s = %q, want none", reportOnlyHeader, ro)
			}
			if got := rec.Header().Get(reportingEndpointsHeader); got != wantReportingEndpoints {
				t.Errorf("GET /: %s = %q, want %q", reportingEndpointsHeader, got, wantReportingEndpoints)
			}

			rec = httptest.NewRecorder()
			newMux().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/config.json", nil))
			if got := rec.Body.String(); got != tc.wantCfg {
				t.Errorf("GET /config.json body = %q, want %q", got, tc.wantCfg)
			}
		})
	}
}

// Never stored, so a cached copy cannot replay one nonce to every visitor.
func TestCSPIndexIsNoStore(t *testing.T) {
	for _, path := range []string{"/", "/index.html"} {
		rec := getRoot(t, path)
		if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
			t.Errorf("GET %s: Cache-Control = %q, want %q", path, cc, "no-store")
		}
	}
}

func TestCSPIndexFileMarksEveryScript(t *testing.T) {
	data, err := os.ReadFile("index.html")
	if err != nil {
		t.Fatal(err)
	}
	tags := scriptOpenRE.FindAll(data, -1)
	if len(tags) != wantScriptTags {
		t.Errorf("index.html: %d <script> tags, want %d", len(tags), wantScriptTags)
	}
	for _, tag := range tags {
		if !strings.Contains(string(tag), ` nonce="`+nonceMarkerText+`"`) {
			t.Errorf("index.html: tag %s has no nonce marker", tag)
		}
	}
}

// Fail closed: no nonce means no page and no policy, and the error must not
// be mistaken for the health answer the unreadable-file fallthrough gives.
func TestCSPRandFailureIs500(t *testing.T) {
	orig := nonceRandRead
	nonceRandRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
	defer func() { nonceRandRead = orig }()
	rec := getRoot(t, "/")
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("GET /: status = %d, want 500", rec.Code)
	}
	for _, name := range []string{reportOnlyHeader, enforcingHeader, reportingEndpointsHeader} {
		if got := rec.Header().Get(name); got != "" {
			t.Errorf("GET /: %s = %q, want none", name, got)
		}
	}
	body := rec.Body.String()
	if strings.Contains(body, "<script") {
		t.Errorf("GET /: body contains <script despite nonce failure")
	}
	if body == "ok" {
		t.Errorf("GET /: body = %q, the healthz answer: the nonce failure fell through", body)
	}
}

// A missing index is a broken image: a server error, never the health answer,
// and with no policy and no no-store (see root_test.go).
func TestCSPUnreadableIndexIs500WithoutPolicy(t *testing.T) {
	t.Chdir(t.TempDir()) // no index.html to read here
	for _, path := range []string{"/", "/index.html"} {
		rec := getRoot(t, path)
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("GET %s: status = %d, want 500", path, rec.Code)
		}
		if got := strings.TrimSpace(rec.Body.String()); got == "ok" {
			t.Errorf("GET %s: body = %q, the health answer", path, got)
		}
		if cc := rec.Header().Get("Cache-Control"); cc == "no-store" {
			t.Errorf("GET %s: Cache-Control = %q, want anything but %q", path, cc, "no-store")
		}
		for _, name := range []string{reportOnlyHeader, enforcingHeader, reportingEndpointsHeader} {
			if got := rec.Header().Get(name); got != "" {
				t.Errorf("GET %s: %s = %q, want none", path, name, got)
			}
		}
	}
}

func TestCSPOnlyOnTheIndexPage(t *testing.T) {
	for _, path := range []string{"/nope", "/config.json"} {
		rec := getRoot(t, path)
		for _, name := range []string{reportOnlyHeader, enforcingHeader, reportingEndpointsHeader} {
			if got := rec.Header().Get(name); got != "" {
				t.Errorf("GET %s: %s = %q, want none", path, name, got)
			}
		}
	}
}

// The web-builder stage copies Go files by name. A new .go file missing from
// that COPY line passes go test but breaks the image build (Praxvera CI,
// 2026-10-29). Every non-test .go file must be on the line.
func TestDockerfileCopiesEveryGoFile(t *testing.T) {
	df, err := os.ReadFile("Dockerfile")
	if err != nil {
		t.Fatalf("read Dockerfile: %v", err)
	}
	var copyLine string
	for _, l := range strings.Split(strings.ReplaceAll(string(df), "\r\n", "\n"), "\n") {
		if strings.HasPrefix(l, "COPY main.go ") {
			copyLine = l
		}
	}
	if copyLine == "" {
		t.Fatalf("Dockerfile has no `COPY main.go …` line")
	}
	files, err := filepath.Glob("*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("glob *.go: %v (%d files)", err, len(files))
	}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		if !strings.Contains(" "+copyLine+" ", " "+f+" ") {
			t.Errorf("Dockerfile COPY line %q is missing %s", copyLine, f)
		}
	}
}
