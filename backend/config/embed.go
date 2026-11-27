// Package config embeds the single-source language-neutral platform registry
// shared by Go backend routing, OpenAPI validation, and frontend catalog generation.
package config

import _ "embed"

//go:embed platforms.json
var platforms []byte

func Platforms() []byte { return append([]byte(nil), platforms...) }
