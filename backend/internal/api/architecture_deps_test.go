package api

import (
	"fmt"
	goparser "go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const platformImportPrefix = "github.com/Brilliant666/DokiTool-Go/backend/internal/platform/"

var zeroPlatformImportFiles = map[string]bool{
	"platform_traits.go": true,
	"stats_types.go":     true,
	"stats_dto.go":       true,
}

func checkAPIPackageImportBoundaries(files map[string]string) ([]string, error) {
	fset := token.NewFileSet()
	var violations []string
	for name, src := range files {
		base := filepath.Base(name)
		if !strings.HasSuffix(base, ".go") || strings.HasSuffix(base, "_test.go") {
			continue
		}
		fileAST, err := goparser.ParseFile(fset, name, src, goparser.ImportsOnly)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", name, err)
		}
		for _, spec := range fileAST.Imports {
			importPath, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				return nil, fmt.Errorf("unquote import in %s: %w", name, err)
			}
			if !strings.HasPrefix(importPath, platformImportPrefix) {
				continue
			}
			pkg := strings.TrimPrefix(importPath, platformImportPrefix)
			if zeroPlatformImportFiles[base] {
				violations = append(violations, fmt.Sprintf("%s: forbidden platform import %q (must stay 0)", base, importPath))
				continue
			}
			if base == "handler.go" && pkg == "ytgeneric" {
				continue
			}
			violations = append(violations, fmt.Sprintf("%s: forbidden site-adapter import %q", base, importPath))
		}
	}
	return violations, nil
}

func TestAPIArchitectureImportBoundaries(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read internal/api dir: %v", err)
	}
	files := make(map[string]string)
	for _, ent := range entries {
		if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".go") || strings.HasSuffix(ent.Name(), "_test.go") {
			continue
		}
		raw, err := os.ReadFile(ent.Name())
		if err != nil {
			t.Fatalf("read %s: %v", ent.Name(), err)
		}
		files[ent.Name()] = string(raw)
	}
	for _, required := range []string{"platform_traits.go", "stats_types.go", "stats_dto.go", "handler.go"} {
		if _, ok := files[required]; !ok {
			t.Fatalf("expected non-test API file %s to be scanned", required)
		}
	}

	violations, err := checkAPIPackageImportBoundaries(files)
	if err != nil {
		t.Fatalf("checkAPIPackageImportBoundaries failed: %v", err)
	}
	if len(violations) > 0 {
		t.Fatalf("internal/api import boundary violations:\n  - %s", strings.Join(violations, "\n  - "))
	}
}

func TestAPIArchitectureImportBoundariesRejectsPlatformImports(t *testing.T) {
	cases := []struct {
		name     string
		file     string
		src      string
		wantFail bool
	}{
		{
			name:     "platform_traits_imports_instagram",
			file:     "platform_traits.go",
			src:      "package api\nimport _ \"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/instagram\"\n",
			wantFail: true,
		},
		{
			name:     "stats_types_imports_youtube",
			file:     "stats_types.go",
			src:      "package api\nimport _ \"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/youtube\"\n",
			wantFail: true,
		},
		{
			name:     "stats_dto_imports_youtube",
			file:     "stats_dto.go",
			src:      "package api\nimport _ \"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/youtube\"\n",
			wantFail: true,
		},
		{
			name:     "cache_imports_bilibili",
			file:     "cache.go",
			src:      "package api\nimport _ \"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/bilibili\"\n",
			wantFail: true,
		},
		{
			name:     "handler_imports_ytgeneric_allowed",
			file:     "handler.go",
			src:      "package api\nimport _ \"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/ytgeneric\"\n",
			wantFail: false,
		},
		{
			name:     "commented_platform_import_ignored",
			file:     "platform_traits.go",
			src:      "package api\n// \"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/instagram\"\n",
			wantFail: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			violations, err := checkAPIPackageImportBoundaries(map[string]string{tc.file: tc.src})
			if err != nil {
				t.Fatalf("unexpected parse error: %v", err)
			}
			gotFail := len(violations) > 0
			if gotFail != tc.wantFail {
				t.Fatalf("got violations=%v (fail=%v), want fail=%v", violations, gotFail, tc.wantFail)
			}
		})
	}
}
