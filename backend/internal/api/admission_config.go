package api

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/bearer"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/ytgeneric"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

const (
	DefaultFastParseQueueWait = 1500 * time.Millisecond
	DefaultFastParseQueueSize = 128
	MaxFastParseQueueWait     = 15 * time.Second
	MaxFastParseQueueSize     = 4096

	DefaultSlowParseQueueWait = 5 * time.Second
	DefaultSlowParseQueueSize = 32
	MaxSlowParseQueueWait     = 30 * time.Second
	MaxSlowParseQueueSize     = 1024
	MaxSlowParseConcurrency   = 64

	MinOwnerTokenBytes      = bearer.MinTokenBytes
	MaxOwnerTokenBytes      = bearer.MaxTokenBytes
	MaxOwnerAuthHeaderBytes = 1024

	DefaultOwnerConcurrency = 8
	MaxOwnerConcurrency     = 32
	DefaultOwnerQueueWait   = 60 * time.Second
	MaxOwnerQueueWait       = 120 * time.Second
	DefaultOwnerQueueSize   = 256
	MaxOwnerQueueSize       = 4096
)

// OwnerAuth stores only the precomputed SHA-256 digest of DOKITOOL_OWNER_TOKEN
// so neither the plaintext token nor its length remains in long-lived structs
// or accidental formatting output.
type OwnerAuth struct {
	enabled bool
	digest  [32]byte
}

// NewOwnerAuth validates a candidate DOKITOOL_OWNER_TOKEN value.
// An empty string disables the owner channel; any non-empty value must be
// 32–512 printable ASCII characters without whitespace or control bytes.
func NewOwnerAuth(token string) (OwnerAuth, error) {
	if token == "" {
		return OwnerAuth{}, nil
	}
	if err := bearer.ValidateToken(token); err != nil {
		return OwnerAuth{}, errors.New("DOKITOOL_OWNER_TOKEN must be empty or 32–512 printable ASCII characters without whitespace")
	}
	return OwnerAuth{
		enabled: true,
		digest:  bearer.Digest(token),
	}, nil
}

// LoadOwnerAuth loads and validates DOKITOOL_OWNER_TOKEN before server startup.
func LoadOwnerAuth(getenv func(string) string) (OwnerAuth, error) {
	if getenv == nil {
		return OwnerAuth{}, errors.New("missing owner authentication reader")
	}
	return NewOwnerAuth(getenv("DOKITOOL_OWNER_TOKEN"))
}

// Enabled reports whether the owner channel is active.
func (o OwnerAuth) Enabled() bool {
	return o.enabled
}

func (o OwnerAuth) String() string {
	if o.enabled {
		return "OwnerAuth{enabled:true}"
	}
	return "OwnerAuth{enabled:false}"
}

func (o OwnerAuth) GoString() string {
	return o.String()
}

// PoolConfig separates a visitor's abuse budget from the service capacity.
// Rates are tokens per second. These are process-local limits, not cluster quotas.
type PoolConfig struct {
	ClientBurst       float64
	ClientRPS         float64
	GlobalBurst       float64
	GlobalRPS         float64
	ClientConcurrency int
	GlobalConcurrency int
	QueueWait         time.Duration
	QueueSize         int
}

type AdmissionConfig struct {
	Parse            PoolConfig
	Resolve          PoolConfig
	SlowParse        PoolConfig
	GenericSlowParse PoolConfig
	Catalog          PoolConfig
	Relay            PoolConfig
	Reports          PoolConfig
	MaxClients       int
	OwnerConcurrency int
	OwnerQueueWait   time.Duration
	OwnerQueueSize   int
}

// DefaultAdmissionConfig splits pure-Go fast platforms from yt-dlp slow platforms
// while keeping the existing per-IP parse budget unchanged across both pools.
func DefaultAdmissionConfig() AdmissionConfig {
	return AdmissionConfig{
		Parse: PoolConfig{
			ClientBurst:       4,
			ClientRPS:         12.0 / 60,
			GlobalBurst:       100,
			GlobalRPS:         50,
			ClientConcurrency: 1,
			GlobalConcurrency: 64,
			QueueWait:         DefaultFastParseQueueWait,
			QueueSize:         DefaultFastParseQueueSize,
		},
		// Resolve serves per-item follow-ups of an already parsed link (for
		// example Bilibili multi-P episodes), so it gets its own, roomier
		// per-IP budget instead of competing with first-time parses.
		Resolve: PoolConfig{
			ClientBurst:       12,
			ClientRPS:         0.5,
			GlobalBurst:       100,
			GlobalRPS:         50,
			ClientConcurrency: 2,
			GlobalConcurrency: 32,
			QueueWait:         DefaultFastParseQueueWait,
			QueueSize:         DefaultFastParseQueueSize,
		},
		SlowParse: PoolConfig{
			ClientBurst:       4,
			ClientRPS:         12.0 / 60,
			GlobalBurst:       32,
			GlobalRPS:         10,
			ClientConcurrency: 1,
			GlobalConcurrency: ytengine.DefaultConcurrency,
			QueueWait:         DefaultSlowParseQueueWait,
			QueueSize:         DefaultSlowParseQueueSize,
		},
		GenericSlowParse: PoolConfig{
			ClientBurst:       3,
			ClientRPS:         6.0 / 60,
			GlobalBurst:       12,
			GlobalRPS:         4,
			ClientConcurrency: 1,
			GlobalConcurrency: ytgeneric.DefaultGenericConcurrency,
			QueueWait:         DefaultSlowParseQueueWait,
			QueueSize:         16,
		},
		Catalog: PoolConfig{
			ClientBurst:       20,
			ClientRPS:         5,
			GlobalBurst:       128,
			GlobalRPS:         100,
			ClientConcurrency: 4,
			GlobalConcurrency: 64,
		},
		Relay: PoolConfig{
			ClientBurst:       12,
			ClientRPS:         1,
			GlobalBurst:       24,
			GlobalRPS:         2,
			ClientConcurrency: 2,
			GlobalConcurrency: 12,
		},
		Reports: PoolConfig{
			ClientBurst:       10,
			ClientRPS:         1,
			GlobalBurst:       60,
			GlobalRPS:         5,
			ClientConcurrency: 2,
			GlobalConcurrency: 16,
		},
		MaxClients:       4096,
		OwnerConcurrency: DefaultOwnerConcurrency,
		OwnerQueueWait:   DefaultOwnerQueueWait,
		OwnerQueueSize:   DefaultOwnerQueueSize,
	}
}

func (c AdmissionConfig) Validate() error {
	for _, entry := range []struct {
		name           string
		p              PoolConfig
		maxConcurrency int
		maxQueueWait   time.Duration
		maxQueueSize   int
	}{
		{"PARSE", c.Parse, 4096, MaxFastParseQueueWait, MaxFastParseQueueSize},
		{"RESOLVE", c.Resolve, 4096, MaxFastParseQueueWait, MaxFastParseQueueSize},
		{"PARSE_SLOW", c.SlowParse, MaxSlowParseConcurrency, MaxSlowParseQueueWait, MaxSlowParseQueueSize},
		{"PARSE_GENERIC", c.GenericSlowParse, MaxSlowParseConcurrency, MaxSlowParseQueueWait, MaxSlowParseQueueSize},
		{"CATALOG", c.Catalog, 4096, 0, 0},
		{"WEIBO", c.Relay, 4096, 0, 0},
		{"REPORT", c.Reports, 4096, 0, 0},
	} {
		p := entry.p
		for _, x := range []struct {
			name    string
			value   float64
			minimum float64
		}{
			{"CLIENT_BURST", p.ClientBurst, 1}, {"CLIENT_RPS", p.ClientRPS, 0.001},
			{"GLOBAL_BURST", p.GlobalBurst, 1}, {"GLOBAL_RPS", p.GlobalRPS, 0.001},
		} {
			if math.IsNaN(x.value) || math.IsInf(x.value, 0) || x.value < x.minimum || x.value > 100000 {
				return fmt.Errorf("DOKITOOL_%s_%s is outside the supported positive range", entry.name, x.name)
			}
		}
		if p.ClientConcurrency < 1 || p.GlobalConcurrency < p.ClientConcurrency || p.GlobalConcurrency > entry.maxConcurrency {
			return fmt.Errorf("DOKITOOL_%s concurrency must satisfy 1 <= client <= global <= %d", entry.name, entry.maxConcurrency)
		}
		if p.QueueWait < 0 || p.QueueWait > entry.maxQueueWait {
			return fmt.Errorf("DOKITOOL_%s_QUEUE_WAIT must be between 0s and %s", entry.name, entry.maxQueueWait)
		}
		if p.QueueSize < 0 || p.QueueSize > entry.maxQueueSize {
			return fmt.Errorf("DOKITOOL_%s_QUEUE_SIZE must be between 0 and %d", entry.name, entry.maxQueueSize)
		}
	}
	// The existing relay also owns twelve binary-stream leases. Do not advertise
	// a larger outer capacity while its independent stream guard remains in place.
	if c.Relay.GlobalConcurrency > 12 {
		return fmt.Errorf("DOKITOOL_WEIBO_GLOBAL_CONCURRENCY cannot exceed the existing 12 relay stream slots")
	}
	if c.MaxClients < 1 || c.MaxClients > 65536 {
		return fmt.Errorf("DOKITOOL_ADMISSION_MAX_CLIENTS must be between 1 and 65536")
	}
	if c.OwnerConcurrency < 1 || c.OwnerConcurrency > MaxOwnerConcurrency {
		return fmt.Errorf("DOKITOOL_OWNER_CONCURRENCY must be an integer between 1 and %d", MaxOwnerConcurrency)
	}
	if c.OwnerQueueWait < 0 || c.OwnerQueueWait > MaxOwnerQueueWait {
		return fmt.Errorf("DOKITOOL_OWNER_QUEUE_WAIT must be between 0s and %s", MaxOwnerQueueWait)
	}
	if c.OwnerQueueSize < 0 || c.OwnerQueueSize > MaxOwnerQueueSize {
		return fmt.Errorf("DOKITOOL_OWNER_QUEUE_SIZE must be between 0 and %d", MaxOwnerQueueSize)
	}
	return nil
}

// LoadAdmissionConfig runs once before startup. Invalid configuration is an
// actionable startup error; zero never means accidentally unlimited traffic.
func LoadAdmissionConfig(getenv func(string) string) (AdmissionConfig, error) {
	c := DefaultAdmissionConfig()
	if getenv == nil {
		return c, fmt.Errorf("missing admission configuration reader")
	}
	if raw := strings.TrimSpace(getenv("DOKITOOL_YTDLP_CONCURRENCY")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > ytengine.MaxConcurrency {
			return AdmissionConfig{}, fmt.Errorf("DOKITOOL_YTDLP_CONCURRENCY must be an integer between 1 and %d", ytengine.MaxConcurrency)
		}
		c.SlowParse.GlobalConcurrency = value
	}
	if raw := strings.TrimSpace(getenv("DOKITOOL_YTDLP_GENERIC_CONCURRENCY")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > ytengine.MaxConcurrency {
			return AdmissionConfig{}, fmt.Errorf("DOKITOOL_YTDLP_GENERIC_CONCURRENCY must be an integer between 1 and %d", ytengine.MaxConcurrency)
		}
		c.GenericSlowParse.GlobalConcurrency = value
	}
	for _, entry := range []struct {
		name string
		p    *PoolConfig
	}{
		{"PARSE", &c.Parse},
		{"RESOLVE", &c.Resolve},
		{"PARSE_SLOW", &c.SlowParse},
		{"PARSE_GENERIC", &c.GenericSlowParse},
		{"CATALOG", &c.Catalog},
		{"WEIBO", &c.Relay},
		{"REPORT", &c.Reports},
	} {
		p := entry.p
		for _, x := range []struct {
			name  string
			value *float64
		}{
			{"CLIENT_BURST", &p.ClientBurst}, {"CLIENT_RPS", &p.ClientRPS},
			{"GLOBAL_BURST", &p.GlobalBurst}, {"GLOBAL_RPS", &p.GlobalRPS},
		} {
			key := "DOKITOOL_" + entry.name + "_" + x.name
			if raw := strings.TrimSpace(getenv(key)); raw != "" {
				value, err := strconv.ParseFloat(raw, 64)
				if err != nil {
					return AdmissionConfig{}, fmt.Errorf("%s must be a finite positive number", key)
				}
				*x.value = value
			}
		}
		for _, x := range []struct {
			name  string
			value *int
		}{
			{"CLIENT_CONCURRENCY", &p.ClientConcurrency}, {"GLOBAL_CONCURRENCY", &p.GlobalConcurrency},
		} {
			key := "DOKITOOL_" + entry.name + "_" + x.name
			if raw := strings.TrimSpace(getenv(key)); raw != "" {
				value, err := strconv.Atoi(raw)
				if err != nil {
					return AdmissionConfig{}, fmt.Errorf("%s must be a positive integer", key)
				}
				*x.value = value
			}
		}
	}
	for _, entry := range []struct {
		name         string
		p            *PoolConfig
		maxQueueWait time.Duration
		maxQueueSize int
	}{
		{"PARSE", &c.Parse, MaxFastParseQueueWait, MaxFastParseQueueSize},
		{"RESOLVE", &c.Resolve, MaxFastParseQueueWait, MaxFastParseQueueSize},
		{"PARSE_SLOW", &c.SlowParse, MaxSlowParseQueueWait, MaxSlowParseQueueSize},
		{"PARSE_GENERIC", &c.GenericSlowParse, MaxSlowParseQueueWait, MaxSlowParseQueueSize},
	} {
		waitKey := "DOKITOOL_" + entry.name + "_QUEUE_WAIT"
		if raw := strings.TrimSpace(getenv(waitKey)); raw != "" {
			var wait time.Duration
			if raw != "0" {
				parsed, err := time.ParseDuration(raw)
				if err != nil {
					return AdmissionConfig{}, fmt.Errorf("%s must be a duration between 0s and %s", waitKey, entry.maxQueueWait)
				}
				wait = parsed
			}
			entry.p.QueueWait = wait
		}
		sizeKey := "DOKITOOL_" + entry.name + "_QUEUE_SIZE"
		if raw := strings.TrimSpace(getenv(sizeKey)); raw != "" {
			size, err := strconv.Atoi(raw)
			if err != nil {
				return AdmissionConfig{}, fmt.Errorf("%s must be an integer between 0 and %d", sizeKey, entry.maxQueueSize)
			}
			entry.p.QueueSize = size
		}
	}
	if raw := strings.TrimSpace(getenv("DOKITOOL_ADMISSION_MAX_CLIENTS")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			return AdmissionConfig{}, fmt.Errorf("DOKITOOL_ADMISSION_MAX_CLIENTS must be a positive integer")
		}
		c.MaxClients = value
	}
	if raw := strings.TrimSpace(getenv("DOKITOOL_OWNER_CONCURRENCY")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > MaxOwnerConcurrency {
			return AdmissionConfig{}, fmt.Errorf("DOKITOOL_OWNER_CONCURRENCY must be an integer between 1 and %d", MaxOwnerConcurrency)
		}
		c.OwnerConcurrency = value
	}
	if raw := strings.TrimSpace(getenv("DOKITOOL_OWNER_QUEUE_WAIT")); raw != "" {
		var wait time.Duration
		if raw != "0" {
			parsed, err := time.ParseDuration(raw)
			if err != nil || parsed < 0 || parsed > MaxOwnerQueueWait {
				return AdmissionConfig{}, fmt.Errorf("DOKITOOL_OWNER_QUEUE_WAIT must be a duration between 0s and %s", MaxOwnerQueueWait)
			}
			wait = parsed
		}
		c.OwnerQueueWait = wait
	}
	if raw := strings.TrimSpace(getenv("DOKITOOL_OWNER_QUEUE_SIZE")); raw != "" {
		size, err := strconv.Atoi(raw)
		if err != nil || size < 0 || size > MaxOwnerQueueSize {
			return AdmissionConfig{}, fmt.Errorf("DOKITOOL_OWNER_QUEUE_SIZE must be an integer between 0 and %d", MaxOwnerQueueSize)
		}
		c.OwnerQueueSize = size
	}
	return c, c.Validate()
}
