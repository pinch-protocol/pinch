package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	pinchv1 "github.com/pinch-protocol/pinch/gen/go/pinch/v1"
	"github.com/pinch-protocol/pinch/relay/internal/auth"
	"github.com/pinch-protocol/pinch/relay/internal/hub"
	"github.com/pinch-protocol/pinch/relay/internal/identity"
	"github.com/pinch-protocol/pinch/relay/internal/store"
	bolt "go.etcd.io/bbolt"
	"golang.org/x/time/rate"
	"google.golang.org/protobuf/proto"
)

type testServer struct {
	ctx    context.Context
	cancel context.CancelFunc
	hub    *hub.Hub
	server *httptest.Server
}

func newTestServer(t *testing.T, cfg wsConfig) *testServer {
	t.Helper()

	ctx, cancel := context.WithCancel(context.Background())
	h := hub.NewHub(nil, nil, nil)
	go h.Run(ctx)

	r := chi.NewRouter()
	r.Get("/ws", wsHandler(ctx, h, cfg))
	r.Get("/health", healthHandler(h))

	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	t.Cleanup(cancel)

	return &testServer{
		ctx:    ctx,
		cancel: cancel,
		hub:    h,
		server: srv,
	}
}

func wsURL(serverURL string) string {
	return "ws" + strings.TrimPrefix(serverURL, "http") + "/ws"
}

func waitForClientCount(t *testing.T, h *hub.Hub, expected int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if h.ClientCount() == expected {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected %d clients, got %d", expected, h.ClientCount())
}

func newTestKeyRegistry(t *testing.T) *store.KeyRegistry {
	t.Helper()

	f, err := os.CreateTemp(t.TempDir(), "pinchd-keyregistry-*.db")
	if err != nil {
		t.Fatalf("create temp db file: %v", err)
	}
	f.Close()

	db, err := bolt.Open(f.Name(), 0600, nil)
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	kr, err := store.NewKeyRegistry(db)
	if err != nil {
		t.Fatalf("NewKeyRegistry: %v", err)
	}
	return kr
}

func authenticateConnection(t *testing.T, conn *websocket.Conn, priv ed25519.PrivateKey) {
	t.Helper()

	readCtx, readCancel := context.WithTimeout(context.Background(), time.Second)
	defer readCancel()
	messageType, challengeBytes, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read auth challenge: %v", err)
	}
	if messageType != websocket.MessageBinary {
		t.Fatalf("expected binary challenge, got message type %d", messageType)
	}

	env := &pinchv1.Envelope{}
	if err := proto.Unmarshal(challengeBytes, env); err != nil {
		t.Fatalf("decode auth challenge: %v", err)
	}
	challenge := env.GetAuthChallenge()
	if challenge == nil {
		t.Fatalf("expected auth challenge payload, got %+v", env.GetPayload())
	}

	payload := auth.SignPayload(challenge.GetRelayHost(), challenge.GetNonce())
	signature := ed25519.Sign(priv, payload)
	pub := priv.Public().(ed25519.PublicKey)

	response := &pinchv1.Envelope{
		Version: 1,
		Type:    pinchv1.MessageType_MESSAGE_TYPE_AUTH_RESPONSE,
		Payload: &pinchv1.Envelope_AuthResponse{
			AuthResponse: &pinchv1.AuthResponse{
				Version:   1,
				PublicKey: pub,
				Signature: signature,
				Nonce:     challenge.GetNonce(),
			},
		},
	}

	responseBytes, err := proto.Marshal(response)
	if err != nil {
		t.Fatalf("marshal auth response: %v", err)
	}
	writeCtx, writeCancel := context.WithTimeout(context.Background(), time.Second)
	defer writeCancel()
	if err := conn.Write(writeCtx, websocket.MessageBinary, responseBytes); err != nil {
		t.Fatalf("write auth response: %v", err)
	}
}

func readAuthResult(t *testing.T, conn *websocket.Conn) *pinchv1.AuthResult {
	t.Helper()

	readCtx, readCancel := context.WithTimeout(context.Background(), time.Second)
	defer readCancel()
	messageType, resultBytes, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read auth result: %v", err)
	}
	if messageType != websocket.MessageBinary {
		t.Fatalf("expected binary auth result, got message type %d", messageType)
	}

	env := &pinchv1.Envelope{}
	if err := proto.Unmarshal(resultBytes, env); err != nil {
		t.Fatalf("decode auth result: %v", err)
	}
	result := env.GetAuthResult()
	if result == nil {
		t.Fatalf("expected auth result payload, got %+v", env.GetPayload())
	}
	return result
}

func TestWSHandlerAuthenticatesAndRegistersClient(t *testing.T) {
	cfg := wsConfig{
		relayPublicHost:  "relay.example.com",
		allowedOrigins:   nil,
		originPatterns:   nil,
		authChallengeTTL: 10 * time.Second,
		authTimeout:      2 * time.Second,
		nowFn:            time.Now,
	}
	ts := newTestServer(t, cfg)

	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)

	conn, _, err := websocket.Dial(context.Background(), wsURL(ts.server.URL), nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "done") })

	authenticateConnection(t, conn, priv)
	result := readAuthResult(t, conn)
	if !result.GetSuccess() {
		t.Fatalf("expected auth success result, got failure: %s", result.GetErrorMessage())
	}

	expectedAddress := identity.GenerateAddress(pub, "relay.example.com")
	waitForClientCount(t, ts.hub, 1, 2*time.Second)
	if _, ok := ts.hub.LookupClient(expectedAddress); !ok {
		t.Fatalf("expected authenticated client at address %q", expectedAddress)
	}
}

func TestWSHandlerRejectsUnauthenticatedClient(t *testing.T) {
	cfg := wsConfig{
		relayPublicHost:  "relay.example.com",
		authChallengeTTL: 10 * time.Second,
		authTimeout:      100 * time.Millisecond,
		nowFn:            time.Now,
	}
	ts := newTestServer(t, cfg)

	conn, _, err := websocket.Dial(context.Background(), wsURL(ts.server.URL), nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "done") })

	// Read and ignore challenge so server eventually times out waiting for auth response.
	readCtx, readCancel := context.WithTimeout(context.Background(), time.Second)
	_, _, _ = conn.Read(readCtx)
	readCancel()

	waitForClientCount(t, ts.hub, 0, 2*time.Second)
}

func TestWSHandlerRejectsDuplicateAddress(t *testing.T) {
	cfg := wsConfig{
		relayPublicHost:  "relay.example.com",
		authChallengeTTL: 10 * time.Second,
		authTimeout:      2 * time.Second,
		nowFn:            time.Now,
	}
	ts := newTestServer(t, cfg)

	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	priv := ed25519.NewKeyFromSeed(seed)

	conn1, _, err := websocket.Dial(context.Background(), wsURL(ts.server.URL), nil)
	if err != nil {
		t.Fatalf("dial conn1 failed: %v", err)
	}
	t.Cleanup(func() { _ = conn1.Close(websocket.StatusNormalClosure, "done") })
	authenticateConnection(t, conn1, priv)
	result1 := readAuthResult(t, conn1)
	if !result1.GetSuccess() {
		t.Fatalf("expected first auth to succeed, got failure: %s", result1.GetErrorMessage())
	}
	waitForClientCount(t, ts.hub, 1, 2*time.Second)

	conn2, _, err := websocket.Dial(context.Background(), wsURL(ts.server.URL), nil)
	if err != nil {
		t.Fatalf("dial conn2 failed: %v", err)
	}
	t.Cleanup(func() { _ = conn2.Close(websocket.StatusNormalClosure, "done") })
	authenticateConnection(t, conn2, priv)
	result2 := readAuthResult(t, conn2)
	if result2.GetSuccess() {
		t.Fatal("expected second auth result to fail for duplicate address")
	}
	if !strings.Contains(result2.GetErrorMessage(), "address already connected") {
		t.Fatalf("unexpected duplicate-address error message: %q", result2.GetErrorMessage())
	}

	// Duplicate address should not increase active client count.
	waitForClientCount(t, ts.hub, 1, 2*time.Second)
}

func TestWSHandlerRejectsBrowserOriginByDefault(t *testing.T) {
	cfg := wsConfig{
		relayPublicHost:  "relay.example.com",
		authChallengeTTL: 10 * time.Second,
		authTimeout:      2 * time.Second,
		nowFn:            time.Now,
	}
	ts := newTestServer(t, cfg)

	headers := http.Header{}
	headers.Set("Origin", "https://app.example.com")
	_, resp, err := websocket.Dial(context.Background(), wsURL(ts.server.URL), &websocket.DialOptions{
		HTTPHeader: headers,
	})
	if err == nil {
		t.Fatal("expected browser origin dial to fail")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 forbidden, got resp=%v err=%v", resp, err)
	}
}

func TestWSHandlerAllowsConfiguredOrigin(t *testing.T) {
	cfg := wsConfig{
		relayPublicHost: "relay.example.com",
		allowedOrigins: map[string]struct{}{
			"https://app.example.com": {},
		},
		originPatterns:   []string{"https://app.example.com"},
		authChallengeTTL: 10 * time.Second,
		authTimeout:      2 * time.Second,
		nowFn:            time.Now,
	}
	ts := newTestServer(t, cfg)

	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 3)
	}
	priv := ed25519.NewKeyFromSeed(seed)

	headers := http.Header{}
	headers.Set("Origin", "https://app.example.com")
	conn, _, err := websocket.Dial(context.Background(), wsURL(ts.server.URL), &websocket.DialOptions{
		HTTPHeader: headers,
	})
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "done") })

	authenticateConnection(t, conn, priv)
	waitForClientCount(t, ts.hub, 1, 2*time.Second)
}

func TestHealthHandlerAllowsLoopback(t *testing.T) {
	h := hub.NewHub(nil, nil, nil)
	handler := healthHandler(h)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.RemoteAddr = "127.0.0.1:34567"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", rec.Code)
	}
	var payload map[string]int
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("failed to decode health payload: %v", err)
	}
	if _, ok := payload["connections"]; !ok {
		t.Fatalf("expected connections field in health payload: %v", payload)
	}
	if _, ok := payload["goroutines"]; !ok {
		t.Fatalf("expected goroutines field in health payload: %v", payload)
	}
}

func TestHealthHandlerAllowsNonLoopback(t *testing.T) {
	h := hub.NewHub(nil, nil, nil)
	handler := healthHandler(h)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.RemoteAddr = "203.0.113.10:34567"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// External health checks are allowed (required for Railway healthcheck.railway.app).
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for external health check, got %d", rec.Code)
	}
}

func TestRegisterHandlerRateLimitsRequests(t *testing.T) {
	kr := newTestKeyRegistry(t)
	limiter := rate.NewLimiter(1, 1)
	handler := registerHandler(kr, "relay.example.com", limiter)

	pubKey := make([]byte, ed25519.PublicKeySize)
	for i := range pubKey {
		pubKey[i] = byte(i + 1)
	}
	payload := `{"public_key":"` + base64.StdEncoding.EncodeToString(pubKey) + `"}`

	req1 := httptest.NewRequest(http.MethodPost, "/agents/register", strings.NewReader(payload))
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("expected first request to succeed, got %d body=%q", rec1.Code, rec1.Body.String())
	}

	req2 := httptest.NewRequest(http.MethodPost, "/agents/register", strings.NewReader(payload))
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusTooManyRequests {
		t.Fatalf("expected second request to be rate limited, got %d body=%q", rec2.Code, rec2.Body.String())
	}
}

func TestClaimHandlerReturns404WhenTurnstileNotConfigured(t *testing.T) {
	kr := newTestKeyRegistry(t)
	handler := claimHandler(kr, nil)

	req := httptest.NewRequest(http.MethodPost, "/agents/claim", strings.NewReader(`{"claim_code":"ABC","turnstile_token":"tok"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func newMockTurnstileVerifier(t *testing.T, accept bool) *turnstileVerifier {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"success": accept})
	}))
	t.Cleanup(srv.Close)

	v := newTurnstileVerifier("test-secret")
	v.verifyURL = srv.URL
	return v
}

func TestClaimHandlerRejects403OnInvalidTurnstileToken(t *testing.T) {
	kr := newTestKeyRegistry(t)
	v := newMockTurnstileVerifier(t, false)
	handler := claimHandler(kr, v)

	req := httptest.NewRequest(http.MethodPost, "/agents/claim", strings.NewReader(`{"claim_code":"ABC","turnstile_token":"bad"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d body=%q", rec.Code, rec.Body.String())
	}
}

func TestClaimHandlerSuccessWithValidToken(t *testing.T) {
	kr := newTestKeyRegistry(t)
	v := newMockTurnstileVerifier(t, true)

	// Register a pending key first.
	pubKey := make([]byte, ed25519.PublicKeySize)
	for i := range pubKey {
		pubKey[i] = byte(i + 10)
	}
	pubKeyB64 := base64.StdEncoding.EncodeToString(pubKey)
	claimCode, err := kr.RegisterPending(pubKeyB64, "pinch:test@relay.example.com")
	if err != nil {
		t.Fatalf("register pending: %v", err)
	}

	handler := claimHandler(kr, v)
	payload := `{"claim_code":"` + claimCode + `","turnstile_token":"valid"}`
	req := httptest.NewRequest(http.MethodPost, "/agents/claim", strings.NewReader(payload))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%q", rec.Code, rec.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["status"] != "approved" {
		t.Fatalf("expected status=approved, got %q", resp["status"])
	}
	if resp["address"] != "pinch:test@relay.example.com" {
		t.Fatalf("unexpected address: %q", resp["address"])
	}
}

func TestClaimPageHandlerServesSiteKey(t *testing.T) {
	handler := claimPageHandler("test-site-key-123")

	req := httptest.NewRequest(http.MethodGet, "/claim", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "test-site-key-123") {
		t.Fatal("expected site key in response body")
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Fatalf("expected text/html content type, got %q", ct)
	}
}

func TestClaimPageHandlerReturns404WhenNoSiteKey(t *testing.T) {
	handler := claimPageHandler("")

	req := httptest.NewRequest(http.MethodGet, "/claim", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}
