package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestParseConfigBoundsValidation(t *testing.T) {
	badCases := [][]string{
		{"-profile", "unknown"},
		{"-duration", "0s"},
		{"-duration", "31m"},
		{"-fast-latency", "-1ms"},
		{"-slow-latency", "31s"},
		{"-hot-ratio", "-0.1"},
		{"-hot-ratio", "1.1"},
		{"-hot-urls", "4"},
		{"-clients", "0"},
		{"-clients", "70000"},
		{"-cache", "invalid"},
		{"-ytdlp-concurrency", "25"},
		{"-shanghai-workers", "99"},
		{"-rps", "0"},
		{"-rps", "9999"},
		{"extra-arg"},
	}
	for _, args := range badCases {
		if _, err := parseConfig(args); err == nil {
			t.Fatalf("expected parseConfig(%v) to fail bounds validation", args)
		}
	}
}

func TestLoopbackClientRejectsExternalAddresses(t *testing.T) {
	c := newLoopbackClient(4, time.Second)
	defer c.CloseIdleConnections()

	for _, target := range []string{
		"http://93.184.216.34/",
		"http://example.com/",
	} {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, target, nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := c.Do(req)
		if resp != nil {
			resp.Body.Close()
		}
		if err == nil {
			t.Fatalf("expected non-loopback target %q to be rejected", target)
		}
	}
}

func TestLoadtestProfilesSmokeLoopbackOnly(t *testing.T) {
	for _, profile := range []string{"baseline", "current"} {
		var out bytes.Buffer
		err := run([]string{
			"-profile", profile,
			"-rps", "40",
			"-duration", "350ms",
			"-fast-latency", "8ms",
			"-slow-latency", "25ms",
			"-shanghai-latency", "8ms",
			"-json",
		}, &out)
		if err != nil {
			t.Fatalf("profile %s smoke failed: %v", profile, err)
		}
		var results []tierResult
		if err := json.Unmarshal(out.Bytes(), &results); err != nil {
			t.Fatalf("decode json output for %s: %v", profile, err)
		}
		if len(results) != 1 {
			t.Fatalf("expected 1 tier result, got %d", len(results))
		}
		r := results[0]
		if r.Overall.Requests < 8 {
			t.Fatalf("expected at least 8 requests in smoke run for %s, got %d", profile, r.Overall.Requests)
		}
		if r.Overall.OtherErr != 0 {
			t.Fatalf("expected zero non-429 errors for %s, got %d", profile, r.Overall.OtherErr)
		}
		if profile == "current" && r.ShanghaiHits == 0 {
			t.Fatalf("expected Shanghai PullBroker hits > 0 in current smoke run, got 0")
		}
	}
}
