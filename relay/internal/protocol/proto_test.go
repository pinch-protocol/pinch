package protocol_test

import (
	"testing"
	"time"

	pinchv1 "github.com/pinch-protocol/pinch/gen/go/pinch/v1"
	"google.golang.org/protobuf/proto"
)

func TestEnvelopeRoundTrip(t *testing.T) {
	messageID := []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
	senderPubKey := make([]byte, 32)
	for i := range senderPubKey {
		senderPubKey[i] = byte(i)
	}
	nonce := make([]byte, 24)
	for i := range nonce {
		nonce[i] = byte(i + 100)
	}
	ciphertext := []byte("encrypted-data-here")

	original := &pinchv1.Envelope{
		Version:     1,
		FromAddress: "pinch:abc123@relay.example.com",
		ToAddress:   "pinch:def456@relay.example.com",
		Type:        pinchv1.MessageType_MESSAGE_TYPE_MESSAGE,
		MessageId:   messageID,
		Timestamp:   time.Now().UnixMilli(),
		Payload: &pinchv1.Envelope_Encrypted{
			Encrypted: &pinchv1.EncryptedPayload{
				Nonce:           nonce,
				Ciphertext:      ciphertext,
				SenderPublicKey: senderPubKey,
			},
		},
	}

	// Serialize
	data, err := proto.Marshal(original)
	if err != nil {
		t.Fatalf("failed to marshal envelope: %v", err)
	}

	// Deserialize
	decoded := &pinchv1.Envelope{}
	if err := proto.Unmarshal(data, decoded); err != nil {
		t.Fatalf("failed to unmarshal envelope: %v", err)
	}

	// Verify all fields
	if decoded.Version != original.Version {
		t.Errorf("version mismatch: got %d, want %d", decoded.Version, original.Version)
	}
	if decoded.FromAddress != original.FromAddress {
		t.Errorf("from_address mismatch: got %q, want %q", decoded.FromAddress, original.FromAddress)
	}
	if decoded.ToAddress != original.ToAddress {
		t.Errorf("to_address mismatch: got %q, want %q", decoded.ToAddress, original.ToAddress)
	}
	if decoded.Type != original.Type {
		t.Errorf("type mismatch: got %d, want %d", decoded.Type, original.Type)
	}
	if len(decoded.MessageId) != len(original.MessageId) {
		t.Errorf("message_id length mismatch: got %d, want %d", len(decoded.MessageId), len(original.MessageId))
	}
	if decoded.Timestamp != original.Timestamp {
		t.Errorf("timestamp mismatch: got %d, want %d", decoded.Timestamp, original.Timestamp)
	}

	// Verify oneof payload
	enc, ok := decoded.Payload.(*pinchv1.Envelope_Encrypted)
	if !ok {
		t.Fatal("payload is not EncryptedPayload")
	}
	if len(enc.Encrypted.Nonce) != 24 {
		t.Errorf("nonce length: got %d, want 24", len(enc.Encrypted.Nonce))
	}
	if string(enc.Encrypted.Ciphertext) != string(ciphertext) {
		t.Errorf("ciphertext mismatch")
	}
	if len(enc.Encrypted.SenderPublicKey) != 32 {
		t.Errorf("sender_public_key length: got %d, want 32", len(enc.Encrypted.SenderPublicKey))
	}
}

func TestPlaintextPayloadRoundTrip(t *testing.T) {
	original := &pinchv1.PlaintextPayload{
		Version:     1,
		Sequence:    42,
		Timestamp:   time.Now().UnixMilli(),
		Content:     []byte("hello"),
		ContentType: "text/plain",
	}

	// Serialize
	data, err := proto.Marshal(original)
	if err != nil {
		t.Fatalf("failed to marshal plaintext payload: %v", err)
	}

	// Deserialize
	decoded := &pinchv1.PlaintextPayload{}
	if err := proto.Unmarshal(data, decoded); err != nil {
		t.Fatalf("failed to unmarshal plaintext payload: %v", err)
	}

	// Verify all fields
	if decoded.Version != 1 {
		t.Errorf("version: got %d, want 1", decoded.Version)
	}
	if decoded.Sequence != 42 {
		t.Errorf("sequence: got %d, want 42", decoded.Sequence)
	}
	if decoded.Timestamp != original.Timestamp {
		t.Errorf("timestamp mismatch: got %d, want %d", decoded.Timestamp, original.Timestamp)
	}
	if string(decoded.Content) != "hello" {
		t.Errorf("content: got %q, want %q", string(decoded.Content), "hello")
	}
	if decoded.ContentType != "text/plain" {
		t.Errorf("content_type: got %q, want %q", decoded.ContentType, "text/plain")
	}
}

func TestHandshakePayload(t *testing.T) {
	signingKey := make([]byte, 32)
	encryptionKey := make([]byte, 32)
	for i := range signingKey {
		signingKey[i] = byte(i)
		encryptionKey[i] = byte(i + 32)
	}

	original := &pinchv1.Envelope{
		Version:     1,
		FromAddress: "pinch:abc123@relay.example.com",
		Type:        pinchv1.MessageType_MESSAGE_TYPE_HANDSHAKE,
		Payload: &pinchv1.Envelope_Handshake{
			Handshake: &pinchv1.Handshake{
				Version:       1,
				SigningKey:    signingKey,
				EncryptionKey: encryptionKey,
			},
		},
	}

	data, err := proto.Marshal(original)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	decoded := &pinchv1.Envelope{}
	if err := proto.Unmarshal(data, decoded); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	hs, ok := decoded.Payload.(*pinchv1.Envelope_Handshake)
	if !ok {
		t.Fatal("payload is not Handshake")
	}
	if hs.Handshake.Version != 1 {
		t.Errorf("handshake version: got %d, want 1", hs.Handshake.Version)
	}
	if len(hs.Handshake.SigningKey) != 32 {
		t.Errorf("signing_key length: got %d, want 32", len(hs.Handshake.SigningKey))
	}
	if len(hs.Handshake.EncryptionKey) != 32 {
		t.Errorf("encryption_key length: got %d, want 32", len(hs.Handshake.EncryptionKey))
	}
}

func TestAuthChallengePayload(t *testing.T) {
	nonce := make([]byte, 32)
	for i := range nonce {
		nonce[i] = byte(i + 11)
	}

	now := time.Now().UnixMilli()
	original := &pinchv1.Envelope{
		Version:   1,
		Type:      pinchv1.MessageType_MESSAGE_TYPE_AUTH_CHALLENGE,
		Timestamp: now,
		Payload: &pinchv1.Envelope_AuthChallenge{
			AuthChallenge: &pinchv1.AuthChallenge{
				Version:     1,
				Nonce:       nonce,
				IssuedAtMs:  now,
				ExpiresAtMs: now + 10_000,
				RelayHost:   "relay.example.com",
			},
		},
	}

	data, err := proto.Marshal(original)
	if err != nil {
		t.Fatalf("failed to marshal auth challenge: %v", err)
	}

	decoded := &pinchv1.Envelope{}
	if err := proto.Unmarshal(data, decoded); err != nil {
		t.Fatalf("failed to unmarshal auth challenge: %v", err)
	}

	ac, ok := decoded.Payload.(*pinchv1.Envelope_AuthChallenge)
	if !ok {
		t.Fatal("payload is not AuthChallenge")
	}
	if ac.AuthChallenge.Version != 1 {
		t.Errorf("auth challenge version: got %d, want 1", ac.AuthChallenge.Version)
	}
	if len(ac.AuthChallenge.Nonce) != 32 {
		t.Errorf("nonce length: got %d, want 32", len(ac.AuthChallenge.Nonce))
	}
	if ac.AuthChallenge.IssuedAtMs != now {
		t.Errorf("issued_at_ms mismatch: got %d, want %d", ac.AuthChallenge.IssuedAtMs, now)
	}
	if ac.AuthChallenge.ExpiresAtMs != now+10_000 {
		t.Errorf("expires_at_ms mismatch: got %d, want %d", ac.AuthChallenge.ExpiresAtMs, now+10_000)
	}
	if ac.AuthChallenge.RelayHost != "relay.example.com" {
		t.Errorf("relay_host mismatch: got %q", ac.AuthChallenge.RelayHost)
	}
}

func TestAuthResponsePayload(t *testing.T) {
	pub := make([]byte, 32)
	sig := make([]byte, 64)
	nonce := make([]byte, 32)
	for i := range pub {
		pub[i] = byte(i)
		nonce[i] = byte(100 + i)
	}
	for i := range sig {
		sig[i] = byte(200 + (i % 32))
	}

	original := &pinchv1.Envelope{
		Version: 1,
		Type:    pinchv1.MessageType_MESSAGE_TYPE_AUTH_RESPONSE,
		Payload: &pinchv1.Envelope_AuthResponse{
			AuthResponse: &pinchv1.AuthResponse{
				Version:   1,
				PublicKey: pub,
				Signature: sig,
				Nonce:     nonce,
			},
		},
	}

	data, err := proto.Marshal(original)
	if err != nil {
		t.Fatalf("failed to marshal auth response: %v", err)
	}

	decoded := &pinchv1.Envelope{}
	if err := proto.Unmarshal(data, decoded); err != nil {
		t.Fatalf("failed to unmarshal auth response: %v", err)
	}

	ar, ok := decoded.Payload.(*pinchv1.Envelope_AuthResponse)
	if !ok {
		t.Fatal("payload is not AuthResponse")
	}
	if ar.AuthResponse.Version != 1 {
		t.Errorf("auth response version: got %d, want 1", ar.AuthResponse.Version)
	}
	if len(ar.AuthResponse.PublicKey) != 32 {
		t.Errorf("public_key length: got %d, want 32", len(ar.AuthResponse.PublicKey))
	}
	if len(ar.AuthResponse.Signature) != 64 {
		t.Errorf("signature length: got %d, want 64", len(ar.AuthResponse.Signature))
	}
	if len(ar.AuthResponse.Nonce) != 32 {
		t.Errorf("nonce length: got %d, want 32", len(ar.AuthResponse.Nonce))
	}
}

func TestMessageTypeEnumValues(t *testing.T) {
	tests := []struct {
		name  string
		value pinchv1.MessageType
		want  int32
	}{
		{"UNSPECIFIED", pinchv1.MessageType_MESSAGE_TYPE_UNSPECIFIED, 0},
		{"HANDSHAKE", pinchv1.MessageType_MESSAGE_TYPE_HANDSHAKE, 1},
		{"AUTH_CHALLENGE", pinchv1.MessageType_MESSAGE_TYPE_AUTH_CHALLENGE, 2},
		{"AUTH_RESPONSE", pinchv1.MessageType_MESSAGE_TYPE_AUTH_RESPONSE, 3},
		{"MESSAGE", pinchv1.MessageType_MESSAGE_TYPE_MESSAGE, 4},
		{"DELIVERY_CONFIRM", pinchv1.MessageType_MESSAGE_TYPE_DELIVERY_CONFIRM, 5},
		{"CONNECTION_REQUEST", pinchv1.MessageType_MESSAGE_TYPE_CONNECTION_REQUEST, 6},
		{"CONNECTION_RESPONSE", pinchv1.MessageType_MESSAGE_TYPE_CONNECTION_RESPONSE, 7},
		{"HEARTBEAT", pinchv1.MessageType_MESSAGE_TYPE_HEARTBEAT, 8},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if int32(tt.value) != tt.want {
				t.Errorf("MessageType %s: got %d, want %d", tt.name, int32(tt.value), tt.want)
			}
		})
	}
}
