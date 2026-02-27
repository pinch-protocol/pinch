// Package hub implements a hub-and-spoke WebSocket connection manager.
// The Hub goroutine maintains a routing table mapping pinch: addresses
// to active WebSocket connections, with channels for registration and
// unregistration of clients.
package hub

import (
	"context"
	"log/slog"
	"sync"
	"time"

	pinchv1 "github.com/pinch-protocol/pinch/gen/go/pinch/v1"
	"github.com/pinch-protocol/pinch/relay/internal/store"
	"google.golang.org/protobuf/proto"
)

const (
	// maxEnvelopeSize is the maximum allowed size in bytes for an incoming
	// protobuf envelope. Envelopes exceeding this limit are silently dropped
	// to prevent abuse.
	maxEnvelopeSize = 65536

	// pendingTTL is how long messages are buffered for offline recipients
	// before being dropped.
	pendingTTL = 30 * time.Second

	// pendingCleanupInterval is how often the cleanup goroutine sweeps
	// expired pending messages.
	pendingCleanupInterval = 10 * time.Second

	// maxPendingPerAddress is the maximum number of pending messages held
	// per recipient address to prevent memory abuse.
	maxPendingPerAddress = 100
)

// pendingMsg holds a message buffered for an offline recipient.
type pendingMsg struct {
	data     []byte
	deadline time.Time
}

// Hub maintains the set of active clients and routes messages between them.
// A single Hub goroutine serializes access to the routing table via channels.
type Hub struct {
	// clients maps pinch: addresses to active Client connections.
	clients map[string]*Client

	// register receives clients to add to the routing table.
	register chan *Client

	// unregister receives clients to remove from the routing table.
	unregister chan *Client

	// blockStore persists block relationships. Can be nil for tests that
	// don't need blocking.
	blockStore *store.BlockStore

	// pendingMessages holds messages for offline recipients, keyed by
	// recipient address. Protected by mu.
	pendingMessages map[string][]pendingMsg

	// mu protects external reads of the routing table and pendingMessages.
	mu sync.RWMutex
}

// NewHub creates a new Hub with initialized channels and routing table.
// blockStore may be nil if block enforcement is not needed (e.g., tests).
func NewHub(blockStore *store.BlockStore) *Hub {
	return &Hub{
		clients:         make(map[string]*Client),
		register:        make(chan *Client),
		unregister:      make(chan *Client),
		blockStore:      blockStore,
		pendingMessages: make(map[string][]pendingMsg),
	}
}

// Run starts the hub's main event loop. It processes register and unregister
// events until the context is cancelled. Run should be called in its own
// goroutine.
func (h *Hub) Run(ctx context.Context) {
	cleanupTicker := time.NewTicker(pendingCleanupInterval)
	defer cleanupTicker.Stop()

	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client.address] = client
			// Flush any pending messages for the newly registered address.
			if pending, ok := h.pendingMessages[client.address]; ok {
				now := time.Now()
				for _, pm := range pending {
					if now.Before(pm.deadline) {
						client.Send(pm.data)
					}
				}
				delete(h.pendingMessages, client.address)
			}
			h.mu.Unlock()
			slog.Info("client registered",
				"address", client.address,
				"connections", h.ClientCount(),
			)

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client.address]; ok {
				delete(h.clients, client.address)
				close(client.send)
				client.cancel()
			}
			h.mu.Unlock()
			slog.Info("client unregistered",
				"address", client.address,
				"connections", h.ClientCount(),
			)

		case <-cleanupTicker.C:
			h.mu.Lock()
			now := time.Now()
			for addr, msgs := range h.pendingMessages {
				// Filter out expired messages in-place.
				n := 0
				for _, pm := range msgs {
					if now.Before(pm.deadline) {
						msgs[n] = pm
						n++
					}
				}
				if n == 0 {
					delete(h.pendingMessages, addr)
				} else {
					h.pendingMessages[addr] = msgs[:n]
				}
			}
			h.mu.Unlock()

		case <-ctx.Done():
			h.mu.Lock()
			for addr, client := range h.clients {
				close(client.send)
				client.cancel()
				delete(h.clients, addr)
			}
			h.mu.Unlock()
			slog.Info("hub stopped")
			return
		}
	}
}

// ClientCount returns the number of currently connected clients.
// It is safe for concurrent use.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// LookupClient returns the client registered with the given address.
// Returns the client and true if found, or nil and false otherwise.
// It is safe for concurrent use.
func (h *Hub) LookupClient(address string) (*Client, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	c, ok := h.clients[address]
	return c, ok
}

// Register queues a client for registration with the hub.
func (h *Hub) Register(client *Client) {
	h.register <- client
}

// Unregister queues a client for removal from the hub.
func (h *Hub) Unregister(client *Client) {
	h.unregister <- client
}

// RouteMessage deserializes an envelope, handles block/unblock commands,
// checks blocks, and delivers the message to the recipient.
// Blocked and undeliverable messages are silently dropped.
// Envelopes exceeding 64KB are silently dropped.
func (h *Hub) RouteMessage(from *Client, envelope []byte) error {
	// Enforce maximum envelope size.
	if len(envelope) > maxEnvelopeSize {
		slog.Debug("route: envelope exceeds max size",
			"from", from.Address(),
			"size", len(envelope),
			"max", maxEnvelopeSize,
		)
		return nil
	}

	var env pinchv1.Envelope
	if err := proto.Unmarshal(envelope, &env); err != nil {
		slog.Debug("route: invalid protobuf",
			"from", from.Address(),
			"error", err,
		)
		return err
	}

	switch env.Type {
	case pinchv1.MessageType_MESSAGE_TYPE_BLOCK_NOTIFICATION:
		bn := env.GetBlockNotification()
		if bn == nil {
			return nil
		}
		if h.blockStore != nil {
			// Blocker is the authenticated sender -- ignore blocker_address
			// field in payload and use the verified address.
			return h.blockStore.Block(from.Address(), bn.BlockedAddress)
		}
		return nil

	case pinchv1.MessageType_MESSAGE_TYPE_UNBLOCK_NOTIFICATION:
		un := env.GetUnblockNotification()
		if un == nil {
			return nil
		}
		if h.blockStore != nil {
			return h.blockStore.Unblock(from.Address(), un.UnblockedAddress)
		}
		return nil
	}

	// For all other message types: check block list before delivery.
	toAddress := env.ToAddress
	if toAddress == "" {
		return nil
	}

	if h.blockStore != nil && h.blockStore.IsBlocked(toAddress, from.Address()) {
		// Silent drop -- no error to sender.
		slog.Debug("route: message blocked",
			"from", from.Address(),
			"to", toAddress,
		)
		return nil
	}

	recipient, ok := h.LookupClient(toAddress)
	if !ok {
		// Recipient offline -- buffer for transient reconnect.
		h.mu.Lock()
		pending := h.pendingMessages[toAddress]
		if len(pending) < maxPendingPerAddress {
			h.pendingMessages[toAddress] = append(pending, pendingMsg{
				data:     envelope,
				deadline: time.Now().Add(pendingTTL),
			})
		}
		h.mu.Unlock()
		return nil
	}

	recipient.Send(envelope)
	return nil
}

// PendingCount returns the number of pending messages for the given address.
// This is primarily used for testing.
func (h *Hub) PendingCount(address string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.pendingMessages[address])
}
