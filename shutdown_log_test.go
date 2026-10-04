package main

import (
	"bytes"
	"context"
	"log"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// The "signal received" line must be written by serveUntil before it returns.
// When main logged it from its own goroutine, an idle server finished
// draining first and the log read "shutdown complete" before "signal received".
func TestServeUntilLogsSignalBeforeReturning(t *testing.T) {
	var buf bytes.Buffer
	prevOut, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := &http.Server{Handler: http.NewServeMux()}
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() { done <- serveUntil(ctx, srv, func() error { return srv.Serve(ln) }, time.Second) }()
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveUntil returned %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serveUntil did not return within 5s")
	}

	if !strings.Contains(buf.String(), "shutdown: signal received") {
		t.Fatalf("log before return = %q, want the signal line", buf.String())
	}
}
