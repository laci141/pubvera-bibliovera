package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

const shutdownTestWait = 5 * time.Second

func startServeUntil(t *testing.T, h http.Handler, grace time.Duration) (addr string, cancel context.CancelFunc, done chan error) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h}
	ctx, cancel := context.WithCancel(context.Background())
	done = make(chan error, 1)
	go func() { done <- serveUntil(ctx, srv, func() error { return srv.Serve(ln) }, grace) }()
	return ln.Addr().String(), cancel, done
}

func TestShutdownInFlightRequestFinishes(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	addr, cancel, done := startServeUntil(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		_, _ = w.Write([]byte("full body"))
	}), 5*time.Second)
	defer cancel()

	type result struct {
		code int
		body string
		err  error
	}
	resCh := make(chan result, 1)
	go func() {
		resp, err := http.Get("http://" + addr + "/")
		if err != nil {
			resCh <- result{err: err}
			return
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		resCh <- result{resp.StatusCode, string(b), err}
	}()

	select {
	case <-started:
	case <-time.After(shutdownTestWait):
		t.Fatal("handler never started")
	}
	cancel()
	time.Sleep(100 * time.Millisecond)
	close(release)

	select {
	case r := <-resCh:
		if r.err != nil || r.code != 200 || r.body != "full body" {
			t.Fatalf("got code=%d body=%q err=%v", r.code, r.body, r.err)
		}
	case <-time.After(shutdownTestWait):
		t.Fatal("client got no response")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveUntil = %v, want nil", err)
		}
	case <-time.After(shutdownTestWait):
		t.Fatal("serveUntil did not return")
	}
}

func TestShutdownRefusesNewConnections(t *testing.T) {
	addr, cancel, done := startServeUntil(t, http.NewServeMux(), time.Second)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveUntil = %v, want nil", err)
		}
	case <-time.After(shutdownTestWait):
		t.Fatal("serveUntil did not return")
	}
	if c, err := net.DialTimeout("tcp", addr, time.Second); err == nil {
		c.Close()
		t.Fatal("connection accepted after shutdown")
	}
}

func TestShutdownGraceExpiry(t *testing.T) {
	started := make(chan struct{})
	block := make(chan struct{})
	defer close(block)
	addr, cancel, done := startServeUntil(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-block
	}), 100*time.Millisecond)
	defer cancel()

	go func() {
		resp, err := http.Get("http://" + addr + "/")
		if err == nil {
			resp.Body.Close()
		}
	}()
	select {
	case <-started:
	case <-time.After(shutdownTestWait):
		t.Fatal("handler never started")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("serveUntil = %v, want context.DeadlineExceeded", err)
		}
	case <-time.After(shutdownTestWait):
		t.Fatal("serveUntil did not return after grace expiry")
	}
}

func TestShutdownListenErrorReturned(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln.Close()
	srv := &http.Server{}
	done := make(chan error, 1)
	go func() {
		done <- serveUntil(context.Background(), srv, func() error { return srv.Serve(ln) }, time.Second)
	}()
	select {
	case err := <-done:
		if err == nil || errors.Is(err, http.ErrServerClosed) {
			t.Fatalf("serveUntil = %v, want the listen error", err)
		}
	case <-time.After(shutdownTestWait):
		t.Fatal("serveUntil did not return")
	}
}
