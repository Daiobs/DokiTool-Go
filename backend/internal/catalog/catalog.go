// Package catalog owns registration facts, not parser or media-selection rules.
package catalog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/Brilliant666/DokiTool-Go/backend/config"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type Catalog struct {
	rows []unified.Object
	byID map[string]unified.Object
}

type platformEntry struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	SiteURL        string   `json:"site_url"`
	Icon           string   `json:"icon"`
	Capabilities   []string `json:"capabilities"`
	Domains        []string `json:"domains"`
	ExactDomains   []string `json:"exact_domains,omitempty"`
	DisplayDomains []string `json:"display_domains,omitempty"`
	Optional       bool     `json:"optional,omitempty"`
}

type registryConfig struct {
	core         []platformEntry
	optional     []platformEntry
	optionalByID map[string]platformEntry
}

var (
	identifier           = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)
	hostName             = regexp.MustCompile(`(?i)^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`)
	embeddedRegistryOnce sync.Once
	embeddedRegistryCfg  *registryConfig
	embeddedRegistryErr  error
)

func validateHostList(field, platformID string, hosts []string) error {
	seen := make(map[string]bool, len(hosts))
	for _, h := range hosts {
		if !hostName.MatchString(h) || h != strings.ToLower(h) {
			return fmt.Errorf("platform %s has invalid %s entry %q", platformID, field, h)
		}
		if seen[h] {
			return fmt.Errorf("platform %s has duplicate %s entry %q", platformID, field, h)
		}
		seen[h] = true
	}
	return nil
}

func decodeRegistry(data []byte) (*registryConfig, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var entries []platformEntry
	if err := dec.Decode(&entries); err != nil {
		return nil, fmt.Errorf("decode platforms.json: %w", err)
	}
	var tail any
	if err := dec.Decode(&tail); err != io.EOF {
		return nil, fmt.Errorf("decode platforms.json: trailing JSON data")
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("platform registry must be a nonempty array")
	}

	cfg := &registryConfig{
		optionalByID: make(map[string]platformEntry),
	}
	seenIDs := make(map[string]bool, len(entries))
	for _, entry := range entries {
		if !identifier.MatchString(entry.ID) {
			return nil, fmt.Errorf("invalid platform id %q", entry.ID)
		}
		if seenIDs[entry.ID] {
			return nil, fmt.Errorf("duplicate platform id %q", entry.ID)
		}
		seenIDs[entry.ID] = true
		if entry.Name == "" || entry.SiteURL == "" || entry.Icon == "" {
			return nil, fmt.Errorf("platform %q lacks required metadata", entry.ID)
		}
		if len(entry.Capabilities) == 0 {
			return nil, fmt.Errorf("platform %q lacks capabilities", entry.ID)
		}
		for _, capName := range entry.Capabilities {
			if strings.TrimSpace(capName) == "" {
				return nil, fmt.Errorf("platform %q has empty capability", entry.ID)
			}
		}
		if len(entry.Domains) == 0 && len(entry.ExactDomains) == 0 {
			return nil, fmt.Errorf("platform %q lacks domains and exact_domains", entry.ID)
		}
		if err := validateHostList("domains", entry.ID, entry.Domains); err != nil {
			return nil, err
		}
		if err := validateHostList("exact_domains", entry.ID, entry.ExactDomains); err != nil {
			return nil, err
		}
		if err := validateHostList("display_domains", entry.ID, entry.DisplayDomains); err != nil {
			return nil, err
		}
		if entry.Optional {
			cfg.optional = append(cfg.optional, entry)
			cfg.optionalByID[entry.ID] = entry
		} else {
			cfg.core = append(cfg.core, entry)
		}
	}
	if len(cfg.core) == 0 {
		return nil, fmt.Errorf("platform registry must define at least one core platform")
	}
	return cfg, nil
}

func loadEmbeddedRegistry() (*registryConfig, error) {
	embeddedRegistryOnce.Do(func() {
		embeddedRegistryCfg, embeddedRegistryErr = decodeRegistry(config.Platforms())
	})
	return embeddedRegistryCfg, embeddedRegistryErr
}

func stringSliceToUnifiedArray(items []string) unified.Array {
	out := make(unified.Array, len(items))
	for i, item := range items {
		out[i] = item
	}
	return out
}

func (e platformEntry) toCatalogObject() unified.Object {
	obj := unified.Object{
		"id":           e.ID,
		"name":         e.Name,
		"site_url":     e.SiteURL,
		"icon":         e.Icon,
		"capabilities": stringSliceToUnifiedArray(e.Capabilities),
		"domains":      stringSliceToUnifiedArray(e.Domains),
	}
	if len(e.ExactDomains) > 0 {
		obj["exact_domains"] = stringSliceToUnifiedArray(e.ExactDomains)
	}
	return obj
}

func buildCoreCatalog(reg *registryConfig) (*Catalog, error) {
	c := &Catalog{byID: make(map[string]unified.Object, len(reg.core))}
	for _, entry := range reg.core {
		if err := c.Register(entry.toCatalogObject()); err != nil {
			return nil, err
		}
	}
	return c, nil
}

// Load returns a fresh runtime catalog pre-populated with the non-optional core
// platforms from backend/config/platforms.json. Optional platforms are registered
// explicitly by callers based on runtime flags via ExtraPlatform / XPlatform / etc.
func Load() (*Catalog, error) {
	reg, err := loadEmbeddedRegistry()
	if err != nil {
		return nil, err
	}
	return buildCoreCatalog(reg)
}

// ExtraPlatform returns a deep copy of the static catalog registration entry for an
// optional Go-registered platform (`"optional": true`) defined in backend/config/platforms.json.
func ExtraPlatform(id string) (unified.Object, bool) {
	reg, err := loadEmbeddedRegistry()
	if err != nil {
		return nil, false
	}
	entry, ok := reg.optionalByID[id]
	if !ok {
		return nil, false
	}
	return entry.toCatalogObject(), true
}

// ExtraPlatformIDs returns the canonical ordered IDs of all optional platforms
// (`"optional": true`) defined in backend/config/platforms.json.
func ExtraPlatformIDs() []string {
	reg, err := loadEmbeddedRegistry()
	if err != nil {
		return nil
	}
	ids := make([]string, len(reg.optional))
	for i, entry := range reg.optional {
		ids[i] = entry.ID
	}
	return ids
}

func mustExtraPlatform(id string) unified.Object {
	entry, ok := ExtraPlatform(id)
	if !ok {
		panic(fmt.Sprintf("catalog: missing embedded optional platform %q", id))
	}
	return entry
}

// XPlatform returns the optional registry entry for X / Twitter.
func XPlatform() unified.Object { return mustExtraPlatform("x") }

// YouTubePlatform returns the optional registry entry for YouTube.
func YouTubePlatform() unified.Object { return mustExtraPlatform("youtube") }

// InstagramPlatform returns the optional registry entry for Instagram.
func InstagramPlatform() unified.Object { return mustExtraPlatform("instagram") }

// Decode parses a platforms.json array and returns a catalog containing its
// non-optional core entries.
func Decode(data []byte) (*Catalog, error) {
	reg, err := decodeRegistry(data)
	if err != nil {
		return nil, err
	}
	return buildCoreCatalog(reg)
}

// Register validates and appends a platform entry to the runtime catalog.
func (c *Catalog) Register(row unified.Object) error {
	if c == nil {
		return fmt.Errorf("missing catalog")
	}
	if c.byID == nil {
		c.byID = make(map[string]unified.Object)
	}
	cloned := unified.Clone(row)
	id := unified.Str(cloned["id"])
	if !identifier.MatchString(id) || c.byID[id] != nil {
		return fmt.Errorf("invalid or duplicate platform id %q", id)
	}
	for _, key := range []string{"name", "site_url", "icon"} {
		if unified.Str(cloned[key]) == "" {
			return fmt.Errorf("platform %s lacks %s", id, key)
		}
	}
	if (len(unified.Slice(cloned["domains"])) == 0 && len(unified.Slice(cloned["exact_domains"])) == 0) || len(unified.Slice(cloned["capabilities"])) == 0 {
		return fmt.Errorf("platform %s lacks domains or capabilities", id)
	}
	for _, domain := range unified.Slice(cloned["domains"]) {
		name := unified.Str(domain)
		if !hostName.MatchString(name) || name != strings.ToLower(name) {
			return fmt.Errorf("invalid platform domain")
		}
	}
	for _, domain := range unified.Slice(cloned["exact_domains"]) {
		name := unified.Str(domain)
		if !hostName.MatchString(name) || name != strings.ToLower(name) {
			return fmt.Errorf("invalid platform exact domain")
		}
	}
	c.rows = append(c.rows, cloned)
	c.byID[id] = cloned
	return nil
}

// AddExactDomains appends exact-match hostnames to an already registered platform
// without publishing private domain metadata in Envelope() or allowing subdomains.
func (c *Catalog) AddExactDomains(id string, domains ...string) error {
	if c == nil || c.byID[id] == nil {
		return fmt.Errorf("unknown platform id %q", id)
	}
	row := c.byID[id]
	existing := unified.Slice(row["exact_domains"])
	for _, d := range domains {
		name := strings.ToLower(strings.TrimSpace(d))
		if !hostName.MatchString(name) {
			return fmt.Errorf("invalid platform exact domain %q", d)
		}
		existing = append(existing, name)
	}
	row["exact_domains"] = existing
	return nil
}

func (c *Catalog) Has(id string) bool { return c.byID[id] != nil }

// Envelope returns only existing public fields, in the registry's original order.
func (c *Catalog) Envelope() unified.Object {
	rows := make(unified.Array, 0, len(c.rows))
	for _, row := range c.rows {
		public := unified.Object{}
		for _, key := range []string{"id", "name", "site_url", "icon", "capabilities"} {
			public[key] = unified.CloneValue(row[key])
		}
		rows = append(rows, public)
	}
	return unified.Object{"schema_version": unified.SchemaVersion, "code": "OK", "data": unified.Object{"platforms": rows}}
}

func parseInputHost(raw string) (string, bool) {
	if unified.MediaURL(raw) == "" {
		return "", false
	}
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f || r == '\\' {
			return "", false
		}
	}
	// Accept opaque percent bytes in paths. Parse only the already validated
	// authority for dispatch; retain the complete input for adapters.
	separator := strings.Index(raw, "://")
	if separator < 0 {
		return "", false
	}
	end := len(raw)
	if suffix := strings.IndexAny(raw[separator+3:], "/?#"); suffix >= 0 {
		end = separator + 3 + suffix
	}
	u, err := url.Parse(raw[:end])
	if err != nil || u.User != nil || u.Opaque != "" {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	if !hostName.MatchString(host) || net.ParseIP(host) != nil {
		return "", false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || (scheme == "https" && n != 443) || (scheme == "http" && n != 80) {
			return "", false
		}
	}
	return host, true
}

// ValidInputURL reports whether raw is a syntactically valid HTTP/HTTPS domain URL
// without userinfo or non-default port, independent of platform registration.
func (c *Catalog) ValidInputURL(raw string) bool {
	_, ok := parseInputHost(raw)
	return ok
}

// PlatformForURL matches the host, never a path/query substring or a userinfo field.
func (c *Catalog) PlatformForURL(raw string) string {
	host, ok := parseInputHost(raw)
	if !ok {
		return ""
	}
	for _, row := range c.rows {
		for _, value := range unified.Slice(row["exact_domains"]) {
			if host == unified.Str(value) {
				return unified.Str(row["id"])
			}
		}
		for _, value := range unified.Slice(row["domains"]) {
			domain := unified.Str(value)
			if host == domain || strings.HasSuffix(host, "."+domain) {
				return unified.Str(row["id"])
			}
		}
	}
	return ""
}
