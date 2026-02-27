package store_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/pinch-protocol/pinch/relay/internal/store"
)

func newTestMessageQueue(t *testing.T, maxPerAgent int, ttl time.Duration) *store.MessageQueue {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test-queue.db")
	db, err := store.OpenDB(path)
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	mq, err := store.NewMessageQueue(db, maxPerAgent, ttl)
	if err != nil {
		t.Fatalf("NewMessageQueue: %v", err)
	}
	return mq
}

func TestEnqueueAndFlushBatch(t *testing.T) {
	mq := newTestMessageQueue(t, 1000, time.Hour)

	// Enqueue 3 messages.
	for i := 0; i < 3; i++ {
		err := mq.Enqueue("recipient-a", "sender-x", []byte{byte(i)})
		if err != nil {
			t.Fatalf("Enqueue %d: %v", i, err)
		}
	}

	// FlushBatch with batchSize=10, should return all 3.
	entries, err := mq.FlushBatch("recipient-a", 10)
	if err != nil {
		t.Fatalf("FlushBatch: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(entries))
	}

	// Verify order (envelopes should be 0, 1, 2).
	for i, e := range entries {
		if len(e.Envelope) != 1 || e.Envelope[0] != byte(i) {
			t.Errorf("entry %d: expected envelope [%d], got %v", i, i, e.Envelope)
		}
		if e.SenderAddr != "sender-x" {
			t.Errorf("entry %d: expected sender sender-x, got %s", i, e.SenderAddr)
		}
	}
}

func TestEnqueueQueueFull(t *testing.T) {
	mq := newTestMessageQueue(t, 5, time.Hour)

	// Enqueue 5 messages (at capacity).
	for i := 0; i < 5; i++ {
		err := mq.Enqueue("recipient-b", "sender-y", []byte{byte(i)})
		if err != nil {
			t.Fatalf("Enqueue %d: %v", i, err)
		}
	}

	// 6th should return ErrQueueFull.
	err := mq.Enqueue("recipient-b", "sender-y", []byte{5})
	if !errors.Is(err, store.ErrQueueFull) {
		t.Fatalf("expected ErrQueueFull, got %v", err)
	}
}

func TestFlushBatchOrdering(t *testing.T) {
	mq := newTestMessageQueue(t, 1000, time.Hour)

	// Enqueue messages with small sleep between them for distinct timestamps.
	for i := 0; i < 5; i++ {
		err := mq.Enqueue("recipient-c", "sender-z", []byte{byte(i)})
		if err != nil {
			t.Fatalf("Enqueue %d: %v", i, err)
		}
		time.Sleep(time.Millisecond)
	}

	entries, err := mq.FlushBatch("recipient-c", 10)
	if err != nil {
		t.Fatalf("FlushBatch: %v", err)
	}
	if len(entries) != 5 {
		t.Fatalf("expected 5 entries, got %d", len(entries))
	}

	// Verify chronological order.
	for i, e := range entries {
		if e.Envelope[0] != byte(i) {
			t.Errorf("entry %d: expected envelope byte %d, got %d", i, i, e.Envelope[0])
		}
	}
}

func TestFlushBatchBatching(t *testing.T) {
	mq := newTestMessageQueue(t, 1000, time.Hour)

	// Enqueue 10 messages.
	for i := 0; i < 10; i++ {
		err := mq.Enqueue("recipient-d", "sender-w", []byte{byte(i)})
		if err != nil {
			t.Fatalf("Enqueue %d: %v", i, err)
		}
	}

	// First batch of 3.
	batch1, err := mq.FlushBatch("recipient-d", 3)
	if err != nil {
		t.Fatalf("FlushBatch 1: %v", err)
	}
	if len(batch1) != 3 {
		t.Fatalf("expected 3 entries in batch 1, got %d", len(batch1))
	}
	for i, e := range batch1 {
		if e.Envelope[0] != byte(i) {
			t.Errorf("batch1[%d]: expected %d, got %d", i, i, e.Envelope[0])
		}
	}

	// Second batch of 3 (should return the same first 3 since we haven't removed any).
	batch2, err := mq.FlushBatch("recipient-d", 3)
	if err != nil {
		t.Fatalf("FlushBatch 2: %v", err)
	}
	if len(batch2) != 3 {
		t.Fatalf("expected 3 entries in batch 2, got %d", len(batch2))
	}
	// Same entries since FlushBatch is read-only.
	for i, e := range batch2 {
		if e.Envelope[0] != byte(i) {
			t.Errorf("batch2[%d]: expected %d, got %d", i, i, e.Envelope[0])
		}
	}
}

func TestRemove(t *testing.T) {
	mq := newTestMessageQueue(t, 1000, time.Hour)

	// Enqueue 3 messages.
	for i := 0; i < 3; i++ {
		err := mq.Enqueue("recipient-e", "sender-v", []byte{byte(i)})
		if err != nil {
			t.Fatalf("Enqueue %d: %v", i, err)
		}
	}

	// Flush to get keys.
	entries, err := mq.FlushBatch("recipient-e", 10)
	if err != nil {
		t.Fatalf("FlushBatch: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(entries))
	}

	// Remove the middle one.
	if err := mq.Remove("recipient-e", entries[1].Key); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	// Flush again -- should only have 2 entries (first and last).
	remaining, err := mq.FlushBatch("recipient-e", 10)
	if err != nil {
		t.Fatalf("FlushBatch after remove: %v", err)
	}
	if len(remaining) != 2 {
		t.Fatalf("expected 2 entries after remove, got %d", len(remaining))
	}
	if remaining[0].Envelope[0] != 0 {
		t.Errorf("expected first entry envelope [0], got %v", remaining[0].Envelope)
	}
	if remaining[1].Envelope[0] != 2 {
		t.Errorf("expected last entry envelope [2], got %v", remaining[1].Envelope)
	}
}

func TestCount(t *testing.T) {
	mq := newTestMessageQueue(t, 1000, time.Hour)

	// Initially 0.
	if c := mq.Count("recipient-f"); c != 0 {
		t.Fatalf("expected count 0, got %d", c)
	}

	// Enqueue 5 messages.
	for i := 0; i < 5; i++ {
		if err := mq.Enqueue("recipient-f", "sender-u", []byte{byte(i)}); err != nil {
			t.Fatalf("Enqueue %d: %v", i, err)
		}
	}

	if c := mq.Count("recipient-f"); c != 5 {
		t.Fatalf("expected count 5, got %d", c)
	}

	// Remove one.
	entries, err := mq.FlushBatch("recipient-f", 1)
	if err != nil {
		t.Fatalf("FlushBatch: %v", err)
	}
	if err := mq.Remove("recipient-f", entries[0].Key); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	if c := mq.Count("recipient-f"); c != 4 {
		t.Fatalf("expected count 4 after remove, got %d", c)
	}
}

func TestSweep(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping TTL test in short mode")
	}

	// Use a very short TTL.
	mq := newTestMessageQueue(t, 1000, time.Millisecond)

	// Enqueue 3 messages.
	for i := 0; i < 3; i++ {
		if err := mq.Enqueue("recipient-g", "sender-t", []byte{byte(i)}); err != nil {
			t.Fatalf("Enqueue %d: %v", i, err)
		}
	}

	// Wait for messages to expire.
	time.Sleep(5 * time.Millisecond)

	// Sweep should clean all 3.
	cleaned, err := mq.Sweep()
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if cleaned != 3 {
		t.Fatalf("expected 3 cleaned, got %d", cleaned)
	}

	// Count should now be 0.
	if c := mq.Count("recipient-g"); c != 0 {
		t.Fatalf("expected count 0 after sweep, got %d", c)
	}
}

func TestSweepLeavesUnexpired(t *testing.T) {
	mq := newTestMessageQueue(t, 1000, time.Hour)

	// Enqueue messages with long TTL.
	for i := 0; i < 3; i++ {
		if err := mq.Enqueue("recipient-h", "sender-s", []byte{byte(i)}); err != nil {
			t.Fatalf("Enqueue %d: %v", i, err)
		}
	}

	// Sweep should clean nothing.
	cleaned, err := mq.Sweep()
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if cleaned != 0 {
		t.Fatalf("expected 0 cleaned, got %d", cleaned)
	}

	// Count should be unchanged.
	if c := mq.Count("recipient-h"); c != 3 {
		t.Fatalf("expected count 3 after sweep, got %d", c)
	}
}

func TestFlushBatchSkipsExpired(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping TTL test in short mode")
	}

	// Very short TTL.
	mq := newTestMessageQueue(t, 1000, time.Millisecond)

	// Enqueue messages.
	for i := 0; i < 3; i++ {
		if err := mq.Enqueue("recipient-i", "sender-r", []byte{byte(i)}); err != nil {
			t.Fatalf("Enqueue %d: %v", i, err)
		}
	}

	// Wait for expiry.
	time.Sleep(5 * time.Millisecond)

	// FlushBatch should return 0 (skips expired without deleting).
	entries, err := mq.FlushBatch("recipient-i", 10)
	if err != nil {
		t.Fatalf("FlushBatch: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected 0 entries (expired), got %d", len(entries))
	}

	// Count still shows 3 (not deleted, just skipped).
	if c := mq.Count("recipient-i"); c != 3 {
		t.Fatalf("expected count 3 (not deleted), got %d", c)
	}
}

func TestEmptyFlush(t *testing.T) {
	mq := newTestMessageQueue(t, 1000, time.Hour)

	// FlushBatch on non-existent address.
	entries, err := mq.FlushBatch("nonexistent-address", 10)
	if err != nil {
		t.Fatalf("FlushBatch: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected empty slice, got %d entries", len(entries))
	}
}

func TestMultipleRecipients(t *testing.T) {
	mq := newTestMessageQueue(t, 1000, time.Hour)

	// Enqueue for two different recipients.
	for i := 0; i < 3; i++ {
		if err := mq.Enqueue("alice", "sender-a", []byte{byte(i)}); err != nil {
			t.Fatalf("Enqueue alice %d: %v", i, err)
		}
		if err := mq.Enqueue("bob", "sender-b", []byte{byte(i + 10)}); err != nil {
			t.Fatalf("Enqueue bob %d: %v", i, err)
		}
	}

	// Flush alice.
	aliceEntries, err := mq.FlushBatch("alice", 10)
	if err != nil {
		t.Fatalf("FlushBatch alice: %v", err)
	}
	if len(aliceEntries) != 3 {
		t.Fatalf("expected 3 alice entries, got %d", len(aliceEntries))
	}
	for i, e := range aliceEntries {
		if e.Envelope[0] != byte(i) {
			t.Errorf("alice entry %d: expected %d, got %d", i, i, e.Envelope[0])
		}
	}

	// Flush bob.
	bobEntries, err := mq.FlushBatch("bob", 10)
	if err != nil {
		t.Fatalf("FlushBatch bob: %v", err)
	}
	if len(bobEntries) != 3 {
		t.Fatalf("expected 3 bob entries, got %d", len(bobEntries))
	}
	for i, e := range bobEntries {
		if e.Envelope[0] != byte(i+10) {
			t.Errorf("bob entry %d: expected %d, got %d", i, i+10, e.Envelope[0])
		}
	}

	// Count is independent.
	if c := mq.Count("alice"); c != 3 {
		t.Fatalf("expected alice count 3, got %d", c)
	}
	if c := mq.Count("bob"); c != 3 {
		t.Fatalf("expected bob count 3, got %d", c)
	}
}

func TestSharedDBWithBlockStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shared-test.db")
	db, err := store.OpenDB(path)
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	defer db.Close()

	// Create both stores on the same DB.
	bs, err := store.NewBlockStore(db)
	if err != nil {
		t.Fatalf("NewBlockStore: %v", err)
	}
	mq, err := store.NewMessageQueue(db, 1000, time.Hour)
	if err != nil {
		t.Fatalf("NewMessageQueue: %v", err)
	}

	// Use BlockStore.
	if err := bs.Block("alice", "bob"); err != nil {
		t.Fatalf("Block: %v", err)
	}
	if !bs.IsBlocked("alice", "bob") {
		t.Fatal("expected alice->bob blocked")
	}

	// Use MessageQueue.
	if err := mq.Enqueue("charlie", "dave", []byte("hello")); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	if c := mq.Count("charlie"); c != 1 {
		t.Fatalf("expected count 1, got %d", c)
	}

	entries, err := mq.FlushBatch("charlie", 10)
	if err != nil {
		t.Fatalf("FlushBatch: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if string(entries[0].Envelope) != "hello" {
		t.Errorf("expected envelope 'hello', got '%s'", string(entries[0].Envelope))
	}

	// Both still work -- no lock conflicts.
	if !bs.IsBlocked("alice", "bob") {
		t.Fatal("BlockStore broken after MessageQueue use")
	}
}

func TestStartSweep(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping sweep goroutine test in short mode")
	}

	// Create a queue with very short TTL and sweep interval for testing.
	path := filepath.Join(t.TempDir(), "sweep-test.db")
	db, err := store.OpenDB(path)
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	defer db.Close()

	mq, err := store.NewMessageQueue(db, 1000, time.Millisecond)
	if err != nil {
		t.Fatalf("NewMessageQueue: %v", err)
	}

	// Enqueue a message.
	if err := mq.Enqueue("recipient-sweep", "sender-sweep", []byte("test")); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	// Start sweep with a cancellable context.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	mq.StartSweep(ctx)

	// The sweep interval is 5 minutes by default, so we manually call Sweep
	// for testing rather than waiting.
	time.Sleep(5 * time.Millisecond) // Let message expire.
	cleaned, err := mq.Sweep()
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if cleaned != 1 {
		t.Fatalf("expected 1 cleaned, got %d", cleaned)
	}

	// Cancel context to stop background sweep.
	cancel()
}
