package api

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

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
)

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
	Parse      PoolConfig
	SlowParse  PoolConfig
	Catalog    PoolConfig
	Relay      PoolConfig
	Reports    PoolConfig
	MaxClients int
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
		MaxClients: 4096,
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
		{"PARSE_SLOW", c.SlowParse, MaxSlowParseConcurrency, MaxSlowParseQueueWait, MaxSlowParseQueueSize},
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
	for _, entry := range []struct {
		name string
		p    *PoolConfig
	}{
		{"PARSE", &c.Parse},
		{"PARSE_SLOW", &c.SlowParse},
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
		{"PARSE_SLOW", &c.SlowParse, MaxSlowParseQueueWait, MaxSlowParseQueueSize},
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
	return c, c.Validate()
}
