package bearer

import (
	"crypto/sha256"
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
