// JSON test: the JSON export cleans invisible characters (U+00AD soft hyphen etc.)
// out of string authors via cleanName, like CSV and BibTeX; object authors pass
// through unchanged.
//
// Run: node tools/json_authors_test.js
//
// Same harness as tools/csv_data_test.js.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The worktree may hold CRLF (core.autocrlf); the index holds LF.
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
const start = html.indexOf('"use strict";\nconst $=');
const end = html.indexOf("// ── Collaboration network");
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: could not locate the export/module section in index.html");
  process.exit(1);
}
const section = html.slice(start, end);

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

const curateRows = [
  { title: "A", doi: "10.1/a", journal: "Lancet", year: 2021, cited_by_count: 50, authors: ["Zoe Young", "Jun\u00ADLi"] },
  { title: "B", doi: "10.1/b", journal: "Lancet", year: 2008, cited_by_count: 90, authors: [{ name: "Anna Brown", id: "A1" }] },
];

// ── DOM shim ──
const stripTags = s => String(s).replace(/<[^>]*>/g, "");
function makeEl() {
  const el = { value: "", textContent: "", _html: "", style: {}, classList: { add() {}, remove() {} } };
  Object.defineProperty(el, "innerHTML", { get() { return el._html; }, set(h) { el._html = String(h); } });
  el.querySelector = sel => {
    if (sel === ".meta") {
      const m = /<span class="meta">([\s\S]*?)<span class="qcount">/.exec(el._html);
      return m ? { textContent: stripTags(m[1]) } : null;
    }
    if (sel === ".qfilter") return /class="qfilter"/.test(el._html) ? { value: "" } : null;
    if (sel === "table") {
      if (!/<table/.test(el._html)) return null;
      return {
        querySelectorAll: s => (s === "tbody tr"
          ? [...el._html.matchAll(/<tr data-i="(\d+)"/g)].map(m => ({ style: { display: "" }, getAttribute: () => m[1] }))
          : []),
        querySelector: () => null,
      };
    }
    return null;
  };
  return el;
}
const els = {};
const byId = id => (els[id] = els[id] || makeEl());
const blobs = [];
const anchors = [];
const sandbox = {
  console, Date, Math, JSON, Number, String, Object, Array, Promise, URLSearchParams, setTimeout, clearTimeout,
  alert: m => { throw new Error("unexpected alert: " + m); },
  localStorage: { getItem: () => null, setItem: () => {} },
  window: { location: { origin: "http://localhost" } },
  Blob: class { constructor(parts, opts) { this.text = parts.join(""); this.type = opts && opts.type; blobs.push(this); } },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  XLSX: { utils: {} },
  fetch: async url => {
    const body = url.startsWith("/curate") ? curateRows : [];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  },
  // Defined after the sliced section in index.html; not under test here.
  updateQcount: () => {},
  checkRetractions: async () => {},
  document: {
    querySelector: sel => {
      const m = /^#([\w-]+)(?:\s+(.+))?$/.exec(sel);
      if (!m) return null;
      return m[2] ? byId(m[1]).querySelector(m[2]) : byId(m[1]);
    },
    querySelectorAll: () => [],
    getElementById: byId,
    createElement: () => { const a = { click() {} }; anchors.push(a); return a; },
    body: { appendChild() {}, removeChild() {} },
  },
};
vm.createContext(sandbox);
vm.runInContext(section, sandbox, { filename: "index.html#export-section" });
const run = code => vm.runInContext(code, sandbox);
const lastBlob = () => blobs[blobs.length - 1] || { text: "", type: "" };

(async () => {
  byId("read_topic").value = "gene therapy";
  byId("read_sort").value = "citations";
  byId("read_lim").value = "15";
  byId("read_year").value = "0";
  byId("read_cites").value = "0";
  await run("runRead()");
  const before = blobs.length;
  run('downloadJSON("read","r.json")');
  const text = blobs.length > before ? lastBlob().text : "";
  check("JSON export produced a blob", text !== "");
  check("no U+00AD anywhere in the JSON text", text !== "" && !text.includes("\u00AD"));
  let rows = [];
  try { rows = JSON.parse(text).rows || []; } catch (e) {}
  const a = rows.find(r => r.title === "A") || {}, b = rows.find(r => r.title === "B") || {};
  const got = (a.authors || [])[1];
  check('string author "Jun\u00ADLi" exports as "JunLi" (got ' + JSON.stringify(got) + ")", got === "JunLi");
  check("object author passes through unchanged (got " + JSON.stringify(b.authors) + ")",
    JSON.stringify(b.authors) === JSON.stringify([{ name: "Anna Brown", id: "A1" }]));

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall JSON author checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
