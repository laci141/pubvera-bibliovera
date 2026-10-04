package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The tests run from the module directory, where index.html exists.
func TestRootServesIndexHTML(t *testing.T) {
	rec := httptest.NewRecorder()
	handleRoot(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type %q, want text/html", ct)
	}
}

// A missing index.html is a broken image. Answering 200 "ok" hid that from
// anything that checks "/"; it must be a server error instead.
func TestRootMissingIndexIsServerError(t *testing.T) {
	t.Chdir(t.TempDir())
	rec := httptest.NewRecorder()
	handleRoot(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) == "ok" {
		t.Fatalf(`body "ok" would look healthy`)
	}
}
