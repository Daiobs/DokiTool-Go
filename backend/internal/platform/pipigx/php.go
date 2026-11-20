package pipigx

import (
	"github.com/Brilliant666/DokiTool-Go/backend/internal/phpcompat"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type phpObject struct {
	keys   []string
	fields unified.Object
}

func (o *phpObject) PHPAssociative() ([]string, unified.Object, bool) {
	if o == nil {
		return nil, nil, false
	}
	return o.keys, o.fields, true
}

func decodePHP(raw []byte, bigintStrings bool, maxDepth int) (any, error) {
	return phpcompat.DecodeAs(raw, bigintStrings, maxDepth, func(keys []string, fields unified.Object) any {
		return &phpObject{keys: keys, fields: fields}
	})
}

func field(value any, key string) any             { return phpcompat.Field(value, key) }
func isArray(value any) bool                      { return phpcompat.IsArray(value) }
func values(value any) unified.Array              { return phpcompat.Values(value) }
func plain(value any) any                         { return phpcompat.Plain(value) }
func first(values ...any) any                     { return phpcompat.First(values...) }
func scalarString(value any) string               { return phpcompat.ScalarString(value) }
func queryValue(q, w string) (string, bool, bool) { return phpcompat.QueryValue(q, w) }
