// Package bearer provides constant-time SHA-256 Bearer Authorization header
// verification shared by the API key registry and Shanghai control plane.
package bearer

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"strings"
)

const (
	prefix = "Bearer "

	// MinTokenBytes is the minimum length of a valid plaintext API bearer token.
	MinTokenBytes = 32
	// MaxTokenBytes is the maximum length of a valid plaintext API bearer token.
	MaxTokenBytes = 512
)

var (
	errInvalidToken  = errors.New("token must be 32–512 printable ASCII characters without whitespace")
	errInvalidDigest = errors.New("token_sha256 must be a valid non-trivial 64-character hex SHA-256 digest")

	zeroDigest  [32]byte
	emptyDigest = sha256.Sum256(nil)
)

// Digest returns the SHA-256 digest of token for storage in auth verifiers so
// neither the plaintext credential nor its length remains in memory.
func Digest(token string) [32]byte {
	return sha256.Sum256([]byte(token))
}

// ValidateToken verifies that raw is 32–512 printable ASCII bytes (33..126)
// without whitespace or control characters. It never echoes raw or its length.
func ValidateToken(raw string) error {
	if len(raw) < MinTokenBytes || len(raw) > MaxTokenBytes {
		return errInvalidToken
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] < 33 || raw[i] > 126 {
			return errInvalidToken
		}
	}
	return nil
}

// ParseDigestHex parses a 64-character ASCII hex SHA-256 digest and rejects
// trivial digests (all-zero bytes and SHA-256 of the empty string).
func ParseDigestHex(raw string) ([32]byte, error) {
	var out [32]byte
	if len(raw) != 64 {
		return out, errInvalidDigest
	}
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
		if !isHex {
			return out, errInvalidDigest
		}
	}
	if _, err := hex.Decode(out[:], []byte(raw)); err != nil {
		return [32]byte{}, errInvalidDigest
	}
	if subtle.ConstantTimeCompare(out[:], zeroDigest[:]) == 1 ||
		subtle.ConstantTimeCompare(out[:], emptyDigest[:]) == 1 {
		return [32]byte{}, errInvalidDigest
	}
	return out, nil
}

// ExtractBearerToken extracts <token> from a single Authorization header of at
// most maxHeaderBytes bytes matching "Bearer <token>" where <token> consists
// solely of non-empty printable ASCII bytes (33..126).
func ExtractBearerToken(values []string, maxHeaderBytes int) (string, bool) {
	if len(values) != 1 || maxHeaderBytes <= 0 {
		return "", false
	}
	raw := values[0]
	if len(raw) > maxHeaderBytes || !strings.HasPrefix(raw, prefix) {
		return "", false
	}
	candidate := raw[len(prefix):]
	if candidate == "" {
		return "", false
	}
	for i := 0; i < len(candidate); i++ {
		if candidate[i] < 33 || candidate[i] > 126 {
			return "", false
		}
	}
	return candidate, true
}

// MatchDigestConstantTime hashes candidateToken with SHA-256 once and compares
// it against every entry in digests using subtle.ConstantTimeCompare without
// early break. It returns the unique matched index, or (-1, false) otherwise.
func MatchDigestConstantTime(candidateToken string, digests [][32]byte) (int, bool) {
	if candidateToken == "" || len(digests) == 0 {
		return -1, false
	}
	sum := sha256.Sum256([]byte(candidateToken))
	matchedIdx := -1
	matchedCount := 0
	for i := 0; i < len(digests); i++ {
		eq := subtle.ConstantTimeCompare(sum[:], digests[i][:])
		matchedIdx = subtle.ConstantTimeSelect(eq, i, matchedIdx)
		matchedCount += eq
	}
	if matchedCount != 1 {
		return -1, false
	}
	return matchedIdx, true
}

// VerifyHeader reports whether values contains a single Authorization header
// of at most maxBytes bytes carrying "Bearer <token>" where <token> consists
// solely of non-empty printable ASCII bytes (33..126) matching digest.
func VerifyHeader(values []string, digest [32]byte, maxBytes int) bool {
	candidate, ok := ExtractBearerToken(values, maxBytes)
	if !ok {
		return false
	}
	sum := sha256.Sum256([]byte(candidate))
	return subtle.ConstantTimeCompare(sum[:], digest[:]) == 1
}
