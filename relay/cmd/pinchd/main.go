package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	pinchv1 "github.com/pinch-protocol/pinch/gen/go/pinch/v1"
	"github.com/pinch-protocol/pinch/relay/internal/auth"
	"github.com/pinch-protocol/pinch/relay/internal/hub"
	"github.com/pinch-protocol/pinch/relay/internal/store"
	"google.golang.org/protobuf/proto"
)

func main() {
	port := os.Getenv("PINCH_RELAY_PORT")
	if port == "" {
		port = "8080"
	}

	relayHost := os.Getenv("PINCH_RELAY_HOST")
	if relayHost == "" {
		relayHost = "localhost"
	}

	dbPath := os.Getenv("PINCH_RELAY_DB")
	if dbPath == "" {
		dbPath = "./pinch-relay.db"
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, err := store.OpenDB(dbPath)
	if err != nil {
		slog.Error("failed to open database", "path", dbPath, "error", err)
		os.Exit(1)
	}
	defer db.Close()

	blockStore, err := store.NewBlockStore(db)
	if err != nil {
		slog.Error("failed to initialize block store", "error", err)
		os.Exit(1)
	}

	mq, err := store.NewMessageQueue(db, 1000, 7*24*time.Hour)
	if err != nil {
		slog.Error("failed to initialize message queue", "error", err)
		os.Exit(1)
	}
	slog.Info("message queue ready", "maxPerAgent", 1000, "ttl", "7d")
	_ = mq // Used in Plan 02 when hub integration is wired up

	h := hub.NewHub(blockStore)
	go h.Run(ctx)

	r := chi.NewRouter()
	r.Get("/ws", wsHandler(ctx, h, relayHost))
	r.Get("/health", healthHandler(h))

	srv := &http.Server{
		Addr:    ":" + port,
		Handler: r,
	}

	// Start server in a goroutine so we can listen for shutdown signals.
	go func() {
		slog.Info("relay starting", "port", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	// Wait for shutdown signal.
	<-ctx.Done()
	slog.Info("shutting down relay")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown error", "error", err)
	}
	slog.Info("relay stopped")
}

// authTimeout is the maximum duration for the challenge-response handshake.
const authTimeout = 10 * time.Second

// wsHandler handles WebSocket upgrade requests. After upgrade, the relay
// performs an Ed25519 challenge-response handshake:
//  1. Generate 32-byte nonce and send AuthChallenge
//  2. Wait for AuthResponse with signature and public key
//  3. Verify signature, derive pinch: address, send AuthResult
//  4. Register authenticated client in hub
//
// Unauthenticated clients are never registered in the hub routing table.
func wsHandler(serverCtx context.Context, h *hub.Hub, relayHost string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			// Allow connections from any origin in development.
			InsecureSkipVerify: true,
		})
		if err != nil {
			slog.Error("websocket accept error", "error", err)
			return
		}

		// Perform auth handshake with timeout.
		pubKey, address, err := performAuth(serverCtx, conn, relayHost)
		if err != nil {
			slog.Info("auth failed", "error", err)
			return
		}

		// CRITICAL: Only register AFTER auth succeeds.
		client := hub.NewClient(h, conn, address, pubKey, serverCtx)
		h.Register(client)

		slog.Info("client authenticated", "address", address)

		go client.ReadPump()
		go client.WritePump()
		go client.HeartbeatLoop()
	}
}

// performAuth executes the challenge-response handshake on an accepted
// WebSocket connection. Returns the verified public key and derived address,
// or an error if authentication fails. On failure, an AuthResult with
// success=false is sent and the connection is closed.
func performAuth(ctx context.Context, conn *websocket.Conn, relayHost string) (ed25519.PublicKey, string, error) {
	authCtx, cancel := context.WithTimeout(ctx, authTimeout)
	defer cancel()

	// Step 1: Generate and send challenge.
	nonce, err := auth.GenerateChallenge()
	if err != nil {
		conn.Close(websocket.StatusInternalError, "internal error")
		return nil, "", err
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
	challengeData, err := proto.Marshal(challengeEnv)
	if err != nil {
		conn.Close(websocket.StatusInternalError, "internal error")
		return nil, "", err
	}
	if err := conn.Write(authCtx, websocket.MessageBinary, challengeData); err != nil {
		return nil, "", err
	}

	// Step 2: Read client's AuthResponse.
	_, responseData, err := conn.Read(authCtx)
	if err != nil {
		return nil, "", err
	}

	var responseEnv pinchv1.Envelope
	if err := proto.Unmarshal(responseData, &responseEnv); err != nil {
		sendAuthFailure(authCtx, conn, "invalid protobuf message")
		conn.Close(websocket.StatusProtocolError, "invalid message")
		return nil, "", err
	}

	authResp := responseEnv.GetAuthResponse()
	if authResp == nil {
		sendAuthFailure(authCtx, conn, "expected AuthResponse payload")
		conn.Close(websocket.StatusProtocolError, "unexpected message type")
		return nil, "", errUnexpectedPayload
	}

	pubKey := ed25519.PublicKey(authResp.PublicKey)
	signature := authResp.Signature

	// Step 3: Verify signature.
	if !auth.VerifyChallenge(pubKey, nonce, signature) {
		sendAuthFailure(authCtx, conn, "signature verification failed")
		conn.Close(4001, "auth failed")
		return nil, "", errAuthFailed
	}

	// Step 4: Derive address and send success result.
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
	resultData, err := proto.Marshal(resultEnv)
	if err != nil {
		conn.Close(websocket.StatusInternalError, "internal error")
		return nil, "", err
	}
	if err := conn.Write(authCtx, websocket.MessageBinary, resultData); err != nil {
		return nil, "", err
	}

	return pubKey, address, nil
}

// sendAuthFailure sends an AuthResult with success=false to the client.
func sendAuthFailure(ctx context.Context, conn *websocket.Conn, errMsg string) {
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

var (
	errUnexpectedPayload = fmt.Errorf("unexpected payload type: expected AuthResponse")
	errAuthFailed        = fmt.Errorf("authentication failed: invalid signature")
)

// healthHandler returns the current health status of the relay,
// including goroutine count and active connection count.
func healthHandler(h *hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := map[string]int{
			"goroutines":  runtime.NumGoroutine(),
			"connections": h.ClientCount(),
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(status)
	}
}
