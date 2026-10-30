package main

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// CSP phase 1: every <script> tag in index.html carries nonce="__CSP_NONCE__",
// and each index response replaces that marker with a fresh nonce named in the
// Content-Security-Policy-Report-Only header. All requests go through
// handleRoot in-process (httptest), like root_cache_test.go.

// wantPolicy is written out here rather than taken from contentSecurityPolicy,
// so a change to any directive in csp.go fails a test.
func wantPolicy(nonce string) string {
	return "script-src 'nonce-" + nonce + "' 'strict-dynamic' https: 'unsafe-inline'; script-src-attr 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
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
	csp := rec.Header().Get(reportOnlyHeader)
	m := cspNonceRE.FindStringSubmatch(csp)
	if m == nil {
		t.Fatalf("GET %s: %s = %q, want a policy with a 22-character nonce", path, reportOnlyHeader, csp)
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

func TestCSPHeaderIsReportOnlyWithExactPolicy(t *testing.T) {
	nonce, _, h := indexNonce(t, "/")
	if got := h.Get(reportOnlyHeader); got != wantPolicy(nonce) {
		t.Errorf("%s = %q, want %q", reportOnlyHeader, got, wantPolicy(nonce))
	}
	if cspHeaderName != reportOnlyHeader {
		t.Errorf("cspHeaderName = %q, want %q", cspHeaderName, reportOnlyHeader)
	}
}

// TestCSPIndexSendsOnlyTheReportOnlyHeader does not use indexNonce, so a
// missing Report-Only header does not hide the enforcing-header check.
func TestCSPIndexSendsOnlyTheReportOnlyHeader(t *testing.T) {
	rec := getRoot(t, "/")
	if got := rec.Header().Get(reportOnlyHeader); got == "" {
		t.Errorf("GET /: %s = %q, want a policy", reportOnlyHeader, got)
	}
	if got := rec.Header().Get(enforcingHeader); got != "" {
		t.Errorf("GET /: %s = %q, want none: phase 1 blocks nothing", enforcingHeader, got)
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
	for _, name := range []string{reportOnlyHeader, enforcingHeader} {
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
		for _, name := range []string{reportOnlyHeader, enforcingHeader} {
			if got := rec.Header().Get(name); got != "" {
				t.Errorf("GET %s: %s = %q, want none", path, name, got)
			}
		}
	}
}

func TestCSPOnlyOnTheIndexPage(t *testing.T) {
	for _, path := range []string{"/nope", "/config.json"} {
		rec := getRoot(t, path)
		for _, name := range []string{reportOnlyHeader, enforcingHeader} {
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
