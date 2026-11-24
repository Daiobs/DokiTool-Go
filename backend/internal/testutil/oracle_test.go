package testutil

import (
	"strings"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func TestOracleDifferenceAndEqual(t *testing.T) {
	a := unified.Object{
		"code":  "OK",
		"items": unified.Array{unified.Object{"id": "1", "count": int64(2)}},
	}
	b := unified.Object{
		"code":  "OK",
		"items": unified.Array{unified.Object{"id": "1", "count": float64(2)}},
	}
	OracleEqual(t, a, b)

	if diff := OracleDifference(
		unified.Object{"a": "1"},
		unified.Object{"a": "1", "b": "2"},
		"$",
	); !strings.Contains(diff, "$.b: presence got=false want=true") {
		t.Fatalf("unexpected missing-key diff: %q", diff)
	}

	if diff := OracleDifference(
		unified.Array{"x"},
		unified.Array{"x", "y"},
		"$",
	); !strings.Contains(diff, "$: length got=1 want=2") {
		t.Fatalf("unexpected slice-length diff: %q", diff)
	}

	if diff := OracleDifference(
		unified.Object{"items": unified.Array{unified.Object{"id": "1"}}},
		unified.Object{"items": unified.Array{unified.Object{"id": "2"}}},
		"$",
	); !strings.Contains(diff, "$.items[0].id:") {
		t.Fatalf("unexpected nested diff: %q", diff)
	}
}
