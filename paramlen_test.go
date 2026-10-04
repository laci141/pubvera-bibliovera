package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

// TestTextParamLengthLimits pins the per-field length limits (audit BUG-09).
// A value of exactly the limit must reach the stub CLI; one character more
// must get 400 and never start the CLI. Limits count characters, not bytes.
func TestTextParamLengthLimits(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "paramlen.log")
	buildConcurrencyStubCLI(t, logPath, 0)
	t.Setenv("RETRACTION_CHECKER_BIN", cliBinaryPath())

	cases := []struct {
		name   string
		h      http.HandlerFunc
		path   string
		static string // fixed query part, already encoded
		param  string
		max    int
		fill   string // one character; "é" is two bytes
	}{
		{"affiliations journal", handleAffiliations, "/affiliations", "", "journal", 100, "a"},
		{"authors institution", handleAuthors, "/authors", "", "institution", 200, "a"},
		{"authors journal", handleAuthors, "/authors", "", "journal", 100, "a"},
		{"drift journal", handleDrift, "/drift", "window1=2015:2019&window2=2020:2024", "journal", 100, "a"},
		{"curate topic", handleCurate, "/curate", "", "topic", 200, "a"},
		{"curate topic multibyte", handleCurate, "/curate", "", "topic", 200, "é"},
		{"curate journal", handleCurate, "/curate", "topic=malaria", "journal", 100, "a"},
		{"mesh org", handleMesh, "/mesh", "", "org", 200, "a"},
		{"check doi", handleCheck, "/check", "", "doi", 300, "a"},
		{"check pmid", handleCheck, "/check", "", "pmid", 20, "1"},
	}

	for _, tc := range cases {
		target := func(n int) string {
			q := url.Values{tc.param: {strings.Repeat(tc.fill, n)}}.Encode()
			if tc.static != "" {
				q = tc.static + "&" + q
			}
			return tc.path + "?" + q
		}
		t.Run(tc.name+" at limit", func(t *testing.T) {
			before := stubRuns(t, logPath)
			rec := httptest.NewRecorder()
			tc.h(rec, httptest.NewRequest(http.MethodGet, target(tc.max), nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("%d chars: got %d (%s), want 200", tc.max, rec.Code, strings.TrimSpace(rec.Body.String()))
			}
			if runs := stubRuns(t, logPath) - before; runs != 1 {
				t.Errorf("ran the CLI %d time(s), want 1", runs)
			}
		})
		t.Run(tc.name+" over limit", func(t *testing.T) {
			before := stubRuns(t, logPath)
			code, msg := callHandler(t, tc.h, target(tc.max+1))
			want := fmt.Sprintf("%s is too long (max %d characters)", tc.param, tc.max)
			if code != http.StatusBadRequest {
				t.Errorf("%d chars: status %d, want 400", tc.max+1, code)
			}
			if msg != want {
				t.Errorf("error %q, want %q", msg, want)
			}
			if runs := stubRuns(t, logPath) - before; runs != 0 {
				t.Errorf("ran the CLI %d time(s), want 0", runs)
			}
		})
	}
}
