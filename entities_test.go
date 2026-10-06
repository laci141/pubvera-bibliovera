package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// curateBody drives handleCurate against a fake CLI that prints cliJSON and
// returns the decoded response rows.
func curateBody(t *testing.T, cliJSON string) []map[string]any {
	t.Helper()
	useFakeCLI(t, "json")
	t.Setenv("FAKE_CLI_JSON", cliJSON)
	rec := serve(handleCurate, "/curate?topic=autism")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %q", rec.Code, rec.Body.String())
	}
	var rows []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &rows); err != nil {
		t.Fatalf("body %q is not a row list: %v", rec.Body.String(), err)
	}
	return rows
}

func TestTitleEntitiesAreDecodedOnce(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"amp", "Bile Acid &amp; Tryptophan", "Bile Acid & Tryptophan"},
		{"escaped tags become text", "&lt;b&gt;x&lt;/b&gt;", "<b>x</b>"},
		{"decoded once, not twice", "&amp;lt;", "&lt;"},
		{"numeric apostrophe", "Crohn&#39;s disease", "Crohn's disease"},
		{"quot", "the &quot;gut&quot; axis", `the "gut" axis`},
		{"plain title unchanged", "A plain title", "A plain title"},
		{"bare ampersand unchanged", "Bile Acid & Tryptophan", "Bile Acid & Tryptophan"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in, _ := json.Marshal([]map[string]any{{"title": c.in}})
			rows := curateBody(t, string(in))
			if len(rows) != 1 {
				t.Fatalf("got %d rows, want 1", len(rows))
			}
			if got := rows[0]["title"]; got != c.want {
				t.Errorf("title = %q, want %q", got, c.want)
			}
		})
	}
}

// The CLI is Go, so its own JSON escapes & as & on the wire.
func TestTitleEntityEscapedAmpersandOnTheWire(t *testing.T) {
	// Built from parts so the literal backslash-u0026 stays in the source.
	wire := `[{"title":"Bile Acid ` + "\\" + `u0026amp; Tryptophan"}]`
	rows := curateBody(t, wire)
	if got := rows[0]["title"]; got != "Bile Acid & Tryptophan" {
		t.Errorf("title = %q, want %q", got, "Bile Acid & Tryptophan")
	}
}

func TestEntityDecodingLeavesNonStringsAlone(t *testing.T) {
	rows := curateBody(t, `[{"title":"A &amp; B","cited_by_count":12345678901234567890,"year":2019,"doi":null,"retracted":false}]`)
	r := rows[0]
	if r["title"] != "A & B" {
		t.Errorf("title = %q, want %q", r["title"], "A & B")
	}
	if r["year"] != float64(2019) {
		t.Errorf("year = %v, want 2019", r["year"])
	}
	if v, ok := r["doi"]; !ok || v != nil {
		t.Errorf("doi = %v (present=%v), want null", v, ok)
	}
	if r["retracted"] != false {
		t.Errorf("retracted = %v, want false", r["retracted"])
	}
	// A big integer must not be rewritten through float64.
	rec := serve(handleCurate, "/curate?topic=autism")
	if got := rec.Body.String(); !strings.Contains(got, "12345678901234567890") {
		t.Errorf("large integer was altered: %s", got)
	}
}

// Entities in a DOI are not decoded: only the display text fields are.
func TestEntityDecodingOnlyTouchesTextFields(t *testing.T) {
	rows := curateBody(t, `[{"title":"x","doi":"10.1/a&amp;b"}]`)
	if got := rows[0]["doi"]; got != "10.1/a&amp;b" {
		t.Errorf("doi = %q, want it unchanged", got)
	}
}

// Every analytics endpoint goes through runCLIRaw; check a pair row (/mesh).
func TestMeshAuthorNamesAreDecoded(t *testing.T) {
	useFakeCLI(t, "json")
	t.Setenv("FAKE_CLI_JSON", `[{"author_a":"A &amp; B","author_b":"C","shared_works":3}]`)
	rec := serve(handleMesh, "/mesh?org=Oxford")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %q", rec.Code, rec.Body.String())
	}
	var rows []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &rows); err != nil {
		t.Fatalf("bad body %q: %v", rec.Body.String(), err)
	}
	if got := rows[0]["author_a"]; got != "A & B" {
		t.Errorf("author_a = %q, want %q", got, "A & B")
	}
}

// keyOrder returns every object key in body in document order. It walks
// Token() instead of decoding into a map, so it sees the order on the wire.
func keyOrder(t *testing.T, body []byte) []string {
	t.Helper()
	type frame struct{ obj, wantKey bool }
	dec := json.NewDecoder(bytes.NewReader(body))
	var keys []string
	var stack []frame
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return keys
		}
		if err != nil {
			t.Fatalf("body %q: %v", body, err)
		}
		if d, ok := tok.(json.Delim); ok && (d == '}' || d == ']') {
			stack = stack[:len(stack)-1]
			if n := len(stack); n > 0 && stack[n-1].obj {
				stack[n-1].wantKey = true
			}
			continue
		}
		if n := len(stack); n > 0 && stack[n-1].obj && stack[n-1].wantKey {
			keys = append(keys, tok.(string))
			stack[n-1].wantKey = false
			continue
		}
		if d, ok := tok.(json.Delim); ok { // '{' or '['
			stack = append(stack, frame{obj: d == '{', wantKey: d == '{'})
			continue
		}
		if n := len(stack); n > 0 && stack[n-1].obj {
			stack[n-1].wantKey = true
		}
	}
}

// curateRaw is curateBody without the decode: the response bytes as sent.
func curateRaw(t *testing.T, cliJSON string) []byte {
	t.Helper()
	useFakeCLI(t, "json")
	t.Setenv("FAKE_CLI_JSON", cliJSON)
	rec := serve(handleCurate, "/curate?topic=autism")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %q", rec.Code, rec.Body.String())
	}
	return rec.Body.Bytes()
}

// index.html builds the CSV/Excel columns from the row keys in order, so a
// decoded response must keep the key order the CLI wrote.
func TestEntityDecodingKeepsKeyOrder(t *testing.T) {
	body := curateRaw(t, `[{"title":"A &amp; B","doi":"10.1/x","journal":"J","year":2020,"cited_by_count":5,"pub_date":"2020-01-01","citations_per_year":1.5}]`)
	want := []string{"title", "doi", "journal", "year", "cited_by_count", "pub_date", "citations_per_year"}
	if got := keyOrder(t, body); !reflect.DeepEqual(got, want) {
		t.Errorf("key order = %v, want %v (body %s)", got, want, body)
	}
	var rows []map[string]any
	if err := json.Unmarshal(body, &rows); err != nil || rows[0]["title"] != "A & B" {
		t.Errorf("title was not decoded (err %v): %s", err, body)
	}
}

func TestEntityDecodingKeepsNestedKeyOrder(t *testing.T) {
	body := curateRaw(t, `[{"title":"A &amp; B","z":1,"authors":[{"name":"N","author_id":"1","title":"C &amp; D","b":[{"y":2,"x":3}]}],"a":2}]`)
	want := []string{"title", "z", "authors", "name", "author_id", "title", "b", "y", "x", "a"}
	if got := keyOrder(t, body); !reflect.DeepEqual(got, want) {
		t.Errorf("key order = %v, want %v (body %s)", got, want, body)
	}
}

// The re-written body must stay valid JSON for empty containers, null, bool
// and nested arrays of scalars, and malformed input comes back untouched.
func TestEntityDecodingKeepsValidJSON(t *testing.T) {
	in := `[{"title":"A &amp; B","tags":[],"meta":{},"n":null,"ok":true,"m":[[1,"x"],[]],"f":-1.50e3}]`
	out := decodeEntities([]byte(in))
	var got, want any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("output %q is not valid JSON: %v", out, err)
	}
	wantJSON := `[{"title":"A & B","tags":[],"meta":{},"n":null,"ok":true,"m":[[1,"x"],[]],"f":-1.50e3}]`
	_ = json.Unmarshal([]byte(wantJSON), &want)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %q, want the same document as %q", out, wantJSON)
	}
	if !strings.Contains(string(out), `-1.50e3`) {
		t.Errorf("number text was altered: %s", out)
	}
	bad := `[{"title":"A &amp; B"`
	if got := decodeEntities([]byte(bad)); string(got) != bad {
		t.Errorf("malformed input changed: %q", got)
	}
}

// Keys are never decoded, only values under an entityFields key.
func TestEntityDecodingNeverTouchesKeys(t *testing.T) {
	rows := curateBody(t, `[{"title":"A &amp; B","x&amp;y":"1"}]`)
	if _, ok := rows[0]["x&amp;y"]; !ok {
		t.Errorf("key was decoded: %v", rows[0])
	}
}
