package hub_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	pinchv1 "github.com/pinch-protocol/pinch/gen/go/pinch/v1"
	"github.com/pinch-protocol/pinch/relay/internal/hub"
	"github.com/pinch-protocol/pinch/relay/internal/store"
	"google.golang.org/protobuf/proto"
)

// newTestServer creates an httptest.Server with a chi router wired
// to a hub for WebSocket testing. Returns the server and hub.
func newTestServer(t *testing.T, ctx context.Context) (*httptest.Server, *hub.Hub) {
	t.Helper()

	h := hub.NewHub(nil)
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

// newTestServerWithBlockStore creates a test server backed by a real bbolt
// block store for routing and block enforcement tests.
func newTestServerWithBlockStore(t *testing.T, ctx context.Context) (*httptest.Server, *hub.Hub, *store.BlockStore) {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "test-blocks.db")
	bs, err := store.NewBlockStore(dbPath)
	if err != nil {
		t.Fatalf("NewBlockStore: %v", err)
	}
	t.Cleanup(func() { bs.Close() })

	h := hub.NewHub(bs)
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

	srv := httptest.NewServer(r)
	t.Cleanup(func() { srv.Close() })
	return srv, h, bs
}

// makeEnvelope creates a protobuf-serialized Envelope for testing.
func makeEnvelope(t *testing.T, msgType pinchv1.MessageType, from, to string, payload interface{}) []byte {
	t.Helper()
	env := &pinchv1.Envelope{
		Version:     1,
		FromAddress: from,
		ToAddress:   to,
		Type:        msgType,
	}
	switch p := payload.(type) {
	case *pinchv1.BlockNotification:
		env.Payload = &pinchv1.Envelope_BlockNotification{BlockNotification: p}
	case *pinchv1.UnblockNotification:
		env.Payload = &pinchv1.Envelope_UnblockNotification{UnblockNotification: p}
	}
	data, err := proto.Marshal(env)
	if err != nil {
		t.Fatalf("proto.Marshal: %v", err)
	}
	return data
}

func TestRouteMessageDeliversToRecipient(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h, _ := newTestServerWithBlockStore(t, ctx)

	// Connect alice and bob.
	aliceConn, err := dialWS(ctx, srv, "pinch:alice@localhost")
	if err != nil {
		t.Fatalf("dial alice: %v", err)
	}
	defer aliceConn.Close(websocket.StatusNormalClosure, "done")

	bobConn, err := dialWS(ctx, srv, "pinch:bob@localhost")
	if err != nil {
		t.Fatalf("dial bob: %v", err)
	}
	defer bobConn.Close(websocket.StatusNormalClosure, "done")

	waitForClientCount(t, h, 2, 2*time.Second)

	// Alice sends a message to Bob.
	msg := makeEnvelope(t, pinchv1.MessageType_MESSAGE_TYPE_MESSAGE, "pinch:alice@localhost", "pinch:bob@localhost", nil)
	writeCtx, writeCancel := context.WithTimeout(ctx, 2*time.Second)
	err = aliceConn.Write(writeCtx, websocket.MessageBinary, msg)
	writeCancel()
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	// Bob should receive the message.
	readCtx, readCancel := context.WithTimeout(ctx, 2*time.Second)
	_, data, err := bobConn.Read(readCtx)
	readCancel()
	if err != nil {
		t.Fatalf("bob read: %v", err)
	}

	var received pinchv1.Envelope
	if err := proto.Unmarshal(data, &received); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if received.FromAddress != "pinch:alice@localhost" {
		t.Fatalf("expected from alice, got %s", received.FromAddress)
	}
	if received.ToAddress != "pinch:bob@localhost" {
		t.Fatalf("expected to bob, got %s", received.ToAddress)
	}
}

func TestRouteMessageSilentDropOfflineRecipient(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h, _ := newTestServerWithBlockStore(t, ctx)

	// Connect only alice.
	aliceConn, err := dialWS(ctx, srv, "pinch:alice@localhost")
	if err != nil {
		t.Fatalf("dial alice: %v", err)
	}
	defer aliceConn.Close(websocket.StatusNormalClosure, "done")

	waitForClientCount(t, h, 1, 2*time.Second)

	// Alice sends a message to offline bob -- should not error.
	msg := makeEnvelope(t, pinchv1.MessageType_MESSAGE_TYPE_MESSAGE, "pinch:alice@localhost", "pinch:bob@localhost", nil)
	writeCtx, writeCancel := context.WithTimeout(ctx, 2*time.Second)
	err = aliceConn.Write(writeCtx, websocket.MessageBinary, msg)
	writeCancel()
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	// Give time for routing (message should be silently dropped).
	time.Sleep(100 * time.Millisecond)

	// Alice should not receive any error indication -- connection stays open.
	if h.ClientCount() != 1 {
		t.Fatal("expected alice to remain connected")
	}
}

func TestRouteMessageBlockedSenderSilentDrop(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h, bs := newTestServerWithBlockStore(t, ctx)

	// Connect alice and bob.
	aliceConn, err := dialWS(ctx, srv, "pinch:alice@localhost")
	if err != nil {
		t.Fatalf("dial alice: %v", err)
	}
	defer aliceConn.Close(websocket.StatusNormalClosure, "done")

	bobConn, err := dialWS(ctx, srv, "pinch:bob@localhost")
	if err != nil {
		t.Fatalf("dial bob: %v", err)
	}
	defer bobConn.Close(websocket.StatusNormalClosure, "done")

	waitForClientCount(t, h, 2, 2*time.Second)

	// Bob blocks Alice at the store level.
	if err := bs.Block("pinch:bob@localhost", "pinch:alice@localhost"); err != nil {
		t.Fatalf("Block: %v", err)
	}

	// Alice sends a message to Bob -- should be silently dropped.
	msg := makeEnvelope(t, pinchv1.MessageType_MESSAGE_TYPE_MESSAGE, "pinch:alice@localhost", "pinch:bob@localhost", nil)
	writeCtx, writeCancel := context.WithTimeout(ctx, 2*time.Second)
	err = aliceConn.Write(writeCtx, websocket.MessageBinary, msg)
	writeCancel()
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	// Bob should NOT receive the message.
	readCtx, readCancel := context.WithTimeout(ctx, 500*time.Millisecond)
	_, _, err = bobConn.Read(readCtx)
	readCancel()
	if err == nil {
		t.Fatal("expected bob to NOT receive a message from blocked alice")
	}

	// Alice should still be connected (no error indication).
	if h.ClientCount() != 2 {
		t.Fatal("expected both clients to remain connected")
	}
}

func TestBlockNotificationUpdatesBlockStore(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h, bs := newTestServerWithBlockStore(t, ctx)

	// Connect bob.
	bobConn, err := dialWS(ctx, srv, "pinch:bob@localhost")
	if err != nil {
		t.Fatalf("dial bob: %v", err)
	}
	defer bobConn.Close(websocket.StatusNormalClosure, "done")

	waitForClientCount(t, h, 1, 2*time.Second)

	// Verify alice is not blocked initially.
	if bs.IsBlocked("pinch:bob@localhost", "pinch:alice@localhost") {
		t.Fatal("expected alice to not be blocked initially")
	}

	// Bob sends a BlockNotification.
	blockMsg := makeEnvelope(t,
		pinchv1.MessageType_MESSAGE_TYPE_BLOCK_NOTIFICATION,
		"pinch:bob@localhost", "",
		&pinchv1.BlockNotification{
			BlockerAddress: "pinch:bob@localhost",
			BlockedAddress: "pinch:alice@localhost",
		},
	)
	writeCtx, writeCancel := context.WithTimeout(ctx, 2*time.Second)
	err = bobConn.Write(writeCtx, websocket.MessageBinary, blockMsg)
	writeCancel()
	if err != nil {
		t.Fatalf("write block notification: %v", err)
	}

	// Wait for the message to be processed.
	time.Sleep(200 * time.Millisecond)

	// Verify alice is now blocked by bob.
	if !bs.IsBlocked("pinch:bob@localhost", "pinch:alice@localhost") {
		t.Fatal("expected alice to be blocked after BlockNotification")
	}
}

func TestUnblockNotificationRestoresDelivery(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h, bs := newTestServerWithBlockStore(t, ctx)

	// Connect alice and bob.
	aliceConn, err := dialWS(ctx, srv, "pinch:alice@localhost")
	if err != nil {
		t.Fatalf("dial alice: %v", err)
	}
	defer aliceConn.Close(websocket.StatusNormalClosure, "done")

	bobConn, err := dialWS(ctx, srv, "pinch:bob@localhost")
	if err != nil {
		t.Fatalf("dial bob: %v", err)
	}
	defer bobConn.Close(websocket.StatusNormalClosure, "done")

	waitForClientCount(t, h, 2, 2*time.Second)

	// Bob blocks Alice.
	if err := bs.Block("pinch:bob@localhost", "pinch:alice@localhost"); err != nil {
		t.Fatalf("Block: %v", err)
	}

	// Bob sends an UnblockNotification via WebSocket.
	unblockMsg := makeEnvelope(t,
		pinchv1.MessageType_MESSAGE_TYPE_UNBLOCK_NOTIFICATION,
		"pinch:bob@localhost", "",
		&pinchv1.UnblockNotification{
			UnblockerAddress: "pinch:bob@localhost",
			UnblockedAddress: "pinch:alice@localhost",
		},
	)
	writeCtx, writeCancel := context.WithTimeout(ctx, 2*time.Second)
	err = bobConn.Write(writeCtx, websocket.MessageBinary, unblockMsg)
	writeCancel()
	if err != nil {
		t.Fatalf("write unblock: %v", err)
	}

	// Wait for unblock to be processed.
	time.Sleep(200 * time.Millisecond)

	// Verify alice is no longer blocked.
	if bs.IsBlocked("pinch:bob@localhost", "pinch:alice@localhost") {
		t.Fatal("expected alice to be unblocked after UnblockNotification")
	}

	// Alice sends a message to Bob -- should now be delivered.
	msg := makeEnvelope(t, pinchv1.MessageType_MESSAGE_TYPE_MESSAGE, "pinch:alice@localhost", "pinch:bob@localhost", nil)
	writeCtx2, writeCancel2 := context.WithTimeout(ctx, 2*time.Second)
	err = aliceConn.Write(writeCtx2, websocket.MessageBinary, msg)
	writeCancel2()
	if err != nil {
		t.Fatalf("write msg: %v", err)
	}

	// Bob should receive the message.
	readCtx, readCancel := context.WithTimeout(ctx, 2*time.Second)
	_, data, err := bobConn.Read(readCtx)
	readCancel()
	if err != nil {
		t.Fatalf("bob read after unblock: %v", err)
	}

	var received pinchv1.Envelope
	if err := proto.Unmarshal(data, &received); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if received.FromAddress != "pinch:alice@localhost" {
		t.Fatalf("expected from alice, got %s", received.FromAddress)
	}
}

func TestBlockedSenderReceivesNoErrorIndication(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h, bs := newTestServerWithBlockStore(t, ctx)

	// Connect alice and bob.
	aliceConn, err := dialWS(ctx, srv, "pinch:alice@localhost")
	if err != nil {
		t.Fatalf("dial alice: %v", err)
	}
	defer aliceConn.Close(websocket.StatusNormalClosure, "done")

	bobConn, err := dialWS(ctx, srv, "pinch:bob@localhost")
	if err != nil {
		t.Fatalf("dial bob: %v", err)
	}
	defer bobConn.Close(websocket.StatusNormalClosure, "done")

	waitForClientCount(t, h, 2, 2*time.Second)

	// Bob blocks Alice.
	if err := bs.Block("pinch:bob@localhost", "pinch:alice@localhost"); err != nil {
		t.Fatalf("Block: %v", err)
	}

	// Alice sends multiple messages -- all should be silently dropped.
	for i := 0; i < 3; i++ {
		msg := makeEnvelope(t, pinchv1.MessageType_MESSAGE_TYPE_MESSAGE, "pinch:alice@localhost", "pinch:bob@localhost", nil)
		writeCtx, writeCancel := context.WithTimeout(ctx, 2*time.Second)
		err = aliceConn.Write(writeCtx, websocket.MessageBinary, msg)
		writeCancel()
		if err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}

	// Wait for processing.
	time.Sleep(200 * time.Millisecond)

	// Alice should still be connected -- no disconnection, no error messages.
	if h.ClientCount() != 2 {
		t.Fatal("expected both clients to remain connected after blocked sends")
	}

	// Alice should not receive any error/notification back.
	readCtx, readCancel := context.WithTimeout(ctx, 300*time.Millisecond)
	_, _, err = aliceConn.Read(readCtx)
	readCancel()
	if err == nil {
		t.Fatal("expected alice to NOT receive any response (silent drop)")
	}
}
