// CSV test: the single "CSV" menu item exports a plain RFC 4180 file for pandas,
// R and Zotero - header on line 1, no "sep=," hint, no provenance line, no BOM -
// with every export column, one record per row and the shared cell rules.
//
// Run: node tools/csv_data_test.js
//
// Same harness as tools/export_test.js: slice the inline export section out
// of index.html and execute it in a vm sandbox with a minimal DOM shim, then
// drive the real run -> render -> export path of the reading list.
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

// Comma, quote and "=" in the title exercise RFC 4180 quoting and the formula guard.
const curateRows = [
  { title: "=1+1", doi: "10.1/a", journal: "Lancet", year: 2021, cited_by_count: 50, authors: ["Zoe Young", "Jun Li"] },
  { title: 'Gene therapy, "B"', doi: "10.1/b", journal: "Lancet", year: 2008, cited_by_count: 90, authors: ["Anna Brown"] },
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

// Minimal RFC4180 reader: quoted fields, doubled quotes, CRLF records.
function parseCSV(text) {
  const recs = []; let rec = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { rec.push(f); f = ""; }
    else if (ch === "\r" && text[i + 1] === "\n") { rec.push(f); recs.push(rec); rec = []; f = ""; i++; }
    else f += ch;
  }
  rec.push(f); recs.push(rec);
  return recs;
}

(async () => {
  byId("read_topic").value = "gene therapy";
  byId("read_sort").value = "citations";
  byId("read_lim").value = "15";
  byId("read_year").value = "0";
  byId("read_cites").value = "0";
  await run("runRead()");
  const page = byId("read_res").innerHTML;

  // The menu item of the rendered row is the call under test: its data-key and data-name decide the filename.
  const item = page.match(/data-action="export" data-call="downloadCSVData" data-key="([^"]*)" data-name="([^"]*)"/);
  const call = item ? "downloadCSVData('" + item[1] + "','" + item[2] + "')" : "";
  let data = "", dataType = "", dataName = "";
  if (call) {
    const before = blobs.length;
    try { run(call); } catch (e) { console.log("      " + call + " threw: " + e.message); }
    if (blobs.length > before) { data = lastBlob().text; dataType = lastBlob().type; }
    dataName = (anchors[anchors.length - 1] || {}).download || "";
  } else {
    console.log("      no downloadCSVData(...) menu item in the rendered reading list");
  }
  const dataLines = data.split("\r\n");

  // a. header on line 1
  check("a. data CSV line 1 is the header, starts with \"title,doi\" (got " + JSON.stringify(dataLines[0]) + ")",
    data !== "" && dataLines[0].startsWith("title,doi"));
  check("a. data CSV holds no \"sep=\" and no \"Bibliovera export\" provenance line",
    data !== "" && !/sep=/.test(data) && !/Bibliovera export/.test(data) && !dataLines.some(l => / · /.test(l)));
  check("a. no line starts with \"sep=\" or \"Bibliovera export\"",
    data !== "" && !dataLines.some(l => /^﻿?(sep=|Bibliovera export)/.test(l)));

  // b. no BOM
  check("b. data CSV does not start with U+FEFF (first code unit " +
    (data ? "U+" + data.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0") : "none") + ")",
    data !== "" && data.charCodeAt(0) !== 0xFEFF);

  // c. header = every export column in first-seen order, one record per row, CRLF line ends
  const dataRecs = data ? parseCSV(data) : [];
  const wantCols = [];
  JSON.parse(run('JSON.stringify(exportRows("read").rows)')).forEach(r => Object.keys(r || {}).forEach(k => { if (!wantCols.includes(k)) wantCols.push(k); }));
  check("c. header is the export columns (" + JSON.stringify((dataRecs[0] || []).join(",")) + ")",
    dataRecs.length > 0 && JSON.stringify(dataRecs[0]) === JSON.stringify(wantCols));
  check("c. one data row per paper (" + (dataRecs.length - 1) + ", want " + curateRows.length + ")",
    dataRecs.length - 1 === curateRows.length);
  check("c. CRLF line ends only", data !== "" && /\r\n/.test(data) && !/[^\r]\n/.test(data));

  // d. cell rules
  const cols = dataRecs[0] || [];
  const r0 = dataRecs[1] || [], r1 = dataRecs[2] || [];
  const authorsCell = r0[cols.indexOf("authors")];
  check('d. authors cell is "Zoe Young; Jun Li" (got ' + JSON.stringify(authorsCell) + ")", authorsCell === "Zoe Young; Jun Li");
  const titleCell = r0[cols.indexOf("title")];
  check("d. \"=1+1\" title is neutralized with a leading quote (got " + JSON.stringify(titleCell) + ")", titleCell === "'=1+1");
  check("d. comma/quote title is RFC 4180 quoted (raw line " + JSON.stringify(dataLines[2]) + ")",
    r1[cols.indexOf("title")] === 'Gene therapy, "B"' && (dataLines[2] || "").startsWith('"Gene therapy, ""B"""'));

  // f. filename and MIME
  check("f. downloaded filename is <base>.csv, not -data.csv (got " + JSON.stringify(dataName) + ")",
    dataName === "bibliovera-reading-list.csv" && !/-data\.csv$/.test(dataName));

  // g. the menu: exactly one CSV item, label "CSV", exact title; no item reaches the legacy CSV
  const labels = [...page.matchAll(/role="menuitem"[^>]*>([^<]*)<\/button>/g)].map(m => m[1]);
  check("g. menu items are Excel, CSV, JSON, BibTeX (got " + JSON.stringify(labels) + ")",
    JSON.stringify(labels) === JSON.stringify(["Excel", "CSV", "JSON", "BibTeX"]));
  const csvBtn = (page.match(/<button[^>]*role="menuitem"[^>]*>CSV<\/button>/) || [""])[0];
  check("g. CSV item title is the plain-CSV hint",
    csvBtn.includes(' title="Plain CSV (RFC 4180) for pandas, R, Zotero. For Excel, use Excel (.xlsx)."'));
  check("g. no menu item calls the legacy downloadCSV(", !/data-call="downloadCSV"/.test(page));
  check("f. data CSV MIME is text/csv;charset=utf-8 (got " + JSON.stringify(dataType) + ")", dataType === "text/csv;charset=utf-8");

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall data CSV checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
