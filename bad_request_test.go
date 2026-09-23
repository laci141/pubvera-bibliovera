package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

// missingCLI points both CLI binaries at a path that does not exist, so a
// request that gets past validation fails in runCLIRaw instead of running
// anything real.
func missingCLI(t *testing.T) {
	t.Helper()
	missing := filepath.Join(t.TempDir(), "no-such-cli")
	t.Setenv("CLI_BIN", missing)
	t.Setenv("RETRACTION_CHECKER_BIN", missing)
}

// callHandler drives a real handler and decodes the {"error": ...} body.
func callHandler(t *testing.T, h http.HandlerFunc, target string) (int, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	rec := httptest.NewRecorder()
	h(rec, req)
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("%s: body %q is not JSON: %v", target, rec.Body.String(), err)
	}
	return rec.Code, body.Error
}

type badRequestCase struct {
	name    string
	h       http.HandlerFunc
	target  string
	wantErr string
}

func runBadRequestCases(t *testing.T, cases []badRequestCase) {
	t.Helper()
	missingCLI(t)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, msg := callHandler(t, tc.h, tc.target)
			if code != http.StatusBadRequest {
				t.Errorf("%s: status %d, want 400", tc.target, code)
			}
			if msg != tc.wantErr {
				t.Errorf("%s: error %q, want %q", tc.target, msg, tc.wantErr)
			}
		})
	}
}

// TestOptIntRangeIsBadRequest covers every optInt parameter: a value outside
// its range is the client's mistake, so 400 with optInt's message unchanged.
func TestOptIntRangeIsBadRequest(t *testing.T) {
	runBadRequestCases(t, []badRequestCase{
		{"affiliations minPrior", handleAffiliations, "/affiliations?minPrior=21", "parameter must be between 0 and 20"},
		{"authors minWorks", handleAuthors, "/authors?minWorks=11", "parameter must be between 1 and 10"},
		{"authors limit", handleAuthors, "/authors?limit=501", "parameter must be between 1 and 500"},
		{"drift topN", handleDrift, "/drift?window1=2015:2019&window2=2020:2024&topN=41", "parameter must be between 1 and 40"},
		{"curate limit", handleCurate, "/curate?topic=malaria&limit=101", "parameter must be between 1 and 100"},
		{"mesh limit", handleMesh, "/mesh?org=Oxford&limit=0", "parameter must be between 1 and 500"},
	})
}

// TestIntFlagRangeIsBadRequest covers every intFlag parameter on /affiliations.
func TestIntFlagRangeIsBadRequest(t *testing.T) {
	runBadRequestCases(t, []badRequestCase{
		{"years", handleAffiliations, "/affiliations?years=101", "years must be between 1 and 100"},
		{"threshold", handleAffiliations, "/affiliations?threshold=1001", "threshold must be between 1 and 1000"},
		{"limit", handleAffiliations, "/affiliations?limit=501", "limit must be between 1 and 500"},
	})
}

// TestNonIntegerIsBadRequest covers the parse-error branch of both helpers.
func TestNonIntegerIsBadRequest(t *testing.T) {
	runBadRequestCases(t, []badRequestCase{
		{"optInt limit=abc", handleMesh, "/mesh?org=Oxford&limit=abc", "parameter must be an integer"},
		{"intFlag years=abc", handleAffiliations, "/affiliations?years=abc", "years must be an integer"},
	})
}

// TestMissingOrMalformedIsBadRequest covers the four required/malformed
// parameter checks written directly in the handlers.
func TestMissingOrMalformedIsBadRequest(t *testing.T) {
	runBadRequestCases(t, []badRequestCase{
		{"missing topic", handleCurate, "/curate", "topic parameter required"},
		{"missing org", handleMesh, "/mesh", "org parameter required"},
		{"missing doi and pmid", handleCheck, "/check", "doi or pmid parameter required"},
		{"malformed window1", handleDrift, "/drift?window1=2015-2019&window2=2020:2024", "window1 and window2 must be YYYY:YYYY (e.g. 2015:2019)"},
	})
}

// TestMeshLimitAboveCeilingIsBadRequest is the production report exactly:
// /mesh?org=Oxford&limit=501 answered 502 for a value Go itself rejected.
func TestMeshLimitAboveCeilingIsBadRequest(t *testing.T) {
	missingCLI(t)
	req := httptest.NewRequest(http.MethodGet, "/mesh?org=Oxford&limit=501", nil)
	rec := httptest.NewRecorder()
	handleMesh(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status %d, want 400", rec.Code)
	}
	const want = `{"error":"parameter must be between 1 and 500"}` + "\n"
	if got := rec.Body.String(); got != want {
		t.Errorf("body %q, want %q", got, want)
	}
}

// TestUpstreamFailureStaysBadGateway is the control: every parameter is valid,
// so validation passes and the missing binary fails in runCLIRaw. That is an
// upstream failure and must still be 502 — otherwise the 400s above could be
// passing only because writeErr stopped returning 502 at all.
func TestUpstreamFailureStaysBadGateway(t *testing.T) {
	missingCLI(t)
	code, msg := callHandler(t, handleMesh, "/mesh?org=Oxford&limit=25")
	if code != http.StatusBadGateway {
		t.Errorf("status %d (%q), want 502", code, msg)
	}
	if msg == "" {
		t.Error("502 body carries no error message")
	}
}
