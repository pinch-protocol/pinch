package hub

import (
	"sync"
	"testing"

	"golang.org/x/time/rate"
)

func TestRateLimiterAllowFirstMessage(t *testing.T) {
	rl := NewRateLimiter(rate.Limit(1.0), 10)
	if !rl.Allow("pinch:alice@localhost") {
		t.Fatal("expected first message to be allowed")
	}
}

func TestRateLimiterRejectAfterBurstExhausted(t *testing.T) {
	burst := 5
	rl := NewRateLimiter(rate.Limit(1.0), burst)
	addr := "pinch:burst@localhost"

	// Consume the entire burst.
	for i := 0; i < burst; i++ {
		if !rl.Allow(addr) {
			t.Fatalf("expected message %d to be allowed (within burst)", i+1)
		}
	}

	// The next message should be rejected.
	if rl.Allow(addr) {
		t.Fatal("expected message after burst exhaustion to be rejected")
	}
}

func TestRateLimiterRemoveResetsLimiter(t *testing.T) {
	burst := 3
	rl := NewRateLimiter(rate.Limit(1.0), burst)
	addr := "pinch:remove@localhost"

	// Exhaust the burst.
	for i := 0; i < burst; i++ {
		rl.Allow(addr)
	}

	// Should be rejected now.
	if rl.Allow(addr) {
		t.Fatal("expected rejection after burst exhaustion")
	}

	// Remove the limiter -- simulates disconnect.
	rl.Remove(addr)

	// After removal, a fresh limiter is created on next Allow.
	if !rl.Allow(addr) {
		t.Fatal("expected allow after Remove (fresh limiter with full burst)")
	}
}

func TestRateLimiterConcurrentAccess(t *testing.T) {
	rl := NewRateLimiter(rate.Limit(1.0), 100)
	addr := "pinch:concurrent@localhost"

	var wg sync.WaitGroup
	goroutines := 50
	callsPerGoroutine := 20

	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < callsPerGoroutine; j++ {
				rl.Allow(addr) // Must not panic or race.
			}
		}()
	}
	wg.Wait()

	// If we reach here without panic or race detector complaint, the test passes.
}
