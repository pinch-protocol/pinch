package store

import bolt "go.etcd.io/bbolt"

// OpenDB opens the shared bbolt database for all relay stores.
// Both BlockStore and MessageQueue receive the shared *bolt.DB handle.
// The caller is responsible for closing the database.
func OpenDB(path string) (*bolt.DB, error) {
	return bolt.Open(path, 0600, nil)
}
