package hub

import (
	"context"
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

func TestClientSendClosedChannelNoPanic(t *testing.T) {
	client := newUnitClient("pinch:closed@localhost", 1)
	close(client.send)

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Send panicked on closed channel: %v", r)
		}
	}()

	client.Send([]byte("hello"))
}

func TestFlushQueuedMessagesKeepsEntryUntilBuffered(t *testing.T) {
	db, err := store.OpenDB(t.TempDir() + "/review-comments.db")
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

	// Fill the outbound buffer so the first flush send attempt drops.
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

	// Free one slot so flush can enqueue, then remove the entry.
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
