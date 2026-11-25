package main

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/api"
)

func TestGeneratedStatsTypesUpToDate(t *testing.T) {
	want, err := RenderStatsTypes()
	if err != nil {
		t.Fatalf("RenderStatsTypes failed: %v", err)
	}
	target := filepath.Join("..", "..", "..", "frontend", "src", "monitor", "statsTypes.generated.ts")
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read %s: %v (run `cd backend && go run ./cmd/genstatstypes`)", target, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s is out of date with Go api.StatsSnapshot; run `(cd backend && go run ./cmd/genstatstypes)`", target)
	}
}

func TestRenderTypeProjectsJSONTagsAndQuotedKeys(t *testing.T) {
	type SyntheticBuckets struct {
		LE10 uint64 `json:"<=10"`
		Inf  uint64 `json:"+Inf"`
	}
	type SyntheticRoot struct {
		Name     string            `json:"name"`
		Optional string            `json:"optional,omitempty"`
		Ignored  string            `json:"-"`
		Counts   map[string]uint64 `json:"counts"`
		Buckets  SyntheticBuckets  `json:"buckets"`
	}

	raw, err := RenderType(reflect.TypeOf(SyntheticRoot{}))
	if err != nil {
		t.Fatalf("RenderType failed: %v", err)
	}
	text := string(raw)
	for _, wantSub := range []string{
		"export interface SyntheticBuckets {",
		`  "<=10": number;`,
		`  "+Inf": number;`,
		"export interface SyntheticRoot {",
		"  name: string;",
		"  optional?: string;",
		"  counts: Record<string, number>;",
		"  buckets: SyntheticBuckets;",
	} {
		if !strings.Contains(text, wantSub) {
			t.Fatalf("generated TS missing %q:\n%s", wantSub, text)
		}
	}
	if strings.Contains(text, "Ignored") {
		t.Fatalf("ignored json:\"-\" field leaked into generated TS:\n%s", text)
	}
}

func cloneFieldOverrides() map[string]fieldOverride {
	out := make(map[string]fieldOverride, len(fieldOverrides))
	for k, v := range fieldOverrides {
		out[k] = v
	}
	return out
}

func cloneExtraCompatFields() map[string][]extraField {
	out := make(map[string][]extraField, len(extraCompatFields))
	for k, v := range extraCompatFields {
		cp := make([]extraField, len(v))
		copy(cp, v)
		out[k] = cp
	}
	return out
}

func TestRenderStatsTypesHasNoStaleOverridesOrCompat(t *testing.T) {
	if len(fieldOverrides) == 0 {
		t.Fatal("expected non-empty fieldOverrides")
	}
	if len(extraCompatFields) == 0 {
		t.Fatal("expected non-empty extraCompatFields")
	}
	raw, err := RenderStatsTypes()
	if err != nil {
		t.Fatalf("RenderStatsTypes() failed strict stale-config validation: %v", err)
	}
	if len(raw) == 0 {
		t.Fatal("RenderStatsTypes() returned empty output")
	}
}

func TestRenderTypeWithConfigRejectsStaleFieldOverride(t *testing.T) {
	overrides := cloneFieldOverrides()
	overrides["StatsSnapshot.nonexistent_renamed_field"] = fieldOverride{optional: true}

	_, err := renderTypeWithConfig(reflect.TypeOf(api.StatsSnapshot{}), overrides, extraCompatFields, true)
	if err == nil {
		t.Fatal("expected strict renderTypeWithConfig to fail on stale fieldOverride key")
	}
	msg := err.Error()
	for _, want := range []string{"unused fieldOverrides", "StatsSnapshot.nonexistent_renamed_field"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q missing expected substring %q", msg, want)
		}
	}

	if _, err := renderTypeWithConfig(reflect.TypeOf(api.StatsSnapshot{}), overrides, extraCompatFields, false); err != nil {
		t.Fatalf("non-strict renderTypeWithConfig should ignore unmatched overrides, got: %v", err)
	}
}

func TestRenderTypeWithConfigRejectsStaleExtraCompatFields(t *testing.T) {
	t.Run("missing_struct", func(t *testing.T) {
		compat := cloneExtraCompatFields()
		compat["GhostSnapshot"] = []extraField{{jsonName: "legacy_metric", tsType: "number", optional: true}}

		_, err := renderTypeWithConfig(reflect.TypeOf(api.StatsSnapshot{}), fieldOverrides, compat, true)
		if err == nil {
			t.Fatal("expected error for extraCompatFields referencing nonexistent struct")
		}
		for _, want := range []string{"unused extraCompatFields", "GhostSnapshot.legacy_metric"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("error %q missing expected substring %q", err.Error(), want)
			}
		}
	})

	t.Run("empty_struct_entry", func(t *testing.T) {
		compat := cloneExtraCompatFields()
		compat["EmptyCompatStruct"] = nil

		_, err := renderTypeWithConfig(reflect.TypeOf(api.StatsSnapshot{}), fieldOverrides, compat, true)
		if err == nil {
			t.Fatal("expected error for empty extraCompatFields struct entry")
		}
		for _, want := range []string{"unused extraCompatFields", "EmptyCompatStruct"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("error %q missing expected substring %q", err.Error(), want)
			}
		}
	})

	t.Run("shadowed_by_real_field", func(t *testing.T) {
		compat := cloneExtraCompatFields()
		compat["YTDLPStatsSnapshot"] = append(compat["YTDLPStatsSnapshot"], extraField{
			jsonName: "enabled",
			tsType:   "boolean",
			optional: true,
		})

		_, err := renderTypeWithConfig(reflect.TypeOf(api.StatsSnapshot{}), fieldOverrides, compat, true)
		if err == nil {
			t.Fatal("expected error when extraCompatFields entry is shadowed by real Go struct field")
		}
		for _, want := range []string{"unused extraCompatFields", "YTDLPStatsSnapshot.enabled"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("error %q missing expected substring %q", err.Error(), want)
			}
		}
	})

	t.Run("both_override_and_compat_stale", func(t *testing.T) {
		overrides := cloneFieldOverrides()
		overrides["StatsSnapshot.old_field"] = fieldOverride{optional: true}
		compat := cloneExtraCompatFields()
		compat["RetiredSnapshot"] = []extraField{{jsonName: "old_alias", tsType: "string", optional: true}}

		_, err := renderTypeWithConfig(reflect.TypeOf(api.StatsSnapshot{}), overrides, compat, true)
		if err == nil {
			t.Fatal("expected error when both fieldOverrides and extraCompatFields contain stale entries")
		}
		for _, want := range []string{
			"unused fieldOverrides",
			"StatsSnapshot.old_field",
			"unused extraCompatFields",
			"RetiredSnapshot.old_alias",
		} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("error %q missing expected substring %q", err.Error(), want)
			}
		}
	})
}
