package auth

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"github.com/coder/websocket"
	pinchv1 "github.com/pinch-protocol/pinch/gen/go/pinch/v1"
	"github.com/pinch-protocol/pinch/relay/internal/identity"
	"google.golang.org/protobuf/proto"
)

const (
	// NonceSize is the size in bytes of the authentication challenge nonce.
	NonceSize = 32

	challengeVersion = 1
	signPrefix       = "pinch-auth-v1"
)

var (
	ErrResponseTimeout    = errors.New("authentication response timeout")
	ErrChallengeExpired   = errors.New("authentication challenge expired")
	ErrInvalidMessageType = errors.New("invalid authentication message type")
	ErrInvalidNonce       = errors.New("invalid authentication nonce")
	ErrInvalidSignature   = errors.New("invalid authentication signature")
)

// GenerateChallenge creates a random nonce used in auth challenge messages.
func GenerateChallenge() ([]byte, error) {
	nonce := make([]byte, NonceSize)
	_, err := rand.Read(nonce)
	return nonce, err
}

// VerifyChallenge verifies an Ed25519 signature over the given payload.
func VerifyChallenge(pubKey ed25519.PublicKey, payload, signature []byte) bool {
	if len(pubKey) != ed25519.PublicKeySize {
		return false
	}
	if len(signature) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(pubKey, payload, signature)
}

// DeriveAddress computes the pinch: address for the given Ed25519 public key.
func DeriveAddress(pubKey ed25519.PublicKey, relayHost string) string {
	return identity.GenerateAddress(pubKey, relayHost)
}

// SignPayload builds the deterministic byte payload signed by the client:
// pinch-auth-v1\0<relay_host>\0<nonce>
func SignPayload(relayHost string, nonce []byte) []byte {
	payload := make([]byte, 0, len(signPrefix)+1+len(relayHost)+1+len(nonce))
	payload = append(payload, signPrefix...)
	payload = append(payload, 0)
	payload = append(payload, relayHost...)
	payload = append(payload, 0)
	payload = append(payload, nonce...)
	return payload
}

// Authenticate performs relay-side challenge-response verification and returns
// the verified public key and derived pinch address on success.
func Authenticate(
	ctx context.Context,
	conn *websocket.Conn,
	relayHost string,
	challengeTTL time.Duration,
	responseTimeout time.Duration,
	nowFn func() time.Time,
) (ed25519.PublicKey, string, error) {
	if nowFn == nil {
		nowFn = time.Now
	}
	if challengeTTL <= 0 {
		challengeTTL = 10 * time.Second
	}
	if responseTimeout <= 0 {
		responseTimeout = 10 * time.Second
	}

	nonce, err := GenerateChallenge()
	if err != nil {
		return nil, "", fmt.Errorf("generate auth nonce: %w", err)
	}

	issuedAt := nowFn()
	expiresAt := issuedAt.Add(challengeTTL)
	challenge := &pinchv1.Envelope{
		Version:   challengeVersion,
		Type:      pinchv1.MessageType_MESSAGE_TYPE_AUTH_CHALLENGE,
		Timestamp: issuedAt.UnixMilli(),
		Payload: &pinchv1.Envelope_AuthChallenge{
			AuthChallenge: &pinchv1.AuthChallenge{
				Version:     challengeVersion,
				Nonce:       nonce,
				IssuedAtMs:  issuedAt.UnixMilli(),
				ExpiresAtMs: expiresAt.UnixMilli(),
				RelayHost:   relayHost,
			},
		},
	}

	challengeBytes, err := proto.Marshal(challenge)
	if err != nil {
		return nil, "", fmt.Errorf("marshal auth challenge: %w", err)
	}

	writeCtx, writeCancel := context.WithTimeout(ctx, responseTimeout)
	err = conn.Write(writeCtx, websocket.MessageBinary, challengeBytes)
	writeCancel()
	if err != nil {
		return nil, "", fmt.Errorf("send auth challenge: %w", err)
	}

	readCtx, readCancel := context.WithTimeout(ctx, responseTimeout)
	messageType, responseBytes, err := conn.Read(readCtx)
	readCancel()
	if err != nil {
		if errors.Is(readCtx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
			return nil, "", ErrResponseTimeout
		}
		return nil, "", fmt.Errorf("read auth response: %w", err)
	}
	if messageType != websocket.MessageBinary {
		return nil, "", fmt.Errorf("%w: expected binary, got %d", ErrInvalidMessageType, messageType)
	}

	responseEnv := &pinchv1.Envelope{}
	if err := proto.Unmarshal(responseBytes, responseEnv); err != nil {
		return nil, "", fmt.Errorf("decode auth response: %w", err)
	}
	if responseEnv.GetType() != pinchv1.MessageType_MESSAGE_TYPE_AUTH_RESPONSE {
		return nil, "", fmt.Errorf("%w: got %s", ErrInvalidMessageType, responseEnv.GetType().String())
	}

	response, ok := responseEnv.GetPayload().(*pinchv1.Envelope_AuthResponse)
	if !ok || response.AuthResponse == nil {
		return nil, "", fmt.Errorf("%w: missing auth_response payload", ErrInvalidMessageType)
	}

	ar := response.AuthResponse
	if ar.GetVersion() != challengeVersion {
		return nil, "", fmt.Errorf("%w: unsupported version %d", ErrInvalidMessageType, ar.GetVersion())
	}
	if len(ar.PublicKey) != ed25519.PublicKeySize {
		return nil, "", fmt.Errorf("%w: expected %d-byte public key, got %d", ErrInvalidSignature, ed25519.PublicKeySize, len(ar.PublicKey))
	}
	if len(ar.Signature) != ed25519.SignatureSize {
		return nil, "", fmt.Errorf("%w: expected %d-byte signature, got %d", ErrInvalidSignature, ed25519.SignatureSize, len(ar.Signature))
	}
	if len(ar.Nonce) != len(nonce) {
		return nil, "", fmt.Errorf("%w: expected %d-byte nonce, got %d", ErrInvalidNonce, len(nonce), len(ar.Nonce))
	}
	if nowFn().After(expiresAt) {
		return nil, "", ErrChallengeExpired
	}
	if !bytes.Equal(ar.Nonce, nonce) {
		return nil, "", ErrInvalidNonce
	}

	pubKey := ed25519.PublicKey(ar.PublicKey)
	if !VerifyChallenge(pubKey, SignPayload(relayHost, nonce), ar.Signature) {
		return nil, "", ErrInvalidSignature
	}

	return pubKey, DeriveAddress(pubKey, relayHost), nil
}
