// Command genstatstypes generates TypeScript interfaces for the read-only
// GET /api/stats?schema_version=1.0 contract directly from Go's api.StatsSnapshot.
//
// Usage (from backend/):
//
//	go run ./cmd/genstatstypes -out ../frontend/src/monitor/statsTypes.generated.ts
//	go run ./cmd/genstatstypes -check -out ../frontend/src/monitor/statsTypes.generated.ts
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"strings"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/api"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/telemetry"
)

var validTSIdent = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

type fieldOverride struct {
	tsType   string
	optional bool
}

type extraField struct {
	jsonName string
	tsType   string
	optional bool
}

// tsTypeNames maps API DTO Go struct types whose Go identifier differs from
// their canonical frontend TypeScript interface name so consumers stay stable.
var tsTypeNames = map[reflect.Type]string{
	reflect.TypeOf(api.YTDLPSlotStatsSnapshot{}): "YTDLPStatsSnapshot",
}

// fieldOverrides preserves narrow TypeScript union types and rolling-upgrade
// optionality markers without weakening Go's authoritative field list.
var fieldOverrides = map[string]fieldOverride{
	"CacheChannelCounts.stale_hits":         {optional: true},
	"AdmissionStatsSnapshot.generic_slow":   {optional: true},
	"YTDLPStatsSnapshot.enabled":            {optional: true},
	"YTDLPStatsSnapshot.waiting":            {optional: true},
	"CircuitBreakerPlatformSnapshot.state":  {tsType: "CircuitBreakerState"},
	"StatsSnapshot.ytdlp_generic":           {optional: true},
	"StatsSnapshot.ytdlp_pools":             {optional: true},
	"StatsSnapshot.youtube_helper":          {optional: true},
	"StatsSnapshot.tiktok":                  {optional: true},
	"StatsSnapshot.circuit_breakers":        {optional: true},
	"StatsSnapshot.generic_circuit_breaker": {optional: true},
	"StatsSnapshot.runtime_policy":          {optional: true},
}

// extraCompatFields retains strictly read-only legacy wire aliases that the
// monitor UI still tolerates when talking to pre-upgrade backends.
var extraCompatFields = map[string][]extraField{
	"YTDLPStatsSnapshot": {
		{jsonName: "queued", tsType: "number", optional: true},
	},
}

type tsGenerator struct {
	visited map[reflect.Type]bool
	order   []reflect.Type
}

func (g *tsGenerator) tsName(t reflect.Type) string {
	if mapped, ok := tsTypeNames[t]; ok {
		return mapped
	}
	return t.Name()
}

func (g *tsGenerator) walk(t reflect.Type) error {
	for t.Kind() == reflect.Pointer || t.Kind() == reflect.Slice || t.Kind() == reflect.Array {
		t = t.Elem()
	}
	if t.Kind() == reflect.Map {
		return g.walk(t.Elem())
	}
	if t.Kind() != reflect.Struct {
		return nil
	}
	if g.visited[t] {
		return nil
	}
	g.visited[t] = true
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		jsonName, _, skip := parseJSONTag(f)
		if skip || jsonName == "" {
			continue
		}
		if err := g.walk(f.Type); err != nil {
			return err
		}
	}
	g.order = append(g.order, t)
	return nil
}

func (g *tsGenerator) renderType(t reflect.Type) (string, error) {
	switch t.Kind() {
	case reflect.Pointer:
		return g.renderType(t.Elem())
	case reflect.Bool:
		return "boolean", nil
	case reflect.String:
		return "string", nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Float32, reflect.Float64:
		return "number", nil
	case reflect.Slice, reflect.Array:
		elem, err := g.renderType(t.Elem())
		if err != nil {
			return "", err
		}
		return elem + "[]", nil
	case reflect.Map:
		if t.Key().Kind() != reflect.String {
			return "", fmt.Errorf("unsupported map key kind %s", t.Key().Kind())
		}
		val, err := g.renderType(t.Elem())
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("Record<string, %s>", val), nil
	case reflect.Struct:
		name := g.tsName(t)
		if name == "" {
			return "", fmt.Errorf("anonymous struct is not supported in stats contract")
		}
		return name, nil
	default:
		return "", fmt.Errorf("unsupported Go kind %s (%s)", t.Kind(), t.String())
	}
}

func parseJSONTag(f reflect.StructField) (name string, omitempty bool, skip bool) {
	tag := f.Tag.Get("json")
	if tag == "-" {
		return "", false, true
	}
	if tag == "" {
		return f.Name, false, false
	}
	parts := strings.Split(tag, ",")
	name = parts[0]
	if name == "" {
		name = f.Name
	}
	for _, opt := range parts[1:] {
		if opt == "omitempty" {
			omitempty = true
		}
	}
	return name, omitempty, false
}

func formatPropName(jsonName string) string {
	if validTSIdent.MatchString(jsonName) {
		return jsonName
	}
	return fmt.Sprintf("%q", jsonName)
}

// RenderType generates the complete TypeScript module starting from rootType.
func RenderType(rootType reflect.Type) ([]byte, error) {
	return renderTypeWithConfig(rootType, fieldOverrides, extraCompatFields, false)
}

func renderTypeWithConfig(
	rootType reflect.Type,
	overrides map[string]fieldOverride,
	compat map[string][]extraField,
	strict bool,
) ([]byte, error) {
	gen := &tsGenerator{visited: make(map[reflect.Type]bool)}
	if err := gen.walk(rootType); err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	buf.WriteString("// Code generated by `go run ./cmd/genstatstypes`; DO NOT EDIT.\n")
	buf.WriteString("// Single source of truth: backend/internal/api StatsSnapshot (+ ytengine, shresolver & telemetry).\n\n")
	buf.WriteString("export type CircuitBreakerState = \"closed\" | \"open\" | \"half_open\";\n")
	fmt.Fprintf(&buf, "export const YOUTUBE_HELPER_CHALLENGE_LRU_CAPACITY = %d;\n", telemetry.YouTubeHelperMaxChallengeCacheEntries)

	matchedOverrides := make(map[string]bool, len(overrides))
	matchedCompatEntries := make(map[string]bool)

	for _, st := range gen.order {
		ifaceName := gen.tsName(st)
		buf.WriteString("\nexport interface ")
		buf.WriteString(ifaceName)
		buf.WriteString(" {\n")
		emitted := make(map[string]bool)
		for i := 0; i < st.NumField(); i++ {
			f := st.Field(i)
			if !f.IsExported() {
				continue
			}
			jsonName, omitempty, skip := parseJSONTag(f)
			if skip || jsonName == "" {
				continue
			}
			tsType, err := gen.renderType(f.Type)
			if err != nil {
				return nil, fmt.Errorf("%s.%s: %w", ifaceName, f.Name, err)
			}
			optional := omitempty || f.Type.Kind() == reflect.Pointer
			overrideKey := ifaceName + "." + jsonName
			if ov, ok := overrides[overrideKey]; ok {
				matchedOverrides[overrideKey] = true
				if ov.tsType != "" {
					tsType = ov.tsType
				}
				if ov.optional {
					optional = true
				}
			}
			optMark := ""
			if optional {
				optMark = "?"
			}
			fmt.Fprintf(&buf, "  %s%s: %s;\n", formatPropName(jsonName), optMark, tsType)
			emitted[jsonName] = true
		}
		for idx, extra := range compat[ifaceName] {
			if emitted[extra.jsonName] {
				continue
			}
			optMark := ""
			if extra.optional {
				optMark = "?"
			}
			fmt.Fprintf(&buf, "  %s%s: %s;\n", formatPropName(extra.jsonName), optMark, extra.tsType)
			emitted[extra.jsonName] = true
			matchedCompatEntries[fmt.Sprintf("%s.%s#%d", ifaceName, extra.jsonName, idx)] = true
		}
		buf.WriteString("}\n")
	}

	if strict {
		var unusedOverrides []string
		for key := range overrides {
			if !matchedOverrides[key] {
				unusedOverrides = append(unusedOverrides, key)
			}
		}
		var unusedCompat []string
		for structName, extras := range compat {
			if len(extras) == 0 {
				unusedCompat = append(unusedCompat, structName)
				continue
			}
			for idx, extra := range extras {
				entryKey := fmt.Sprintf("%s.%s#%d", structName, extra.jsonName, idx)
				if !matchedCompatEntries[entryKey] {
					unusedCompat = append(unusedCompat, structName+"."+extra.jsonName)
				}
			}
		}
		if len(unusedOverrides) > 0 || len(unusedCompat) > 0 {
			sortStrings(unusedOverrides)
			sortStrings(unusedCompat)
			var parts []string
			if len(unusedOverrides) > 0 {
				parts = append(parts, fmt.Sprintf("unused fieldOverrides: %s", strings.Join(unusedOverrides, ", ")))
			}
			if len(unusedCompat) > 0 {
				parts = append(parts, fmt.Sprintf("unused extraCompatFields: %s", strings.Join(unusedCompat, ", ")))
			}
			return nil, fmt.Errorf("stale stats type config: %s", strings.Join(parts, "; "))
		}
	}

	return buf.Bytes(), nil
}

func sortStrings(xs []string) {
	for i := 1; i < len(xs); i++ {
		for j := i; j > 0 && xs[j] < xs[j-1]; j-- {
			xs[j], xs[j-1] = xs[j-1], xs[j]
		}
	}
}

// RenderStatsTypes generates the canonical TypeScript contract for api.StatsSnapshot.
func RenderStatsTypes() ([]byte, error) {
	return renderTypeWithConfig(reflect.TypeOf(api.StatsSnapshot{}), fieldOverrides, extraCompatFields, true)
}

func main() {
	outPath := flag.String("out", "../frontend/src/monitor/statsTypes.generated.ts", "Output TypeScript file path")
	checkOnly := flag.Bool("check", false, "Verify that -out matches generated output without writing")
	flag.Parse()

	rendered, err := RenderStatsTypes()
	if err != nil {
		fmt.Fprintf(os.Stderr, "genstatstypes: %v\n", err)
		os.Exit(1)
	}

	if *checkOnly {
		existing, err := os.ReadFile(*outPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "genstatstypes --check: cannot read %s: %v\n", *outPath, err)
			os.Exit(1)
		}
		if !bytes.Equal(existing, rendered) {
			fmt.Fprintf(os.Stderr, "genstatstypes --check: %s is out of date; run:\n  (cd backend && go run ./cmd/genstatstypes -out %s)\n", *outPath, *outPath)
			os.Exit(1)
		}
		fmt.Printf("genstatstypes: %s is up to date (%d bytes)\n", *outPath, len(rendered))
		return
	}

	if err := os.WriteFile(*outPath, rendered, 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "genstatstypes: write %s: %v\n", *outPath, err)
		os.Exit(1)
	}
	fmt.Printf("genstatstypes: wrote %s (%d bytes)\n", *outPath, len(rendered))
}
