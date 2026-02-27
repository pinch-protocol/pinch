package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/time/rate"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	pinchv1 "github.com/pinch-protocol/pinch/gen/go/pinch/v1"
	"github.com/pinch-protocol/pinch/relay/internal/auth"
	"github.com/pinch-protocol/pinch/relay/internal/hub"
	"github.com/pinch-protocol/pinch/relay/internal/store"
	"google.golang.org/protobuf/proto"
)

type wsConfig struct {
	relayPublicHost  string
	allowedOrigins   map[string]struct{}
	originPatterns   []string
	authChallengeTTL time.Duration
	authTimeout      time.Duration
	nowFn            func() time.Time
}

func main() {
	port := os.Getenv("PINCH_RELAY_PORT")
	if port == "" {
		port = "8080"
	}
	publicHost := os.Getenv("PINCH_RELAY_PUBLIC_HOST")
	if publicHost == "" {
		slog.Error("missing required PINCH_RELAY_PUBLIC_HOST")
		os.Exit(1)
	}
	allowedOrigins, originPatterns, err := parseAllowedOrigins(os.Getenv("PINCH_RELAY_ALLOWED_ORIGINS"))
	if err != nil {
		slog.Error("invalid PINCH_RELAY_ALLOWED_ORIGINS", "error", err)
		os.Exit(1)
	}

	dbPath := os.Getenv("PINCH_RELAY_DB")
	if dbPath == "" {
		dbPath = "./pinch-relay.db"
	}

	queueMax := 1000
	if v := os.Getenv("PINCH_RELAY_QUEUE_MAX"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			queueMax = n
		}
	}

	queueTTLHours := 168 // 7 days
	if v := os.Getenv("PINCH_RELAY_QUEUE_TTL"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			queueTTLHours = n
		}
	}

	rateLimit := 1.0 // messages per second (sustained)
	if v := os.Getenv("PINCH_RELAY_RATE_LIMIT"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			rateLimit = f
		}
	}

	rateBurst := 10
	if v := os.Getenv("PINCH_RELAY_RATE_BURST"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			rateBurst = n
		}
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

	queueTTL := time.Duration(queueTTLHours) * time.Hour
	mq, err := store.NewMessageQueue(db, queueMax, queueTTL)
	if err != nil {
		slog.Error("failed to initialize message queue", "error", err)
		os.Exit(1)
	}
	slog.Info("message queue ready", "maxPerAgent", queueMax, "ttl", queueTTL)
	mq.StartSweep(ctx)

	rl := hub.NewRateLimiter(rate.Limit(rateLimit), rateBurst)
	slog.Info("rate limiter ready", "rate", rateLimit, "burst", rateBurst)

	h := hub.NewHub(blockStore, mq, rl)
	go h.Run(ctx)

	r := chi.NewRouter()
	r.Get("/ws", wsHandler(ctx, h, wsConfig{
		relayPublicHost:  publicHost,
		allowedOrigins:   allowedOrigins,
		originPatterns:   originPatterns,
		authChallengeTTL: 10 * time.Second,
		authTimeout:      10 * time.Second,
		nowFn:            time.Now,
	}))
	r.Get("/health", healthHandler(h))

	srv := &http.Server{
		Addr:    ":" + port,
		Handler: r,
	}

	go func() {
		slog.Info("relay starting", "port", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down relay")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown error", "error", err)
	}
	slog.Info("relay stopped")
}

// wsHandler handles WebSocket upgrade requests and performs challenge-response
// authentication before registering the client in the hub.
func wsHandler(serverCtx context.Context, h *hub.Hub, cfg wsConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isOriginAllowed(r.Header.Get("Origin"), cfg.allowedOrigins) {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}

		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			OriginPatterns: cfg.originPatterns,
		})
		if err != nil {
			slog.Error("websocket accept error", "error", err)
			return
		}

		pubKey, address, err := auth.Authenticate(
			serverCtx,
			conn,
			cfg.relayPublicHost,
			cfg.authChallengeTTL,
			cfg.authTimeout,
			cfg.nowFn,
		)
		if err != nil {
			slog.Warn("authentication failed", "error", err)
			_ = sendAuthResult(conn, false, "", "authentication failed")
			_ = conn.Close(websocket.StatusPolicyViolation, "authentication failed")
			return
		}

		client := hub.NewClient(h, conn, address, pubKey, serverCtx)
		if err := h.Register(client); err != nil {
			slog.Warn("registration failed", "address", address, "error", err)
			client.Close()
			_ = sendAuthResult(conn, false, "", "address already connected")
			_ = conn.Close(websocket.StatusPolicyViolation, "address already connected")
			return
		}

		if err := sendAuthResult(conn, true, address, ""); err != nil {
			slog.Warn("failed to send auth result", "address", address, "error", err)
			h.Unregister(client)
			_ = conn.Close(websocket.StatusInternalError, "authentication acknowledgment failed")
			return
		}

		slog.Info("client authenticated", "address", address)
		go client.ReadPump()
		go client.WritePump()
		go client.HeartbeatLoop()
	}
}

func sendAuthResult(conn *websocket.Conn, success bool, assignedAddress, errorMessage string) error {
	env := &pinchv1.Envelope{
		Version: 1,
		Type:    pinchv1.MessageType_MESSAGE_TYPE_AUTH_RESULT,
		Payload: &pinchv1.Envelope_AuthResult{
			AuthResult: &pinchv1.AuthResult{
				Success:         success,
				ErrorMessage:    errorMessage,
				AssignedAddress: assignedAddress,
			},
		},
	}
	data, err := proto.Marshal(env)
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return conn.Write(writeCtx, websocket.MessageBinary, data)
}

// healthHandler returns the current health status of the relay,
// including goroutine count and active connection count.
func healthHandler(h *hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRemoteAddr(r.RemoteAddr) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		status := map[string]int{
			"goroutines":  runtime.NumGoroutine(),
			"connections": h.ClientCount(),
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(status)
	}
}

func parseAllowedOrigins(raw string) (map[string]struct{}, []string, error) {
	allowed := make(map[string]struct{})
	if strings.TrimSpace(raw) == "" {
		return allowed, nil, nil
	}

	parts := strings.Split(raw, ",")
	patterns := make([]string, 0, len(parts))
	for _, part := range parts {
		origin, err := canonicalOrigin(part)
		if err != nil {
			return nil, nil, err
		}
		if origin == "" {
			continue
		}
		allowed[origin] = struct{}{}
		patterns = append(patterns, origin)
	}
	return allowed, patterns, nil
}

func isOriginAllowed(originHeader string, allowed map[string]struct{}) bool {
	if originHeader == "" {
		return true
	}
	origin, err := canonicalOrigin(originHeader)
	if err != nil {
		return false
	}
	_, ok := allowed[origin]
	return ok
}

func canonicalOrigin(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", nil
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", err
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("origin must include scheme and host")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", errors.New("origin must not include a path")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("origin must not include query or fragment")
	}
	return strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host), nil
}

func isLoopbackRemoteAddr(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
