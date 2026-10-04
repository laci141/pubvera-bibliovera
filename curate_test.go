package main

import (
	"encoding/json"
	"net/http"
	"slices"
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

func TestCurateUnknownSortIsBadRequest(t *testing.T) {
	useFakeCLI(t, "args")
	rec := serve(handleCurate, "/curate?topic=malaria&sort=bogus")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400; body %q", rec.Code, rec.Body.String())
	}
}
