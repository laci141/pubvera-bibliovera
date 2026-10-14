// Authors export test: CSV/XLSX write an array of author names as one readable
// "A; B; C" cell (no JSON brackets), invisible characters (soft hyphen, zero
// width, BOM) are stripped from names, author order is kept, and BibTeX gets
// exactly one "author = {A and B and C}" line.
//
// Run: node tools/authors_export_test.js
//
// Same harness as tools/export_test.js: slice the inline export section out
// of index.html and execute it in a vm sandbox with a minimal DOM shim.
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

// ── minimal DOM shim (no rendering is driven here) ──
const el = () => ({ value: "", textContent: "", innerHTML: "", style: {}, classList: { add() {}, remove() {} }, querySelector: () => null });
const sandbox = {
  console, Date, Math, JSON, Number, String, Object, Array, Promise, URLSearchParams, setTimeout, clearTimeout,
  alert: () => {},
  localStorage: { getItem: () => null, setItem: () => {} },
  window: { location: { origin: "http://localhost" } },
  Blob: class { constructor(parts) { this.text = parts.join(""); } },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  XLSX: { utils: {} },
  fetch: async () => ({ ok: true, status: 200, text: async () => "[]" }),
  updateQcount: () => {},
  checkRetractions: async () => {},
  document: {
    querySelector: () => el(),
    querySelectorAll: () => [],
    getElementById: () => el(),
    createElement: () => ({ click() {} }),
    body: { appendChild() {}, removeChild() {} },
  },
};
vm.createContext(sandbox);
vm.runInContext(section, sandbox, { filename: "index.html#export-section" });
const call = (name, ...args) => {
  try {
    sandbox.__args = args;
    return vm.runInContext(name + "(...__args)", sandbox);
  } catch (e) {
    return "ERROR: " + e.message;
  }
};

// Non-alphabetical, non-sorted order: a sort or reverse cannot pass.
const authors = ["Zoe Young", "­Jun Li­", "Anna Brown"];
const want = "Zoe Young; Jun Li; Anna Brown";

// a. CSV
const csv = String(call("toCSV", [{ title: "T", authors }])).replace(/^﻿/, "").split("\r\n");
const csvCols = (csv[1] || "").split(",");
const csvCell = (csv[2] || "").split(",").slice(csvCols.indexOf("authors")).join(",");
check("a. CSV authors cell is exactly " + JSON.stringify(want) + " (got " + JSON.stringify(csvCell) + ")", csvCell === want);
check("a. CSV authors cell holds no U+00AD, brackets or quotes", !/[­\[\]"]/.test(csvCell));

// b. XLSX path
const sv = call("sheetValue", authors);
check("b. sheetValue(authors) is " + JSON.stringify(want) + " (got " + JSON.stringify(sv) + ")", sv === want);

// c. non-string arrays and objects keep JSON
const svNum = call("sheetValue", [1, 2]);
const svObj = call("sheetValue", { a: 1 });
const svMix = call("sheetValue", ["x", { a: 1 }]);
check("c. sheetValue([1,2]) is JSON (got " + JSON.stringify(svNum) + ")", svNum === "[1,2]");
check("c. sheetValue({a:1}) is JSON (got " + JSON.stringify(svObj) + ")", svObj === '{"a":1}');
check("c. sheetValue mixed array is JSON (got " + JSON.stringify(svMix) + ")", svMix === '["x",{"a":1}]');

// d. BibTeX
const bib = String(call("toBibTeX", [{ title: "T", year: 2020, authors }]));
const authorLines = bib.split("\n").filter(l => /^\s*author\s*=/.test(l));
const wantBib = "  author  = {Zoe Young and Jun Li and Anna Brown},";
check("d. BibTeX has exactly one author line " + JSON.stringify(wantBib) + " (got " + JSON.stringify(authorLines) + ")",
  authorLines.length === 1 && authorLines[0] === wantBib);
check("d. BibTeX output holds no U+00AD", !/­/.test(bib));

// e. no authors -> no author line
const bibEmpty = String(call("toBibTeX", [{ title: "E", authors: [] }, { title: "N" }]));
check("e. BibTeX rows with authors [] / no authors have no author line", /title/.test(bibEmpty) && !/author\s*=/.test(bibEmpty));

// f. formula-injection guard on the joined cell
const svEq = call("sheetValue", ["=HYPERLINK(1)", "Anna Brown"]);
check("f. sheetValue first name \"=...\" starts with \"'=\" (got " + JSON.stringify(svEq) + ")", typeof svEq === "string" && svEq.startsWith("'="));
const csvEq = String(call("toCSV", [{ authors: ["=HYPERLINK(1)", "Anna Brown"] }])).replace(/^﻿/, "").split("\r\n")[2] || "";
check("f. CSV first name \"=...\" cell starts with \"'=\" (got " + JSON.stringify(csvEq) + ")", csvEq.startsWith("'="));

console.log(failed ? "\n" + failed + " check(s) FAILED" : "\nall checks passed");
process.exit(failed ? 1 : 0);
