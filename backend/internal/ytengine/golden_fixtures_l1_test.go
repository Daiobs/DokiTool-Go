package ytengine

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func TestGoldenFixturesL1YouTube8KLabeling(t *testing.T) {
	fixturePath := filepath.Join("..", "..", "..", "tests", "golden-fixtures", "youtube", "ytengine-8k-input.json")
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read golden fixture %s: %v", fixturePath, err)
	}
	var info Info
	if err := json.Unmarshal(raw, &info); err != nil {
		t.Fatalf("unmarshal golden fixture %s: %v", fixturePath, err)
	}

	const now int64 = 1762300800
	opts := AdaptOptions{
		PlatformID:    "youtube",
		ContentID:     info.ID,
		SourceURL:     "https://www.youtube.com/watch?v=" + info.ID,
		EnableDASHMux: true,
		AllowedMediaURL: func(rawURL string) bool {
			return strings.HasPrefix(rawURL, "https://rr1---sn-golden.googlevideo.com/")
		},
	}

	env := AdaptInfo(&info, opts, now)
	assertGoldenVariantEnvelopeValid(t, env, now, "OK")

	data := unified.Map(env["data"])
	items := unified.Slice(data["items"])
	if len(items) != 1 {
		t.Fatalf("items len = %d, want 1", len(items))
	}
	variants := unified.Slice(unified.Map(items[0])["variants"])
	if len(variants) == 0 {
		t.Fatalf("expected non-empty variants")
	}

	asInt64 := func(v any) int64 {
		switch n := v.(type) {
		case int:
			return int64(n)
		case int64:
			return n
		case float64:
			return int64(n)
		case json.Number:
			if parsed, err := n.Int64(); err == nil {
				return parsed
			}
		}
		return 0
	}

	var saw8K, saw4K bool
	for _, rawVariant := range variants {
		v := unified.Map(rawVariant)
		meta := unified.Map(v["metadata"])
		label := unified.Str(v["label"])
		height := asInt64(meta["height"])
		width := asInt64(meta["width"])
		if height >= 4320 || width >= 7680 {
			saw8K = true
			if !strings.Contains(label, "8K") {
				t.Errorf("4320p variant label = %q, want to contain 8K", label)
			}
			if strings.Contains(label, "4K") {
				t.Errorf("4320p variant label = %q, must NOT mislabel 8K as 4K", label)
			}
		} else if height >= 2160 || width >= 3840 {
			saw4K = true
			if !strings.Contains(label, "4K") {
				t.Errorf("2160p variant label = %q, want to contain 4K", label)
			}
			if strings.Contains(label, "8K") {
				t.Errorf("2160p variant label = %q, must NOT mislabel 4K as 8K", label)
			}
		}
	}
	if !saw8K {
		t.Fatalf("expected an 8K (4320p) variant in adapted output, got variants=%+v", variants)
	}
	if !saw4K {
		t.Fatalf("expected a 4K (2160p) variant in adapted output, got variants=%+v", variants)
	}
}
