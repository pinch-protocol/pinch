package main

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestSendAuthFailureLogsWriteError(t *testing.T) {
	serverConnCh := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true,
		})
		if err != nil {
			t.Errorf("websocket accept failed: %v", err)
			return
		}
		serverConnCh <- conn
	}))
	t.Cleanup(func() { srv.Close() })

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	clientConn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatalf("websocket dial failed: %v", err)
	}
	t.Cleanup(func() {
		_ = clientConn.Close(websocket.StatusNormalClosure, "done")
	})

	var serverConn *websocket.Conn
	select {
	case serverConn = <-serverConnCh:
	case <-time.After(time.Second):
	}
	if serverConn == nil {
		t.Fatal("did not receive server-side websocket connection")
	}
	t.Cleanup(func() {
		_ = serverConn.Close(websocket.StatusNormalClosure, "done")
	})

	var logBuf bytes.Buffer
	prevLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	})))
	t.Cleanup(func() {
		slog.SetDefault(prevLogger)
	})

	writeCtx, cancel := context.WithCancel(context.Background())
	cancel()

	sendAuthFailure(writeCtx, serverConn, "expected failure")

	if !strings.Contains(logBuf.String(), "failed to send auth failure message") {
		t.Fatalf("expected debug log for auth failure write error, got logs: %s", logBuf.String())
	}
}
