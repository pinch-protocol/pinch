package hub

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	pinchv1 "github.com/pinch-protocol/pinch/gen/go/pinch/v1"
	"github.com/pinch-protocol/pinch/relay/internal/store"
	"google.golang.org/protobuf/proto"
)

func newUnitClient(address string, buffer int) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		address: address,
		send:    make(chan []byte, buffer),
		ctx:     ctx,
		cancel:  cancel,
	}
}

func newUnitTestClient(address string) *Client {
	return newUnitClient(address, 8)
}

func waitForCondition(t *testing.T, timeout time.Duration, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}

func TestUnregisterStaleClientKeepsReplacement(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	h := NewHub(nil, nil, nil)
	runDone := make(chan struct{})
	go func() {
		h.Run(ctx)
		close(runDone)
	}()
	t.Cleanup(func() {
		cancel()
		<-runDone
	})

	addr := "pinch:alice@localhost"
	stale := newUnitTestClient(addr)
	replacement := newUnitTestClient(addr)

	h.Register(stale)
	h.Register(replacement)

	waitForCondition(t, time.Second, func() bool {
		client, ok := h.LookupClient(addr)
		return ok && client == replacement
	})

	h.Unregister(stale)

	waitForCondition(t, time.Second, func() bool {
		client, ok := h.LookupClient(addr)
		return ok && client == replacement
	})
}

func TestUnregisterAfterRunStopsDoesNotBlock(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	h := NewHub(nil, nil, nil)
	runDone := make(chan struct{})
	go func() {
		h.Run(ctx)
		close(runDone)
	}()

	cancel()
	<-runDone

	done := make(chan struct{})
	go func() {
		h.Unregister(newUnitTestClient("pinch:bob@localhost"))
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("Unregister blocked after hub stopped")
	}
}

func TestRouteMessageNormalizesForgedSenderFields(t *testing.T) {
	h := NewHub(nil, nil, nil)
	sender := newUnitTestClient("pinch:alice@localhost")
	recipient := newUnitTestClient("pinch:bob@localhost")

	h.mu.Lock()
	h.clients[recipient.address] = recipient
	h.mu.Unlock()

	forged := &pinchv1.Envelope{
		Version:     1,
		FromAddress: "pinch:mallory@localhost",
		ToAddress:   recipient.address,
		Type:        pinchv1.MessageType_MESSAGE_TYPE_CONNECTION_REQUEST,
		Payload: &pinchv1.Envelope_ConnectionRequest{
			ConnectionRequest: &pinchv1.ConnectionRequest{
				FromAddress:     "pinch:mallory@localhost",
				ToAddress:       "pinch:eve@localhost",
				Message:         "forged",
				SenderPublicKey: []byte{1, 2, 3},
				ExpiresAt:       time.Now().Add(time.Hour).Unix(),
			},
		},
	}

	data, err := proto.Marshal(forged)
	if err != nil {
		t.Fatalf("marshal forged envelope: %v", err)
	}

	if err := h.RouteMessage(sender, data); err != nil {
		t.Fatalf("RouteMessage returned error: %v", err)
	}

	select {
	case delivered := <-recipient.send:
		var env pinchv1.Envelope
		if err := proto.Unmarshal(delivered, &env); err != nil {
			t.Fatalf("unmarshal delivered envelope: %v", err)
		}
		if env.FromAddress != sender.address {
			t.Fatalf("expected normalized from_address %q, got %q", sender.address, env.FromAddress)
		}
		req := env.GetConnectionRequest()
		if req == nil {
			t.Fatal("expected ConnectionRequest payload")
		}
		if req.FromAddress != sender.address {
			t.Fatalf("expected normalized payload from_address %q, got %q", sender.address, req.FromAddress)
		}
		if req.ToAddress != recipient.address {
			t.Fatalf("expected normalized payload to_address %q, got %q", recipient.address, req.ToAddress)
		}
	case <-time.After(time.Second):
		t.Fatal("expected routed message")
	}
}

func TestClientSendDoesNotPanicWhenChannelClosed(t *testing.T) {
	client := newUnitTestClient("pinch:closed@localhost")
	close(client.send)

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Send panicked on closed channel: %v", r)
		}
	}()

	client.Send([]byte("hello"))
}

func TestFlushQueuedMessagesKeepsEntryUntilBuffered(t *testing.T) {
	db, err := store.OpenDB(filepath.Join(t.TempDir(), "review-comments.db"))
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	defer db.Close()

	mq, err := store.NewMessageQueue(db, 100, 7*24*time.Hour)
	if err != nil {
		t.Fatalf("NewMessageQueue: %v", err)
	}

	env := &pinchv1.Envelope{
		Version:     1,
		FromAddress: "pinch:alice@localhost",
		ToAddress:   "pinch:bob@localhost",
		Type:        pinchv1.MessageType_MESSAGE_TYPE_MESSAGE,
		Payload: &pinchv1.Envelope_Encrypted{
			Encrypted: &pinchv1.EncryptedPayload{Ciphertext: []byte("queued")},
		},
	}
	raw, err := proto.Marshal(env)
	if err != nil {
		t.Fatalf("proto.Marshal: %v", err)
	}
	if err := mq.Enqueue("pinch:bob@localhost", "pinch:alice@localhost", raw); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	h := NewHub(nil, mq, nil)
	client := newUnitClient("pinch:bob@localhost", 1)

	client.send <- []byte("occupied")

	done := make(chan struct{})
	go func() {
		h.flushQueuedMessages(client)
		close(done)
	}()

	time.Sleep(50 * time.Millisecond)
	if got := mq.Count("pinch:bob@localhost"); got != 1 {
		t.Fatalf("expected queued entry to remain while send buffer is full, got count=%d", got)
	}

	<-client.send

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("flushQueuedMessages did not complete")
	}

	if got := mq.Count("pinch:bob@localhost"); got != 0 {
		t.Fatalf("expected queued entry removed after successful buffering, got count=%d", got)
	}
}
