// Package bearer provides constant-time SHA-256 Bearer Authorization header
// verification shared by the owner admission channel and Shanghai control plane.
package bearer

import (
	"crypto/sha256"
	"crypto/subtle"
	"strings"
)

const prefix = "Bearer "

// Digest returns the SHA-256 digest of token for storage in auth verifiers so
// neither the plaintext credential nor its length remains in memory.
func Digest(token string) [32]byte {
	return sha256.Sum256([]byte(token))
}

// VerifyHeader reports whether values contains a single Authorization header
// of at most maxBytes bytes carrying "Bearer <token>" where <token> consists
// solely of non-empty printable ASCII bytes (33..126) matching digest.
func VerifyHeader(values []string, digest [32]byte, maxBytes int) bool {
	if len(values) != 1 || maxBytes <= 0 {
		return false
	}
	raw := values[0]
	if len(raw) > maxBytes || !strings.HasPrefix(raw, prefix) {
		return false
	}
	candidate := raw[len(prefix):]
	if candidate == "" {
		return false
	}
	for i := 0; i < len(candidate); i++ {
		if candidate[i] < 33 || candidate[i] > 126 {
			return false
		}
	}
	sum := sha256.Sum256([]byte(candidate))
	return subtle.ConstantTimeCompare(sum[:], digest[:]) == 1
}
