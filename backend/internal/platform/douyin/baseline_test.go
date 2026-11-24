//go:build phporacle

package douyin

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/testsupport/publicoracle"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func TestPHPDouyinBaseline(t *testing.T) {
	cases := phpDouyinFixtures(t)
	if len(cases) < 70 {
		t.Fatalf("missing PHP migration fixtures: %d", len(cases))
	}
	oracle, err := publicoracle.New()
	if err != nil {
		t.Fatal(err)
	}
	exported := array{}
	checkedViews := 0
	for _, value := range cases {
		c := unified.Map(value)
		t.Run(unified.Str(c["id"]), func(t *testing.T) {
			input, expected := unified.Map(c["input"]), unified.Map(c["expected"])
			now, _ := unified.Numeric(input["now"])
			executor := &fixtureExecutor{t: t, responses: unified.Slice(input["http_responses"]), requests: array{}}
			prober := &fixtureProber{t: t, results: unified.Slice(input["probe_results"]), requests: array{}}
			parser := New(executor, prober)
			full, err := parser.Parse(context.Background(), unified.Str(input["url"]), int64(now))
			if err != nil {
				t.Fatal(err)
			}
			actual := object{"id": c["id"]}
			for _, debug := range []bool{false, true} {
				view := "normal"
				if debug {
					view = "debug"
				}
				t.Run(view, func(t *testing.T) {
					got := unified.PublicView(full, debug, int64(now))
					actual[view] = got
					want, err := oracle.Expected(publicoracle.DouyinFixture, unified.Str(c["id"]), view, expected[view])
					if err != nil {
						t.Fatal(err)
					}
					requireSameWire(t, got, want)
					checkedViews++
					if err := unified.ValidateEnvelopeAt(got, int64(now)); err != nil {
						t.Fatal(err)
					}
				})
			}
			exported = append(exported, actual)
			t.Run("requests", func(t *testing.T) {
				wanted := array{}
				for _, value := range unified.Slice(expected["http_requests"]) {
					request := unified.Clone(unified.Map(value))
					delete(request, "transport") // The Go executor replaces PHP curl/get_headers.
					wanted = append(wanted, request)
				}
				requireSameWire(t, executor.requests, wanted)
				requireSameWire(t, prober.requests, expected["probe_requests"])
				if executor.position != len(executor.responses) || prober.position != len(prober.results) {
					t.Fatal("fixture response was not consumed")
				}
			})
			if expected["formatter"] != nil {
				t.Run("formatter", func(t *testing.T) {
					responses := array{}
					for _, value := range unified.Slice(input["http_responses"]) {
						request := unified.Map(value)
						if unified.Str(request["method"]) == "HEAD" && AllowedMediaURL(unified.Str(request["url"])) {
							responses = append(responses, request)
						}
					}
					formatter := New(&fixtureExecutor{t: t, responses: responses}, &fixtureProber{t: t, results: unified.Slice(input["probe_results"])})
					got, err := formatter.formatData(context.Background(), unified.Map(input["detail"]), stringValue(child(input, "detail", "aweme_id")))
					if err != nil {
						t.Fatal(err)
					}
					requireSameWire(t, got, expected["formatter"])
				})
			}
		})
	}
	if checkedViews == 2*len(cases) {
		if err := oracle.RequireConsumed(publicoracle.DouyinFixture); err != nil {
			t.Fatal(err)
		}
	}
	if destination := os.Getenv("DOKITOOL_GO_DOUYIN_OUTPUT"); destination != "" && !t.Failed() {
		if len(exported) != len(cases) || checkedViews != 2*len(cases) {
			t.Fatal("Go output export requires all PHP Douyin baseline cases")
		}
		if !filepath.IsAbs(destination) {
			t.Fatal("DOKITOOL_GO_DOUYIN_OUTPUT must be an absolute path")
		}
		manifestBytes, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "php-douyin", "manifest.json"))
		if err != nil {
			t.Fatal(err)
		}
		manifest, err := unified.Decode(manifestBytes)
		if err != nil {
			t.Fatal(err)
		}
		payload := object{"cases": exported, "renewal_groups": unified.CloneValue(manifest["renewal_groups"])}
		encoded, err := unified.Encode(payload)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(destination, append(encoded, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}
