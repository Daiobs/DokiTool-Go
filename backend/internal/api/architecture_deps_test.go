package api

import (
	"fmt"
	goparser "go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const (
	// ADR (ARCH-12): backend/go.mod intentionally keeps the historical module path
	// "github.com/Brilliant666/DokiTool-Go/backend" frozen.
	//
	// Rationale:
	//   1. The entire Go module consists strictly of deployment binaries under cmd/,
	//      private packages under internal/, and embedded static data under config/.
	//      There is no public external `go get` library API or external Go importer.
	//   2. Mechanically rewriting ~300 Go files across active branches yields zero
	//      runtime, security, or wire-contract value while maximizing merge churn.
	//   3. Instead, this static AST test enforces 100% single-prefix consistency
	//      between backend/go.mod and every local cross-package import in backend/.
	canonicalBackendModulePath = "github.com/Brilliant666/DokiTool-Go/backend"
	platformImportPrefix       = canonicalBackendModulePath + "/internal/platform/"
)

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

func parseGoModModulePath(raw string) (string, error) {
	for _, line := range strings.Split(raw, "\n") {
		if idx := strings.Index(line, "//"); idx >= 0 {
			line = line[:idx]
		}
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "module" {
			mod := fields[1]
			if strings.HasPrefix(mod, `"`) || strings.HasPrefix(mod, "`") {
				unquoted, err := strconv.Unquote(mod)
				if err != nil {
					return "", fmt.Errorf("unquote module path %q: %w", mod, err)
				}
				return unquoted, nil
			}
			return mod, nil
		}
	}
	return "", fmt.Errorf("missing module directive in go.mod")
}

func looksLikeLocalRepoImport(importPath string) bool {
	lower := strings.ToLower(importPath)
	if strings.Contains(lower, "dokitool-go") {
		return true
	}
	return strings.Contains(lower, "/backend/internal/") ||
		strings.HasSuffix(lower, "/backend/internal") ||
		strings.Contains(lower, "/backend/cmd/") ||
		strings.HasSuffix(lower, "/backend/cmd") ||
		strings.Contains(lower, "/backend/config/") ||
		strings.HasSuffix(lower, "/backend/config")
}

func checkBackendModuleImports(modPath string, files map[string]string, existingDirs map[string]bool) ([]string, int, error) {
	if modPath != canonicalBackendModulePath {
		return []string{fmt.Sprintf("go.mod module = %q, want frozen ADR module path %q", modPath, canonicalBackendModulePath)}, 0, nil
	}
	fset := token.NewFileSet()
	prefix := modPath + "/"
	var violations []string
	localImportCount := 0
	for name, src := range files {
		if !strings.HasSuffix(name, ".go") {
			continue
		}
		fileAST, err := goparser.ParseFile(fset, name, src, goparser.ImportsOnly)
		if err != nil {
			return nil, 0, fmt.Errorf("parse %s: %w", name, err)
		}
		for _, spec := range fileAST.Imports {
			importPath, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				return nil, 0, fmt.Errorf("unquote import in %s: %w", name, err)
			}
			if importPath == modPath || strings.HasPrefix(importPath, prefix) {
				localImportCount++
				rel := strings.TrimPrefix(importPath, prefix)
				if importPath == modPath || (existingDirs != nil && !existingDirs[rel]) {
					violations = append(violations, fmt.Sprintf("%s: local import %q does not map to a backend package directory", name, importPath))
				}
				continue
			}
			if looksLikeLocalRepoImport(importPath) {
				violations = append(violations, fmt.Sprintf("%s: drifted local module prefix %q (must match go.mod %q)", name, importPath, modPath))
			}
		}
	}
	return violations, localImportCount, nil
}

// TestBackendGoModModulePathConsistencyADR enforces ARCH-12:
// backend/go.mod stays frozen at github.com/Brilliant666/DokiTool-Go/backend,
// all backend Go packages remain internal/cmd/config-scoped (no public library API),
// and 100% of local cross-package imports across every .go file under backend/
// match the exact go.mod module path with zero mixed/drifted prefixes.
func TestBackendGoModModulePathConsistencyADR(t *testing.T) {
	backendRoot := filepath.Join("..", "..")
	goModRaw, err := os.ReadFile(filepath.Join(backendRoot, "go.mod"))
	if err != nil {
		t.Fatalf("read backend/go.mod: %v", err)
	}
	modPath, err := parseGoModModulePath(string(goModRaw))
	if err != nil {
		t.Fatalf("parse backend/go.mod: %v", err)
	}
	if modPath != canonicalBackendModulePath {
		t.Fatalf("backend/go.mod module = %q, want %q (ARCH-12 frozen internal-only module path)", modPath, canonicalBackendModulePath)
	}

	files := make(map[string]string)
	existingDirs := make(map[string]bool)
	err = filepath.WalkDir(backendRoot, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			name := d.Name()
			if name == "vendor" || (strings.HasPrefix(name, ".") && path != backendRoot) {
				return filepath.SkipDir
			}
			relDir, relErr := filepath.Rel(backendRoot, path)
			if relErr != nil {
				return relErr
			}
			if relDir != "." {
				existingDirs[filepath.ToSlash(relDir)] = true
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") {
			return nil
		}
		relFile, relErr := filepath.Rel(backendRoot, path)
		if relErr != nil {
			return relErr
		}
		slashRel := filepath.ToSlash(relFile)
		topDir := strings.SplitN(slashRel, "/", 2)[0]
		if topDir != "cmd" && topDir != "internal" && topDir != "config" {
			t.Errorf("unexpected top-level Go package %q outside cmd/, internal/, config/ (breaks ARCH-12 internal-only ADR)", slashRel)
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		files[slashRel] = string(raw)
		return nil
	})
	if err != nil {
		t.Fatalf("walk backend/: %v", err)
	}
	if len(files) < 100 {
		t.Fatalf("expected >= 100 Go files under backend/, scanned only %d", len(files))
	}

	violations, localImports, err := checkBackendModuleImports(modPath, files, existingDirs)
	if err != nil {
		t.Fatalf("checkBackendModuleImports failed: %v", err)
	}
	if localImports == 0 {
		t.Fatal("expected local cross-package imports under backend/, found 0")
	}
	if len(violations) > 0 {
		t.Fatalf("ARCH-12 module path consistency violations:\n  - %s", strings.Join(violations, "\n  - "))
	}
}

func TestBackendGoModModulePathGuardRejectsDrift(t *testing.T) {
	dirs := map[string]bool{
		"internal/unified": true,
		"internal/api":     true,
		"config":           true,
	}
	cases := []struct {
		name     string
		modPath  string
		src      string
		wantFail bool
	}{
		{
			name:     "valid_local_and_third_party_imports",
			modPath:  canonicalBackendModulePath,
			src:      "package sample\nimport (\n\t\"fmt\"\n\t_ \"github.com/bogdanfinn/fhttp\"\n\t_ \"github.com/Brilliant666/DokiTool-Go/backend/internal/unified\"\n\t_ \"github.com/Brilliant666/DokiTool-Go/backend/config\"\n)\n",
			wantFail: false,
		},
		{
			name:     "rejects_drifted_org_prefix",
			modPath:  canonicalBackendModulePath,
			src:      "package sample\nimport _ \"github.com/Daiobs/DokiTool-Go/backend/internal/unified\"\n",
			wantFail: true,
		},
		{
			name:     "rejects_drifted_case_prefix",
			modPath:  canonicalBackendModulePath,
			src:      "package sample\nimport _ \"github.com/brilliant666/dokitool-go/backend/internal/api\"\n",
			wantFail: true,
		},
		{
			name:     "rejects_nonexistent_local_package",
			modPath:  canonicalBackendModulePath,
			src:      "package sample\nimport _ \"github.com/Brilliant666/DokiTool-Go/backend/internal/doesnotexist\"\n",
			wantFail: true,
		},
		{
			name:     "rejects_modified_go_mod_declaration",
			modPath:  "github.com/Daiobs/DokiTool-Go/backend",
			src:      "package sample\nimport _ \"github.com/Daiobs/DokiTool-Go/backend/internal/unified\"\n",
			wantFail: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			violations, _, err := checkBackendModuleImports(tc.modPath, map[string]string{"internal/sample/sample.go": tc.src}, dirs)
			if err != nil {
				t.Fatalf("unexpected parse error: %v", err)
			}
			gotFail := len(violations) > 0
			if gotFail != tc.wantFail {
				t.Fatalf("violations=%v (fail=%v), want fail=%v", violations, gotFail, tc.wantFail)
			}
		})
	}
}
