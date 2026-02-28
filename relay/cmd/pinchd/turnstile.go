package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const defaultTurnstileVerifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

type turnstileVerifier struct {
	secretKey  string
	verifyURL  string // injectable for tests
	httpClient *http.Client
}

func newTurnstileVerifier(secretKey string) *turnstileVerifier {
	return &turnstileVerifier{
		secretKey: secretKey,
		verifyURL: defaultTurnstileVerifyURL,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// Verify checks a Turnstile token with Cloudflare's siteverify endpoint.
// Returns true if the token is valid, false otherwise.
func (v *turnstileVerifier) Verify(token, remoteIP string) (bool, error) {
	form := url.Values{
		"secret":   {v.secretKey},
		"response": {token},
	}
	if remoteIP != "" {
		form.Set("remoteip", remoteIP)
	}

	resp, err := v.httpClient.PostForm(v.verifyURL, form)
	if err != nil {
		return false, fmt.Errorf("turnstile request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if err != nil {
		return false, fmt.Errorf("turnstile response read failed: %w", err)
	}

	var result struct {
		Success bool `json:"success"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return false, fmt.Errorf("turnstile response decode failed: %w", err)
	}

	return result.Success, nil
}
