package hub

import (
	"sync"

	"golang.org/x/time/rate"
)

// RateLimiter manages per-connection token bucket rate limiters.
// Each pinch address gets its own limiter created on first message.
type RateLimiter struct {
	mu       sync.Mutex
	limiters map[string]*rate.Limiter
	rate     rate.Limit
	burst    int
}

// NewRateLimiter creates a rate limiter with the given sustained rate
// and burst size. Recommended defaults: rate=1.0 (60 msgs/min), burst=10.
func NewRateLimiter(r rate.Limit, burst int) *RateLimiter {
	return &RateLimiter{
		limiters: make(map[string]*rate.Limiter),
		rate:     r,
		burst:    burst,
	}
}

// Allow checks if the given address is under the rate limit.
// Returns true if allowed, false if rate-limited.
// The limiter for a given address is created lazily on first call.
func (rl *RateLimiter) Allow(address string) bool {
	rl.mu.Lock()
	limiter, ok := rl.limiters[address]
	if !ok {
		limiter = rate.NewLimiter(rl.rate, rl.burst)
		rl.limiters[address] = limiter
	}
	rl.mu.Unlock()
	return limiter.Allow()
}

// Remove deletes the limiter for the given address.
// Call on client disconnect to prevent memory leaks.
func (rl *RateLimiter) Remove(address string) {
	rl.mu.Lock()
	delete(rl.limiters, address)
	rl.mu.Unlock()
}
