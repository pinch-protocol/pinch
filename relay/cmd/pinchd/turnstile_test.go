package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTurnstileVerifierSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.FormValue("secret") != "test-secret" {
			t.Errorf("unexpected secret: %q", r.FormValue("secret"))
		}
		if r.FormValue("response") != "valid-token" {
			t.Errorf("unexpected response token: %q", r.FormValue("response"))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"success": true})
	}))
	defer srv.Close()

	v := newTurnstileVerifier("test-secret")
	v.verifyURL = srv.URL

	ok, err := v.Verify("valid-token", "1.2.3.4")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("expected verification to succeed")
	}
}

func TestTurnstileVerifierFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"success": false})
	}))
	defer srv.Close()

	v := newTurnstileVerifier("test-secret")
	v.verifyURL = srv.URL

	ok, err := v.Verify("invalid-token", "1.2.3.4")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("expected verification to fail")
	}
}

func TestTurnstileVerifierNetworkError(t *testing.T) {
	v := newTurnstileVerifier("test-secret")
	v.verifyURL = "http://127.0.0.1:1" // unreachable port

	ok, err := v.Verify("some-token", "1.2.3.4")
	if err == nil {
		t.Fatal("expected network error")
	}
	if ok {
		t.Fatal("expected ok to be false on error")
	}
}

func TestTurnstileVerifierPassesRemoteIP(t *testing.T) {
	var gotIP string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotIP = r.FormValue("remoteip")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"success": true})
	}))
	defer srv.Close()

	v := newTurnstileVerifier("test-secret")
	v.verifyURL = srv.URL

	_, _ = v.Verify("token", "5.6.7.8")
	if gotIP != "5.6.7.8" {
		t.Fatalf("expected remoteip=5.6.7.8, got %q", gotIP)
	}
}
