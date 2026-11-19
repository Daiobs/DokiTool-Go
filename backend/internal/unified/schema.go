package unified

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math/big"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

// The generated resource is an exact copy of the canonical repository schema.
// A test detects drift; neither Go code nor a second hand-maintained schema is
// allowed to redefine the public contract.
//
//go:generate go run generate_schema.go
//go:embed unified-v1.generated.schema.json
var embeddedSchema []byte

var (
	embeddedSchemaOnce  sync.Once
	schemaDocument      Object
	embeddedRoot        *compiledSchemaNode
	embeddedDefs        map[string]*compiledSchemaNode
	embeddedNodesByPtr  map[uintptr]*compiledSchemaNode
	precompiledPatterns map[string]*regexp.Regexp
	dynamicPatternCache sync.Map // map[string]*regexp.Regexp

	runtimeKeywordAudits atomic.Int64
	regexpCompileCount   atomic.Int64
)

func init() {
	ensureEmbeddedSchema()
}

func ensureEmbeddedSchema() {
	embeddedSchemaOnce.Do(func() {
		schema, err := Decode(embeddedSchema)
		if err != nil {
			panic("invalid embedded unified-v1 schema: " + err.Error())
		}
		patterns, err := precompileEmbeddedPatterns(schema)
		if err != nil {
			panic("invalid embedded unified-v1 schema pattern: " + err.Error())
		}
		precompiledPatterns = patterns
		if err := ValidateSchemaDefinition(schema); err != nil {
			panic("unsupported embedded unified-v1 schema: " + err.Error())
		}
		defs, root, byPtr := buildEmbeddedCompiledSchema(schema)
		schemaDocument = schema
		embeddedDefs = defs
		embeddedRoot = root
		embeddedNodesByPtr = byPtr
	})
}

func precompileEmbeddedPatterns(root Object) (map[string]*regexp.Regexp, error) {
	patterns := make(map[string]*regexp.Regexp)
	var walk func(Object) error
	walk = func(node Object) error {
		if node == nil {
			return nil
		}
		if pattern, ok := node["pattern"].(string); ok && pattern != "" {
			if _, exists := patterns[pattern]; !exists {
				regexpCompileCount.Add(1)
				re, err := regexp.Compile(pattern)
				if err != nil {
					return err
				}
				patterns[pattern] = re
			}
		}
		for _, key := range []string{"$defs", "properties"} {
			if children := Map(node[key]); children != nil {
				for _, child := range children {
					if err := walk(Map(child)); err != nil {
						return err
					}
				}
			}
		}
		for _, key := range []string{"items", "propertyNames", "additionalProperties"} {
			if child := Map(node[key]); child != nil {
				if err := walk(child); err != nil {
					return err
				}
			}
		}
		for _, key := range []string{"anyOf", "oneOf"} {
			for _, child := range Slice(node[key]) {
				if err := walk(Map(child)); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk(root); err != nil {
		return nil, err
	}
	return patterns, nil
}

func compilePattern(pattern string) (*regexp.Regexp, error) {
	if precompiledPatterns != nil {
		if re, ok := precompiledPatterns[pattern]; ok {
			return re, nil
		}
	}
	if cached, ok := dynamicPatternCache.Load(pattern); ok {
		return cached.(*regexp.Regexp), nil
	}
	regexpCompileCount.Add(1)
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, err
	}
	actual, _ := dynamicPatternCache.LoadOrStore(pattern, re)
	return actual.(*regexp.Regexp), nil
}

type compiledNumericBound struct {
	rat      *big.Rat
	hasInt64 bool
	int64Val int64
}

func makeNumericBound(raw any) (compiledNumericBound, bool) {
	limit, present := schemaNumber(raw)
	if !present {
		return compiledNumericBound{}, false
	}
	b := compiledNumericBound{rat: limit}
	if limit.IsInt() && limit.Num().IsInt64() {
		b.hasInt64 = true
		b.int64Val = limit.Num().Int64()
	}
	return b, true
}

type compiledSchemaNode struct {
	refRaw         string
	refUnsupported bool
	refTarget      *compiledSchemaNode

	hasOneOf bool
	hasAnyOf bool
	branches []*compiledSchemaNode

	hasConst bool
	constVal any

	hasEnum  bool
	enumVals Array

	typeName string

	hasMinProperties   bool
	minProperties      float64
	required           []string
	properties         map[string]*compiledSchemaNode
	propertyNames      *compiledSchemaNode
	disallowAdditional bool
	additionalSchema   *compiledSchemaNode

	hasMinItems bool
	minItems    float64
	hasMaxItems bool
	maxItems    float64
	uniqueItems bool
	items       *compiledSchemaNode

	hasMinLength bool
	minLength    float64
	hasMaxLength bool
	maxLength    float64
	hasPattern   bool
	patternRe    *regexp.Regexp
	patternErr   error
	format       string

	hasNumericBounds    bool
	hasMinimum          bool
	minimum             compiledNumericBound
	hasExclusiveMinimum bool
	exclusiveMinimum    compiledNumericBound
	hasMaximum          bool
	maximum             compiledNumericBound
}

func buildEmbeddedCompiledSchema(schema Object) (map[string]*compiledSchemaNode, *compiledSchemaNode, map[uintptr]*compiledSchemaNode) {
	byPtr := make(map[uintptr]*compiledSchemaNode)
	defsMap := Map(schema["$defs"])
	defs := make(map[string]*compiledSchemaNode, len(defsMap))
	for name, rawDef := range defsMap {
		if defObj := Map(rawDef); defObj != nil {
			compiled := &compiledSchemaNode{}
			defs[name] = compiled
			if ptr := reflect.ValueOf(defObj).Pointer(); ptr != 0 {
				byPtr[ptr] = compiled
			}
		}
	}
	var compileNode func(Object) *compiledSchemaNode
	compileNode = func(raw Object) *compiledSchemaNode {
		if raw == nil {
			return &compiledSchemaNode{}
		}
		ptr := reflect.ValueOf(raw).Pointer()
		if ptr != 0 {
			if existing, ok := byPtr[ptr]; ok {
				return existing
			}
		}
		compiled := &compiledSchemaNode{}
		if ptr != 0 {
			byPtr[ptr] = compiled
		}
		populateCompiledSchemaNode(compiled, raw, defs, compileNode)
		return compiled
	}
	for name, rawDef := range defsMap {
		if defObj := Map(rawDef); defObj != nil {
			populateCompiledSchemaNode(defs[name], defObj, defs, compileNode)
		}
	}
	root := compileNode(schema)
	return defs, root, byPtr
}

func populateCompiledSchemaNode(dst *compiledSchemaNode, raw Object, defs map[string]*compiledSchemaNode, compileChild func(Object) *compiledSchemaNode) {
	if reference := Str(raw["$ref"]); reference != "" {
		dst.refRaw = reference
		const prefix = "#/$defs/"
		if !strings.HasPrefix(reference, prefix) {
			dst.refUnsupported = true
		} else {
			dst.refTarget = defs[strings.TrimPrefix(reference, prefix)]
		}
		return
	}
	if oneOf := Slice(raw["oneOf"]); oneOf != nil {
		dst.hasOneOf = true
		dst.branches = make([]*compiledSchemaNode, len(oneOf))
		for i, alt := range oneOf {
			dst.branches[i] = compileChild(Map(alt))
		}
		return
	}
	if anyOf := Slice(raw["anyOf"]); anyOf != nil {
		dst.hasAnyOf = true
		dst.branches = make([]*compiledSchemaNode, len(anyOf))
		for i, alt := range anyOf {
			dst.branches[i] = compileChild(Map(alt))
		}
		return
	}
	if wanted, exists := raw["const"]; exists {
		dst.hasConst = true
		dst.constVal = wanted
	}
	if enumeration := Slice(raw["enum"]); enumeration != nil {
		dst.hasEnum = true
		dst.enumVals = enumeration
	}
	dst.typeName = Str(raw["type"])
	if dst.typeName == "object" {
		if minimum, ok := Numeric(raw["minProperties"]); ok {
			dst.hasMinProperties = true
			dst.minProperties = minimum
		}
		if reqSlice := Slice(raw["required"]); len(reqSlice) > 0 {
			dst.required = make([]string, len(reqSlice))
			for i, r := range reqSlice {
				dst.required[i] = Str(r)
			}
		}
		if props := Map(raw["properties"]); len(props) > 0 {
			dst.properties = make(map[string]*compiledSchemaNode, len(props))
			for k, v := range props {
				if childMap := Map(v); childMap != nil {
					dst.properties[k] = compileChild(childMap)
				}
			}
		}
		if names := Map(raw["propertyNames"]); names != nil {
			dst.propertyNames = compileChild(names)
		}
		if raw["additionalProperties"] == false {
			dst.disallowAdditional = true
		} else if addMap := Map(raw["additionalProperties"]); addMap != nil {
			dst.additionalSchema = compileChild(addMap)
		}
	}
	if dst.typeName == "array" {
		if minimum, ok := Numeric(raw["minItems"]); ok {
			dst.hasMinItems = true
			dst.minItems = minimum
		}
		if maximum, ok := Numeric(raw["maxItems"]); ok {
			dst.hasMaxItems = true
			dst.maxItems = maximum
		}
		dst.uniqueItems = raw["uniqueItems"] == true
		if itemMap := Map(raw["items"]); itemMap != nil {
			dst.items = compileChild(itemMap)
		}
	}
	if dst.typeName == "string" {
		if minimum, ok := Numeric(raw["minLength"]); ok {
			dst.hasMinLength = true
			dst.minLength = minimum
		}
		if maximum, ok := Numeric(raw["maxLength"]); ok {
			dst.hasMaxLength = true
			dst.maxLength = maximum
		}
		if pattern := Str(raw["pattern"]); pattern != "" {
			dst.hasPattern = true
			dst.patternRe, dst.patternErr = compilePattern(pattern)
		}
		dst.format = Str(raw["format"])
	}
	if b, ok := makeNumericBound(raw["minimum"]); ok {
		dst.hasMinimum = true
		dst.minimum = b
		dst.hasNumericBounds = true
	}
	if b, ok := makeNumericBound(raw["exclusiveMinimum"]); ok {
		dst.hasExclusiveMinimum = true
		dst.exclusiveMinimum = b
		dst.hasNumericBounds = true
	}
	if b, ok := makeNumericBound(raw["maximum"]); ok {
		dst.hasMaximum = true
		dst.maximum = b
		dst.hasNumericBounds = true
	}
}

func lookupEmbeddedCompiledNode(node Object) *compiledSchemaNode {
	if node == nil {
		return nil
	}
	ptr := reflect.ValueOf(node).Pointer()
	if ptr == 0 {
		return nil
	}
	return embeddedNodesByPtr[ptr]
}

// compileCustomSchema audits keywords once across a synthetic/non-embedded
// schema tree and compiles its nodes using the shared regex cache.
func compileCustomSchema(root Object, rootPath string) (*compiledSchemaNode, error) {
	visited := make(map[uintptr]bool)
	var auditTree func(Object, string) error
	auditTree = func(node Object, path string) error {
		if node == nil {
			return nil
		}
		if ptr := reflect.ValueOf(node).Pointer(); ptr != 0 {
			if visited[ptr] {
				return nil
			}
			visited[ptr] = true
		}
		if err := auditSchemaKeywords(node, path); err != nil {
			return err
		}
		for _, key := range []string{"$defs", "properties"} {
			if children := Map(node[key]); children != nil {
				for _, name := range sortedObjectKeys(children) {
					if child := Map(children[name]); child != nil {
						if err := auditTree(child, path+"."+key+"."+name); err != nil {
							return err
						}
					}
				}
			}
		}
		for _, key := range []string{"items", "propertyNames"} {
			if child := Map(node[key]); child != nil {
				if err := auditTree(child, path+"."+key); err != nil {
					return err
				}
			}
		}
		if value, exists := node["additionalProperties"]; exists {
			if _, boolean := value.(bool); !boolean {
				if child := Map(value); child != nil {
					if err := auditTree(child, path+".additionalProperties"); err != nil {
						return err
					}
				}
			}
		}
		for _, key := range []string{"anyOf", "oneOf"} {
			for index, rawChild := range Slice(node[key]) {
				if child := Map(rawChild); child != nil {
					if err := auditTree(child, fmt.Sprintf("%s.%s[%d]", path, key, index)); err != nil {
						return err
					}
				}
			}
		}
		return nil
	}
	if err := auditTree(root, rootPath); err != nil {
		return nil, err
	}

	defs := make(map[string]*compiledSchemaNode, len(embeddedDefs))
	for k, v := range embeddedDefs {
		defs[k] = v
	}
	memo := make(map[uintptr]*compiledSchemaNode)
	customDefs := Map(root["$defs"])
	for name, rawDef := range customDefs {
		if defObj := Map(rawDef); defObj != nil {
			compiled := &compiledSchemaNode{}
			defs[name] = compiled
			if ptr := reflect.ValueOf(defObj).Pointer(); ptr != 0 {
				memo[ptr] = compiled
			}
		}
	}
	var compileNode func(Object) *compiledSchemaNode
	compileNode = func(raw Object) *compiledSchemaNode {
		if raw == nil {
			return &compiledSchemaNode{}
		}
		ptr := reflect.ValueOf(raw).Pointer()
		if ptr != 0 {
			if existing, ok := memo[ptr]; ok {
				return existing
			}
		}
		compiled := &compiledSchemaNode{}
		if ptr != 0 {
			memo[ptr] = compiled
		}
		populateCompiledSchemaNode(compiled, raw, defs, compileNode)
		return compiled
	}
	for name, rawDef := range customDefs {
		if defObj := Map(rawDef); defObj != nil {
			populateCompiledSchemaNode(defs[name], defObj, defs, compileNode)
		}
	}
	return compileNode(root), nil
}

func SchemaBytes() []byte { return append([]byte(nil), embeddedSchema...) }

// ValidateStructure implements the keywords used by the canonical schema.
// Independent Draft 2020-12 validation remains an external acceptance check.
func ValidateStructure(value any) error {
	ensureEmbeddedSchema()
	if compiledNodeMatches(value, embeddedRoot) {
		return nil
	}
	return validateCompiledSchemaNode(value, embeddedRoot, "$")
}

func sortedObjectKeys(object Object) []string {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func schemaNumber(value any) (*big.Rat, bool) {
	text, ok := numberText(value)
	if !ok {
		return nil, false
	}
	if _, finite := Numeric(value); !finite {
		return nil, false
	}
	number, ok := new(big.Rat).SetString(text)
	return number, ok
}

func schemaInteger(value any) bool {
	switch v := value.(type) {
	case int, int64, int32, uint, uint64:
		return true
	case float32, float64:
		return false
	case json.Number:
		// Preserve the PHP runtime's integer wire values. Numeric strings and
		// floating point observations are not integer metadata, even when integral.
		return integerSpelling.MatchString(v.String())
	default:
		return false
	}
}

var integerSpelling = regexp.MustCompile(`^-?(?:0|[1-9][0-9]*)$`)
var timestampSpelling = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$`)

func parseContractTime(raw string) (time.Time, bool) {
	if !timestampSpelling.MatchString(raw) || strings.HasPrefix(raw, "0000-") {
		return time.Time{}, false
	}
	if !strings.HasSuffix(raw, "Z") {
		offset := raw[len(raw)-6:]
		hours, _ := strconv.Atoi(offset[1:3])
		minutes, _ := strconv.Atoi(offset[4:6])
		if hours > 23 || minutes > 59 {
			return time.Time{}, false
		}
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	return t, err == nil
}

func fastInt64Value(value any) (int64, bool) {
	switch v := value.(type) {
	case int:
		return int64(v), true
	case int64:
		return v, true
	case int32:
		return int64(v), true
	case json.Number:
		s := v.String()
		if !integerSpelling.MatchString(s) {
			return 0, false
		}
		n, err := strconv.ParseInt(s, 10, 64)
		return n, err == nil
	default:
		return 0, false
	}
}

func checkNumericBounds(value any, node *compiledSchemaNode) string {
	if iv, ok := fastInt64Value(value); ok &&
		(!node.hasMinimum || node.minimum.hasInt64) &&
		(!node.hasExclusiveMinimum || node.exclusiveMinimum.hasInt64) &&
		(!node.hasMaximum || node.maximum.hasInt64) {
		if node.hasMinimum && iv < node.minimum.int64Val {
			return "outside minimum"
		}
		if node.hasExclusiveMinimum && iv <= node.exclusiveMinimum.int64Val {
			return "outside exclusiveMinimum"
		}
		if node.hasMaximum && iv > node.maximum.int64Val {
			return "outside maximum"
		}
		return ""
	}
	if number, ok := schemaNumber(value); ok {
		if node.hasMinimum && number.Cmp(node.minimum.rat) < 0 {
			return "outside minimum"
		}
		if node.hasExclusiveMinimum && number.Cmp(node.exclusiveMinimum.rat) <= 0 {
			return "outside exclusiveMinimum"
		}
		if node.hasMaximum && number.Cmp(node.maximum.rat) > 0 {
			return "outside maximum"
		}
	}
	return ""
}

// compiledNodeMatches performs allocation-free boolean schema validation for
// valid envelopes and oneOf/anyOf branch probing. When it returns false at the
// entry point, validateCompiledSchemaNode produces the exact deterministic path error.
func compiledNodeMatches(value any, node *compiledSchemaNode) bool {
	if node == nil {
		return true
	}
	if node.refRaw != "" {
		if node.refUnsupported || node.refTarget == nil {
			return false
		}
		return compiledNodeMatches(value, node.refTarget)
	}
	if node.hasOneOf || node.hasAnyOf {
		matches := 0
		for _, alt := range node.branches {
			if compiledNodeMatches(value, alt) {
				matches++
			}
		}
		if node.hasOneOf {
			return matches == 1
		}
		return matches > 0
	}
	if node.hasConst && !Equal(value, node.constVal) {
		return false
	}
	if node.hasEnum {
		found := false
		for _, allowed := range node.enumVals {
			if Equal(value, allowed) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	switch node.typeName {
	case "object":
		object := Map(value)
		if object == nil {
			return false
		}
		if node.hasMinProperties && float64(len(object)) < node.minProperties {
			return false
		}
		for _, req := range node.required {
			if _, exists := object[req]; !exists {
				return false
			}
		}
		for key, childVal := range object {
			if node.propertyNames != nil && !compiledNodeMatches(key, node.propertyNames) {
				return false
			}
			if childSchema := node.properties[key]; childSchema != nil {
				if !compiledNodeMatches(childVal, childSchema) {
					return false
				}
			} else if node.disallowAdditional {
				return false
			} else if node.additionalSchema != nil {
				if !compiledNodeMatches(childVal, node.additionalSchema) {
					return false
				}
			}
		}
	case "array":
		values := Slice(value)
		if values == nil {
			return false
		}
		if node.hasMinItems && float64(len(values)) < node.minItems {
			return false
		}
		if node.hasMaxItems && float64(len(values)) > node.maxItems {
			return false
		}
		for index, child := range values {
			if node.uniqueItems {
				for _, prior := range values[:index] {
					if Equal(prior, child) {
						return false
					}
				}
			}
			if node.items != nil && !compiledNodeMatches(child, node.items) {
				return false
			}
		}
	case "string":
		text, ok := value.(string)
		if !ok || !utf8.ValidString(text) {
			return false
		}
		if node.hasMinLength || node.hasMaxLength {
			length := float64(utf8.RuneCountInString(text))
			if node.hasMinLength && length < node.minLength {
				return false
			}
			if node.hasMaxLength && length > node.maxLength {
				return false
			}
		}
		if node.hasPattern {
			if node.patternErr != nil || !node.patternRe.MatchString(text) {
				return false
			}
		}
		switch node.format {
		case "date-time":
			if _, ok := parseContractTime(text); !ok {
				return false
			}
		case "uri":
			if MediaURL(text) != text {
				return false
			}
		}
	case "integer":
		if !schemaInteger(value) {
			return false
		}
	case "number":
		if _, ok := schemaNumber(value); !ok {
			return false
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return false
		}
	case "null":
		if value != nil {
			return false
		}
	case "":
	default:
		return false
	}
	if node.hasNumericBounds {
		if msg := checkNumericBounds(value, node); msg != "" {
			return false
		}
	}
	return true
}

func validateCompiledSchemaNode(value any, node *compiledSchemaNode, path string) error {
	if node == nil {
		return nil
	}
	fail := func(message string) error { return fmt.Errorf("%s: %s", path, message) }
	if node.refRaw != "" {
		if node.refUnsupported {
			return fail("unsupported schema reference")
		}
		if node.refTarget == nil {
			return fail("unknown schema reference")
		}
		return validateCompiledSchemaNode(value, node.refTarget, path)
	}
	if node.hasOneOf || node.hasAnyOf {
		matches := 0
		for _, alternative := range node.branches {
			if compiledNodeMatches(value, alternative) {
				matches++
			}
		}
		if (node.hasOneOf && matches != 1) || (!node.hasOneOf && matches == 0) {
			return fail("invalid schema branch")
		}
		return nil
	}
	if node.hasConst && !Equal(value, node.constVal) {
		return fail("invalid constant")
	}
	if node.hasEnum {
		found := false
		for _, allowed := range node.enumVals {
			if Equal(value, allowed) {
				found = true
				break
			}
		}
		if !found {
			return fail("invalid enum")
		}
	}
	valid := true
	switch node.typeName {
	case "object":
		valid = Map(value) != nil
	case "array":
		valid = Slice(value) != nil
	case "string":
		_, valid = value.(string)
	case "integer":
		valid = schemaInteger(value)
	case "number":
		_, valid = schemaNumber(value)
	case "boolean":
		_, valid = value.(bool)
	case "null":
		valid = value == nil
	case "":
	default:
		valid = false
	}
	if !valid {
		return fail("invalid type")
	}
	if node.typeName == "object" {
		object := Map(value)
		if node.hasMinProperties && float64(len(object)) < node.minProperties {
			return fail("too few properties")
		}
		for _, required := range node.required {
			if _, exists := object[required]; !exists {
				return fail("missing " + required)
			}
		}
		for _, key := range sortedObjectKeys(object) {
			if node.propertyNames != nil {
				if !compiledNodeMatches(key, node.propertyNames) {
					return validateCompiledSchemaNode(key, node.propertyNames, path+".[property]")
				}
			}
			if child := node.properties[key]; child != nil {
				if !compiledNodeMatches(object[key], child) {
					return validateCompiledSchemaNode(object[key], child, path+"."+key)
				}
			} else if node.disallowAdditional {
				return fail("unknown " + key)
			} else if node.additionalSchema != nil {
				if !compiledNodeMatches(object[key], node.additionalSchema) {
					return validateCompiledSchemaNode(object[key], node.additionalSchema, path+"."+key)
				}
			}
		}
	}
	if node.typeName == "array" {
		values := Slice(value)
		if node.hasMinItems && float64(len(values)) < node.minItems {
			return fail("too few array items")
		}
		if node.hasMaxItems && float64(len(values)) > node.maxItems {
			return fail("too many array items")
		}
		for index, child := range values {
			if node.uniqueItems {
				for _, prior := range values[:index] {
					if Equal(prior, child) {
						return fail("duplicate array item")
					}
				}
			}
			if node.items != nil && !compiledNodeMatches(child, node.items) {
				return validateCompiledSchemaNode(child, node.items, fmt.Sprintf("%s[%d]", path, index))
			}
		}
	}
	if node.typeName == "string" {
		text := Str(value)
		if !utf8.ValidString(text) {
			return fail("invalid UTF-8")
		}
		if node.hasMinLength || node.hasMaxLength {
			length := float64(utf8.RuneCountInString(text))
			if node.hasMinLength && length < node.minLength {
				return fail("text too short")
			}
			if node.hasMaxLength && length > node.maxLength {
				return fail("text too long")
			}
		}
		if node.hasPattern {
			if node.patternErr != nil {
				return fail("unsupported schema pattern")
			}
			if !node.patternRe.MatchString(text) {
				return fail("invalid pattern")
			}
		}
		switch node.format {
		case "date-time":
			if _, ok := parseContractTime(text); !ok {
				return fail("invalid RFC3339 timestamp")
			}
		case "uri":
			// Use the same raw HTTP(S) boundary as PHP's FILTER_VALIDATE_URL.
			// net/url would both admit invalid DNS labels/raw Unicode and reject
			// some percent bytes that PHP preserves in transport URLs.
			if MediaURL(text) != text {
				return fail("invalid absolute URI")
			}
		}
	}
	if node.hasNumericBounds {
		if msg := checkNumericBounds(value, node); msg != "" {
			return fail(msg)
		}
	}
	return nil
}

func validateSchemaNode(value any, node Object, path string) error {
	ensureEmbeddedSchema()
	if node == nil {
		return nil
	}
	if compiled := lookupEmbeddedCompiledNode(node); compiled != nil {
		if compiledNodeMatches(value, compiled) {
			return nil
		}
		return validateCompiledSchemaNode(value, compiled, path)
	}
	compiled, err := compileCustomSchema(node, path)
	if err != nil {
		return err
	}
	if compiledNodeMatches(value, compiled) {
		return nil
	}
	return validateCompiledSchemaNode(value, compiled, path)
}

var schemaAnnotations = map[string]bool{
	"$schema": true, "$id": true, "$defs": true, "title": true,
	"description": true, "default": true, "discriminator": true,
}

var schemaAssertions = map[string]bool{
	"$ref": true, "type": true, "const": true, "enum": true, "anyOf": true, "oneOf": true,
	"properties": true, "additionalProperties": true, "propertyNames": true, "required": true, "minProperties": true,
	"items": true, "minItems": true, "maxItems": true, "uniqueItems": true,
	"minLength": true, "maxLength": true, "pattern": true, "format": true,
	"minimum": true, "maximum": true, "exclusiveMinimum": true,
}

func auditSchemaKeywords(node Object, path string) error {
	runtimeKeywordAudits.Add(1)
	fail := func(message string) error { return fmt.Errorf("%s: %s", path, message) }
	for key := range node {
		if !schemaAnnotations[key] && !schemaAssertions[key] {
			return fail("unsupported schema keyword " + key)
		}
	}
	if format, exists := node["format"]; exists && !hasString([]string{"uri", "date-time"}, Str(format)) {
		return fail("unsupported schema format")
	}
	if dialect, exists := node["$schema"]; exists && Str(dialect) != "https://json-schema.org/draft/2020-12/schema" {
		return fail("unsupported schema dialect")
	}
	if kind, exists := node["type"]; exists && !hasString([]string{"object", "array", "string", "integer", "number", "boolean", "null"}, Str(kind)) {
		return fail("unsupported schema type")
	}
	branch := ""
	for _, key := range []string{"$ref", "anyOf", "oneOf"} {
		if _, exists := node[key]; exists {
			if branch != "" {
				return fail("unsupported combined schema branches")
			}
			branch = key
		}
	}
	if branch != "" {
		for key := range node {
			if schemaAssertions[key] && key != branch {
				return fail("unsupported assertion beside " + branch)
			}
		}
	}
	for _, rule := range []struct {
		keys  []string
		types []string
	}{
		{[]string{"properties", "additionalProperties", "propertyNames", "required", "minProperties"}, []string{"object"}},
		{[]string{"items", "minItems", "maxItems", "uniqueItems"}, []string{"array"}},
		{[]string{"minLength", "maxLength", "pattern", "format"}, []string{"string"}},
		{[]string{"minimum", "maximum", "exclusiveMinimum"}, []string{"integer", "number"}},
	} {
		for _, key := range rule.keys {
			if _, exists := node[key]; exists && !hasString(rule.types, Str(node["type"])) {
				return fail("unsupported implicit type for " + key)
			}
		}
	}
	return nil
}

// ValidateSchemaDefinition is a fail-closed vocabulary and shape gate. A future
// canonical assertion cannot silently become an ignored annotation in Go.
// Unsupported combinations require implementing their semantics first.
func ValidateSchemaDefinition(document Object) error {
	var audit func(Object, string) error
	audit = func(node Object, path string) error {
		if node == nil {
			return fmt.Errorf("%s: schema object required", path)
		}
		if err := auditSchemaKeywords(node, path); err != nil {
			return err
		}
		if reference, exists := node["$ref"]; exists {
			text := Str(reference)
			if !strings.HasPrefix(text, "#/$defs/") || Map(Map(document["$defs"])[strings.TrimPrefix(text, "#/$defs/")]) == nil {
				return fmt.Errorf("%s: unknown local schema reference", path)
			}
		}
		for _, key := range []string{"$defs", "properties"} {
			if value, exists := node[key]; exists {
				children := Map(value)
				if children == nil {
					return fmt.Errorf("%s.%s: object required", path, key)
				}
				for name, child := range children {
					if err := audit(Map(child), path+"."+key+"."+name); err != nil {
						return err
					}
				}
			}
		}
		for _, key := range []string{"items", "propertyNames"} {
			if value, exists := node[key]; exists {
				if err := audit(Map(value), path+"."+key); err != nil {
					return err
				}
			}
		}
		if value, exists := node["additionalProperties"]; exists {
			if _, boolean := value.(bool); !boolean {
				if err := audit(Map(value), path+".additionalProperties"); err != nil {
					return err
				}
			}
		}
		for _, key := range []string{"anyOf", "oneOf"} {
			if value, exists := node[key]; exists {
				children := Slice(value)
				if len(children) == 0 {
					return fmt.Errorf("%s.%s: nonempty schema array required", path, key)
				}
				for index, child := range children {
					if err := audit(Map(child), fmt.Sprintf("%s.%s[%d]", path, key, index)); err != nil {
						return err
					}
				}
			}
		}
		if value, exists := node["required"]; exists {
			values := Slice(value)
			if values == nil {
				return fmt.Errorf("%s.required: array required", path)
			}
			for _, name := range values {
				if _, ok := name.(string); !ok {
					return fmt.Errorf("%s.required: property name required", path)
				}
			}
		}
		if value, exists := node["enum"]; exists && len(Slice(value)) == 0 {
			return fmt.Errorf("%s.enum: nonempty array required", path)
		}
		if value, exists := node["uniqueItems"]; exists {
			if _, ok := value.(bool); !ok {
				return fmt.Errorf("%s.uniqueItems: boolean required", path)
			}
		}
		for _, key := range []string{"minProperties", "minItems", "maxItems", "minLength", "maxLength"} {
			if value, exists := node[key]; exists {
				n, ok := Numeric(value)
				if !schemaInteger(value) || !ok || n < 0 {
					return fmt.Errorf("%s.%s: nonnegative integer required", path, key)
				}
			}
		}
		for _, key := range []string{"minimum", "maximum", "exclusiveMinimum"} {
			if value, exists := node[key]; exists {
				if _, ok := schemaNumber(value); !ok {
					return fmt.Errorf("%s.%s: numeric bound required", path, key)
				}
			}
		}
		if value, exists := node["pattern"]; exists {
			pattern, ok := value.(string)
			if !ok {
				return fmt.Errorf("%s.pattern: string required", path)
			}
			if _, err := compilePattern(pattern); err != nil {
				return fmt.Errorf("%s.pattern: unsupported expression: %w", path, err)
			}
		}
		return nil
	}
	return audit(document, "$")
}
