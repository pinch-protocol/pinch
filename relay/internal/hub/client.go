package hub

import (
	"context"
	"crypto/ed25519"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	// heartbeatInterval is how often the server pings the client.
	heartbeatInterval = 25 * time.Second

	// pongTimeout is how long to wait for a pong response.
	pongTimeout = 7 * time.Second

	// readTimeout is the maximum time to wait for a message from the client.
	readTimeout = 60 * time.Second

	// writeTimeout is the maximum time to wait for a write to complete.
	writeTimeout = 10 * time.Second

	// sendBufferSize is the capacity of the outbound message channel.
	sendBufferSize = 256
)

// Client represents a single WebSocket connection to the hub.
// Each client has its own read, write, and heartbeat goroutines
// managed by a shared context.
type Client struct {
	hub       *Hub
	conn      *websocket.Conn
	address   string
	PublicKey ed25519.PublicKey
	send      chan []byte
	ctx       context.Context
	cancel    context.CancelFunc

	// flushing is set atomically while the hub is draining queued messages
	// to this client. While true, new real-time messages are enqueued to
	// bbolt instead of delivered directly to preserve ordering.
	flushing atomic.Bool
}

// NewClient creates a new Client bound to the given hub and WebSocket connection.
// The address is the pinch: address derived from the authenticated public key.
// The pubKey is the Ed25519 public key verified during the auth handshake.
// The provided context controls the client's lifecycle; cancelling it
// stops all client goroutines.
func NewClient(hub *Hub, conn *websocket.Conn, address string, pubKey ed25519.PublicKey, ctx context.Context) *Client {
	clientCtx, cancel := context.WithCancel(ctx)
	return &Client{
		hub:       hub,
		conn:      conn,
		address:   address,
		PublicKey: pubKey,
		send:      make(chan []byte, sendBufferSize),
		ctx:       clientCtx,
		cancel:    cancel,
	}
}

// ReadPump reads messages from the WebSocket connection and routes them
// through the hub. When ReadPump exits, the client is unregistered.
func (c *Client) ReadPump() {
	defer func() {
		c.hub.Unregister(c)
	}()

	// Set WebSocket read limit above maxEnvelopeSize so that oversized
	// envelopes reach RouteMessage for application-level silent drop rather
	// than causing a WebSocket-level connection close. We use 2x the envelope
	// limit as the hard WebSocket cutoff.
	c.conn.SetReadLimit(2 * maxEnvelopeSize)

	for {
		readCtx, readCancel := context.WithTimeout(c.ctx, readTimeout)
		_, data, err := c.conn.Read(readCtx)
		readCancel()
		if err != nil {
			if c.ctx.Err() == nil {
				slog.Debug("read error",
					"address", c.address,
					"error", err,
				)
			}
			return
		}
		if err := c.hub.RouteMessage(c, data); err != nil {
			slog.Debug("route error",
				"address", c.address,
				"error", err,
			)
		}
	}
}

// WritePump writes messages from the send channel to the WebSocket connection.
// It exits when the client context is cancelled or the send channel is closed.
func (c *Client) WritePump() {
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				// Channel closed -- hub has unregistered this client.
				_ = c.conn.Close(websocket.StatusNormalClosure, "closed")
				return
			}
			writeCtx, writeCancel := context.WithTimeout(c.ctx, writeTimeout)
			err := c.conn.Write(writeCtx, websocket.MessageBinary, msg)
			writeCancel()
			if err != nil {
				slog.Debug("write error",
					"address", c.address,
					"error", err,
				)
				return
			}

		case <-c.ctx.Done():
			return
		}
	}
}

// HeartbeatLoop sends periodic pings to the client to verify the connection
// is alive. If a pong is not received within pongTimeout, the connection
// is closed and the client goroutines will exit via context cancellation.
func (c *Client) HeartbeatLoop() {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-c.ctx.Done():
			return

		case <-ticker.C:
			pingCtx, pingCancel := context.WithTimeout(c.ctx, pongTimeout)
			err := c.conn.Ping(pingCtx)
			pingCancel()
			if err != nil {
				slog.Info("heartbeat failed",
					"address", c.address,
					"error", err,
				)
				_ = c.conn.Close(websocket.StatusPolicyViolation, "heartbeat timeout")
				return
			}
		}
	}
}

// Send writes data to the client's outbound channel. If the channel
// is full, the message is dropped to prevent blocking the sender.
func (c *Client) Send(data []byte) {
	select {
	case c.send <- data:
	default:
		slog.Debug("send buffer full, dropping message",
			"address", c.address,
		)
	}
}

// Address returns the client's pinch: address.
func (c *Client) Address() string {
	return c.address
}

// IsFlushing returns true if the client is currently receiving a flush
// of queued messages. Lock-free atomic read.
func (c *Client) IsFlushing() bool {
	return c.flushing.Load()
}

// SetFlushing sets the client's flushing state atomically.
func (c *Client) SetFlushing(v bool) {
	c.flushing.Store(v)
}

