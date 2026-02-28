import type { GenEnum, GenFile, GenMessage } from "@bufbuild/protobuf/codegenv2";
import type { Message } from "@bufbuild/protobuf";
/**
 * Describes the file pinch/v1/envelope.proto.
 */
export declare const file_pinch_v1_envelope: GenFile;
/**
 * Envelope is the outer wire message. The relay can read this for routing
 * but never sees the encrypted inner payload.
 *
 * @generated from message pinch.v1.Envelope
 */
export type Envelope = Message<"pinch.v1.Envelope"> & {
    /**
     * @generated from field: uint32 version = 1;
     */
    version: number;
    /**
     * @generated from field: string from_address = 2;
     */
    fromAddress: string;
    /**
     * @generated from field: string to_address = 3;
     */
    toAddress: string;
    /**
     * @generated from field: pinch.v1.MessageType type = 4;
     */
    type: MessageType;
    /**
     * @generated from field: bytes message_id = 5;
     */
    messageId: Uint8Array;
    /**
     * @generated from field: int64 timestamp = 6;
     */
    timestamp: bigint;
    /**
     * @generated from oneof pinch.v1.Envelope.payload
     */
    payload: {
        /**
         * @generated from field: pinch.v1.EncryptedPayload encrypted = 10;
         */
        value: EncryptedPayload;
        case: "encrypted";
    } | {
        /**
         * @generated from field: pinch.v1.Handshake handshake = 11;
         */
        value: Handshake;
        case: "handshake";
    } | {
        /**
         * @generated from field: pinch.v1.Heartbeat heartbeat = 12;
         */
        value: Heartbeat;
        case: "heartbeat";
    } | {
        /**
         * @generated from field: pinch.v1.AuthChallenge auth_challenge = 13;
         */
        value: AuthChallenge;
        case: "authChallenge";
    } | {
        /**
         * @generated from field: pinch.v1.AuthResponse auth_response = 14;
         */
        value: AuthResponse;
        case: "authResponse";
    } | {
        /**
         * @generated from field: pinch.v1.AuthResult auth_result = 15;
         */
        value: AuthResult;
        case: "authResult";
    } | {
        /**
         * @generated from field: pinch.v1.ConnectionRequest connection_request = 16;
         */
        value: ConnectionRequest;
        case: "connectionRequest";
    } | {
        /**
         * @generated from field: pinch.v1.ConnectionResponse connection_response = 17;
         */
        value: ConnectionResponse;
        case: "connectionResponse";
    } | {
        /**
         * @generated from field: pinch.v1.ConnectionRevoke connection_revoke = 18;
         */
        value: ConnectionRevoke;
        case: "connectionRevoke";
    } | {
        /**
         * @generated from field: pinch.v1.BlockNotification block_notification = 19;
         */
        value: BlockNotification;
        case: "blockNotification";
    } | {
        /**
         * @generated from field: pinch.v1.UnblockNotification unblock_notification = 20;
         */
        value: UnblockNotification;
        case: "unblockNotification";
    } | {
        /**
         * @generated from field: pinch.v1.DeliveryConfirm delivery_confirm = 21;
         */
        value: DeliveryConfirm;
        case: "deliveryConfirm";
    } | {
        /**
         * @generated from field: pinch.v1.QueueStatus queue_status = 22;
         */
        value: QueueStatus;
        case: "queueStatus";
    } | {
        /**
         * @generated from field: pinch.v1.QueueFull queue_full = 23;
         */
        value: QueueFull;
        case: "queueFull";
    } | {
        /**
         * @generated from field: pinch.v1.RateLimited rate_limited = 24;
         */
        value: RateLimited;
        case: "rateLimited";
    } | {
        case: undefined;
        value?: undefined;
    };
};
/**
 * Describes the message pinch.v1.Envelope.
 * Use `create(EnvelopeSchema)` to create a new message.
 */
export declare const EnvelopeSchema: GenMessage<Envelope>;
/**
 * EncryptedPayload is an opaque encrypted blob. The relay cannot read this.
 *
 * @generated from message pinch.v1.EncryptedPayload
 */
export type EncryptedPayload = Message<"pinch.v1.EncryptedPayload"> & {
    /**
     * @generated from field: bytes nonce = 1;
     */
    nonce: Uint8Array;
    /**
     * @generated from field: bytes ciphertext = 2;
     */
    ciphertext: Uint8Array;
    /**
     * @generated from field: bytes sender_public_key = 3;
     */
    senderPublicKey: Uint8Array;
};
/**
 * Describes the message pinch.v1.EncryptedPayload.
 * Use `create(EncryptedPayloadSchema)` to create a new message.
 */
export declare const EncryptedPayloadSchema: GenMessage<EncryptedPayload>;
/**
 * PlaintextPayload exists only in decrypted form at the client.
 * Sequence and timestamp live inside the encryption boundary for
 * replay protection (the relay cannot tamper with these fields).
 *
 * @generated from message pinch.v1.PlaintextPayload
 */
export type PlaintextPayload = Message<"pinch.v1.PlaintextPayload"> & {
    /**
     * @generated from field: uint32 version = 1;
     */
    version: number;
    /**
     * @generated from field: uint64 sequence = 2;
     */
    sequence: bigint;
    /**
     * @generated from field: int64 timestamp = 3;
     */
    timestamp: bigint;
    /**
     * @generated from field: bytes content = 4;
     */
    content: Uint8Array;
    /**
     * @generated from field: string content_type = 5;
     */
    contentType: string;
};
/**
 * Describes the message pinch.v1.PlaintextPayload.
 * Use `create(PlaintextPayloadSchema)` to create a new message.
 */
export declare const PlaintextPayloadSchema: GenMessage<PlaintextPayload>;
/**
 * Handshake is sent during initial connection setup.
 *
 * @generated from message pinch.v1.Handshake
 */
export type Handshake = Message<"pinch.v1.Handshake"> & {
    /**
     * @generated from field: uint32 version = 1;
     */
    version: number;
    /**
     * @generated from field: bytes signing_key = 2;
     */
    signingKey: Uint8Array;
    /**
     * @generated from field: bytes encryption_key = 3;
     */
    encryptionKey: Uint8Array;
};
/**
 * Describes the message pinch.v1.Handshake.
 * Use `create(HandshakeSchema)` to create a new message.
 */
export declare const HandshakeSchema: GenMessage<Handshake>;
/**
 * Heartbeat is a keep-alive message.
 *
 * @generated from message pinch.v1.Heartbeat
 */
export type Heartbeat = Message<"pinch.v1.Heartbeat"> & {
    /**
     * @generated from field: int64 timestamp = 1;
     */
    timestamp: bigint;
};
/**
 * Describes the message pinch.v1.Heartbeat.
 * Use `create(HeartbeatSchema)` to create a new message.
 */
export declare const HeartbeatSchema: GenMessage<Heartbeat>;
/**
 * AuthChallenge is sent by the relay on connect. The agent signs
 * pinch-auth-v1\0<relay_host>\0<nonce> and returns AuthResponse.
 *
 * @generated from message pinch.v1.AuthChallenge
 */
export type AuthChallenge = Message<"pinch.v1.AuthChallenge"> & {
    /**
     * @generated from field: uint32 version = 1;
     */
    version: number;
    /**
     * @generated from field: bytes nonce = 2;
     */
    nonce: Uint8Array;
    /**
     * @generated from field: int64 issued_at_ms = 3;
     */
    issuedAtMs: bigint;
    /**
     * @generated from field: int64 expires_at_ms = 4;
     */
    expiresAtMs: bigint;
    /**
     * @generated from field: string relay_host = 5;
     */
    relayHost: string;
};
/**
 * Describes the message pinch.v1.AuthChallenge.
 * Use `create(AuthChallengeSchema)` to create a new message.
 */
export declare const AuthChallengeSchema: GenMessage<AuthChallenge>;
/**
 * AuthResponse proves possession of the Ed25519 private key for the
 * presented public key.
 *
 * @generated from message pinch.v1.AuthResponse
 */
export type AuthResponse = Message<"pinch.v1.AuthResponse"> & {
    /**
     * @generated from field: uint32 version = 1;
     */
    version: number;
    /**
     * @generated from field: bytes public_key = 2;
     */
    publicKey: Uint8Array;
    /**
     * @generated from field: bytes signature = 3;
     */
    signature: Uint8Array;
    /**
     * @generated from field: bytes nonce = 4;
     */
    nonce: Uint8Array;
};
/**
 * Describes the message pinch.v1.AuthResponse.
 * Use `create(AuthResponseSchema)` to create a new message.
 */
export declare const AuthResponseSchema: GenMessage<AuthResponse>;
/**
 * AuthResult is sent by the relay after verifying the AuthResponse.
 *
 * @generated from message pinch.v1.AuthResult
 */
export type AuthResult = Message<"pinch.v1.AuthResult"> & {
    /**
     * @generated from field: bool success = 1;
     */
    success: boolean;
    /**
     * only populated on failure
     *
     * @generated from field: string error_message = 2;
     */
    errorMessage: string;
    /**
     * the pinch: address derived from pubkey
     *
     * @generated from field: string assigned_address = 3;
     */
    assignedAddress: string;
};
/**
 * Describes the message pinch.v1.AuthResult.
 * Use `create(AuthResultSchema)` to create a new message.
 */
export declare const AuthResultSchema: GenMessage<AuthResult>;
/**
 * ConnectionRequest is sent by an agent to request a connection with another agent.
 *
 * @generated from message pinch.v1.ConnectionRequest
 */
export type ConnectionRequest = Message<"pinch.v1.ConnectionRequest"> & {
    /**
     * @generated from field: string from_address = 1;
     */
    fromAddress: string;
    /**
     * @generated from field: string to_address = 2;
     */
    toAddress: string;
    /**
     * free-text short message, max 280 chars enforced at application level
     *
     * @generated from field: string message = 3;
     */
    message: string;
    /**
     * @generated from field: bytes sender_public_key = 4;
     */
    senderPublicKey: Uint8Array;
    /**
     * Unix timestamp for 7-day TTL
     *
     * @generated from field: int64 expires_at = 5;
     */
    expiresAt: bigint;
};
/**
 * Describes the message pinch.v1.ConnectionRequest.
 * Use `create(ConnectionRequestSchema)` to create a new message.
 */
export declare const ConnectionRequestSchema: GenMessage<ConnectionRequest>;
/**
 * ConnectionResponse is the recipient's response to a ConnectionRequest.
 *
 * @generated from message pinch.v1.ConnectionResponse
 */
export type ConnectionResponse = Message<"pinch.v1.ConnectionResponse"> & {
    /**
     * @generated from field: string from_address = 1;
     */
    fromAddress: string;
    /**
     * @generated from field: string to_address = 2;
     */
    toAddress: string;
    /**
     * @generated from field: bool accepted = 3;
     */
    accepted: boolean;
    /**
     * only populated if accepted
     *
     * @generated from field: bytes responder_public_key = 4;
     */
    responderPublicKey: Uint8Array;
};
/**
 * Describes the message pinch.v1.ConnectionResponse.
 * Use `create(ConnectionResponseSchema)` to create a new message.
 */
export declare const ConnectionResponseSchema: GenMessage<ConnectionResponse>;
/**
 * ConnectionRevoke severs a connection between two agents without blocking.
 *
 * @generated from message pinch.v1.ConnectionRevoke
 */
export type ConnectionRevoke = Message<"pinch.v1.ConnectionRevoke"> & {
    /**
     * @generated from field: string from_address = 1;
     */
    fromAddress: string;
    /**
     * @generated from field: string to_address = 2;
     */
    toAddress: string;
};
/**
 * Describes the message pinch.v1.ConnectionRevoke.
 * Use `create(ConnectionRevokeSchema)` to create a new message.
 */
export declare const ConnectionRevokeSchema: GenMessage<ConnectionRevoke>;
/**
 * BlockNotification informs the relay that an agent has blocked another.
 *
 * @generated from message pinch.v1.BlockNotification
 */
export type BlockNotification = Message<"pinch.v1.BlockNotification"> & {
    /**
     * @generated from field: string blocker_address = 1;
     */
    blockerAddress: string;
    /**
     * @generated from field: string blocked_address = 2;
     */
    blockedAddress: string;
};
/**
 * Describes the message pinch.v1.BlockNotification.
 * Use `create(BlockNotificationSchema)` to create a new message.
 */
export declare const BlockNotificationSchema: GenMessage<BlockNotification>;
/**
 * UnblockNotification informs the relay that an agent has unblocked another.
 *
 * @generated from message pinch.v1.UnblockNotification
 */
export type UnblockNotification = Message<"pinch.v1.UnblockNotification"> & {
    /**
     * @generated from field: string unblocker_address = 1;
     */
    unblockerAddress: string;
    /**
     * @generated from field: string unblocked_address = 2;
     */
    unblockedAddress: string;
};
/**
 * Describes the message pinch.v1.UnblockNotification.
 * Use `create(UnblockNotificationSchema)` to create a new message.
 */
export declare const UnblockNotificationSchema: GenMessage<UnblockNotification>;
/**
 * DeliveryConfirm is an E2E signed delivery receipt sent by the recipient
 * back to the sender to confirm message delivery.
 *
 * @generated from message pinch.v1.DeliveryConfirm
 */
export type DeliveryConfirm = Message<"pinch.v1.DeliveryConfirm"> & {
    /**
     * ID of the message being confirmed
     *
     * @generated from field: bytes message_id = 1;
     */
    messageId: Uint8Array;
    /**
     * Ed25519 detached signature of (message_id || timestamp)
     *
     * @generated from field: bytes signature = 2;
     */
    signature: Uint8Array;
    /**
     * confirmation timestamp
     *
     * @generated from field: int64 timestamp = 3;
     */
    timestamp: bigint;
    /**
     * delivery state (e.g., "delivered", "read_by_agent", "escalated_to_human")
     *
     * @generated from field: string state = 4;
     */
    state: string;
    /**
     * true if the message was queued (store-and-forward) and delivered later
     *
     * @generated from field: bool was_stored = 5;
     */
    wasStored: boolean;
};
/**
 * Describes the message pinch.v1.DeliveryConfirm.
 * Use `create(DeliveryConfirmSchema)` to create a new message.
 */
export declare const DeliveryConfirmSchema: GenMessage<DeliveryConfirm>;
/**
 * QueueStatus is sent by the relay to inform the agent of pending
 * queued messages before starting a flush.
 *
 * @generated from message pinch.v1.QueueStatus
 */
export type QueueStatus = Message<"pinch.v1.QueueStatus"> & {
    /**
     * @generated from field: int32 pending_count = 1;
     */
    pendingCount: number;
};
/**
 * Describes the message pinch.v1.QueueStatus.
 * Use `create(QueueStatusSchema)` to create a new message.
 */
export declare const QueueStatusSchema: GenMessage<QueueStatus>;
/**
 * QueueFull is sent to the sender when the recipient's message queue
 * has reached its capacity and cannot accept more messages.
 *
 * @generated from message pinch.v1.QueueFull
 */
export type QueueFull = Message<"pinch.v1.QueueFull"> & {
    /**
     * @generated from field: string recipient_address = 1;
     */
    recipientAddress: string;
    /**
     * @generated from field: string reason = 2;
     */
    reason: string;
};
/**
 * Describes the message pinch.v1.QueueFull.
 * Use `create(QueueFullSchema)` to create a new message.
 */
export declare const QueueFullSchema: GenMessage<QueueFull>;
/**
 * RateLimited is sent to the sender when their messages exceed the
 * per-connection rate limit. Contains retry-after information.
 *
 * @generated from message pinch.v1.RateLimited
 */
export type RateLimited = Message<"pinch.v1.RateLimited"> & {
    /**
     * milliseconds until sender can retry
     *
     * @generated from field: int64 retry_after_ms = 1;
     */
    retryAfterMs: bigint;
    /**
     * human-readable explanation
     *
     * @generated from field: string reason = 2;
     */
    reason: string;
};
/**
 * Describes the message pinch.v1.RateLimited.
 * Use `create(RateLimitedSchema)` to create a new message.
 */
export declare const RateLimitedSchema: GenMessage<RateLimited>;
/**
 * MessageType enumerates all wire message types.
 *
 * @generated from enum pinch.v1.MessageType
 */
export declare enum MessageType {
    /**
     * @generated from enum value: MESSAGE_TYPE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: MESSAGE_TYPE_HANDSHAKE = 1;
     */
    HANDSHAKE = 1,
    /**
     * @generated from enum value: MESSAGE_TYPE_AUTH_CHALLENGE = 2;
     */
    AUTH_CHALLENGE = 2,
    /**
     * @generated from enum value: MESSAGE_TYPE_AUTH_RESPONSE = 3;
     */
    AUTH_RESPONSE = 3,
    /**
     * @generated from enum value: MESSAGE_TYPE_MESSAGE = 4;
     */
    MESSAGE = 4,
    /**
     * @generated from enum value: MESSAGE_TYPE_DELIVERY_CONFIRM = 5;
     */
    DELIVERY_CONFIRM = 5,
    /**
     * @generated from enum value: MESSAGE_TYPE_CONNECTION_REQUEST = 6;
     */
    CONNECTION_REQUEST = 6,
    /**
     * @generated from enum value: MESSAGE_TYPE_CONNECTION_RESPONSE = 7;
     */
    CONNECTION_RESPONSE = 7,
    /**
     * @generated from enum value: MESSAGE_TYPE_HEARTBEAT = 8;
     */
    HEARTBEAT = 8,
    /**
     * @generated from enum value: MESSAGE_TYPE_AUTH_RESULT = 9;
     */
    AUTH_RESULT = 9,
    /**
     * @generated from enum value: MESSAGE_TYPE_CONNECTION_REVOKE = 10;
     */
    CONNECTION_REVOKE = 10,
    /**
     * @generated from enum value: MESSAGE_TYPE_BLOCK_NOTIFICATION = 11;
     */
    BLOCK_NOTIFICATION = 11,
    /**
     * @generated from enum value: MESSAGE_TYPE_UNBLOCK_NOTIFICATION = 12;
     */
    UNBLOCK_NOTIFICATION = 12,
    /**
     * @generated from enum value: MESSAGE_TYPE_QUEUE_STATUS = 13;
     */
    QUEUE_STATUS = 13,
    /**
     * @generated from enum value: MESSAGE_TYPE_QUEUE_FULL = 14;
     */
    QUEUE_FULL = 14,
    /**
     * @generated from enum value: MESSAGE_TYPE_RATE_LIMITED = 15;
     */
    RATE_LIMITED = 15
}
/**
 * Describes the enum pinch.v1.MessageType.
 */
export declare const MessageTypeSchema: GenEnum<MessageType>;
