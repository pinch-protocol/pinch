package hub_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/pinch-protocol/pinch/relay/internal/hub"
)

// newTestServer creates an httptest.Server with a chi router wired
// to a hub for WebSocket testing. Returns the server and hub.
func newTestServer(t *testing.T, ctx context.Context) (*httptest.Server, *hub.Hub) {
	t.Helper()

	h := hub.NewHub()
	go h.Run(ctx)

	r := chi.NewRouter()
	r.Get("/ws", func(w http.ResponseWriter, r *http.Request) {
		address := r.URL.Query().Get("address")
		if address == "" {
			http.Error(w, "missing address", http.StatusBadRequest)
			return
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true,
		})
		if err != nil {
			t.Logf("websocket accept error: %v", err)
			return
		}
		client := hub.NewClient(h, conn, address, nil, ctx)
		h.Register(client)
		go client.ReadPump()
		go client.WritePump()
		go client.HeartbeatLoop()
	})
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		status := map[string]int{
			"goroutines":  runtime.NumGoroutine(),
			"connections": h.ClientCount(),
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(status)
	})

	srv := httptest.NewServer(r)
	t.Cleanup(func() { srv.Close() })
	return srv, h
}

// wsURL converts an httptest.Server URL to a WebSocket URL with address param.
func wsURL(srv *httptest.Server, address string) string {
	return "ws" + srv.URL[len("http"):] + "/ws?address=" + address
}

// dialWS connects to the test server's WebSocket endpoint.
func dialWS(ctx context.Context, srv *httptest.Server, address string) (*websocket.Conn, error) {
	conn, _, err := websocket.Dial(ctx, wsURL(srv, address), nil)
	return conn, err
}

// waitForClientCount polls the hub until it has the expected count
// or the timeout expires.
func waitForClientCount(t *testing.T, h *hub.Hub, expected int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if h.ClientCount() == expected {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected %d clients, got %d (after %v)", expected, h.ClientCount(), timeout)
}

func TestHubRegisterUnregister(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h := newTestServer(t, ctx)

	// Connect a client.
	conn, err := dialWS(ctx, srv, "pinch:test1@localhost")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	// Wait for registration.
	waitForClientCount(t, h, 1, 2*time.Second)

	// Verify client is in the routing table.
	client, ok := h.LookupClient("pinch:test1@localhost")
	if !ok {
		t.Fatal("expected client to be in routing table")
	}
	if client.Address() != "pinch:test1@localhost" {
		t.Fatalf("expected address pinch:test1@localhost, got %s", client.Address())
	}

	// Close the connection to trigger unregistration.
	conn.Close(websocket.StatusNormalClosure, "done")

	// Wait for unregistration.
	waitForClientCount(t, h, 0, 2*time.Second)

	// Verify client is removed from routing table.
	_, ok = h.LookupClient("pinch:test1@localhost")
	if ok {
		t.Fatal("expected client to be removed from routing table")
	}
}

func TestHubLookup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h := newTestServer(t, ctx)

	// Connect two clients with different addresses.
	conn1, err := dialWS(ctx, srv, "pinch:alice@localhost")
	if err != nil {
		t.Fatalf("dial alice: %v", err)
	}
	defer conn1.Close(websocket.StatusNormalClosure, "done")

	conn2, err := dialWS(ctx, srv, "pinch:bob@localhost")
	if err != nil {
		t.Fatalf("dial bob: %v", err)
	}
	defer conn2.Close(websocket.StatusNormalClosure, "done")

	waitForClientCount(t, h, 2, 2*time.Second)

	// Lookup alice.
	c, ok := h.LookupClient("pinch:alice@localhost")
	if !ok {
		t.Fatal("expected alice in routing table")
	}
	if c.Address() != "pinch:alice@localhost" {
		t.Fatalf("expected alice, got %s", c.Address())
	}

	// Lookup bob.
	c, ok = h.LookupClient("pinch:bob@localhost")
	if !ok {
		t.Fatal("expected bob in routing table")
	}
	if c.Address() != "pinch:bob@localhost" {
		t.Fatalf("expected bob, got %s", c.Address())
	}

	// Lookup unknown address returns false.
	_, ok = h.LookupClient("pinch:unknown@localhost")
	if ok {
		t.Fatal("expected unknown address to not be found")
	}
}

func TestGoroutineLeakOnDisconnect(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h := newTestServer(t, ctx)

	// Force GC and get baseline goroutine count.
	runtime.GC()
	time.Sleep(50 * time.Millisecond)
	baseline := runtime.NumGoroutine()

	const clientCount = 10
	conns := make([]*websocket.Conn, clientCount)

	// Connect N clients.
	for i := 0; i < clientCount; i++ {
		addr := fmt.Sprintf("pinch:leak-test-%d@localhost", i)
		conn, err := dialWS(ctx, srv, addr)
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		conns[i] = conn
	}

	waitForClientCount(t, h, clientCount, 3*time.Second)

	// Abruptly close all connections (simulating disconnect).
	for _, conn := range conns {
		conn.Close(websocket.StatusGoingAway, "test disconnect")
	}

	// Wait for all clients to unregister.
	waitForClientCount(t, h, 0, 5*time.Second)

	// Give goroutines time to fully exit.
	time.Sleep(200 * time.Millisecond)
	runtime.GC()
	time.Sleep(100 * time.Millisecond)

	current := runtime.NumGoroutine()
	// Allow a small margin (2) for background goroutines.
	if current > baseline+2 {
		t.Fatalf("goroutine leak: baseline=%d, current=%d (delta=%d, max allowed=2)",
			baseline, current, current-baseline)
	}
}

func TestGracefulShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	srv, h := newTestServer(t, ctx)

	const clientCount = 5
	conns := make([]*websocket.Conn, clientCount)

	// Connect clients.
	for i := 0; i < clientCount; i++ {
		addr := fmt.Sprintf("pinch:shutdown-%d@localhost", i)
		conn, err := dialWS(ctx, srv, addr)
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		conns[i] = conn
	}

	waitForClientCount(t, h, clientCount, 3*time.Second)

	// Cancel the server context to trigger graceful shutdown.
	cancel()

	// Wait for all clients to disconnect.
	waitForClientCount(t, h, 0, 5*time.Second)

	// Verify connections are closed from the client side.
	for i, conn := range conns {
		readCtx, readCancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, _, err := conn.Read(readCtx)
		readCancel()
		if err == nil {
			t.Fatalf("client %d: expected read error after shutdown, got nil", i)
		}
	}
}

func TestHealthEndpoint(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h := newTestServer(t, ctx)

	// Check health with no connections.
	resp, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatalf("health request: %v", err)
	}
	defer resp.Body.Close()

	var status map[string]int
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		t.Fatalf("decode health: %v", err)
	}
	if status["connections"] != 0 {
		t.Fatalf("expected 0 connections, got %d", status["connections"])
	}
	if status["goroutines"] <= 0 {
		t.Fatal("expected positive goroutine count")
	}

	// Connect a client and check again.
	conn, err := dialWS(ctx, srv, "pinch:health-test@localhost")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "done")

	waitForClientCount(t, h, 1, 2*time.Second)

	resp2, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatalf("health request 2: %v", err)
	}
	defer resp2.Body.Close()

	var status2 map[string]int
	if err := json.NewDecoder(resp2.Body).Decode(&status2); err != nil {
		t.Fatalf("decode health 2: %v", err)
	}
	if status2["connections"] != 1 {
		t.Fatalf("expected 1 connection, got %d", status2["connections"])
	}
}

func TestConcurrentRegisterUnregister(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h := newTestServer(t, ctx)

	const clientCount = 20
	var wg sync.WaitGroup
	wg.Add(clientCount)

	// Connect many clients concurrently.
	for i := 0; i < clientCount; i++ {
		go func(i int) {
			defer wg.Done()
			addr := fmt.Sprintf("pinch:concurrent-%d@localhost", i)
			conn, err := dialWS(ctx, srv, addr)
			if err != nil {
				t.Errorf("dial %d: %v", i, err)
				return
			}
			// Hold connection briefly, then disconnect.
			time.Sleep(100 * time.Millisecond)
			conn.Close(websocket.StatusNormalClosure, "done")
		}(i)
	}

	wg.Wait()

	// Wait for all to unregister.
	waitForClientCount(t, h, 0, 5*time.Second)

	// Verify routing table is clean.
	if h.ClientCount() != 0 {
		t.Fatalf("expected 0 clients after concurrent test, got %d", h.ClientCount())
	}
}
