// Package store provides persistent storage for the relay.
package store

import (
	bolt "go.etcd.io/bbolt"
)

var blocksBucket = []byte("blocks")

// BlockStore persists directional block relationships in bbolt.
// Key format: "blockerAddr:blockedAddr" -> "1".
// Block checks use read-only transactions for fast concurrent access.
type BlockStore struct {
	db *bolt.DB
}

// NewBlockStore opens a bbolt database at path with 0600 permissions
// and creates the "blocks" bucket if it does not exist.
func NewBlockStore(path string) (*BlockStore, error) {
	db, err := bolt.Open(path, 0600, nil)
	if err != nil {
		return nil, err
	}
	// Create the blocks bucket on init.
	err = db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(blocksBucket)
		return err
	})
	if err != nil {
		db.Close()
		return nil, err
	}
	return &BlockStore{db: db}, nil
}

// Block records that blockerAddr has blocked blockedAddr.
func (s *BlockStore) Block(blockerAddr, blockedAddr string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(blocksBucket)
		key := []byte(blockerAddr + ":" + blockedAddr)
		return b.Put(key, []byte("1"))
	})
}

// Unblock removes the block record so blockedAddr can send messages
// to blockerAddr again. Blocking is reversible -- unblocking restores
// the connection without needing a new connection request.
func (s *BlockStore) Unblock(blockerAddr, blockedAddr string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(blocksBucket)
		key := []byte(blockerAddr + ":" + blockedAddr)
		return b.Delete(key)
	})
}

// IsBlocked checks whether blockerAddr has blocked senderAddr.
// Uses a read-only transaction for fast concurrent access.
func (s *BlockStore) IsBlocked(blockerAddr, senderAddr string) bool {
	var blocked bool
	s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(blocksBucket)
		key := []byte(blockerAddr + ":" + senderAddr)
		blocked = b.Get(key) != nil
		return nil
	})
	return blocked
}

// Close closes the underlying bbolt database.
func (s *BlockStore) Close() error {
	return s.db.Close()
}
