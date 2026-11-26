package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"
)

const (
	// EnvRuntimeConfigFile points to an optional JSON manifest declaring dynamic runtime
	// pool, bulkhead, circuit-breaker, and cache policies that can be hot-reloaded via SIGHUP.
	EnvRuntimeConfigFile = "DOKITOOL_RUNTIME_CONFIG_FILE"

	// MaxRuntimeConfigFileBytes caps runtime config reads from disk at 64 KiB.
	MaxRuntimeConfigFileBytes = 64 << 10

	// RuntimeConfigSchemaVersion is the only supported runtime config schema version.
	RuntimeConfigSchemaVersion = "1.0"

	minRuntimeYouTubeSlots       = 1
	maxRuntimeYouTubeSlots       = 16
	minRuntimeSocialSlots        = 1
	maxRuntimeSocialSlots        = 16
	minRuntimeGenericSlots       = 1
	maxRuntimeGenericSlots       = 12
	maxRuntimeTotalYTDLPSlots    = 32
	minRuntimeYTDLPQueueSize     = 0
	maxRuntimeYTDLPQueueSize     = 1024
	maxRuntimeYTDLPQueueWait     = 30 * time.Second
	minRuntimeYouTubeEJSConc     = 1
	maxRuntimeYouTubeEJSConc     = 16
	minRuntimeFastPerPlatform    = 2
	maxRuntimeFastPerPlatform    = 256
	minRuntimeCBConsecFailures   = 1
	maxRuntimeCBConsecFailures   = 100
	minRuntimeCBWindowSize       = 1
	maxRuntimeCBWindowSize       = 200
	minRuntimeCBOpenDuration     = 5 * time.Second
	maxRuntimeCBOpenDuration     = 600 * time.Second
	minRuntimeCBHalfOpenProbes   = 1
	maxRuntimeCBHalfOpenProbes   = 16
	maxRuntimeYouTubeParseTTL    = 600 * time.Second
	maxRuntimeStaleIfErrorTTL    = 3600 * time.Second
	maxRuntimeUpstreamBlockedTTL = 60 * time.Second
)

// RuntimeYTDLPConfig controls dynamic compartment concurrency and wait queues
// for the three yt-dlp slow pools plus the decoupled YouTube EJS helper pool.
type RuntimeYTDLPConfig struct {
	YouTubeSlots          int
	YouTubeQueueSize      int
	YouTubeQueueWait      time.Duration
	SocialSlots           int
	SocialQueueSize       int
	SocialQueueWait       time.Duration
	GenericSlots          int
	GenericQueueSize      int
	GenericQueueWait      time.Duration
	YouTubeEJSConcurrency int
	YouTubeEJSQueueSize   int
	YouTubeEJSQueueWait   time.Duration
}

// RuntimeFastPoolConfig controls the per-platform bulkhead inside the fast parse pool.
type RuntimeFastPoolConfig struct {
	PerPlatformMaxConcurrency int
}

// CircuitBreakerConfig controls per-platform failure-isolation circuit breaking
// and manual ops platform disabling.
type CircuitBreakerConfig struct {
	Enabled              bool
	ConsecutiveFailures  int
	WindowSize           int
	FailureRateThreshold float64
	OpenDuration         time.Duration
	HalfOpenMaxProbes    int
	DisabledPlatforms    []string
}

// RuntimeCachePolicy controls dynamic YouTube short parse caching, stale-if-error
// fallback windows, and UPSTREAM_BLOCKED short negative caching.
type RuntimeCachePolicy struct {
	YouTubeParseTTL       time.Duration
	StaleIfErrorTTL       time.Duration
	UpstreamBlockedNegTTL time.Duration
}

// RuntimeConfig holds the validated runtime hot-reloadable configuration policy.
type RuntimeConfig struct {
	SchemaVersion  string
	YTDLP          RuntimeYTDLPConfig
	FastPool       RuntimeFastPoolConfig
	CircuitBreaker CircuitBreakerConfig
	Cache          RuntimeCachePolicy
}

// DefaultRuntimeConfig returns the production-hardened runtime policy defaults.
func DefaultRuntimeConfig() RuntimeConfig {
	return RuntimeConfig{
		SchemaVersion: RuntimeConfigSchemaVersion,
		YTDLP: RuntimeYTDLPConfig{
			YouTubeSlots:          DefaultYouTubeSlowConcurrency,
			YouTubeQueueSize:      DefaultSlowParseQueueSize,
			YouTubeQueueWait:      DefaultSlowParseQueueWait,
			SocialSlots:           DefaultSocialSlowConcurrency,
			SocialQueueSize:       DefaultSlowParseQueueSize,
			SocialQueueWait:       DefaultSlowParseQueueWait,
			GenericSlots:          DefaultGenericSlowConcurrency,
			GenericQueueSize:      DefaultGenericSlowParseQueueSize,
			GenericQueueWait:      DefaultGenericSlowParseQueueWait,
			YouTubeEJSConcurrency: DefaultYouTubeEJSConcurrency,
			YouTubeEJSQueueSize:   DefaultYouTubeEJSQueueSize,
			YouTubeEJSQueueWait:   DefaultYouTubeEJSQueueWait,
		},
		FastPool: RuntimeFastPoolConfig{
			PerPlatformMaxConcurrency: DefaultFastPerPlatformMaxConcurrency,
		},
		CircuitBreaker: CircuitBreakerConfig{
			Enabled:              true,
			ConsecutiveFailures:  5,
			WindowSize:           10,
			FailureRateThreshold: 0.6,
			OpenDuration:         30 * time.Second,
			HalfOpenMaxProbes:    2,
			DisabledPlatforms:    make([]string, 0),
		},
		Cache: RuntimeCachePolicy{
			YouTubeParseTTL:       120 * time.Second,
			StaleIfErrorTTL:       600 * time.Second,
			UpstreamBlockedNegTTL: 5 * time.Second,
		},
	}
}

// Validate checks every hard bound on RuntimeConfig without leaking secrets or paths.
func (c RuntimeConfig) Validate() error {
	_, err := normalizeAndValidateRuntimeConfig(c)
	return err
}

func normalizeAndValidateRuntimeConfig(c RuntimeConfig) (RuntimeConfig, error) {
	if c.SchemaVersion != RuntimeConfigSchemaVersion {
		return RuntimeConfig{}, fmt.Errorf("DOKITOOL_RUNTIME_CONFIG_FILE schema_version must be %q", RuntimeConfigSchemaVersion)
	}
	y := c.YTDLP
	if y.YouTubeSlots < minRuntimeYouTubeSlots || y.YouTubeSlots > maxRuntimeYouTubeSlots {
		return RuntimeConfig{}, fmt.Errorf("ytdlp.youtube_slots must be between %d and %d", minRuntimeYouTubeSlots, maxRuntimeYouTubeSlots)
	}
	if y.SocialSlots < minRuntimeSocialSlots || y.SocialSlots > maxRuntimeSocialSlots {
		return RuntimeConfig{}, fmt.Errorf("ytdlp.social_slots must be between %d and %d", minRuntimeSocialSlots, maxRuntimeSocialSlots)
	}
	if y.GenericSlots < minRuntimeGenericSlots || y.GenericSlots > maxRuntimeGenericSlots {
		return RuntimeConfig{}, fmt.Errorf("ytdlp.generic_slots must be between %d and %d", minRuntimeGenericSlots, maxRuntimeGenericSlots)
	}
	if y.YouTubeSlots+y.SocialSlots+y.GenericSlots > maxRuntimeTotalYTDLPSlots {
		return RuntimeConfig{}, fmt.Errorf("ytdlp youtube_slots + social_slots + generic_slots must not exceed %d", maxRuntimeTotalYTDLPSlots)
	}
	for _, q := range []struct {
		name string
		val  int
	}{
		{"ytdlp.youtube_queue_size", y.YouTubeQueueSize},
		{"ytdlp.social_queue_size", y.SocialQueueSize},
		{"ytdlp.generic_queue_size", y.GenericQueueSize},
		{"ytdlp.youtube_ejs_queue_size", y.YouTubeEJSQueueSize},
	} {
		if q.val < minRuntimeYTDLPQueueSize || q.val > maxRuntimeYTDLPQueueSize {
			return RuntimeConfig{}, fmt.Errorf("%s must be between %d and %d", q.name, minRuntimeYTDLPQueueSize, maxRuntimeYTDLPQueueSize)
		}
	}
	for _, w := range []struct {
		name string
		val  time.Duration
	}{
		{"ytdlp.youtube_queue_wait", y.YouTubeQueueWait},
		{"ytdlp.social_queue_wait", y.SocialQueueWait},
		{"ytdlp.generic_queue_wait", y.GenericQueueWait},
		{"ytdlp.youtube_ejs_queue_wait", y.YouTubeEJSQueueWait},
	} {
		if w.val < 0 || w.val > maxRuntimeYTDLPQueueWait {
			return RuntimeConfig{}, fmt.Errorf("%s must be between 0s and %s", w.name, maxRuntimeYTDLPQueueWait)
		}
	}
	if y.YouTubeEJSConcurrency < minRuntimeYouTubeEJSConc || y.YouTubeEJSConcurrency > maxRuntimeYouTubeEJSConc {
		return RuntimeConfig{}, fmt.Errorf("ytdlp.youtube_ejs_concurrency must be between %d and %d", minRuntimeYouTubeEJSConc, maxRuntimeYouTubeEJSConc)
	}

	if c.FastPool.PerPlatformMaxConcurrency < minRuntimeFastPerPlatform || c.FastPool.PerPlatformMaxConcurrency > maxRuntimeFastPerPlatform {
		return RuntimeConfig{}, fmt.Errorf("fast_pool.per_platform_max_concurrency must be between %d and %d", minRuntimeFastPerPlatform, maxRuntimeFastPerPlatform)
	}

	cb := c.CircuitBreaker
	if cb.ConsecutiveFailures < minRuntimeCBConsecFailures || cb.ConsecutiveFailures > maxRuntimeCBConsecFailures {
		return RuntimeConfig{}, fmt.Errorf("circuit_breaker.consecutive_failures must be between %d and %d", minRuntimeCBConsecFailures, maxRuntimeCBConsecFailures)
	}
	if cb.WindowSize < minRuntimeCBWindowSize || cb.WindowSize > maxRuntimeCBWindowSize {
		return RuntimeConfig{}, fmt.Errorf("circuit_breaker.window_size must be between %d and %d", minRuntimeCBWindowSize, maxRuntimeCBWindowSize)
	}
	if math.IsNaN(cb.FailureRateThreshold) || math.IsInf(cb.FailureRateThreshold, 0) || cb.FailureRateThreshold <= 0.0 || cb.FailureRateThreshold > 1.0 {
		return RuntimeConfig{}, errors.New("circuit_breaker.failure_rate_threshold must satisfy 0.0 < value <= 1.0")
	}
	if cb.OpenDuration < minRuntimeCBOpenDuration || cb.OpenDuration > maxRuntimeCBOpenDuration {
		return RuntimeConfig{}, fmt.Errorf("circuit_breaker.open_duration must be between %s and %s", minRuntimeCBOpenDuration, maxRuntimeCBOpenDuration)
	}
	if cb.HalfOpenMaxProbes < minRuntimeCBHalfOpenProbes || cb.HalfOpenMaxProbes > maxRuntimeCBHalfOpenProbes {
		return RuntimeConfig{}, fmt.Errorf("circuit_breaker.half_open_max_probes must be between %d and %d", minRuntimeCBHalfOpenProbes, maxRuntimeCBHalfOpenProbes)
	}
	dedupDisabled := make([]string, 0, len(cb.DisabledPlatforms))
	seenDisabled := make(map[string]struct{}, len(cb.DisabledPlatforms))
	for _, p := range cb.DisabledPlatforms {
		if _, ok := allowedKeyPlatforms[p]; !ok {
			return RuntimeConfig{}, errors.New("circuit_breaker.disabled_platforms contains an unsupported platform id")
		}
		if _, dup := seenDisabled[p]; dup {
			continue
		}
		seenDisabled[p] = struct{}{}
		dedupDisabled = append(dedupDisabled, p)
	}
	c.CircuitBreaker.DisabledPlatforms = dedupDisabled

	cache := c.Cache
	if cache.YouTubeParseTTL < 0 || cache.YouTubeParseTTL > maxRuntimeYouTubeParseTTL {
		return RuntimeConfig{}, fmt.Errorf("cache.youtube_parse_ttl must be between 0s and %s", maxRuntimeYouTubeParseTTL)
	}
	if cache.StaleIfErrorTTL < 0 || cache.StaleIfErrorTTL > maxRuntimeStaleIfErrorTTL {
		return RuntimeConfig{}, fmt.Errorf("cache.stale_if_error_ttl must be between 0s and %s", maxRuntimeStaleIfErrorTTL)
	}
	if cache.UpstreamBlockedNegTTL < 0 || cache.UpstreamBlockedNegTTL > maxRuntimeUpstreamBlockedTTL {
		return RuntimeConfig{}, fmt.Errorf("cache.upstream_blocked_neg_ttl must be between 0s and %s", maxRuntimeUpstreamBlockedTTL)
	}

	return c, nil
}

type runtimeOptField[T any] struct {
	set bool
	val T
}

func (o *runtimeOptField[T]) UnmarshalJSON(b []byte) error {
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		return errors.New("field must not be null")
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	o.val = v
	o.set = true
	return nil
}

func decodeStrictJSONObject(b []byte, dst any) error {
	trimmed := bytes.TrimSpace(b)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return errors.New("must be a JSON object")
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return errors.New("unexpected trailing tokens")
	}
	return nil
}

type rawRuntimeYTDLPConfig struct {
	YouTubeSlots          runtimeOptField[int]    `json:"youtube_slots"`
	YouTubeQueueSize      runtimeOptField[int]    `json:"youtube_queue_size"`
	YouTubeQueueWait      runtimeOptField[string] `json:"youtube_queue_wait"`
	SocialSlots           runtimeOptField[int]    `json:"social_slots"`
	SocialQueueSize       runtimeOptField[int]    `json:"social_queue_size"`
	SocialQueueWait       runtimeOptField[string] `json:"social_queue_wait"`
	GenericSlots          runtimeOptField[int]    `json:"generic_slots"`
	GenericQueueSize      runtimeOptField[int]    `json:"generic_queue_size"`
	GenericQueueWait      runtimeOptField[string] `json:"generic_queue_wait"`
	YouTubeEJSConcurrency runtimeOptField[int]    `json:"youtube_ejs_concurrency"`
	YouTubeEJSQueueSize   runtimeOptField[int]    `json:"youtube_ejs_queue_size"`
	YouTubeEJSQueueWait   runtimeOptField[string] `json:"youtube_ejs_queue_wait"`
}

func (r *rawRuntimeYTDLPConfig) UnmarshalJSON(b []byte) error {
	type alias rawRuntimeYTDLPConfig
	var tmp alias
	if err := decodeStrictJSONObject(b, &tmp); err != nil {
		return err
	}
	*r = rawRuntimeYTDLPConfig(tmp)
	return nil
}

type rawRuntimeFastPoolConfig struct {
	PerPlatformMaxConcurrency runtimeOptField[int] `json:"per_platform_max_concurrency"`
}

func (r *rawRuntimeFastPoolConfig) UnmarshalJSON(b []byte) error {
	type alias rawRuntimeFastPoolConfig
	var tmp alias
	if err := decodeStrictJSONObject(b, &tmp); err != nil {
		return err
	}
	*r = rawRuntimeFastPoolConfig(tmp)
	return nil
}

type rawRuntimeCircuitBreakerConfig struct {
	Enabled              runtimeOptField[bool]     `json:"enabled"`
	ConsecutiveFailures  runtimeOptField[int]      `json:"consecutive_failures"`
	WindowSize           runtimeOptField[int]      `json:"window_size"`
	FailureRateThreshold runtimeOptField[float64]  `json:"failure_rate_threshold"`
	OpenDuration         runtimeOptField[string]   `json:"open_duration"`
	HalfOpenMaxProbes    runtimeOptField[int]      `json:"half_open_max_probes"`
	DisabledPlatforms    runtimeOptField[[]string] `json:"disabled_platforms"`
}

func (r *rawRuntimeCircuitBreakerConfig) UnmarshalJSON(b []byte) error {
	type alias rawRuntimeCircuitBreakerConfig
	var tmp alias
	if err := decodeStrictJSONObject(b, &tmp); err != nil {
		return err
	}
	*r = rawRuntimeCircuitBreakerConfig(tmp)
	return nil
}

type rawRuntimeCachePolicy struct {
	YouTubeParseTTL       runtimeOptField[string] `json:"youtube_parse_ttl"`
	StaleIfErrorTTL       runtimeOptField[string] `json:"stale_if_error_ttl"`
	UpstreamBlockedNegTTL runtimeOptField[string] `json:"upstream_blocked_neg_ttl"`
}

func (r *rawRuntimeCachePolicy) UnmarshalJSON(b []byte) error {
	type alias rawRuntimeCachePolicy
	var tmp alias
	if err := decodeStrictJSONObject(b, &tmp); err != nil {
		return err
	}
	*r = rawRuntimeCachePolicy(tmp)
	return nil
}

type rawRuntimeConfig struct {
	SchemaVersion  string                         `json:"schema_version"`
	YTDLP          rawRuntimeYTDLPConfig          `json:"ytdlp"`
	FastPool       rawRuntimeFastPoolConfig       `json:"fast_pool"`
	CircuitBreaker rawRuntimeCircuitBreakerConfig `json:"circuit_breaker"`
	Cache          rawRuntimeCachePolicy          `json:"cache"`
}

func parseRuntimeDuration(field, raw string) (time.Duration, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, fmt.Errorf("%s must be a valid duration string", field)
	}
	if trimmed == "0" {
		return 0, nil
	}
	d, err := time.ParseDuration(trimmed)
	if err != nil {
		return 0, fmt.Errorf("%s must be a valid duration string", field)
	}
	return d, nil
}

func sanitizeRuntimeDecodeError(err error) error {
	msg := err.Error()
	if strings.HasPrefix(msg, "json: unknown field ") {
		return errors.New("DOKITOOL_RUNTIME_CONFIG_FILE contains an unknown JSON field")
	}
	return errors.New("DOKITOOL_RUNTIME_CONFIG_FILE contains invalid JSON syntax or field types")
}

// ParseRuntimeConfig strictly decodes and validates a runtime config JSON payload.
func ParseRuntimeConfig(data []byte) (RuntimeConfig, error) {
	if len(data) > MaxRuntimeConfigFileBytes {
		return RuntimeConfig{}, fmt.Errorf("DOKITOOL_RUNTIME_CONFIG_FILE exceeds %d bytes", MaxRuntimeConfigFileBytes)
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return RuntimeConfig{}, errors.New("DOKITOOL_RUNTIME_CONFIG_FILE must contain a JSON object")
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	var doc rawRuntimeConfig
	if err := dec.Decode(&doc); err != nil {
		return RuntimeConfig{}, sanitizeRuntimeDecodeError(err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return RuntimeConfig{}, errors.New("DOKITOOL_RUNTIME_CONFIG_FILE must contain a single JSON object without trailing tokens")
	}

	cfg := DefaultRuntimeConfig()
	cfg.SchemaVersion = doc.SchemaVersion

	if doc.YTDLP.YouTubeSlots.set {
		cfg.YTDLP.YouTubeSlots = doc.YTDLP.YouTubeSlots.val
	}
	if doc.YTDLP.YouTubeQueueSize.set {
		cfg.YTDLP.YouTubeQueueSize = doc.YTDLP.YouTubeQueueSize.val
	}
	if doc.YTDLP.YouTubeQueueWait.set {
		d, err := parseRuntimeDuration("ytdlp.youtube_queue_wait", doc.YTDLP.YouTubeQueueWait.val)
		if err != nil {
			return RuntimeConfig{}, err
		}
		cfg.YTDLP.YouTubeQueueWait = d
	}
	if doc.YTDLP.SocialSlots.set {
		cfg.YTDLP.SocialSlots = doc.YTDLP.SocialSlots.val
	}
	if doc.YTDLP.SocialQueueSize.set {
		cfg.YTDLP.SocialQueueSize = doc.YTDLP.SocialQueueSize.val
	}
	if doc.YTDLP.SocialQueueWait.set {
		d, err := parseRuntimeDuration("ytdlp.social_queue_wait", doc.YTDLP.SocialQueueWait.val)
		if err != nil {
			return RuntimeConfig{}, err
		}
		cfg.YTDLP.SocialQueueWait = d
	}
	if doc.YTDLP.GenericSlots.set {
		cfg.YTDLP.GenericSlots = doc.YTDLP.GenericSlots.val
	}
	if doc.YTDLP.GenericQueueSize.set {
		cfg.YTDLP.GenericQueueSize = doc.YTDLP.GenericQueueSize.val
	}
	if doc.YTDLP.GenericQueueWait.set {
		d, err := parseRuntimeDuration("ytdlp.generic_queue_wait", doc.YTDLP.GenericQueueWait.val)
		if err != nil {
			return RuntimeConfig{}, err
		}
		cfg.YTDLP.GenericQueueWait = d
	}
	if doc.YTDLP.YouTubeEJSConcurrency.set {
		cfg.YTDLP.YouTubeEJSConcurrency = doc.YTDLP.YouTubeEJSConcurrency.val
	}
	if doc.YTDLP.YouTubeEJSQueueSize.set {
		cfg.YTDLP.YouTubeEJSQueueSize = doc.YTDLP.YouTubeEJSQueueSize.val
	}
	if doc.YTDLP.YouTubeEJSQueueWait.set {
		d, err := parseRuntimeDuration("ytdlp.youtube_ejs_queue_wait", doc.YTDLP.YouTubeEJSQueueWait.val)
		if err != nil {
			return RuntimeConfig{}, err
		}
		cfg.YTDLP.YouTubeEJSQueueWait = d
	}

	if doc.FastPool.PerPlatformMaxConcurrency.set {
		cfg.FastPool.PerPlatformMaxConcurrency = doc.FastPool.PerPlatformMaxConcurrency.val
	}

	if doc.CircuitBreaker.Enabled.set {
		cfg.CircuitBreaker.Enabled = doc.CircuitBreaker.Enabled.val
	}
	if doc.CircuitBreaker.ConsecutiveFailures.set {
		cfg.CircuitBreaker.ConsecutiveFailures = doc.CircuitBreaker.ConsecutiveFailures.val
	}
	if doc.CircuitBreaker.WindowSize.set {
		cfg.CircuitBreaker.WindowSize = doc.CircuitBreaker.WindowSize.val
	}
	if doc.CircuitBreaker.FailureRateThreshold.set {
		cfg.CircuitBreaker.FailureRateThreshold = doc.CircuitBreaker.FailureRateThreshold.val
	}
	if doc.CircuitBreaker.OpenDuration.set {
		d, err := parseRuntimeDuration("circuit_breaker.open_duration", doc.CircuitBreaker.OpenDuration.val)
		if err != nil {
			return RuntimeConfig{}, err
		}
		cfg.CircuitBreaker.OpenDuration = d
	}
	if doc.CircuitBreaker.HalfOpenMaxProbes.set {
		cfg.CircuitBreaker.HalfOpenMaxProbes = doc.CircuitBreaker.HalfOpenMaxProbes.val
	}
	if doc.CircuitBreaker.DisabledPlatforms.set {
		cfg.CircuitBreaker.DisabledPlatforms = slices.Clone(doc.CircuitBreaker.DisabledPlatforms.val)
	}

	if doc.Cache.YouTubeParseTTL.set {
		d, err := parseRuntimeDuration("cache.youtube_parse_ttl", doc.Cache.YouTubeParseTTL.val)
		if err != nil {
			return RuntimeConfig{}, err
		}
		cfg.Cache.YouTubeParseTTL = d
	}
	if doc.Cache.StaleIfErrorTTL.set {
		d, err := parseRuntimeDuration("cache.stale_if_error_ttl", doc.Cache.StaleIfErrorTTL.val)
		if err != nil {
			return RuntimeConfig{}, err
		}
		cfg.Cache.StaleIfErrorTTL = d
	}
	if doc.Cache.UpstreamBlockedNegTTL.set {
		d, err := parseRuntimeDuration("cache.upstream_blocked_neg_ttl", doc.Cache.UpstreamBlockedNegTTL.val)
		if err != nil {
			return RuntimeConfig{}, err
		}
		cfg.Cache.UpstreamBlockedNegTTL = d
	}

	return normalizeAndValidateRuntimeConfig(cfg)
}

func readBoundedRuntimeConfigFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("DOKITOOL_RUNTIME_CONFIG_FILE does not exist")
		}
		if errors.Is(err, os.ErrPermission) {
			return nil, errors.New("DOKITOOL_RUNTIME_CONFIG_FILE permission denied")
		}
		return nil, errors.New("failed to open DOKITOOL_RUNTIME_CONFIG_FILE")
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, errors.New("failed to stat DOKITOOL_RUNTIME_CONFIG_FILE")
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("DOKITOOL_RUNTIME_CONFIG_FILE must be a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxRuntimeConfigFileBytes+1))
	if err != nil {
		return nil, errors.New("failed to read DOKITOOL_RUNTIME_CONFIG_FILE")
	}
	if len(data) > MaxRuntimeConfigFileBytes {
		return nil, fmt.Errorf("DOKITOOL_RUNTIME_CONFIG_FILE exceeds %d bytes", MaxRuntimeConfigFileBytes)
	}
	return data, nil
}

// LoadRuntimeConfigFile reads and strictly validates a regular runtime config file (<= 64 KiB).
func LoadRuntimeConfigFile(path string) (RuntimeConfig, error) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return RuntimeConfig{}, errors.New("DOKITOOL_RUNTIME_CONFIG_FILE path must not be empty")
	}
	raw, err := readBoundedRuntimeConfigFile(trimmed)
	if err != nil {
		return RuntimeConfig{}, err
	}
	return ParseRuntimeConfig(raw)
}

// LoadRuntimeConfig loads DOKITOOL_RUNTIME_CONFIG_FILE if set.
// When unset/empty, it returns (DefaultRuntimeConfig(), false, nil) so existing
// environment-variable configuration remains 100% backward compatible.
func LoadRuntimeConfig(getenv func(string) string) (cfg RuntimeConfig, fromFile bool, err error) {
	if getenv == nil {
		return RuntimeConfig{}, false, errors.New("missing runtime configuration reader")
	}
	rawPath := getenv(EnvRuntimeConfigFile)
	if rawPath == "" {
		return DefaultRuntimeConfig(), false, nil
	}
	trimmed := strings.TrimSpace(rawPath)
	if trimmed == "" {
		return RuntimeConfig{}, false, errors.New("DOKITOOL_RUNTIME_CONFIG_FILE must not be whitespace")
	}
	cfg, err = LoadRuntimeConfigFile(trimmed)
	if err != nil {
		return RuntimeConfig{}, false, err
	}
	return cfg, true, nil
}

// ApplyRuntimeConfigToAdmissionConfig overlays runtime hot-config pool limits onto
// an AdmissionConfig before server startup when DOKITOOL_RUNTIME_CONFIG_FILE is active.
func ApplyRuntimeConfigToAdmissionConfig(adm *AdmissionConfig, cfg RuntimeConfig) {
	if adm == nil {
		return
	}
	applyPool := func(p *PoolConfig, globalConc, qSize int, qWait time.Duration) {
		p.GlobalConcurrency = globalConc
		if p.ClientConcurrency > p.GlobalConcurrency {
			p.ClientConcurrency = p.GlobalConcurrency
		}
		p.QueueSize = qSize
		p.QueueWait = qWait
	}
	applyPool(&adm.YouTubeSlowParse, cfg.YTDLP.YouTubeSlots, cfg.YTDLP.YouTubeQueueSize, cfg.YTDLP.YouTubeQueueWait)
	applyPool(&adm.SlowParse, cfg.YTDLP.SocialSlots, cfg.YTDLP.SocialQueueSize, cfg.YTDLP.SocialQueueWait)
	applyPool(&adm.GenericSlowParse, cfg.YTDLP.GenericSlots, cfg.YTDLP.GenericQueueSize, cfg.YTDLP.GenericQueueWait)
	applyPool(&adm.YouTubeEJS, cfg.YTDLP.YouTubeEJSConcurrency, cfg.YTDLP.YouTubeEJSQueueSize, cfg.YTDLP.YouTubeEJSQueueWait)
	adm.FastPerPlatformMaxConcurrency = cfg.FastPool.PerPlatformMaxConcurrency
}

// RuntimePolicySnapshot is an immutable point-in-time view of hot-path request
// policies published via atomic.Pointer on every committed ApplyRuntimeConfig.
// Request handlers load one snapshot lock-free so all policy checks within a
// single request observe a single consistent generation without tearing.
type RuntimePolicySnapshot struct {
	Generation            uint64
	Cache                 RuntimeCachePolicy
	CircuitBreakerEnabled bool
	disabledPlatforms     []string
	disabledSet           map[string]struct{}
}

var defaultRuntimePolicySnapshot = newRuntimePolicySnapshot(DefaultRuntimeConfig(), 0)

func newRuntimePolicySnapshot(cfg RuntimeConfig, generation uint64) *RuntimePolicySnapshot {
	disabled := make([]string, len(cfg.CircuitBreaker.DisabledPlatforms))
	copy(disabled, cfg.CircuitBreaker.DisabledPlatforms)
	var disabledSet map[string]struct{}
	if len(disabled) > 0 {
		disabledSet = make(map[string]struct{}, len(disabled))
		for _, p := range disabled {
			disabledSet[p] = struct{}{}
		}
	}
	return &RuntimePolicySnapshot{
		Generation:            generation,
		Cache:                 cfg.Cache,
		CircuitBreakerEnabled: cfg.CircuitBreaker.Enabled,
		disabledPlatforms:     disabled,
		disabledSet:           disabledSet,
	}
}

// IsPlatformDisabled reports whether platform is manually disabled in this snapshot.
func (s *RuntimePolicySnapshot) IsPlatformDisabled(platform string) bool {
	if s == nil || platform == "" || len(s.disabledSet) == 0 {
		return false
	}
	_, disabled := s.disabledSet[platform]
	return disabled
}

// DisabledPlatforms returns a defensive copy of disabled platform IDs in this snapshot.
func (s *RuntimePolicySnapshot) DisabledPlatforms() []string {
	if s == nil || len(s.disabledPlatforms) == 0 {
		return make([]string, 0)
	}
	return slices.Clone(s.disabledPlatforms)
}

// RuntimeConfigCommitHook executes an external compartment-resize step (such as
// ytengine compartment SetConcurrencyLimit) inside the serialized reload critical
// section after validation and snapshot preparation, and before mutating admission
// pools, circuit breakers, cache entries, or publishing the next policy snapshot.
// Returning a non-nil error aborts the reload before admission/handler state is mutated
// (the hook itself is responsible for best-effort compartment rollback on partial failure).
type RuntimeConfigCommitHook func(next RuntimeConfig) error

// ApplyRuntimeConfig applies a validated RuntimeConfig in-place to the live admission
// pools, handler circuit breakers, immutable RuntimePolicySnapshot, and stats summary.
// Admission *pool structs are never replaced: active leases and FIFO waiters are preserved.
func ApplyRuntimeConfig(entry http.Handler, handler *Handler, cfg RuntimeConfig, fromFile bool, isReload bool) bool {
	return ApplyRuntimeConfigWithHook(entry, handler, cfg, fromFile, isReload, nil) == nil
}

// ApplyRuntimeConfigWithHook executes a serialized validate -> prepare -> commit
// runtime config reload. Concurrent reloads are serialized under reloadMu:
//   - atomic.Pointer[RuntimePolicySnapshot] provides lock-free single-generation
//     consistency for request-path policy reads;
//   - external ytengine compartments and each admission *pool are updated sequentially
//     in-place (thread-safe per pool without dropping active leases or FIFO waiters)
//     rather than as a single cross-subsystem instant transaction.
//
// Validation errors or non-nil hook errors abort before admission pools, circuit breakers,
// cache entries, RuntimePolicySnapshot, stats, or generation are modified.
func ApplyRuntimeConfigWithHook(
	entry http.Handler,
	handler *Handler,
	cfg RuntimeConfig,
	fromFile bool,
	isReload bool,
	hook RuntimeConfigCommitHook,
) error {
	// Phase 1: Validate and normalize before taking any lock or mutating live state.
	norm, err := normalizeAndValidateRuntimeConfig(cfg)
	if err != nil {
		return err
	}
	var adm *admission
	if entry != nil {
		if a, ok := entry.(*admission); ok && a != nil {
			adm = a
		}
	}
	if handler == nil && adm != nil {
		if h, ok := adm.next.(*Handler); ok {
			handler = h
		}
	}
	if adm == nil && handler == nil {
		return errors.New("missing admission and handler targets for runtime config apply")
	}

	// Phase 2: Prepare immutable policy snapshot allocations outside commit locks.
	preparedSnap := newRuntimePolicySnapshot(norm, 0)

	// Phase 3: Serialized commit in deterministic lock order (handler -> admission).
	if handler != nil {
		handler.reloadMu.Lock()
		defer handler.reloadMu.Unlock()
	}
	if adm != nil {
		adm.runtimeReloadMu.Lock()
		defer adm.runtimeReloadMu.Unlock()
	}

	// Execute external compartment hook first while serialized so any partial failure
	// rolls back compartments without waking admission waiters or mutating policy.
	if hook != nil {
		if err := hook(norm); err != nil {
			return err
		}
	}

	if adm != nil {
		adm.youtubeSlow.updateLimits(norm.YTDLP.YouTubeSlots, norm.YTDLP.YouTubeQueueSize, norm.YTDLP.YouTubeQueueWait)
		adm.slow.updateLimits(norm.YTDLP.SocialSlots, norm.YTDLP.SocialQueueSize, norm.YTDLP.SocialQueueWait)
		adm.genericSlow.updateLimits(norm.YTDLP.GenericSlots, norm.YTDLP.GenericQueueSize, norm.YTDLP.GenericQueueWait)
		adm.youtubeEJS.updateLimits(norm.YTDLP.YouTubeEJSConcurrency, norm.YTDLP.YouTubeEJSQueueSize, norm.YTDLP.YouTubeEJSQueueWait)
		adm.public.updatePerPlatformLimit(norm.FastPool.PerPlatformMaxConcurrency)
	}
	if handler != nil {
		if handler.cb != nil {
			handler.cb.UpdateConfig(norm.CircuitBreaker)
		}
		preparedSnap.Generation = handler.currentPolicySnapshot().Generation + 1
		handler.policy.Store(preparedSnap)
		if handler.cache != nil && len(norm.CircuitBreaker.DisabledPlatforms) > 0 {
			handler.cache.purgePlatforms(norm.CircuitBreaker.DisabledPlatforms)
		}
		handler.notifyRuntimeConfigObservers(norm)
		handler.stats.applyRuntimePolicy(norm, fromFile, isReload)
	} else if adm != nil && adm.stats != nil {
		adm.stats.applyRuntimePolicy(norm, fromFile, isReload)
	}
	return nil
}
