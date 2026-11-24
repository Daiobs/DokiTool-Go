package main

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
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
