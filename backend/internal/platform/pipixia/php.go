package pipixia

import (
	"github.com/Brilliant666/DokiTool-Go/backend/internal/phpcompat"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func decodePHP(raw []byte, bigintStrings bool, maxDepth int) (any, error) {
	return phpcompat.Decode(raw, bigintStrings, maxDepth)
}

func field(value any, key string) any             { return phpcompat.Field(value, key) }
func isArray(value any) bool                      { return phpcompat.IsArray(value) }
func values(value any) unified.Array              { return phpcompat.Values(value) }
func plain(value any) any                         { return phpcompat.Plain(value) }
func first(values ...any) any                     { return phpcompat.First(values...) }
func truthy(value any) bool                       { return phpcompat.Truthy(value) }
func percentDecode(raw string) string             { return phpcompat.PercentDecode(raw) }
func queryValue(q, w string) (string, bool, bool) { return phpcompat.QueryValue(q, w) }
