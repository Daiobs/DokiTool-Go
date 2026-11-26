package urlpolicy

import (
	"fmt"
	"testing"
	"time"
)

func TestExtractSubtitleExpiresAt(t *testing.T) {
	now := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	const maxWindow = 30 * 24 * time.Hour

	fmtUnix := func(sec int64) string {
		return time.Unix(sec, 0).UTC().Format(time.RFC3339)
	}

	nowSec := now.Unix()
	plus1s := now.Add(time.Second).Unix()
	plus1h := now.Add(time.Hour).Unix()
	plus2h := now.Add(2 * time.Hour).Unix()
	plus6h := now.Add(6 * time.Hour).Unix()
	atMax := now.Add(maxWindow).Unix()
	past1s := now.Add(-time.Second).Unix()
	overMax1s := now.Add(maxWindow + time.Second).Unix()

	tests := []struct {
		name      string
		rawURL    string
		now       time.Time
		maxWindow time.Duration
		want      string
	}{
		// Basic parameter names & casing
		{
			name:      "lowercase expire with ampersand",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?v=abc&expire=%d&lang=en", plus2h),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(plus2h),
		},
		{
			name:      "lowercase expires with ampersand",
			rawURL:    fmt.Sprintf("https://captions.example.com/sub.vtt?lang=en&expires=%d", plus6h),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(plus6h),
		},
		{
			name:      "uppercase EXPIRE",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?EXPIRE=%d", plus2h),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(plus2h),
		},
		{
			name:      "mixed case ExPiReS",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?ExPiReS=%d", plus2h),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(plus2h),
		},

		// Query separators (&, ;, mixed, empty segments, valueless keys)
		{
			name:      "semicolon separator only",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?v=abc;expire=%d;lang=en", plus2h),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(plus2h),
		},
		{
			name:      "mixed ampersand and semicolon separators",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?v=abc&lang=en;expires=%d&fmt=vtt;foo=bar", plus1h),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(plus1h),
		},
		{
			name:      "empty segments and valueless expire key skipped",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?&&;;expire&;expires=%d;&", plus2h),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(plus2h),
		},

		// Whitespace, percent-encoding, and malformed percent-encoding fallback
		{
			name:      "percent-encoded key and value",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?%%65xpire=%%3%d%s", plus2h/1000000000, fmt.Sprintf("%09d", plus2h%1000000000)),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(plus2h),
		},
		{
			name:      "trimmed whitespace around encoded key and value",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?%%20EXPIRES%%20=+%%20%d%%20+", plus1h),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(plus1h),
		},
		{
			name:      "malformed percent-encoding in key falls back without panic",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?%%ZZ=%d&expire%%ZZ=%d", plus2h, plus2h),
			now:       now,
			maxWindow: maxWindow,
			want:      "",
		},
		{
			name:      "malformed percent-encoding in value falls back and skips invalid",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expire=%%ZZ&expires=%d%%ZZ", plus2h),
			now:       now,
			maxWindow: maxWindow,
			want:      "",
		},
		{
			name:      "malformed percent-encoded params do not block valid later expire",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?%%ZZ=1;expire=%%ZZ&expires=%d", plus1h),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(plus1h),
		},

		// Multiple expire/expires params -> earliest valid wins
		{
			name:      "multiple params later then earlier picks earliest",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expire=%d&expires=%d", plus6h, plus1h),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(plus1h),
		},
		{
			name:      "multiple params earlier then later picks earliest",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expires=%d;expire=%d", plus1h, plus6h),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(plus1h),
		},
		{
			name: "multiple params ignoring past, out-of-window, zero, negative, non-numeric",
			rawURL: fmt.Sprintf(
				"https://www.youtube.com/api/timedtext?expire=%d&expires=%d&expire=0&expires=-50&expire=abc;expires=%d;expire=%d&expire=%d",
				past1s, overMax1s, plus6h, plus2h, plus2h*1000,
			),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(plus2h),
		},

		// Exact window boundaries: (now, now+maxWindow]
		{
			name:      "boundary now rejected",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expire=%d", nowSec),
			now:       now,
			maxWindow: maxWindow,
			want:      "",
		},
		{
			name:      "boundary now-1s rejected",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expire=%d", past1s),
			now:       now,
			maxWindow: maxWindow,
			want:      "",
		},
		{
			name:      "boundary now+1s accepted",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expire=%d", plus1s),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(plus1s),
		},
		{
			name:      "boundary now+maxWindow accepted",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expire=%d", atMax),
			now:       now,
			maxWindow: maxWindow,
			want:      fmtUnix(atMax),
		},
		{
			name:      "boundary now+maxWindow+1s rejected",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expire=%d", overMax1s),
			now:       now,
			maxWindow: maxWindow,
			want:      "",
		},
		{
			name:      "sub-second now rejects same-second and accepts next-second",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expire=%d&expires=%d", nowSec, plus1s),
			now:       now.Add(500 * time.Millisecond),
			maxWindow: maxWindow,
			want:      fmtUnix(plus1s),
		},
		{
			name:      "non-UTC now timezone returns UTC RFC3339",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expire=%d", plus2h),
			now:       now.In(time.FixedZone("CST", 8*3600)),
			maxWindow: maxWindow,
			want:      fmtUnix(plus2h),
		},

		// Guards and invalid inputs
		{
			name:      "zero now rejected",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expire=%d", plus2h),
			now:       time.Time{},
			maxWindow: maxWindow,
			want:      "",
		},
		{
			name:      "zero maxWindow rejected",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expire=%d", plus2h),
			now:       now,
			maxWindow: 0,
			want:      "",
		},
		{
			name:      "negative maxWindow rejected",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expire=%d", plus2h),
			now:       now,
			maxWindow: -time.Hour,
			want:      "",
		},
		{
			name:      "empty URL",
			rawURL:    "",
			now:       now,
			maxWindow: maxWindow,
			want:      "",
		},
		{
			name:      "malformed URL",
			rawURL:    "://missing-scheme?expire=1794238131",
			now:       now,
			maxWindow: maxWindow,
			want:      "",
		},
		{
			name:      "URL with control byte fails url.Parse",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expire=%d\x00", plus2h),
			now:       now,
			maxWindow: maxWindow,
			want:      "",
		},
		{
			name:      "URL without query",
			rawURL:    "https://www.youtube.com/api/timedtext",
			now:       now,
			maxWindow: maxWindow,
			want:      "",
		},
		{
			name:      "non-matching parameter names ignored",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?exp=%d&expired=%d&expiration=%d", plus2h, plus2h, plus2h),
			now:       now,
			maxWindow: maxWindow,
			want:      "",
		},
		{
			name:      "zero and negative seconds rejected",
			rawURL:    "https://www.youtube.com/api/timedtext?expire=0&expires=-12345",
			now:       now,
			maxWindow: maxWindow,
			want:      "",
		},
		{
			name:      "non-numeric and overflow values rejected",
			rawURL:    "https://www.youtube.com/api/timedtext?expire=&expires=abc&expire=123.45&expires=99999999999999999999999",
			now:       now,
			maxWindow: maxWindow,
			want:      "",
		},
		{
			name:      "millisecond timestamp rejected as out-of-window",
			rawURL:    fmt.Sprintf("https://www.youtube.com/api/timedtext?expire=%d", plus2h*1000),
			now:       now,
			maxWindow: maxWindow,
			want:      "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ExtractSubtitleExpiresAt(tc.rawURL, tc.now, tc.maxWindow); got != tc.want {
				t.Fatalf("ExtractSubtitleExpiresAt(%q, %v, %v) = %q, want %q", tc.rawURL, tc.now, tc.maxWindow, got, tc.want)
			}
		})
	}
}
