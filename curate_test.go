package main

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
)

// curateArgs drives handleCurate against the arg-echo fake CLI and returns the
// arguments the handler passed to it.
func curateArgs(t *testing.T, target string) []string {
	t.Helper()
	useFakeCLI(t, "args")
	rec := serve(handleCurate, target)
	if rec.Code != http.StatusOK {
		t.Fatalf("%s: status %d, body %q", target, rec.Code, rec.Body.String())
	}
	var args []string
	if err := json.Unmarshal(rec.Body.Bytes(), &args); err != nil {
		t.Fatalf("%s: body is not the echoed args: %v", target, err)
	}
	return args
}

func hasPair(args []string, flag, val string) bool {
	i := slices.Index(args, flag)
	return i >= 0 && i+1 < len(args) && args[i+1] == val
}

func TestCurateSortPerYearIsForwarded(t *testing.T) {
	args := curateArgs(t, "/curate?topic=malaria&sort=per-year")
	if !hasPair(args, "--sort", "per-year") {
		t.Fatalf("args %v: want --sort per-year", args)
	}
}

func TestCurateAlwaysPassesLocalDataSource(t *testing.T) {
	for _, target := range []string{
		"/curate?topic=malaria",
		"/curate?topic=malaria&sort=citations",
		"/curate?topic=malaria&sort=date",
		"/curate?topic=malaria&sort=per-year",
	} {
		args := curateArgs(t, target)
		if !hasPair(args, "--data-source", "local") {
			t.Errorf("%s: args %v: want --data-source local", target, args)
		}
	}
}

// velocityBody is the envelope /curate answers with for sort=velocity.
type velocityBody struct {
	Rows         []map[string]any `json:"rows"`
	Sort         string           `json:"sort"`
	SortFallback string           `json:"sort_fallback"`
	Notice       string           `json:"notice"`
}

func curateVelocity(t *testing.T, vel string) (int, velocityBody) {
	t.Helper()
	useFakeCLI(t, "curate")
	t.Setenv("FAKE_CURATE_VEL", vel)
	rec := serve(handleCurate, "/curate?topic=malaria&sort=velocity")
	var b velocityBody
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
			t.Fatalf("body is not the velocity envelope: %v; %q", err, rec.Body.String())
		}
	}
	return rec.Code, b
}

func TestCurateSortVelocityIsAcceptedAndForwarded(t *testing.T) {
	useFakeCLI(t, "args")
	rec := serve(handleCurate, "/curate?topic=malaria&sort=velocity")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200; body %q", rec.Code, rec.Body.String())
	}
	var b struct {
		Rows []string `json:"rows"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatalf("body: %v; %q", err, rec.Body.String())
	}
	if !hasPair(b.Rows, "--sort", "velocity") || !hasPair(b.Rows, "--data-source", "local") {
		t.Fatalf("args %v: want --sort velocity --data-source local", b.Rows)
	}
}

func TestCurateVelocityFallsBackToPerYearOnRefreshHint(t *testing.T) {
	code, b := curateVelocity(t, "refresh")
	if code != http.StatusOK {
		t.Fatalf("status %d, want 200 via fallback", code)
	}
	if b.SortFallback != "per-year" {
		t.Errorf("sort_fallback = %q, want per-year", b.SortFallback)
	}
	if b.Notice == "" {
		t.Error("notice is empty, want a short text for the UI")
	}
	if len(b.Rows) != 1 || b.Rows[0]["doi"] != "10.1/per-year" {
		t.Errorf("rows = %v, want the per-year row", b.Rows)
	}
}

func TestCurateVelocityOtherFailureDoesNotFallBack(t *testing.T) {
	code, _ := curateVelocity(t, "fail")
	if code != http.StatusBadGateway {
		t.Fatalf("status %d, want 502 (no fallback for an unrelated CLI failure)", code)
	}
}

func TestCurateVelocityUnsyncedLineBecomesNotice(t *testing.T) {
	code, b := curateVelocity(t, "partial")
	if code != http.StatusOK {
		t.Fatalf("status %d, want 200", code)
	}
	if b.SortFallback != "" {
		t.Errorf("sort_fallback = %q, want none: velocity worked", b.SortFallback)
	}
	if !strings.Contains(b.Notice, "4683 of 7997") || !strings.Contains(b.Notice, "no current yearly citation counts") {
		t.Errorf("notice = %q, want the N of M line", b.Notice)
	}
	if len(b.Rows) != 2 || b.Rows[1]["velocity"] != nil {
		t.Errorf("rows = %v, want both rows with the null velocity last", b.Rows)
	}
}

func TestCurateVelocityWithoutStderrHasNoNotice(t *testing.T) {
	code, b := curateVelocity(t, "rows")
	if code != http.StatusOK || b.Notice != "" || b.SortFallback != "" {
		t.Fatalf("status %d notice %q fallback %q, want 200 and neither", code, b.Notice, b.SortFallback)
	}
}

func TestCurateUnknownSortIsBadRequest(t *testing.T) {
	useFakeCLI(t, "args")
	rec := serve(handleCurate, "/curate?topic=malaria&sort=bogus")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400; body %q", rec.Code, rec.Body.String())
	}
}
