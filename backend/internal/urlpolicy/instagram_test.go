package urlpolicy

import (
	"strings"
	"testing"
)

func TestExtractInstagramPostTarget(t *testing.T) {
	valid := []struct {
		raw       string
		wantID    string
		wantCanon string
	}{
		{
			raw:       "https://www.instagram.com/p/aye83DjauH/",
			wantID:    "aye83DjauH",
			wantCanon: "https://www.instagram.com/p/aye83DjauH/",
		},
		{
			raw:       "https://instagram.com/p/aye83DjauH?utm_source=ig_web_copy_link&igsh=abc#frag",
			wantID:    "aye83DjauH",
			wantCanon: "https://www.instagram.com/p/aye83DjauH/",
		},
		{
			raw:       "https://m.instagram.com/reel/CTApqC8BGWd/?hl=en",
			wantID:    "CTApqC8BGWd",
			wantCanon: "https://www.instagram.com/reel/CTApqC8BGWd/",
		},
		{
			raw:       "http://www.instagram.com:80/reels/CTApqC8BGWd#ig",
			wantID:    "CTApqC8BGWd",
			wantCanon: "https://www.instagram.com/reel/CTApqC8BGWd/",
		},
		{
			raw:       "https://www.instagram.com:443/tv/aye83DjauH/?a=1",
			wantID:    "aye83DjauH",
			wantCanon: "https://www.instagram.com/tv/aye83DjauH/",
		},
		{
			raw:       "https://www.instagram.com/some_creator/p/aye83DjauH/?img_index=2",
			wantID:    "aye83DjauH",
			wantCanon: "https://www.instagram.com/p/aye83DjauH/",
		},
		{
			raw:       "https://www.instagram.com/some_creator/reel/CTApqC8BGWd/",
			wantID:    "CTApqC8BGWd",
			wantCanon: "https://www.instagram.com/reel/CTApqC8BGWd/",
		},
		{
			raw:       "https://instagr.am/p/aye83DjauH/?utm_medium=share",
			wantID:    "aye83DjauH",
			wantCanon: "https://www.instagram.com/p/aye83DjauH/",
		},
		{
			raw:       "https://www.instagr.am/reel/CTApqC8BGWd/#top",
			wantID:    "CTApqC8BGWd",
			wantCanon: "https://www.instagram.com/reel/CTApqC8BGWd/",
		},
	}

	for _, tc := range valid {
		id, canon, ok := ExtractInstagramPostTarget(tc.raw)
		if !ok || id != tc.wantID || canon != tc.wantCanon {
			t.Fatalf("ExtractInstagramPostTarget(%q) = (%q, %q, %v), want (%q, %q, true)",
				tc.raw, id, canon, ok, tc.wantID, tc.wantCanon)
		}
	}

	invalid := []string{
		"",
		"https://instagr.am/someuser/p/aye83DjauH/",
		"https://foo.instagr.am/p/aye83DjauH/",
		"https://instagr.am:8443/p/aye83DjauH/",
		"https://www.instagram.com:8443/p/aye83DjauH/",
		"https://www.instagram.com:/p/aye83DjauH/",
		"https://user:pass@www.instagram.com/p/aye83DjauH/",
		"ftp://www.instagram.com/p/aye83DjauH/",
		"https://www.instagram.com/p//aye83DjauH/",
		"https://www.instagram.com/stories/user/123456/",
		"https://www.instagram.com/p/ab/",
		"https://www.instagram.com/p/aye83DjauH/ extra",
		"https://www.instagram.com/p/aye83DjauH/\\" + "x",
		"https://www.instagram.com/p/aye83DjauH/?" + strings.Repeat("a", 2050),
	}
	for _, raw := range invalid {
		if id, canon, ok := ExtractInstagramPostTarget(raw); ok {
			t.Fatalf("ExtractInstagramPostTarget(%q) unexpectedly succeeded: (%q, %q)", raw, id, canon)
		}
	}
}
