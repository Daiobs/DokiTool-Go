package urlpolicy

import "testing"

func TestExtractPinterestPinTarget(t *testing.T) {
	cases := []struct {
		name      string
		raw       string
		wantID    string
		wantCanon string
		wantShort bool
		wantOK    bool
	}{
		{
			name:      "standard-pin",
			raw:       "https://www.pinterest.com/pin/858146903966145191/",
			wantID:    "858146903966145191",
			wantCanon: "https://www.pinterest.com/pin/858146903966145191/",
			wantOK:    true,
		},
		{
			name:      "sent-tracking-query-and-regional-subdomain",
			raw:       "https://jp.pinterest.com/pin/858146903966145191/sent/?invite_code=abc&sender=123",
			wantID:    "858146903966145191",
			wantCanon: "https://www.pinterest.com/pin/858146903966145191/",
			wantOK:    true,
		},
		{
			name:      "regional-tld-ca-and-slug",
			raw:       "https://www.pinterest.ca/pin/cool-design-idea--858146903966145191/",
			wantID:    "858146903966145191",
			wantCanon: "https://www.pinterest.com/pin/858146903966145191/",
			wantOK:    true,
		},
		{
			name:      "regional-tld-co-uk-http",
			raw:       "http://pinterest.co.uk/pin/858146903966145191",
			wantID:    "858146903966145191",
			wantCanon: "https://www.pinterest.com/pin/858146903966145191/",
			wantOK:    true,
		},
		{
			name:      "pin-it-shortlink",
			raw:       "https://pin.it/3abcXYZ_1",
			wantCanon: "https://pin.it/3abcXYZ_1",
			wantShort: true,
			wantOK:    true,
		},
		{
			name:   "board-page-rejected",
			raw:    "https://www.pinterest.com/creator/my-board/",
			wantOK: false,
		},
		{
			name:   "homepage-rejected",
			raw:    "https://www.pinterest.com/",
			wantOK: false,
		},
		{
			name:   "pin-it-root-rejected",
			raw:    "https://pin.it/",
			wantOK: false,
		},
		{
			name:   "evil-lookalike-rejected",
			raw:    "https://evilpinterest.com/pin/858146903966145191/",
			wantOK: false,
		},
		{
			name:   "non-standard-port-rejected",
			raw:    "https://www.pinterest.com:8443/pin/858146903966145191/",
			wantOK: false,
		},
		{
			name:   "userinfo-rejected",
			raw:    "https://user:pass@www.pinterest.com/pin/858146903966145191/",
			wantOK: false,
		},
		{
			name:   "short-pin-id-rejected",
			raw:    "https://www.pinterest.com/pin/123/",
			wantOK: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotID, gotCanon, gotShort, gotOK := ExtractPinterestPinTarget(tc.raw)
			if gotOK != tc.wantOK || gotID != tc.wantID || gotCanon != tc.wantCanon || gotShort != tc.wantShort {
				t.Fatalf("ExtractPinterestPinTarget(%q) = (%q, %q, %v, %v), want (%q, %q, %v, %v)",
					tc.raw, gotID, gotCanon, gotShort, gotOK, tc.wantID, tc.wantCanon, tc.wantShort, tc.wantOK)
			}
		})
	}
}
