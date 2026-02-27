package hub_test

import (
	"context"
	"crypto/ed25519"
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
	"github.com/pinch-protocol/pinch/relay/internal/auth"
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

// --- Auth handshake integration tests ---

// newAuthTestServer creates an httptest.Server that performs the real
// Ed25519 challenge-response auth handshake before registering clients.
func newAuthTestServer(t *testing.T, ctx context.Context) (*httptest.Server, *hub.Hub, *store.BlockStore) {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "test-auth-blocks.db")
	bs, err := store.NewBlockStore(dbPath)
	if err != nil {
		t.Fatalf("NewBlockStore: %v", err)
	}
	t.Cleanup(func() { bs.Close() })

	h := hub.NewHub(bs)
	go h.Run(ctx)

	const relayHost = "localhost"

	r := chi.NewRouter()
	r.Get("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true,
		})
		if err != nil {
			t.Logf("websocket accept error: %v", err)
			return
		}

		// Perform real auth handshake.
		authCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()

		// Step 1: Generate and send challenge.
		nonce, err := auth.GenerateChallenge()
		if err != nil {
			conn.Close(websocket.StatusInternalError, "internal error")
			return
		}

		challengeEnv := &pinchv1.Envelope{
			Version: 1,
			Type:    pinchv1.MessageType_MESSAGE_TYPE_AUTH_CHALLENGE,
			Payload: &pinchv1.Envelope_AuthChallenge{
				AuthChallenge: &pinchv1.AuthChallenge{
					Nonce:     nonce,
					Timestamp: time.Now().Unix(),
				},
			},
		}
		challengeData, _ := proto.Marshal(challengeEnv)
		if err := conn.Write(authCtx, websocket.MessageBinary, challengeData); err != nil {
			return
		}

		// Step 2: Read AuthResponse.
		_, responseData, err := conn.Read(authCtx)
		if err != nil {
			return
		}

		var responseEnv pinchv1.Envelope
		if err := proto.Unmarshal(responseData, &responseEnv); err != nil {
			conn.Close(websocket.StatusProtocolError, "invalid message")
			return
		}

		authResp := responseEnv.GetAuthResponse()
		if authResp == nil {
			sendAuthFailureHelper(authCtx, conn, "expected AuthResponse")
			conn.Close(websocket.StatusProtocolError, "unexpected type")
			return
		}

		pubKey := ed25519.PublicKey(authResp.PublicKey)
		signature := authResp.Signature

		// Step 3: Verify.
		if !auth.VerifyChallenge(pubKey, nonce, signature) {
			sendAuthFailureHelper(authCtx, conn, "signature verification failed")
			conn.Close(4001, "auth failed")
			return
		}

		// Step 4: Derive address and send result.
		address := auth.DeriveAddress(pubKey, relayHost)

		resultEnv := &pinchv1.Envelope{
			Version: 1,
			Type:    pinchv1.MessageType_MESSAGE_TYPE_AUTH_RESULT,
			Payload: &pinchv1.Envelope_AuthResult{
				AuthResult: &pinchv1.AuthResult{
					Success:         true,
					AssignedAddress: address,
				},
			},
		}
		resultData, _ := proto.Marshal(resultEnv)
		if err := conn.Write(authCtx, websocket.MessageBinary, resultData); err != nil {
			return
		}

		// Register after successful auth.
		client := hub.NewClient(h, conn, address, pubKey, ctx)
		h.Register(client)
		go client.ReadPump()
		go client.WritePump()
		go client.HeartbeatLoop()
	})

	srv := httptest.NewServer(r)
	t.Cleanup(func() { srv.Close() })
	return srv, h, bs
}

func sendAuthFailureHelper(ctx context.Context, conn *websocket.Conn, errMsg string) {
	env := &pinchv1.Envelope{
		Version: 1,
		Type:    pinchv1.MessageType_MESSAGE_TYPE_AUTH_RESULT,
		Payload: &pinchv1.Envelope_AuthResult{
			AuthResult: &pinchv1.AuthResult{
				Success:      false,
				ErrorMessage: errMsg,
			},
		},
	}
	data, err := proto.Marshal(env)
	if err != nil {
		return
	}
	_ = conn.Write(ctx, websocket.MessageBinary, data)
}

// dialAuthWS performs the full client-side auth handshake (like the TS RelayClient).
// Returns the WebSocket connection, assigned address, and any error.
func dialAuthWS(ctx context.Context, srv *httptest.Server, privKey ed25519.PrivateKey, pubKey ed25519.PublicKey) (*websocket.Conn, string, error) {
	url := "ws" + srv.URL[len("http"):] + "/ws"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return nil, "", err
	}

	// Read AuthChallenge.
	readCtx, readCancel := context.WithTimeout(ctx, 5*time.Second)
	_, challengeData, err := conn.Read(readCtx)
	readCancel()
	if err != nil {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return nil, "", fmt.Errorf("read challenge: %w", err)
	}

	var challengeEnv pinchv1.Envelope
	if err := proto.Unmarshal(challengeData, &challengeEnv); err != nil {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return nil, "", fmt.Errorf("unmarshal challenge: %w", err)
	}

	challenge := challengeEnv.GetAuthChallenge()
	if challenge == nil {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return nil, "", fmt.Errorf("expected AuthChallenge, got %T", challengeEnv.Payload)
	}

	// Sign the nonce.
	signature := ed25519.Sign(privKey, challenge.Nonce)

	// Send AuthResponse.
	responseEnv := &pinchv1.Envelope{
		Version: 1,
		Type:    pinchv1.MessageType_MESSAGE_TYPE_AUTH_RESPONSE,
		Payload: &pinchv1.Envelope_AuthResponse{
			AuthResponse: &pinchv1.AuthResponse{
				Signature: signature,
				PublicKey: pubKey,
			},
		},
	}
	responseData, _ := proto.Marshal(responseEnv)
	writeCtx, writeCancel := context.WithTimeout(ctx, 5*time.Second)
	err = conn.Write(writeCtx, websocket.MessageBinary, responseData)
	writeCancel()
	if err != nil {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return nil, "", fmt.Errorf("write response: %w", err)
	}

	// Read AuthResult.
	readCtx2, readCancel2 := context.WithTimeout(ctx, 5*time.Second)
	_, resultData, err := conn.Read(readCtx2)
	readCancel2()
	if err != nil {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return nil, "", fmt.Errorf("read result: %w", err)
	}

	var resultEnv pinchv1.Envelope
	if err := proto.Unmarshal(resultData, &resultEnv); err != nil {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return nil, "", fmt.Errorf("unmarshal result: %w", err)
	}

	result := resultEnv.GetAuthResult()
	if result == nil {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return nil, "", fmt.Errorf("expected AuthResult")
	}
	if !result.Success {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return nil, "", fmt.Errorf("auth failed: %s", result.ErrorMessage)
	}

	return conn, result.AssignedAddress, nil
}

func TestAuthHandshakeSuccess(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h, _ := newAuthTestServer(t, ctx)

	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	conn, address, err := dialAuthWS(ctx, srv, priv, pub)
	if err != nil {
		t.Fatalf("dialAuthWS: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "done")

	// Verify assigned address format.
	if len(address) < len("pinch:x@localhost") {
		t.Fatalf("address too short: %q", address)
	}
	if address[:6] != "pinch:" {
		t.Fatalf("address does not start with 'pinch:': %q", address)
	}

	waitForClientCount(t, h, 1, 2*time.Second)
}

func TestAuthHandshakeBadSignature(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, _, _ := newAuthTestServer(t, ctx)

	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	// Use a different private key to produce an invalid signature.
	_, wrongPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	_, _, err = dialAuthWS(ctx, srv, wrongPriv, pub)
	if err == nil {
		t.Fatal("expected auth failure with wrong private key, got success")
	}
}

func TestAuthHandshakeTimeout(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Create a server with a very short auth timeout.
	dbPath := filepath.Join(t.TempDir(), "test-timeout-blocks.db")
	bs, err := store.NewBlockStore(dbPath)
	if err != nil {
		t.Fatalf("NewBlockStore: %v", err)
	}
	t.Cleanup(func() { bs.Close() })

	h := hub.NewHub(bs)
	go h.Run(ctx)

	r := chi.NewRouter()
	r.Get("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true,
		})
		if err != nil {
			return
		}

		// Very short auth timeout for testing.
		authCtx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
		defer cancel()

		nonce, _ := auth.GenerateChallenge()
		challengeEnv := &pinchv1.Envelope{
			Version: 1,
			Type:    pinchv1.MessageType_MESSAGE_TYPE_AUTH_CHALLENGE,
			Payload: &pinchv1.Envelope_AuthChallenge{
				AuthChallenge: &pinchv1.AuthChallenge{Nonce: nonce},
			},
		}
		challengeData, _ := proto.Marshal(challengeEnv)
		if err := conn.Write(authCtx, websocket.MessageBinary, challengeData); err != nil {
			return
		}

		// Wait for response (which will time out since client doesn't respond).
		_, _, readErr := conn.Read(authCtx)
		if readErr != nil {
			conn.Close(websocket.StatusPolicyViolation, "auth timeout")
			return
		}
	})

	srv := httptest.NewServer(r)
	t.Cleanup(func() { srv.Close() })

	// Connect but don't send AuthResponse -- should time out.
	url := "ws" + srv.URL[len("http"):] + "/ws"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	// Read the challenge.
	readCtx, readCancel := context.WithTimeout(ctx, 2*time.Second)
	_, _, err = conn.Read(readCtx)
	readCancel()
	if err != nil {
		t.Fatalf("read challenge: %v", err)
	}

	// Don't send a response -- wait for timeout.
	// The server should close the connection.
	readCtx2, readCancel2 := context.WithTimeout(ctx, 2*time.Second)
	_, _, err = conn.Read(readCtx2)
	readCancel2()
	if err == nil {
		t.Fatal("expected connection to be closed after auth timeout")
	}

	// No client should be registered.
	if h.ClientCount() != 0 {
		t.Fatalf("expected 0 clients after auth timeout, got %d", h.ClientCount())
	}
}

func TestAuthRouteConnectionRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h, _ := newAuthTestServer(t, ctx)

	// Connect Alice and Bob via auth handshake.
	alicePub, alicePriv, _ := ed25519.GenerateKey(nil)
	aliceConn, aliceAddr, err := dialAuthWS(ctx, srv, alicePriv, alicePub)
	if err != nil {
		t.Fatalf("alice auth: %v", err)
	}
	defer aliceConn.Close(websocket.StatusNormalClosure, "done")

	bobPub, bobPriv, _ := ed25519.GenerateKey(nil)
	bobConn, bobAddr, err := dialAuthWS(ctx, srv, bobPriv, bobPub)
	if err != nil {
		t.Fatalf("bob auth: %v", err)
	}
	defer bobConn.Close(websocket.StatusNormalClosure, "done")

	waitForClientCount(t, h, 2, 2*time.Second)

	// Alice sends a ConnectionRequest to Bob.
	connReqEnv := &pinchv1.Envelope{
		Version:     1,
		FromAddress: aliceAddr,
		ToAddress:   bobAddr,
		Type:        pinchv1.MessageType_MESSAGE_TYPE_CONNECTION_REQUEST,
		Payload: &pinchv1.Envelope_ConnectionRequest{
			ConnectionRequest: &pinchv1.ConnectionRequest{
				FromAddress:     aliceAddr,
				ToAddress:       bobAddr,
				Message:         "Hello from Alice",
				SenderPublicKey: alicePub,
				ExpiresAt:       time.Now().Add(7 * 24 * time.Hour).Unix(),
			},
		},
	}
	reqData, _ := proto.Marshal(connReqEnv)
	writeCtx, writeCancel := context.WithTimeout(ctx, 2*time.Second)
	err = aliceConn.Write(writeCtx, websocket.MessageBinary, reqData)
	writeCancel()
	if err != nil {
		t.Fatalf("write connection request: %v", err)
	}

	// Bob should receive the ConnectionRequest.
	readCtx, readCancel := context.WithTimeout(ctx, 2*time.Second)
	_, receivedData, err := bobConn.Read(readCtx)
	readCancel()
	if err != nil {
		t.Fatalf("bob read: %v", err)
	}

	var received pinchv1.Envelope
	if err := proto.Unmarshal(receivedData, &received); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if received.Type != pinchv1.MessageType_MESSAGE_TYPE_CONNECTION_REQUEST {
		t.Fatalf("expected CONNECTION_REQUEST type, got %v", received.Type)
	}
	connReq := received.GetConnectionRequest()
	if connReq == nil {
		t.Fatal("expected ConnectionRequest payload")
	}
	if connReq.FromAddress != aliceAddr {
		t.Fatalf("expected from %s, got %s", aliceAddr, connReq.FromAddress)
	}
	if connReq.Message != "Hello from Alice" {
		t.Fatalf("expected message 'Hello from Alice', got %q", connReq.Message)
	}
}

func TestAuthBlockEnforcementViaNotification(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h, _ := newAuthTestServer(t, ctx)

	// Connect Alice and Bob via auth handshake.
	alicePub, alicePriv, _ := ed25519.GenerateKey(nil)
	aliceConn, aliceAddr, err := dialAuthWS(ctx, srv, alicePriv, alicePub)
	if err != nil {
		t.Fatalf("alice auth: %v", err)
	}
	defer aliceConn.Close(websocket.StatusNormalClosure, "done")

	bobPub, bobPriv, _ := ed25519.GenerateKey(nil)
	bobConn, bobAddr, err := dialAuthWS(ctx, srv, bobPriv, bobPub)
	if err != nil {
		t.Fatalf("bob auth: %v", err)
	}
	defer bobConn.Close(websocket.StatusNormalClosure, "done")

	waitForClientCount(t, h, 2, 2*time.Second)

	// Bob sends a BlockNotification to block Alice.
	blockEnv := &pinchv1.Envelope{
		Version:     1,
		FromAddress: bobAddr,
		Type:        pinchv1.MessageType_MESSAGE_TYPE_BLOCK_NOTIFICATION,
		Payload: &pinchv1.Envelope_BlockNotification{
			BlockNotification: &pinchv1.BlockNotification{
				BlockerAddress: bobAddr,
				BlockedAddress: aliceAddr,
			},
		},
	}
	blockData, _ := proto.Marshal(blockEnv)
	writeCtx, writeCancel := context.WithTimeout(ctx, 2*time.Second)
	err = bobConn.Write(writeCtx, websocket.MessageBinary, blockData)
	writeCancel()
	if err != nil {
		t.Fatalf("write block: %v", err)
	}

	// Wait for block to be processed.
	time.Sleep(200 * time.Millisecond)

	// Alice sends a message to Bob -- should be silently dropped.
	msg := &pinchv1.Envelope{
		Version:     1,
		FromAddress: aliceAddr,
		ToAddress:   bobAddr,
		Type:        pinchv1.MessageType_MESSAGE_TYPE_MESSAGE,
	}
	msgData, _ := proto.Marshal(msg)
	writeCtx2, writeCancel2 := context.WithTimeout(ctx, 2*time.Second)
	err = aliceConn.Write(writeCtx2, websocket.MessageBinary, msgData)
	writeCancel2()
	if err != nil {
		t.Fatalf("write message: %v", err)
	}

	// Bob should NOT receive the message (blocked).
	readCtx, readCancel := context.WithTimeout(ctx, 500*time.Millisecond)
	_, _, err = bobConn.Read(readCtx)
	readCancel()
	if err == nil {
		t.Fatal("expected bob to NOT receive message from blocked alice")
	}
}

// --- 64KB size enforcement and transient buffer tests ---

func TestMaxEnvelopeSizeDrop(t *testing.T) {
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

	// Create an envelope that exceeds 64KB when serialized.
	bigPayload := make([]byte, 70000)
	for i := range bigPayload {
		bigPayload[i] = 0xAB
	}
	env := &pinchv1.Envelope{
		Version:     1,
		FromAddress: "pinch:alice@localhost",
		ToAddress:   "pinch:bob@localhost",
		Type:        pinchv1.MessageType_MESSAGE_TYPE_MESSAGE,
		Payload: &pinchv1.Envelope_Encrypted{
			Encrypted: &pinchv1.EncryptedPayload{
				Ciphertext: bigPayload,
			},
		},
	}
	data, err := proto.Marshal(env)
	if err != nil {
		t.Fatalf("proto.Marshal: %v", err)
	}
	if len(data) <= 65536 {
		t.Fatalf("expected envelope > 64KB, got %d bytes", len(data))
	}

	// Alice sends the oversized envelope.
	writeCtx, writeCancel := context.WithTimeout(ctx, 2*time.Second)
	err = aliceConn.Write(writeCtx, websocket.MessageBinary, data)
	writeCancel()
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	// Bob should NOT receive the message (silently dropped due to size).
	readCtx, readCancel := context.WithTimeout(ctx, 500*time.Millisecond)
	_, _, err = bobConn.Read(readCtx)
	readCancel()
	if err == nil {
		t.Fatal("expected bob to NOT receive oversized message")
	}

	// Both clients should remain connected.
	if h.ClientCount() != 2 {
		t.Fatal("expected both clients to remain connected after oversized drop")
	}
}

func TestPendingMessageDeliveredOnReconnect(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h, _ := newTestServerWithBlockStore(t, ctx)

	// Connect only alice -- bob is offline.
	aliceConn, err := dialWS(ctx, srv, "pinch:alice@localhost")
	if err != nil {
		t.Fatalf("dial alice: %v", err)
	}
	defer aliceConn.Close(websocket.StatusNormalClosure, "done")

	waitForClientCount(t, h, 1, 2*time.Second)

	// Alice sends a message to offline bob.
	msg := makeEnvelope(t, pinchv1.MessageType_MESSAGE_TYPE_MESSAGE, "pinch:alice@localhost", "pinch:bob@localhost", nil)
	writeCtx, writeCancel := context.WithTimeout(ctx, 2*time.Second)
	err = aliceConn.Write(writeCtx, websocket.MessageBinary, msg)
	writeCancel()
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	// Give time for routing.
	time.Sleep(100 * time.Millisecond)

	// Verify message is pending.
	if h.PendingCount("pinch:bob@localhost") != 1 {
		t.Fatalf("expected 1 pending message, got %d", h.PendingCount("pinch:bob@localhost"))
	}

	// Now bob connects -- should receive the buffered message.
	bobConn, err := dialWS(ctx, srv, "pinch:bob@localhost")
	if err != nil {
		t.Fatalf("dial bob: %v", err)
	}
	defer bobConn.Close(websocket.StatusNormalClosure, "done")

	waitForClientCount(t, h, 2, 2*time.Second)

	// Bob should receive the pending message.
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

	// Pending messages should be cleared.
	if h.PendingCount("pinch:bob@localhost") != 0 {
		t.Fatalf("expected 0 pending messages after flush, got %d", h.PendingCount("pinch:bob@localhost"))
	}
}

func TestPendingMessageExpires(t *testing.T) {
	// This test uses the hub directly (not WebSocket) to avoid needing
	// to actually wait 30 seconds. We manually insert a pending message
	// with an expired deadline and verify the cleanup goroutine removes it.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h := hub.NewHub(nil)
	go h.Run(ctx)

	// Use the hub's RouteMessage with a mock client to enqueue a message.
	// First we need a "sender" client registered so RouteMessage can work.
	// We use a nil conn client for unit-level testing by directly manipulating
	// pending state via RouteMessage.

	// Create a simple envelope addressed to an offline recipient.
	env := &pinchv1.Envelope{
		Version:     1,
		FromAddress: "pinch:sender@localhost",
		ToAddress:   "pinch:offline@localhost",
		Type:        pinchv1.MessageType_MESSAGE_TYPE_MESSAGE,
	}
	data, err := proto.Marshal(env)
	if err != nil {
		t.Fatalf("proto.Marshal: %v", err)
	}

	// Create a minimal sender client for RouteMessage.
	senderConn, err := dialWSForHub(ctx, t, h, "pinch:sender@localhost")
	if err != nil {
		t.Fatalf("create sender: %v", err)
	}
	defer senderConn.Close(websocket.StatusNormalClosure, "done")

	waitForClientCount(t, h, 1, 2*time.Second)

	// Send message to offline recipient -- should be buffered.
	senderClient, ok := h.LookupClient("pinch:sender@localhost")
	if !ok {
		t.Fatal("sender not found")
	}
	if err := h.RouteMessage(senderClient, data); err != nil {
		t.Fatalf("RouteMessage: %v", err)
	}

	// Verify message is pending.
	if h.PendingCount("pinch:offline@localhost") != 1 {
		t.Fatalf("expected 1 pending, got %d", h.PendingCount("pinch:offline@localhost"))
	}

	// Wait for cleanup + TTL to expire.
	// The cleanup runs every 10s and messages expire after 30s.
	// We need to wait past the TTL plus a full cleanup interval to ensure
	// the expired message is swept. 45s accounts for timing variance.
	// NOTE: This is a slow test (~45s). In production we'd inject the clock.
	// For CI, we accept the cost since it validates critical behavior.
	t.Log("waiting for pending message to expire (45 seconds)...")
	time.Sleep(45 * time.Second)

	// Verify the pending message was cleaned up.
	if h.PendingCount("pinch:offline@localhost") != 0 {
		t.Fatalf("expected 0 pending after expiry, got %d", h.PendingCount("pinch:offline@localhost"))
	}
}

func TestPendingCapPerAddress(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv, h, _ := newTestServerWithBlockStore(t, ctx)

	// Connect alice.
	aliceConn, err := dialWS(ctx, srv, "pinch:alice@localhost")
	if err != nil {
		t.Fatalf("dial alice: %v", err)
	}
	defer aliceConn.Close(websocket.StatusNormalClosure, "done")

	waitForClientCount(t, h, 1, 2*time.Second)

	// Send 110 messages to offline bob -- only 100 should be buffered.
	for i := 0; i < 110; i++ {
		msg := makeEnvelope(t, pinchv1.MessageType_MESSAGE_TYPE_MESSAGE, "pinch:alice@localhost", "pinch:bob@localhost", nil)
		writeCtx, writeCancel := context.WithTimeout(ctx, 2*time.Second)
		err = aliceConn.Write(writeCtx, websocket.MessageBinary, msg)
		writeCancel()
		if err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}

	// Give time for all messages to be routed.
	time.Sleep(500 * time.Millisecond)

	// Verify cap.
	count := h.PendingCount("pinch:bob@localhost")
	if count != 100 {
		t.Fatalf("expected 100 pending messages (cap), got %d", count)
	}
}

// dialWSForHub is a helper that creates a test server for a hub and dials a WebSocket.
// This is used when we need to interact with a specific hub instance directly.
func dialWSForHub(ctx context.Context, t *testing.T, h *hub.Hub, address string) (*websocket.Conn, error) {
	t.Helper()

	r := chi.NewRouter()
	r.Get("/ws", func(w http.ResponseWriter, r *http.Request) {
		addr := r.URL.Query().Get("address")
		if addr == "" {
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
		client := hub.NewClient(h, conn, addr, nil, ctx)
		h.Register(client)
		go client.ReadPump()
		go client.WritePump()
		go client.HeartbeatLoop()
	})

	srv := httptest.NewServer(r)
	t.Cleanup(func() { srv.Close() })

	conn, _, err := websocket.Dial(ctx, wsURL(srv, address), nil)
	return conn, err
}
