package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// getMeshWithLimit drives the real handleMesh with an explicit limit, the same
// way getMesh in semaphore_test.go drives it with only an org.
func getMeshWithLimit(t *testing.T, limit string) (int, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/mesh?org=Oxford&limit="+limit, nil)
	rec := httptest.NewRecorder()
	handleMesh(rec, req)
	return rec.Code, rec.Body.String()
}

// stubRuns counts how many times the stub CLI started, using the same S/E
// marker log buildConcurrencyStubCLI already writes. A rejected limit must
// never reach the child process at all.
func stubRuns(t *testing.T, logPath string) int {
	t.Helper()
	raw, err := os.ReadFile(logPath)
	if err != nil {
		if os.IsNotExist(err) {
			return 0
		}
		t.Fatalf("read stub log: %v", err)
	}
	n := 0
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "S" {
			n++
		}
	}
	return n
}

// TestMeshLimitCeiling pins the ceiling /mesh offers. optInt rejects rather
// than clamps, so the max is the only thing standing between the UI and the
// 500-pair network the CLI already returns.
func TestMeshLimitCeiling(t *testing.T) {
	if maxMeshPairs != 500 {
		t.Errorf("maxMeshPairs = %d, want 500", maxMeshPairs)
	}

	logPath := filepath.Join(t.TempDir(), "mesh.log")
	buildConcurrencyStubCLI(t, logPath, 0)

	wantErr := fmt.Sprintf("parameter must be between 1 and %d", maxMeshPairs)

	cases := []struct {
		name    string
		limit   string
		accept  bool
		wantRun int
	}{
		// One over the ceiling: rejected by optInt, and no CLI run.
		{"above the ceiling", "501", false, 0},
		// The ceiling itself: accepted, and the CLI is invoked.
		{"at the ceiling", "500", true, 1},
		// The minimum did not move with the maximum.
		{"below the minimum", "0", false, 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := stubRuns(t, logPath)
			code, body := getMeshWithLimit(t, tc.limit)
			runs := stubRuns(t, logPath) - before

			if tc.accept {
				if code != http.StatusOK {
					t.Fatalf("limit=%s got %d (%s), want 200", tc.limit, code, strings.TrimSpace(body))
				}
			} else {
				if code == http.StatusOK {
					t.Fatalf("limit=%s got 200, want the optInt rejection", tc.limit)
				}
				if !strings.Contains(body, wantErr) {
					t.Errorf("limit=%s body = %q, want it to contain %q", tc.limit, strings.TrimSpace(body), wantErr)
				}
			}
			if runs != tc.wantRun {
				t.Errorf("limit=%s ran the CLI %d time(s), want %d", tc.limit, runs, tc.wantRun)
			}
		})
	}
}
