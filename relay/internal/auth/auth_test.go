package auth

import (
	"bytes"
	"crypto/ed25519"
	"testing"

	"github.com/pinch-protocol/pinch/relay/internal/identity"
)

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

	// Create a bogus signature (all zeros).
	badSig := make([]byte, ed25519.SignatureSize)
	if VerifyChallenge(pub, nonce, badSig) {
		t.Error("VerifyChallenge returned true for invalid signature")
	}
}

func TestVerifyChallenge_WrongNonce(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey error: %v", err)
	}

	nonce1, err := GenerateChallenge()
	if err != nil {
		t.Fatalf("GenerateChallenge error: %v", err)
	}

	nonce2, err := GenerateChallenge()
	if err != nil {
		t.Fatalf("GenerateChallenge error: %v", err)
	}

	// Sign nonce1, but verify against nonce2.
	sig := ed25519.Sign(priv, nonce1)
	if VerifyChallenge(pub, nonce2, sig) {
		t.Error("VerifyChallenge returned true for signature of wrong nonce")
	}
}

func TestVerifyChallenge_InvalidKeySize(t *testing.T) {
	nonce, _ := GenerateChallenge()
	badKey := make([]byte, 16) // too short
	sig := make([]byte, ed25519.SignatureSize)
	if VerifyChallenge(badKey, nonce, sig) {
		t.Error("VerifyChallenge returned true for invalid key size")
	}
}

func TestVerifyChallenge_InvalidSignatureSize(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(nil)
	nonce, _ := GenerateChallenge()
	badSig := make([]byte, 32) // too short
	if VerifyChallenge(pub, nonce, badSig) {
		t.Error("VerifyChallenge returned true for invalid signature size")
	}
}

func TestDeriveAddress_ProducesCorrectFormat(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey error: %v", err)
	}

	addr := DeriveAddress(pub, "localhost")

	// Verify it starts with "pinch:" and ends with "@localhost".
	if len(addr) < len("pinch:x@localhost") {
		t.Fatalf("address too short: %q", addr)
	}
	if addr[:6] != "pinch:" {
		t.Errorf("address does not start with 'pinch:': %q", addr)
	}
	if addr[len(addr)-len("@localhost"):] != "@localhost" {
		t.Errorf("address does not end with '@localhost': %q", addr)
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
		t.Errorf("DeriveAddress and identity.GenerateAddress differ:\n  auth:     %q\n  identity: %q", authAddr, identityAddr)
	}
}
