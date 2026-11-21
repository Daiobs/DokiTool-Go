package bearer

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
)

func TestDigestAndVerifyHeader(t *testing.T) {
	const (
		validToken = "test-credential-33to126-!#$%&'()*+,-./0123456789:;=?@AZ_az~"
		maxBytes   = 128
	)
	digest := Digest(validToken)
	if want := sha256.Sum256([]byte(validToken)); digest != want {
		t.Fatalf("Digest mismatch: got %x, want %x", digest, want)
	}

	if !VerifyHeader([]string{"Bearer " + validToken}, digest, maxBytes) {
		t.Fatal("expected valid Bearer header to pass")
	}

	// Exact maxBytes boundary succeeds; maxBytes+1 fails.
	exactToken := strings.Repeat("a", maxBytes-len("Bearer "))
	exactDigest := Digest(exactToken)
	if !VerifyHeader([]string{"Bearer " + exactToken}, exactDigest, maxBytes) {
		t.Fatal("expected header at exact maxBytes boundary to pass")
	}
	overToken := exactToken + "a"
	overDigest := Digest(overToken)
	if VerifyHeader([]string{"Bearer " + overToken}, overDigest, maxBytes) {
		t.Fatal("expected over-length header to fail even when digest matches")
	}

	rejectCases := []struct {
		name     string
		values   []string
		digest   [32]byte
		maxBytes int
	}{
		{
			name:     "nil-values",
			values:   nil,
			digest:   digest,
			maxBytes: maxBytes,
		},
		{
			name:     "empty-values",
			values:   []string{},
			digest:   digest,
			maxBytes: maxBytes,
		},
		{
			name:     "multiple-headers-identical",
			values:   []string{"Bearer " + validToken, "Bearer " + validToken},
			digest:   digest,
			maxBytes: maxBytes,
		},
		{
			name:     "multiple-headers-mixed",
			values:   []string{"Bearer wrong", "Bearer " + validToken},
			digest:   digest,
			maxBytes: maxBytes,
		},
		{
			name:     "non-positive-maxBytes",
			values:   []string{"Bearer " + validToken},
			digest:   digest,
			maxBytes: 0,
		},
		{
			name:     "negative-maxBytes",
			values:   []string{"Bearer " + validToken},
			digest:   digest,
			maxBytes: -1,
		},
		{
			name:     "over-length",
			values:   []string{"Bearer " + strings.Repeat("x", maxBytes)},
			digest:   digest,
			maxBytes: maxBytes,
		},
		{
			name:     "empty-header-string",
			values:   []string{""},
			digest:   digest,
			maxBytes: maxBytes,
		},
		{
			name:     "missing-prefix",
			values:   []string{validToken},
			digest:   digest,
			maxBytes: maxBytes,
		},
		{
			name:     "lowercase-prefix",
			values:   []string{"bearer " + validToken},
			digest:   digest,
			maxBytes: maxBytes,
		},
		{
			name:     "uppercase-prefix",
			values:   []string{"BEARER " + validToken},
			digest:   digest,
			maxBytes: maxBytes,
		},
		{
			name:     "basic-scheme",
			values:   []string{"Basic " + validToken},
			digest:   digest,
			maxBytes: maxBytes,
		},
		{
			name:     "prefix-without-space",
			values:   []string{"Bearer"},
			digest:   digest,
			maxBytes: maxBytes,
		},
		{
			name:     "tab-after-bearer",
			values:   []string{"Bearer\t" + validToken},
			digest:   digest,
			maxBytes: maxBytes,
		},
		{
			name:     "empty-token",
			values:   []string{"Bearer "},
			digest:   Digest(""),
			maxBytes: maxBytes,
		},
		{
			name:     "leading-space-in-token",
			values:   []string{"Bearer  " + validToken},
			digest:   Digest(" " + validToken),
			maxBytes: maxBytes,
		},
		{
			name:     "trailing-space-in-token",
			values:   []string{"Bearer " + validToken + " "},
			digest:   Digest(validToken + " "),
			maxBytes: maxBytes,
		},
		{
			name:     "inner-space-in-token",
			values:   []string{"Bearer abc def"},
			digest:   Digest("abc def"),
			maxBytes: maxBytes,
		},
		{
			name:     "nul-byte-below-33",
			values:   []string{"Bearer abc\x00def"},
			digest:   Digest("abc\x00def"),
			maxBytes: maxBytes,
		},
		{
			name:     "newline-below-33",
			values:   []string{"Bearer abc\ndef"},
			digest:   Digest("abc\ndef"),
			maxBytes: maxBytes,
		},
		{
			name:     "unit-separator-31-below-33",
			values:   []string{"Bearer abc\x1fdef"},
			digest:   Digest("abc\x1fdef"),
			maxBytes: maxBytes,
		},
		{
			name:     "del-127-above-126",
			values:   []string{"Bearer abc\x7fdef"},
			digest:   Digest("abc\x7fdef"),
			maxBytes: maxBytes,
		},
		{
			name:     "utf8-multibyte",
			values:   []string{"Bearer 令牌token"},
			digest:   Digest("令牌token"),
			maxBytes: maxBytes,
		},
		{
			name:     "invalid-utf8-high-byte",
			values:   []string{"Bearer abc\xffdef"},
			digest:   Digest("abc\xffdef"),
			maxBytes: maxBytes,
		},
		{
			name:     "wrong-token-same-length",
			values:   []string{"Bearer " + strings.Repeat("x", len(validToken))},
			digest:   digest,
			maxBytes: maxBytes,
		},
		{
			name:     "wrong-token-prefix",
			values:   []string{"Bearer " + validToken[:len(validToken)-1]},
			digest:   digest,
			maxBytes: maxBytes,
		},
		{
			name:     "wrong-token-suffix",
			values:   []string{"Bearer " + validToken + "x"},
			digest:   digest,
			maxBytes: maxBytes,
		},
	}

	for _, tc := range rejectCases {
		t.Run(tc.name, func(t *testing.T) {
			if VerifyHeader(tc.values, tc.digest, tc.maxBytes) {
				t.Fatalf("VerifyHeader(%q) unexpectedly succeeded", tc.values)
			}
		})
	}
}

func TestValidateTokenParseDigestHexAndMultiKeyConstantTime(t *testing.T) {
	if err := ValidateToken(strings.Repeat("a", MinTokenBytes)); err != nil {
		t.Fatalf("32-byte token rejected: %v", err)
	}
	if err := ValidateToken(strings.Repeat("~", MaxTokenBytes)); err != nil {
		t.Fatalf("512-byte token rejected: %v", err)
	}

	canary := "secret-canary-token-material-xyz123456"
	invalidTokens := []struct {
		name string
		raw  string
	}{
		{"empty", ""},
		{"short-31", canary[:31]},
		{"long-513", canary + strings.Repeat("b", 513-len(canary))},
		{"space", canary[:20] + " " + canary[20:]},
		{"newline", canary + "\n"},
		{"tab", canary[:16] + "\t" + canary[16:]},
		{"nul", canary[:16] + "\x00" + canary[16:]},
		{"del", canary[:16] + "\x7f" + canary[16:]},
		{"utf8", canary[:20] + "密" + canary[20:]},
	}
	for _, tc := range invalidTokens {
		t.Run("token-"+tc.name, func(t *testing.T) {
			err := ValidateToken(tc.raw)
			if err == nil {
				t.Fatalf("expected invalid token %s to fail", tc.name)
			}
			if strings.Contains(err.Error(), "secret-canary") {
				t.Fatalf("ValidateToken error leaked token material: %q", err.Error())
			}
		})
	}

	validTok := "valid-token-for-digest-parsing-test-0001"
	wantDigest := Digest(validTok)
	lowerHex := hex.EncodeToString(wantDigest[:])
	upperHex := strings.ToUpper(lowerHex)
	if got, err := ParseDigestHex(lowerHex); err != nil || got != wantDigest {
		t.Fatalf("ParseDigestHex(lower) = %x, %v; want %x", got, err, wantDigest)
	}
	if got, err := ParseDigestHex(upperHex); err != nil || got != wantDigest {
		t.Fatalf("ParseDigestHex(upper) = %x, %v; want %x", got, err, wantDigest)
	}

	emptyHex := fmt.Sprintf("%x", sha256.Sum256(nil))
	invalidDigests := []struct {
		name string
		raw  string
	}{
		{"empty", ""},
		{"short-63", lowerHex[:63]},
		{"long-65", lowerHex + "0"},
		{"leading-space", " " + lowerHex[:63]},
		{"non-hex-char", strings.Repeat("g", 64)},
		{"all-zeros", strings.Repeat("0", 64)},
		{"sha256-of-empty-string", emptyHex},
	}
	for _, tc := range invalidDigests {
		t.Run("digest-"+tc.name, func(t *testing.T) {
			_, err := ParseDigestHex(tc.raw)
			if err == nil {
				t.Fatalf("expected invalid digest %s to fail", tc.name)
			}
			if tc.raw != "" && len(tc.raw) >= 16 && strings.Contains(err.Error(), tc.raw[:16]) {
				t.Fatalf("ParseDigestHex error echoed digest input: %q", err.Error())
			}
		})
	}

	// ExtractBearerToken + MatchDigestConstantTime across 64 digests (first, middle, last, miss, duplicate).
	const keyCount = 64
	tokens := make([]string, keyCount)
	digests := make([][32]byte, keyCount)
	for i := 0; i < keyCount; i++ {
		tokens[i] = fmt.Sprintf("key-token-%02d-%s", i, strings.Repeat("k", 32))
		digests[i] = Digest(tokens[i])
	}

	for _, checkIdx := range []int{0, 1, 31, 32, 62, 63} {
		extracted, ok := ExtractBearerToken([]string{"Bearer " + tokens[checkIdx]}, 1024)
		if !ok || extracted != tokens[checkIdx] {
			t.Fatalf("ExtractBearerToken idx=%d got (%q, %v)", checkIdx, extracted, ok)
		}
		gotIdx, matched := MatchDigestConstantTime(extracted, digests)
		if !matched || gotIdx != checkIdx {
			t.Fatalf("MatchDigestConstantTime idx=%d got (%d, %v)", checkIdx, gotIdx, matched)
		}
	}

	if idx, ok := MatchDigestConstantTime("non-existent-token-"+strings.Repeat("z", 32), digests); ok || idx != -1 {
		t.Fatalf("expected non-matching token to return (-1, false), got (%d, %v)", idx, ok)
	}
	if idx, ok := MatchDigestConstantTime("", digests); ok || idx != -1 {
		t.Fatalf("expected empty candidate to return (-1, false), got (%d, %v)", idx, ok)
	}
	if idx, ok := MatchDigestConstantTime(tokens[0], nil); ok || idx != -1 {
		t.Fatalf("expected empty digests slice to return (-1, false), got (%d, %v)", idx, ok)
	}

	// Defensive check: duplicate digests in slice fail closed instead of ambiguously matching.
	dup := append([][32]byte(nil), digests[:4]...)
	dup[3] = dup[1]
	if idx, ok := MatchDigestConstantTime(tokens[1], dup); ok || idx != -1 {
		t.Fatalf("expected duplicate digest match to fail closed (-1, false), got (%d, %v)", idx, ok)
	}
}
