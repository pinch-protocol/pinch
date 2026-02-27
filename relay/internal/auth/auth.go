// Package auth provides Ed25519 challenge-response authentication for WebSocket
// clients connecting to the relay. The relay generates a random nonce, the client
// signs it with their Ed25519 private key, and the relay verifies the signature
// before registering the client in the hub routing table.
package auth

import (
	"crypto/ed25519"
	"crypto/rand"

	"github.com/pinch-protocol/pinch/relay/internal/identity"
)

// NonceSize is the size in bytes of the authentication challenge nonce.
const NonceSize = 32

// GenerateChallenge creates a 32-byte random nonce using crypto/rand.
// The nonce is sent to the client as an authentication challenge.
func GenerateChallenge() ([]byte, error) {
	nonce := make([]byte, NonceSize)
	_, err := rand.Read(nonce)
	return nonce, err
}

// VerifyChallenge checks that the given Ed25519 signature is a valid
// signature of the nonce by the given public key.
func VerifyChallenge(pubKey ed25519.PublicKey, nonce, signature []byte) bool {
	if len(pubKey) != ed25519.PublicKeySize {
		return false
	}
	if len(signature) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(pubKey, nonce, signature)
}

// DeriveAddress computes the pinch: address for the given Ed25519 public key
// and relay host. It delegates to the identity package to ensure consistent
// address format across the codebase.
func DeriveAddress(pubKey ed25519.PublicKey, relayHost string) string {
	return identity.GenerateAddress(pubKey, relayHost)
}
