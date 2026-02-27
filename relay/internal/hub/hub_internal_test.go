package hub

import (
	"context"
	"errors"
	"testing"
	"time"
)

func newUnitTestClient(address string) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		address: address,
		send:    make(chan []byte, 1),
		ctx:     ctx,
		cancel:  cancel,
	}
}

func TestRegisterRejectsDuplicateAddress(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h := NewHub(nil, nil, nil)
	go h.Run(ctx)

	c1 := newUnitTestClient("pinch:dup@relay.example.com")
	if err := h.Register(c1); err != nil {
		t.Fatalf("first register failed: %v", err)
	}
	c2 := newUnitTestClient("pinch:dup@relay.example.com")
	err := h.Register(c2)
	if !errors.Is(err, ErrAddressInUse) {
		t.Fatalf("expected ErrAddressInUse, got %v", err)
	}
	if got := h.ClientCount(); got != 1 {
		t.Fatalf("client count mismatch: got %d, want 1", got)
	}
	active, ok := h.LookupClient("pinch:dup@relay.example.com")
	if !ok {
		t.Fatal("expected active client")
	}
	if active != c1 {
		t.Fatal("duplicate register replaced active client")
	}
}

func TestUnregisterIgnoresStaleClient(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h := NewHub(nil, nil, nil)
	go h.Run(ctx)

	address := "pinch:stale@relay.example.com"
	stale := newUnitTestClient(address)
	if err := h.Register(stale); err != nil {
		t.Fatalf("register stale client: %v", err)
	}

	active := newUnitTestClient(address)
	h.mu.Lock()
	h.clients[address] = active
	h.mu.Unlock()

	h.Unregister(stale)

	// Let hub process the unregister event.
	time.Sleep(20 * time.Millisecond)

	lookup, ok := h.LookupClient(address)
	if !ok {
		t.Fatal("stale unregister removed active client")
	}
	if lookup != active {
		t.Fatal("wrong client remained after stale unregister")
	}
}
