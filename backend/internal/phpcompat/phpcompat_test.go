package phpcompat

import (
	"math"
	"reflect"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func TestDecodeOrderedDuplicateKeysAndEncodeJSON(t *testing.T) {
	raw := []byte(`{"z":1,"a":"first","m":{"x":10,"y":20,"x":30},"a":"last","c":"https://example.com/中"}`)
	decoded, err := Decode(raw, true, 64)
	if err != nil {
		t.Fatalf("Decode failed: %v", err)
	}

	root := ObjectValue(decoded)
	if root == nil {
		t.Fatalf("expected *Object, got %T", decoded)
	}
	wantKeys := []string{"z", "a", "m", "c"}
	if !reflect.DeepEqual(root.Keys, wantKeys) || root.Len() != 4 {
		t.Fatalf("Keys = %v (len=%d), want %v", root.Keys, root.Len(), wantKeys)
	}
	if got, ok := root.Get("a"); !ok || got != "last" {
		t.Fatalf("Get(a) = (%v, %v), want (\"last\", true)", got, ok)
	}
	if _, ok := root.Get("missing"); ok {
		t.Fatal("expected missing key lookup to return false")
	}

	nested := ObjectValue(Field(root, "m"))
	if nested == nil {
		t.Fatalf("expected nested *Object, got %T", Field(root, "m"))
	}
	if !reflect.DeepEqual(nested.Keys, []string{"x", "y"}) {
		t.Fatalf("nested.Keys = %v, want [x y]", nested.Keys)
	}
	if got := Field(nested, "x"); got != int64(30) {
		t.Fatalf("nested[x] = %v (%T), want int64(30)", got, got)
	}
	if got := Values(nested); !reflect.DeepEqual(got, unified.Array{int64(30), int64(20)}) {
		t.Fatalf("Values(nested) = %v, want [30 20]", got)
	}

	escaped, err := EncodeJSON(decoded, false)
	if err != nil {
		t.Fatalf("EncodeJSON(false) failed: %v", err)
	}
	wantEscaped := `{"z":1,"a":"last","m":{"x":30,"y":20},"c":"https:\/\/example.com\/\u4e2d"}`
	if string(escaped) != wantEscaped {
		t.Fatalf("EncodeJSON(false) = %s, want %s", escaped, wantEscaped)
	}

	unescaped, err := EncodeJSON(decoded, true)
	if err != nil {
		t.Fatalf("EncodeJSON(true) failed: %v", err)
	}
	wantUnescaped := `{"z":1,"a":"last","m":{"x":30,"y":20},"c":"https://example.com/\u4e2d"}`
	if string(unescaped) != wantUnescaped {
		t.Fatalf("EncodeJSON(true) = %s, want %s", unescaped, wantUnescaped)
	}

	if _, err := EncodeJSON(unified.Object{"unordered": 1}, true); err == nil {
		t.Fatal("expected EncodeJSON to reject unordered unified.Object")
	}
}

func TestDecodeBigintStrings(t *testing.T) {
	raw := []byte(`{"max_i64":9223372036854775807,"min_i64":-9223372036854775808,"over":9223372036854775808,"under":-9223372036854775809,"float":1.5,"exp":1e20}`)

	asString, err := Decode(raw, true, 16)
	if err != nil {
		t.Fatalf("Decode(bigintStrings=true) failed: %v", err)
	}
	if got := Field(asString, "max_i64"); got != int64(math.MaxInt64) {
		t.Fatalf("max_i64 = %v (%T), want int64(MaxInt64)", got, got)
	}
	if got := Field(asString, "min_i64"); got != int64(math.MinInt64) {
		t.Fatalf("min_i64 = %v (%T), want int64(MinInt64)", got, got)
	}
	if got := Field(asString, "over"); got != "9223372036854775808" {
		t.Fatalf("over (bigintStrings=true) = %v (%T), want string", got, got)
	}
	if got := Field(asString, "under"); got != "-9223372036854775809" {
		t.Fatalf("under (bigintStrings=true) = %v (%T), want string", got, got)
	}
	if got := Field(asString, "float"); got != float64(1.5) {
		t.Fatalf("float = %v (%T), want float64(1.5)", got, got)
	}
	if got := Field(asString, "exp"); got != float64(1e20) {
		t.Fatalf("exp = %v (%T), want float64(1e20)", got, got)
	}

	asFloat, err := Decode(raw, false, 16)
	if err != nil {
		t.Fatalf("Decode(bigintStrings=false) failed: %v", err)
	}
	if _, ok := Field(asFloat, "over").(float64); !ok {
		t.Fatalf("over (bigintStrings=false) = %T, want float64", Field(asFloat, "over"))
	}
	if _, ok := Field(asFloat, "under").(float64); !ok {
		t.Fatalf("under (bigintStrings=false) = %T, want float64", Field(asFloat, "under"))
	}
}

func TestDecodeDepthLimitsAndTrailingJSON(t *testing.T) {
	if got, err := Decode([]byte(`"scalar"`), false, 1); err != nil || got != "scalar" {
		t.Fatalf("scalar at maxDepth=1 = (%v, %v), want (\"scalar\", nil)", got, err)
	}
	for _, raw := range []string{`{}`, `[]`} {
		if _, err := Decode([]byte(raw), false, 1); err == nil || err.Error() != "PHP JSON depth exceeded" {
			t.Fatalf("Decode(%s, maxDepth=1) err = %v, want PHP JSON depth exceeded", raw, err)
		}
	}
	for _, raw := range []string{`{"a":1}`, `[1,2]`} {
		if _, err := Decode([]byte(raw), false, 2); err != nil {
			t.Fatalf("Decode(%s, maxDepth=2) unexpected err: %v", raw, err)
		}
	}
	for _, raw := range []string{`{"a":{"b":1}}`, `[[1]]`, `{"a":[1]}`} {
		if _, err := Decode([]byte(raw), false, 2); err == nil || err.Error() != "PHP JSON depth exceeded" {
			t.Fatalf("Decode(%s, maxDepth=2) err = %v, want PHP JSON depth exceeded", raw, err)
		}
	}
	if _, err := Decode([]byte(`{"a":1} {"b":2}`), false, 16); err == nil || err.Error() != "trailing JSON" {
		t.Fatalf("trailing JSON err = %v, want trailing JSON", err)
	}
}

func TestDecodeUnicodeAndSurrogates(t *testing.T) {
	invalidCases := [][]byte{
		{'"', 0xff, '"'},
		[]byte(`"\ud83d"`),
		[]byte(`"\ud83dplain"`),
		[]byte(`"\ud83d\u0041"`),
		[]byte(`"\ude00"`),
		[]byte(`"\u123"`),
		[]byte(`"\u123g"`),
	}
	for _, raw := range invalidCases {
		if _, err := Decode(raw, true, 16); err == nil || err.Error() != "invalid upstream Unicode" {
			t.Fatalf("Decode(%q) err = %v, want invalid upstream Unicode", raw, err)
		}
	}

	valid, err := Decode([]byte(`{"emoji":"\ud83d\ude00","escaped_quote":"\"\\ud83d\"","bmp":"\u4e2d\u6587"}`), true, 16)
	if err != nil {
		t.Fatalf("Decode valid surrogates failed: %v", err)
	}
	if got, ok := String(Field(valid, "emoji")); !ok || got != "😀" {
		t.Fatalf("emoji = (%q, %v), want (\"😀\", true)", got, ok)
	}
	if got, ok := String(Field(valid, "bmp")); !ok || got != "中文" {
		t.Fatalf("bmp = (%q, %v), want (\"中文\", true)", got, ok)
	}
}

func TestTruthy(t *testing.T) {
	var typedNil *Object
	falsy := []any{
		nil,
		typedNil,
		false,
		"",
		"0",
		int64(0),
		0,
		float64(0),
		&Object{},
		unified.Array{},
		unified.Object{},
	}
	for _, v := range falsy {
		if Truthy(v) {
			t.Fatalf("Truthy(%#v) = true, want false", v)
		}
	}

	truthyValues := []any{
		true,
		"1",
		"00",
		"false",
		" ",
		int64(1),
		int64(-1),
		1,
		float64(0.1),
		&Object{Keys: []string{"a"}, Fields: unified.Object{"a": nil}},
		unified.Array{nil},
		unified.Object{"a": nil},
	}
	for _, v := range truthyValues {
		if !Truthy(v) {
			t.Fatalf("Truthy(%#v) = false, want true", v)
		}
	}
}

func TestScalarString(t *testing.T) {
	var typedNil *Object
	cases := []struct {
		in   any
		want string
	}{
		{"hello", "hello"},
		{"", ""},
		{int64(-9876543210), "-9876543210"},
		{42, "42"},
		{float64(12.5), "12.5"},
		{true, "1"},
		{false, ""},
		{nil, ""},
		{typedNil, ""},
		{&Object{}, "Array"},
		{unified.Array{1, 2}, "Array"},
		{unified.Object{"a": 1}, "Array"},
	}
	for _, tc := range cases {
		if got := ScalarString(tc.in); got != tc.want {
			t.Fatalf("ScalarString(%#v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestAccessorsPlainAndQueryValue(t *testing.T) {
	seqDecoded, err := Decode([]byte(`{"0":"first","1":"second"}`), true, 16)
	if err != nil {
		t.Fatal(err)
	}
	if got := Plain(seqDecoded); !reflect.DeepEqual(got, unified.Array{"first", "second"}) {
		t.Fatalf("Plain(sequential) = %#v, want [first second]", got)
	}
	emptyDecoded, err := Decode([]byte(`{}`), true, 16)
	if err != nil {
		t.Fatal(err)
	}
	if got := Plain(emptyDecoded); !reflect.DeepEqual(got, unified.Array{}) {
		t.Fatalf("Plain(empty) = %#v, want []", got)
	}
	assocDecoded, err := Decode([]byte(`{"1":"b","0":"a"}`), true, 16)
	if err != nil {
		t.Fatal(err)
	}
	if got := Plain(assocDecoded); !reflect.DeepEqual(got, unified.Object{"0": "a", "1": "b"}) {
		t.Fatalf("Plain(non-sequential) = %#v, want map", got)
	}

	list := unified.Array{"zero", "one"}
	if Field(list, "1") != "one" || Field(list, "01") != nil || Field(list, "-1") != nil || Field(list, "2") != nil {
		t.Fatal("Field slice index canonicalization failed")
	}
	if !IsArray(seqDecoded) || !IsArray(list) || !IsArray(unified.Object{}) || IsArray("scalar") || IsArray((*Object)(nil)) {
		t.Fatal("IsArray mismatch")
	}
	if First(nil, nil, "ok", "later") != "ok" || First(nil, nil) != nil {
		t.Fatal("First mismatch")
	}
	if n, ok := Int64("123"); !ok || n != 123 {
		t.Fatalf("Int64(\"123\") = (%d, %v), want (123, true)", n, ok)
	}

	if v, present, scalar := QueryValue("a=1&item.id=42&arr[]=x&open[k=y&%20lead=ok%2Bplus+space\x00ignored=9", "item_id"); !present || !scalar || v != "42" {
		t.Fatalf("QueryValue(item_id) = (%q, %v, %v)", v, present, scalar)
	}
	if _, present, scalar := QueryValue("arr[]=x", "arr"); !present || scalar {
		t.Fatalf("QueryValue(arr[]) = (present=%v, scalar=%v), want (true, false)", present, scalar)
	}
	if v, present, scalar := QueryValue("open[k=y", "open_k"); !present || !scalar || v != "y" {
		t.Fatalf("QueryValue(open[k) = (%q, %v, %v)", v, present, scalar)
	}
	if v, present, scalar := QueryValue("%20lead=ok%2Bplus+space\x00tail=1", "lead"); !present || !scalar || v != "ok+plus space" {
		t.Fatalf("QueryValue(lead) = (%q, %v, %v)", v, present, scalar)
	}
}
