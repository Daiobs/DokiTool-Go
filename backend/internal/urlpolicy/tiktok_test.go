package urlpolicy

import "testing"

func TestIsTikTokDomain(t *testing.T) {
	good := []string{
		"tiktok.com",
		"www.tiktok.com",
		"m.tiktok.com",
		"vm.tiktok.com",
		"vt.tiktok.com",
		"WWW.TIKTOK.COM",
	}
	for _, host := range good {
		if !IsTikTokDomain(host) {
			t.Errorf("expected IsTikTokDomain(%q)=true", host)
		}
	}
	bad := []string{
		"",
		"not-tiktok.com",
		"tiktok.com.evil.example",
		"tiktokcdn.com",
		"douyin.com",
	}
	for _, host := range bad {
		if IsTikTokDomain(host) {
			t.Errorf("expected IsTikTokDomain(%q)=false", host)
		}
	}
}

func TestExtractTikTokItemTarget(t *testing.T) {
	const wantID = "7345678901234567890"
	const wantCanonical = "https://www.tiktok.com/@i/video/" + wantID

	longCases := []string{
		"https://www.tiktok.com/@creator/video/" + wantID,
		"https://www.tiktok.com/@creator/video/" + wantID + "?is_from_webapp=1&sender_device=pc",
		"https://www.tiktok.com/@creator/photo/" + wantID + "?foo=bar",
		"https://m.tiktok.com/@creator/video/" + wantID + "/",
		"https://www.tiktok.com/share/video/" + wantID,
		"https://www.tiktok.com/share/photo/" + wantID,
		"https://www.tiktok.com/embed/v2/" + wantID,
		"https://www.tiktok.com/player/v1/" + wantID,
		"https://m.tiktok.com/v/" + wantID + ".html",
		"http://m.tiktok.com/v/" + wantID,
		"https://www.tiktok.com:443/@creator/photo/" + wantID,
	}
	for _, raw := range longCases {
		id, canonical, isShort, ok := ExtractTikTokItemTarget(raw)
		if !ok || isShort || id != wantID || canonical != wantCanonical {
			t.Errorf("ExtractTikTokItemTarget(%q) = (%q, %q, %v, %v), want (%q, %q, false, true)",
				raw, id, canonical, isShort, ok, wantID, wantCanonical)
		}
	}

	shortCases := []struct {
		raw       string
		wantCanon string
		wantKey   string
	}{
		{"https://vm.tiktok.com/ZM8abc123/", "https://vm.tiktok.com/ZM8abc123/", "vm:ZM8abc123"},
		{"http://vt.tiktok.com/ZS9xyz789?foo=1", "https://vt.tiktok.com/ZS9xyz789/", "vt:ZS9xyz789"},
		{"https://www.tiktok.com/t/ZT8def456/", "https://www.tiktok.com/t/ZT8def456/", "t:ZT8def456"},
		{"https://tiktok.com/t/ZT8def456", "https://www.tiktok.com/t/ZT8def456/", "t:ZT8def456"},
	}
	for _, tc := range shortCases {
		id, canonical, isShort, ok := ExtractTikTokItemTarget(tc.raw)
		if !ok || !isShort || id != "" || canonical != tc.wantCanon {
			t.Errorf("ExtractTikTokItemTarget(%q) = (%q, %q, %v, %v), want (\"\", %q, true, true)",
				tc.raw, id, canonical, isShort, ok, tc.wantCanon)
		}
		key, keyOK := ExtractTikTokShortCode(tc.raw)
		if !keyOK || key != tc.wantKey {
			t.Errorf("ExtractTikTokShortCode(%q) = (%q, %v), want (%q, true)", tc.raw, key, keyOK, tc.wantKey)
		}
	}

	invalidCases := []string{
		"",
		"https://www.tiktok.com/",
		"https://www.tiktok.com/?_r=1",
		"https://www.tiktok.com/@creator",
		"https://www.tiktok.com/discover",
		"https://www.tiktok.com/@creator/video/1234", // too short
		"https://www.tiktok.com/@creator/video/notdigits",
		"https://vm.tiktok.com/a/b",
		"https://www.tiktok.com/t/",
		"https://user:pass@www.tiktok.com/@creator/video/" + wantID,
		"https://www.tiktok.com:8443/@creator/video/" + wantID,
		"ftp://www.tiktok.com/@creator/video/" + wantID,
		"https://evil-tiktok.com/@creator/video/" + wantID,
	}
	for _, raw := range invalidCases {
		if id, canon, isShort, ok := ExtractTikTokItemTarget(raw); ok {
			t.Errorf("expected invalid for %q, got (%q, %q, %v)", raw, id, canon, isShort)
		}
	}
}
