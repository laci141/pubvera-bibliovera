package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The index page must be revalidated on every load, so a deploy is visible
// immediately instead of whenever a browser's heuristic cache expires. Without
// a Cache-Control header neither Caddy nor Cloudflare adds one.
//
// main() builds its mux inline and registers handleRoot as the "/" catch-all,
// so handleRoot is the route table for every path tested here.

func getRoot(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	handleRoot(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func TestIndexIsRevalidatedOnEveryLoad(t *testing.T) {
	for _, path := range []string{"/", "/index.html"} {
		rec := getRoot(t, path)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: status = %d, want 200", path, rec.Code)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
			t.Errorf("GET %s: Cache-Control = %q, want %q", path, cc, "no-cache")
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Errorf("GET %s: Content-Type = %q, want text/html", path, ct)
		}
	}
}

func TestConfigStaysNoStore(t *testing.T) {
	rec := getRoot(t, "/config.json")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /config.json: status = %d, want 200", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("GET /config.json: Cache-Control = %q, want %q", cc, "no-store")
	}
}

func TestUnknownPathIs404(t *testing.T) {
	if rec := getRoot(t, "/nope"); rec.Code != http.StatusNotFound {
		t.Errorf("GET /nope: status = %d, want 404", rec.Code)
	}
}
