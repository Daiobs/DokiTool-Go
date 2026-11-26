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
	"sort"
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

type extraConfig struct {
	ExactDomainAdditions map[string][]string `json:"exact_domain_additions"`
	ExtraPlatforms       []extraPlatformSpec `json:"extra_platforms"`
	byID                 map[string]extraPlatformSpec
}

type extraPlatformSpec struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	SiteURL        string   `json:"site_url"`
	Icon           string   `json:"icon"`
	Capabilities   []string `json:"capabilities"`
	Domains        []string `json:"domains"`
	ExactDomains   []string `json:"exact_domains"`
	DisplayDomains []string `json:"display_domains,omitempty"`
}

var (
	identifier        = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)
	hostName          = regexp.MustCompile(`(?i)^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`)
	embeddedExtraOnce sync.Once
	embeddedExtraCfg  *extraConfig
	embeddedExtraErr  error
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

func decodeExtraConfig(data []byte) (*extraConfig, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var cfg extraConfig
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("decode platforms_extra.json: %w", err)
	}
	var tail any
	if err := dec.Decode(&tail); err != io.EOF {
		return nil, fmt.Errorf("decode platforms_extra.json: trailing JSON data")
	}
	for id, domains := range cfg.ExactDomainAdditions {
		if !identifier.MatchString(id) {
			return nil, fmt.Errorf("invalid exact_domain_additions platform id %q", id)
		}
		if len(domains) == 0 {
			return nil, fmt.Errorf("exact_domain_additions for %q must be nonempty", id)
		}
		if err := validateHostList("exact_domain_additions", id, domains); err != nil {
			return nil, err
		}
	}
	if len(cfg.ExtraPlatforms) == 0 {
		return nil, fmt.Errorf("extra_platforms must be a nonempty array")
	}
	cfg.byID = make(map[string]extraPlatformSpec, len(cfg.ExtraPlatforms))
	for _, spec := range cfg.ExtraPlatforms {
		if !identifier.MatchString(spec.ID) {
			return nil, fmt.Errorf("invalid extra platform id %q", spec.ID)
		}
		if _, dup := cfg.byID[spec.ID]; dup {
			return nil, fmt.Errorf("duplicate extra platform id %q", spec.ID)
		}
		if spec.Name == "" || spec.SiteURL == "" || spec.Icon == "" {
			return nil, fmt.Errorf("extra platform %q lacks required metadata", spec.ID)
		}
		if len(spec.Capabilities) == 0 {
			return nil, fmt.Errorf("extra platform %q lacks capabilities", spec.ID)
		}
		for _, capName := range spec.Capabilities {
			if strings.TrimSpace(capName) == "" {
				return nil, fmt.Errorf("extra platform %q has empty capability", spec.ID)
			}
		}
		if len(spec.Domains) == 0 && len(spec.ExactDomains) == 0 {
			return nil, fmt.Errorf("extra platform %q lacks domains and exact_domains", spec.ID)
		}
		if err := validateHostList("domains", spec.ID, spec.Domains); err != nil {
			return nil, err
		}
		if err := validateHostList("exact_domains", spec.ID, spec.ExactDomains); err != nil {
			return nil, err
		}
		if err := validateHostList("display_domains", spec.ID, spec.DisplayDomains); err != nil {
			return nil, err
		}
		cfg.byID[spec.ID] = spec
	}
	return &cfg, nil
}

func loadEmbeddedExtra() (*extraConfig, error) {
	embeddedExtraOnce.Do(func() {
		embeddedExtraCfg, embeddedExtraErr = decodeExtraConfig(config.PlatformsExtra())
	})
	return embeddedExtraCfg, embeddedExtraErr
}

func stringSliceToUnifiedArray(items []string) unified.Array {
	out := make(unified.Array, len(items))
	for i, item := range items {
		out[i] = item
	}
	return out
}

func (s extraPlatformSpec) toCatalogObject() unified.Object {
	obj := unified.Object{
		"id":           s.ID,
		"name":         s.Name,
		"site_url":     s.SiteURL,
		"icon":         s.Icon,
		"capabilities": stringSliceToUnifiedArray(s.Capabilities),
		"domains":      stringSliceToUnifiedArray(s.Domains),
	}
	if len(s.ExactDomains) > 0 {
		obj["exact_domains"] = stringSliceToUnifiedArray(s.ExactDomains)
	}
	return obj
}

func Load() (*Catalog, error) {
	c, err := Decode(config.Platforms())
	if err != nil {
		return nil, err
	}
	extra, err := loadEmbeddedExtra()
	if err != nil {
		return nil, err
	}
	additionIDs := make([]string, 0, len(extra.ExactDomainAdditions))
	for id := range extra.ExactDomainAdditions {
		additionIDs = append(additionIDs, id)
	}
	sort.Strings(additionIDs)
	for _, id := range additionIDs {
		if err := c.AddExactDomains(id, extra.ExactDomainAdditions[id]...); err != nil {
			return nil, err
		}
	}
	for _, spec := range extra.ExtraPlatforms {
		if c.Has(spec.ID) {
			return nil, fmt.Errorf("extra platform %q duplicates base registry entry", spec.ID)
		}
	}
	return c, nil
}

// ExtraPlatform returns a deep copy of the static catalog registration entry for an
// optional Go-registered platform defined in backend/config/platforms_extra.json.
func ExtraPlatform(id string) (unified.Object, bool) {
	extra, err := loadEmbeddedExtra()
	if err != nil {
		return nil, false
	}
	spec, ok := extra.byID[id]
	if !ok {
		return nil, false
	}
	return spec.toCatalogObject(), true
}

// ExtraPlatformIDs returns the canonical ordered IDs of all optional platforms
// defined in backend/config/platforms_extra.json.
func ExtraPlatformIDs() []string {
	extra, err := loadEmbeddedExtra()
	if err != nil {
		return nil
	}
	ids := make([]string, len(extra.ExtraPlatforms))
	for i, spec := range extra.ExtraPlatforms {
		ids[i] = spec.ID
	}
	return ids
}

func mustExtraPlatform(id string) unified.Object {
	entry, ok := ExtraPlatform(id)
	if !ok {
		panic(fmt.Sprintf("catalog: missing embedded extra platform %q", id))
	}
	return entry
}

// XPlatform returns the optional registry entry for X / Twitter.
func XPlatform() unified.Object { return mustExtraPlatform("x") }

// YouTubePlatform returns the optional registry entry for YouTube.
func YouTubePlatform() unified.Object { return mustExtraPlatform("youtube") }

// InstagramPlatform returns the optional registry entry for Instagram.
func InstagramPlatform() unified.Object { return mustExtraPlatform("instagram") }

func Decode(data []byte) (*Catalog, error) {
	value, err := unified.DecodeValue(data)
	if err != nil {
		return nil, err
	}
	rows, ok := value.([]any)
	if !ok || len(rows) == 0 {
		return nil, fmt.Errorf("platform registry must be a nonempty array")
	}
	c := &Catalog{byID: make(map[string]unified.Object)}
	for _, value := range rows {
		if err := c.Register(unified.Map(value)); err != nil {
			return nil, err
		}
	}
	return c, nil
}

// Register validates and appends an optional platform entry to the runtime catalog.
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
	// PHP accepts opaque percent bytes in paths. Parse only the already
	// validated authority for dispatch; retain the complete input for adapters.
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
