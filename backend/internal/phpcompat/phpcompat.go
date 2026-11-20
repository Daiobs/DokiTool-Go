// Package phpcompat implements shared PHP json_decode/json_encode, parse_str,
// and ordered associative-array compatibility helpers.
package phpcompat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

// Associative represents a JSON object decoded as an ordered PHP associative
// array, retaining insertion-ordered keys alongside a field lookup map.
type Associative interface {
	PHPAssociative() ([]string, unified.Object, bool)
}

// Object decodes JSON objects as ordered PHP associative arrays. Keep insertion
// order and the last value for a repeated key; never derive source order from a
// Go map.
type Object struct {
	Keys   []string
	Fields unified.Object
}

// PHPAssociative implements Associative.
func (o *Object) PHPAssociative() ([]string, unified.Object, bool) {
	if o == nil {
		return nil, nil, false
	}
	return o.Keys, o.Fields, true
}

// Get looks up key in o.Fields.
func (o *Object) Get(key string) (any, bool) {
	if o == nil || o.Fields == nil {
		return nil, false
	}
	value, ok := o.Fields[key]
	return value, ok
}

// Len reports the number of distinct keys retained in o.
func (o *Object) Len() int {
	if o == nil {
		return 0
	}
	return len(o.Keys)
}

func inspectAssociative(value any) (keys []string, fields unified.Object, isAssoc, valid bool) {
	assoc, ok := value.(Associative)
	if !ok {
		return nil, nil, false, false
	}
	keys, fields, valid = assoc.PHPAssociative()
	return keys, fields, true, valid
}

// Decode decodes raw JSON using PHP associative-array semantics, preserving
// object key insertion order, repeated-key last-value semantics, maxDepth, and
// optional JSON_BIGINT_AS_STRING behavior.
func Decode(raw []byte, bigintStrings bool, maxDepth int) (any, error) {
	return DecodeAs(raw, bigintStrings, maxDepth, nil)
}

// DecodeAs decodes raw JSON like Decode, constructing each JSON object via
// newObject (or *Object when newObject is nil).
func DecodeAs(raw []byte, bigintStrings bool, maxDepth int, newObject func(keys []string, fields unified.Object) any) (any, error) {
	if !utf8.Valid(raw) || !ValidJSONSurrogates(raw) {
		return nil, fmt.Errorf("invalid upstream Unicode")
	}
	if newObject == nil {
		newObject = func(keys []string, fields unified.Object) any {
			return &Object{Keys: keys, Fields: fields}
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var read func(int) (any, error)
	read = func(depth int) (any, error) {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		if delimiter, ok := token.(json.Delim); ok {
			if depth+1 >= maxDepth {
				return nil, fmt.Errorf("PHP JSON depth exceeded")
			}
			if delimiter == '{' {
				var keys []string
				fields := unified.Object{}
				for decoder.More() {
					keyToken, err := decoder.Token()
					if err != nil {
						return nil, err
					}
					key, ok := keyToken.(string)
					if !ok {
						return nil, fmt.Errorf("invalid object key")
					}
					value, err := read(depth + 1)
					if err != nil {
						return nil, err
					}
					if _, seen := fields[key]; !seen {
						keys = append(keys, key)
					}
					fields[key] = value
				}
				end, err := decoder.Token()
				if err != nil || end != json.Delim('}') {
					return nil, fmt.Errorf("unterminated object")
				}
				return newObject(keys, fields), nil
			}
			if delimiter == '[' {
				out := unified.Array{}
				for decoder.More() {
					value, err := read(depth + 1)
					if err != nil {
						return nil, err
					}
					out = append(out, value)
				}
				end, err := decoder.Token()
				if err != nil || end != json.Delim(']') {
					return nil, fmt.Errorf("unterminated list")
				}
				return out, nil
			}
			return nil, fmt.Errorf("unexpected delimiter")
		}
		if number, ok := token.(json.Number); ok {
			if !strings.ContainsAny(number.String(), ".eE") {
				if integer, err := number.Int64(); err == nil {
					return integer, nil
				}
				if bigintStrings {
					return number.String(), nil
				}
			}
			return number.Float64()
		}
		return token, nil
	}
	value, err := read(0)
	if err != nil {
		return nil, err
	}
	if _, err = decoder.Token(); err != io.EOF {
		return nil, fmt.Errorf("trailing JSON")
	}
	return value, nil
}

// EncodeJSON encodes ordered PHP values (scalars, slices, unified.PHPObject,
// and Associative/*Object) using PHP's json_encode escaping and number rules.
// Unordered Go maps are rejected so serialized byte order stays deterministic.
func EncodeJSON(value any, unescapedSlashes bool) ([]byte, error) {
	prepared, ok := prepareOrderedJSON(value)
	if !ok {
		return nil, fmt.Errorf("PHP identity object requires explicit field order")
	}
	return unified.PHPJSON(prepared, unescapedSlashes)
}

func prepareOrderedJSON(value any) (any, bool) {
	if keys, fields, isAssoc, valid := inspectAssociative(value); isAssoc {
		if !valid {
			return nil, true
		}
		out := make(unified.PHPObject, 0, len(keys))
		for _, key := range keys {
			child, ok := prepareOrderedJSON(fields[key])
			if !ok {
				return nil, false
			}
			out = append(out, unified.PHPField{Key: key, Value: child})
		}
		return out, true
	}
	if po, ok := value.(unified.PHPObject); ok {
		out := make(unified.PHPObject, 0, len(po))
		for _, entry := range po {
			child, ok := prepareOrderedJSON(entry.Value)
			if !ok {
				return nil, false
			}
			out = append(out, unified.PHPField{Key: entry.Key, Value: child})
		}
		return out, true
	}
	if unified.Map(value) != nil {
		return nil, false
	}
	if list := unified.Slice(value); list != nil {
		out := make(unified.Array, 0, len(list))
		for _, item := range list {
			child, ok := prepareOrderedJSON(item)
			if !ok {
				return nil, false
			}
			out = append(out, child)
		}
		return out, true
	}
	return value, true
}

// ObjectValue returns value as *Object when value is a non-nil *Object.
func ObjectValue(value any) *Object {
	obj, ok := value.(*Object)
	if !ok || obj == nil {
		return nil
	}
	return obj
}

// Field looks up key on an ordered Associative/*Object, unified.Object, or
// canonical decimal index on a slice.
func Field(value any, key string) any {
	if _, fields, isAssoc, valid := inspectAssociative(value); isAssoc {
		if !valid {
			return nil
		}
		return fields[key]
	}
	if object := unified.Map(value); object != nil {
		return object[key]
	}
	if list := unified.Slice(value); list != nil {
		i, err := strconv.Atoi(key)
		if err == nil && i >= 0 && i < len(list) && strconv.Itoa(i) == key {
			return list[i]
		}
	}
	return nil
}

// IsArray reports whether value behaves as a PHP array (ordered Associative,
// map, or slice).
func IsArray(value any) bool {
	if _, _, isAssoc, valid := inspectAssociative(value); isAssoc {
		return valid
	}
	return unified.Map(value) != nil || unified.Slice(value) != nil
}

// Values returns the ordered values of an Associative/*Object or slice, or an
// empty slice for non-array values.
func Values(value any) unified.Array {
	if keys, fields, isAssoc, valid := inspectAssociative(value); isAssoc {
		if !valid {
			return unified.Array{}
		}
		out := make(unified.Array, 0, len(keys))
		for _, key := range keys {
			out = append(out, fields[key])
		}
		return out
	}
	if list := unified.Slice(value); list != nil {
		return list
	}
	return unified.Array{}
}

// Plain recursively converts ordered Associative values into unified.Array
// (when keys are 0..n-1, including empty) or unified.Object.
func Plain(value any) any {
	if keys, fields, isAssoc, valid := inspectAssociative(value); isAssoc {
		if !valid {
			return nil
		}
		list := true
		for index, key := range keys {
			if strconv.Itoa(index) != key {
				list = false
				break
			}
		}
		if list {
			out := unified.Array{}
			for _, key := range keys {
				out = append(out, Plain(fields[key]))
			}
			return out
		}
		out := unified.Object{}
		for _, key := range keys {
			out[key] = Plain(fields[key])
		}
		return out
	}
	if list := unified.Slice(value); list != nil {
		out := make(unified.Array, 0, len(list))
		for _, child := range list {
			out = append(out, Plain(child))
		}
		return out
	}
	return value
}

// First returns the first non-nil argument, or nil if all arguments are nil.
func First(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

// Int64 converts value using PHP integer coercion rules via unified.PHPInt.
func Int64(value any) (int64, bool) {
	return unified.PHPInt(value)
}

// String returns value when it is a Go string.
func String(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok
}

// Truthy evaluates PHP boolean truthiness on decoded JSON and unified values.
func Truthy(value any) bool {
	if keys, _, isAssoc, valid := inspectAssociative(value); isAssoc {
		return valid && len(keys) != 0
	}
	switch value := value.(type) {
	case nil:
		return false
	case bool:
		return value
	case string:
		return value != "" && value != "0"
	case int64:
		return value != 0
	case int:
		return value != 0
	case float64:
		return value != 0
	}
	if m := unified.Map(value); m != nil {
		return len(m) != 0
	}
	if list := unified.Slice(value); list != nil {
		return len(list) != 0
	}
	return true
}

// ScalarString formats a value using PHP string coercion rules ("Array" for
// arrays/objects).
func ScalarString(value any) string {
	if _, _, isAssoc, valid := inspectAssociative(value); isAssoc && !valid {
		return ""
	}
	switch value := value.(type) {
	case string:
		return value
	case int64:
		return strconv.FormatInt(value, 10)
	case int:
		return strconv.Itoa(value)
	case float64:
		return strconv.FormatFloat(value, 'G', 14, 64)
	case bool:
		if value {
			return "1"
		}
		return ""
	case nil:
		return ""
	}
	return "Array"
}

// PercentDecode decodes %XX hex escapes byte-for-byte without touching '+'.
func PercentDecode(raw string) string {
	var out strings.Builder
	for i := 0; i < len(raw); i++ {
		if raw[i] == '%' && i+2 < len(raw) {
			if value, err := strconv.ParseUint(raw[i+1:i+3], 16, 8); err == nil {
				out.WriteByte(byte(value))
				i += 2
				continue
			}
		}
		out.WriteByte(raw[i])
	}
	return out.String()
}

// QueryValue follows PHP parse_str scalar/array key normalization and single
// percent-decoding without decoding twice.
func QueryValue(query, wanted string) (value string, present, scalar bool) {
	query, _, _ = strings.Cut(query, "\x00")
	for _, pair := range strings.Split(query, "&") {
		key, raw, _ := strings.Cut(pair, "=")
		key = PercentDecode(strings.ReplaceAll(key, "+", " "))
		key, _, _ = strings.Cut(key, "\x00")
		key = strings.TrimLeft(key, " ")
		array := false
		if bracket := strings.IndexByte(key, '['); bracket >= 0 {
			if strings.Contains(key[bracket+1:], "]") {
				key, array = key[:bracket], true
			} else {
				key = strings.ReplaceAll(key, "[", "_")
			}
		}
		key = strings.NewReplacer(" ", "_", ".", "_").Replace(key)
		if key == wanted {
			value, present, scalar = PercentDecode(strings.ReplaceAll(raw, "+", " ")), true, !array
		}
	}
	return
}

// ValidJSONSurrogates verifies that every \uXXXX escape inside JSON string
// literals is either a non-surrogate BMP code unit or a valid UTF-16 surrogate
// pair (\uD800..\uDBFF followed immediately by \uDC00..\uDFFF).
func ValidJSONSurrogates(raw []byte) bool {
	inString := false
	for i := 0; i < len(raw); i++ {
		if raw[i] == '"' {
			inString = !inString
			continue
		}
		if !inString || raw[i] != '\\' {
			continue
		}
		i++
		if i >= len(raw) {
			return false
		}
		if raw[i] != 'u' {
			continue
		}
		if i+4 >= len(raw) {
			return false
		}
		unit, err := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if unit >= 0xdc00 && unit <= 0xdfff {
			return false
		}
		if unit >= 0xd800 && unit <= 0xdbff {
			if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}
