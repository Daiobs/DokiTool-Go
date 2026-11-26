// Package config embeds the existing language-neutral platform registry.
// platforms.json remains the frozen core registry used by PHP, Go and frontend generation;
// platforms_extra.json holds the additional Go-registered platforms and exact-host additions.
package config

import _ "embed"

//go:embed platforms.json
var platforms []byte

//go:embed platforms_extra.json
var platformsExtra []byte

func Platforms() []byte { return append([]byte(nil), platforms...) }

func PlatformsExtra() []byte { return append([]byte(nil), platformsExtra...) }
