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
		{"-owner-ratio", "-0.2"},
		{"-owner-ratio", "1.2"},
		{"-owner-concurrency", "-1"},
		{"-owner-concurrency", "33"},
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
	for _, profile := range []string{"baseline", "current", "pre-pr5", "post-pr5"} {
		var out bytes.Buffer
		err := run([]string{
			"-profile", profile,
			"-rps", "60",
			"-duration", "400ms",
			"-fast-latency", "5ms",
			"-slow-latency", "15ms",
			"-shanghai-latency", "5ms",
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
		if r.Overall.Requests < 12 {
			t.Fatalf("expected at least 12 requests in smoke run for %s, got %d", profile, r.Overall.Requests)
		}
		if r.Overall.OtherErr != 0 {
			t.Fatalf("expected zero non-429 errors for %s, got %d", profile, r.Overall.OtherErr)
		}
		if profile == "current" && (r.ShanghaiHits == 0 || r.ShanghaiBilibiliHits == 0) {
			t.Fatalf("expected Shanghai PullBroker total and Bilibili hits > 0 in current smoke run, got total=%d bilibili=%d", r.ShanghaiHits, r.ShanghaiBilibiliHits)
		}
		if profile == "post-pr5" {
			if r.OwnerAgent.OK == 0 || r.Anonymous.OK == 0 {
				t.Fatalf("expected both owner and anonymous 200 OKs in post-pr5 smoke run, got owner=%d anon=%d", r.OwnerAgent.OK, r.Anonymous.OK)
			}
			if r.WeiboOwnerDirect == 0 || r.WeiboAnonRelay != 0 {
				t.Fatalf("expected Weibo direct > 0 and zero legacy relay in post-pr5, got direct=%d relay=%d", r.WeiboOwnerDirect, r.WeiboAnonRelay)
			}
		}
		if profile == "pre-pr5" && r.WeiboAnonRelay != 0 {
			t.Fatalf("expected zero legacy Weibo relay URLs in pre-pr5, got %d", r.WeiboAnonRelay)
		}
	}
}
