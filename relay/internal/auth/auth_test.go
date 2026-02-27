package auth

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	pinchv1 "github.com/pinch-protocol/pinch/gen/go/pinch/v1"
	"github.com/pinch-protocol/pinch/relay/internal/identity"
	"google.golang.org/protobuf/proto"
)

type authResult struct {
	pubKey  ed25519.PublicKey
	address string
	err     error
}

func startAuthHarness(
	t *testing.T,
	relayHost string,
	challengeTTL time.Duration,
	responseTimeout time.Duration,
	nowFn func() time.Time,
) (wsURL string, resultCh <-chan authResult) {
	t.Helper()

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	results := make(chan authResult, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			results <- authResult{err: err}
			return
		}
		pubKey, address, err := Authenticate(ctx, conn, relayHost, challengeTTL, responseTimeout, nowFn)
		results <- authResult{pubKey: pubKey, address: address, err: err}
		_ = conn.Close(websocket.StatusNormalClosure, "done")
	})

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	wsURL = "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	return wsURL, results
}

func waitForResult(t *testing.T, ch <-chan authResult) authResult {
	t.Helper()
	select {
	case result := <-ch:
		return result
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for auth result")
		return authResult{}
	}
}

func readChallenge(t *testing.T, conn *websocket.Conn) *pinchv1.AuthChallenge {
	t.Helper()

	readCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	messageType, payload, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("failed to read challenge: %v", err)
	}
	if messageType != websocket.MessageBinary {
		t.Fatalf("expected binary challenge, got message type %d", messageType)
	}

	env := &pinchv1.Envelope{}
	if err := proto.Unmarshal(payload, env); err != nil {
		t.Fatalf("failed to decode challenge envelope: %v", err)
	}
	challenge, ok := env.Payload.(*pinchv1.Envelope_AuthChallenge)
	if !ok {
		t.Fatalf("expected auth_challenge payload, got %T", env.Payload)
	}
	return challenge.AuthChallenge
}

func writeEnvelope(t *testing.T, conn *websocket.Conn, env *pinchv1.Envelope) {
	t.Helper()

	data, err := proto.Marshal(env)
	if err != nil {
		t.Fatalf("failed to marshal envelope: %v", err)
	}
	writeCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := conn.Write(writeCtx, websocket.MessageBinary, data); err != nil {
		t.Fatalf("failed to write envelope: %v", err)
	}
}

func buildValidAuthResponse(relayHost string, challenge *pinchv1.AuthChallenge, priv ed25519.PrivateKey) *pinchv1.Envelope {
	payload := SignPayload(relayHost, challenge.Nonce)
	signature := ed25519.Sign(priv, payload)
	pub := priv.Public().(ed25519.PublicKey)
	return &pinchv1.Envelope{
		Version: 1,
		Type:    pinchv1.MessageType_MESSAGE_TYPE_AUTH_RESPONSE,
		Payload: &pinchv1.Envelope_AuthResponse{
			AuthResponse: &pinchv1.AuthResponse{
				Version:   1,
				PublicKey: pub,
				Signature: signature,
				Nonce:     challenge.Nonce,
			},
		},
	}
}

func TestGenerateChallenge_Returns32Bytes(t *testing.T) {
	nonce, err := GenerateChallenge()
	if err != nil {
		t.Fatalf("GenerateChallenge() error: %v", err)
	}
	if len(nonce) != NonceSize {
		t.Errorf("expected nonce length %d, got %d", NonceSize, len(nonce))
	}
}

func TestGenerateChallenge_ProducesDifferentNonces(t *testing.T) {
	nonce1, err := GenerateChallenge()
	if err != nil {
		t.Fatalf("GenerateChallenge() first call error: %v", err)
	}
	nonce2, err := GenerateChallenge()
	if err != nil {
		t.Fatalf("GenerateChallenge() second call error: %v", err)
	}
	if bytes.Equal(nonce1, nonce2) {
		t.Error("two calls to GenerateChallenge produced identical nonces")
	}
}

func TestVerifyChallenge_ValidSignature(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey error: %v", err)
	}

	nonce, err := GenerateChallenge()
	if err != nil {
		t.Fatalf("GenerateChallenge error: %v", err)
	}

	sig := ed25519.Sign(priv, nonce)
	if !VerifyChallenge(pub, nonce, sig) {
		t.Error("VerifyChallenge returned false for valid signature")
	}
}

func TestVerifyChallenge_WrongSignature(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey error: %v", err)
	}

	nonce, err := GenerateChallenge()
	if err != nil {
		t.Fatalf("GenerateChallenge error: %v", err)
	}

	badSig := make([]byte, ed25519.SignatureSize)
	if VerifyChallenge(pub, nonce, badSig) {
		t.Error("VerifyChallenge returned true for invalid signature")
	}
}

func TestVerifyChallenge_InvalidKeySize(t *testing.T) {
	nonce, _ := GenerateChallenge()
	badKey := make([]byte, 16)
	sig := make([]byte, ed25519.SignatureSize)
	if VerifyChallenge(badKey, nonce, sig) {
		t.Error("VerifyChallenge returned true for invalid key size")
	}
}

func TestVerifyChallenge_InvalidSignatureSize(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(nil)
	nonce, _ := GenerateChallenge()
	badSig := make([]byte, 32)
	if VerifyChallenge(pub, nonce, badSig) {
		t.Error("VerifyChallenge returned true for invalid signature size")
	}
}

func TestDeriveAddress_MatchesIdentityPackage(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey error: %v", err)
	}

	authAddr := DeriveAddress(pub, "relay.example.com")
	identityAddr := identity.GenerateAddress(pub, "relay.example.com")
	if authAddr != identityAddr {
		t.Errorf("DeriveAddress and identity.GenerateAddress differ: auth=%q identity=%q", authAddr, identityAddr)
	}
}

func TestAuthenticateSuccess(t *testing.T) {
	relayHost := "relay.example.com"
	wsURL, results := startAuthHarness(t, relayHost, 10*time.Second, 2*time.Second, time.Now)

	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)

	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "done") })

	challenge := readChallenge(t, conn)
	resp := buildValidAuthResponse(relayHost, challenge, priv)
	writeEnvelope(t, conn, resp)

	result := waitForResult(t, results)
	if result.err != nil {
		t.Fatalf("authenticate returned error: %v", result.err)
	}
	want := identity.GenerateAddress(pub, relayHost)
	if result.address != want {
		t.Fatalf("address mismatch: got %q, want %q", result.address, want)
	}
	if !bytes.Equal(result.pubKey, pub) {
		t.Fatalf("public key mismatch")
	}
}

func TestAuthenticateRejectsInvalidSignature(t *testing.T) {
	relayHost := "relay.example.com"
	wsURL, results := startAuthHarness(t, relayHost, 10*time.Second, 2*time.Second, time.Now)

	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	priv := ed25519.NewKeyFromSeed(seed)

	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "done") })

	challenge := readChallenge(t, conn)
	resp := buildValidAuthResponse(relayHost, challenge, priv)
	resp.GetAuthResponse().Signature[0] ^= 0xFF
	writeEnvelope(t, conn, resp)

	result := waitForResult(t, results)
	if result.err == nil || !strings.Contains(result.err.Error(), "signature") {
		t.Fatalf("expected signature validation error, got %v", result.err)
	}
}

func TestAuthenticateRejectsWrongMessageType(t *testing.T) {
	relayHost := "relay.example.com"
	wsURL, results := startAuthHarness(t, relayHost, 10*time.Second, 2*time.Second, time.Now)

	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "done") })

	_ = readChallenge(t, conn)
	writeEnvelope(t, conn, &pinchv1.Envelope{
		Version: 1,
		Type:    pinchv1.MessageType_MESSAGE_TYPE_MESSAGE,
	})

	result := waitForResult(t, results)
	if result.err == nil || !strings.Contains(result.err.Error(), "message type") {
		t.Fatalf("expected message type error, got %v", result.err)
	}
}

func TestAuthenticateRejectsNonceMismatch(t *testing.T) {
	relayHost := "relay.example.com"
	wsURL, results := startAuthHarness(t, relayHost, 10*time.Second, 2*time.Second, time.Now)

	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	priv := ed25519.NewKeyFromSeed(seed)

	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "done") })

	challenge := readChallenge(t, conn)
	resp := buildValidAuthResponse(relayHost, challenge, priv)
	resp.GetAuthResponse().Nonce[0] ^= 0xAB
	writeEnvelope(t, conn, resp)

	result := waitForResult(t, results)
	if result.err == nil || !strings.Contains(result.err.Error(), "nonce") {
		t.Fatalf("expected nonce mismatch error, got %v", result.err)
	}
}

func TestAuthenticateRejectsExpiredChallenge(t *testing.T) {
	relayHost := "relay.example.com"
	var mu sync.Mutex
	now := time.Now()
	nowFn := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	advance := func(d time.Duration) {
		mu.Lock()
		defer mu.Unlock()
		now = now.Add(d)
	}

	wsURL, results := startAuthHarness(t, relayHost, 10*time.Millisecond, 2*time.Second, nowFn)

	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	priv := ed25519.NewKeyFromSeed(seed)

	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "done") })

	challenge := readChallenge(t, conn)
	advance(time.Second)
	writeEnvelope(t, conn, buildValidAuthResponse(relayHost, challenge, priv))

	result := waitForResult(t, results)
	if result.err == nil || !strings.Contains(result.err.Error(), "expired") {
		t.Fatalf("expected expired challenge error, got %v", result.err)
	}
}

func TestAuthenticateTimesOutMissingResponse(t *testing.T) {
	relayHost := "relay.example.com"
	wsURL, results := startAuthHarness(t, relayHost, 10*time.Second, 50*time.Millisecond, time.Now)

	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "done") })

	_ = readChallenge(t, conn)

	result := waitForResult(t, results)
	if result.err == nil || !strings.Contains(result.err.Error(), "timeout") {
		t.Fatalf("expected timeout error, got %v", result.err)
	}
}
