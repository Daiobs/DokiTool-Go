package testutil

import (
	"fmt"
	"sort"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

// OracleDifference returns a deterministic JSON-path diff between two unified
// values, or an empty string when they are semantically equal.
func OracleDifference(got, want any, path string) string {
	if unified.Equal(got, want) {
		return ""
	}
	a, b := unified.Map(got), unified.Map(want)
	if a != nil && b != nil {
		keys := map[string]bool{}
		for key := range a {
			keys[key] = true
		}
		for key := range b {
			keys[key] = true
		}
		ordered := make([]string, 0, len(keys))
		for key := range keys {
			ordered = append(ordered, key)
		}
		sort.Strings(ordered)
		for _, key := range ordered {
			av, ap := a[key]
			bv, bp := b[key]
			if ap != bp {
				return fmt.Sprintf("%s.%s: presence got=%v want=%v", path, key, ap, bp)
			}
			if difference := OracleDifference(av, bv, path+"."+key); difference != "" {
				return difference
			}
		}
	}
	x, y := unified.Slice(got), unified.Slice(want)
	if x != nil && y != nil {
		if len(x) != len(y) {
			return fmt.Sprintf("%s: length got=%d want=%d", path, len(x), len(y))
		}
		for index := range x {
			if difference := OracleDifference(x[index], y[index], fmt.Sprintf("%s[%d]", path, index)); difference != "" {
				return difference
			}
		}
	}
	return fmt.Sprintf("%s: got %#v (%T); want %#v (%T)", path, got, got, want, want)
}

// OracleEqual fails the test with the first deterministic JSON-path difference
// if got and want are not semantically equal under unified.Equal.
func OracleEqual(t testing.TB, got, want any) {
	t.Helper()
	if difference := OracleDifference(got, want, "$"); difference != "" {
		t.Fatal(difference)
	}
}
