package store_test

import (
	"path/filepath"
	"testing"

	"github.com/pinch-protocol/pinch/relay/internal/store"
)

func newTestBlockStore(t *testing.T) *store.BlockStore {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test-blocks.db")
	db, err := store.OpenDB(path)
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	bs, err := store.NewBlockStore(db)
	if err != nil {
		t.Fatalf("NewBlockStore: %v", err)
	}
	return bs
}

func TestBlockAndIsBlocked(t *testing.T) {
	bs := newTestBlockStore(t)

	// Initially not blocked.
	if bs.IsBlocked("alice", "bob") {
		t.Fatal("expected alice->bob to not be blocked initially")
	}

	// Block bob.
	if err := bs.Block("alice", "bob"); err != nil {
		t.Fatalf("Block: %v", err)
	}

	// Now blocked.
	if !bs.IsBlocked("alice", "bob") {
		t.Fatal("expected alice->bob to be blocked after Block")
	}
}

func TestIsBlockedReturnsFalseForNonBlockedPairs(t *testing.T) {
	bs := newTestBlockStore(t)

	if bs.IsBlocked("alice", "bob") {
		t.Fatal("expected false for non-blocked pair")
	}
	if bs.IsBlocked("", "") {
		t.Fatal("expected false for empty addresses")
	}
	if bs.IsBlocked("x", "y") {
		t.Fatal("expected false for arbitrary non-blocked pair")
	}
}

func TestUnblock(t *testing.T) {
	bs := newTestBlockStore(t)

	// Block then unblock.
	if err := bs.Block("alice", "bob"); err != nil {
		t.Fatalf("Block: %v", err)
	}
	if !bs.IsBlocked("alice", "bob") {
		t.Fatal("expected blocked after Block")
	}

	if err := bs.Unblock("alice", "bob"); err != nil {
		t.Fatalf("Unblock: %v", err)
	}
	if bs.IsBlocked("alice", "bob") {
		t.Fatal("expected not blocked after Unblock")
	}
}

func TestBlockIsDirectional(t *testing.T) {
	bs := newTestBlockStore(t)

	// Alice blocks Bob -- Bob should NOT be blocking Alice.
	if err := bs.Block("alice", "bob"); err != nil {
		t.Fatalf("Block: %v", err)
	}

	if !bs.IsBlocked("alice", "bob") {
		t.Fatal("expected alice->bob blocked")
	}
	if bs.IsBlocked("bob", "alice") {
		t.Fatal("expected bob->alice NOT blocked (blocking is directional)")
	}
}

func TestPersistenceAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "persist-test.db")

	// Open, block, close.
	db1, err := store.OpenDB(path)
	if err != nil {
		t.Fatalf("OpenDB 1: %v", err)
	}
	bs1, err := store.NewBlockStore(db1)
	if err != nil {
		t.Fatalf("NewBlockStore 1: %v", err)
	}
	if err := bs1.Block("alice", "bob"); err != nil {
		t.Fatalf("Block: %v", err)
	}
	if err := db1.Close(); err != nil {
		t.Fatalf("Close 1: %v", err)
	}

	// Reopen and verify block survives.
	db2, err := store.OpenDB(path)
	if err != nil {
		t.Fatalf("OpenDB 2: %v", err)
	}
	defer db2.Close()

	bs2, err := store.NewBlockStore(db2)
	if err != nil {
		t.Fatalf("NewBlockStore 2: %v", err)
	}

	if !bs2.IsBlocked("alice", "bob") {
		t.Fatal("expected block to persist across DB close/reopen")
	}
}

func TestMultipleBlocksFromSameBlocker(t *testing.T) {
	bs := newTestBlockStore(t)

	// Alice blocks multiple addresses.
	targets := []string{"bob", "charlie", "dave"}
	for _, target := range targets {
		if err := bs.Block("alice", target); err != nil {
			t.Fatalf("Block alice->%s: %v", target, err)
		}
	}

	// All should be blocked.
	for _, target := range targets {
		if !bs.IsBlocked("alice", target) {
			t.Fatalf("expected alice->%s to be blocked", target)
		}
	}

	// Unblock one -- others remain blocked.
	if err := bs.Unblock("alice", "charlie"); err != nil {
		t.Fatalf("Unblock: %v", err)
	}
	if bs.IsBlocked("alice", "charlie") {
		t.Fatal("expected alice->charlie to be unblocked")
	}
	if !bs.IsBlocked("alice", "bob") {
		t.Fatal("expected alice->bob to still be blocked")
	}
	if !bs.IsBlocked("alice", "dave") {
		t.Fatal("expected alice->dave to still be blocked")
	}
}

func TestUnblockNonExistentPair(t *testing.T) {
	bs := newTestBlockStore(t)

	// Unblocking a pair that was never blocked should not error.
	if err := bs.Unblock("alice", "bob"); err != nil {
		t.Fatalf("Unblock non-existent: %v", err)
	}
}
