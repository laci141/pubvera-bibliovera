// CSV/XLSX formula-injection test (BUG-06): neutralizeCell prefixes a single
// quote to strings that start with = + - @ TAB or CR; numbers, booleans and
// null pass through; CSV quoting is applied after neutralizing; XLSX user
// strings stay string cells (t:"s") and never carry a formula ("f").
//
// Run: node tools/csv_injection_test.js
//
// Same loading pattern as tools/export_test.js: the inline script section is
// sliced out of index.html and run in a vm sandbox with a minimal DOM shim. No
// server, no network: fetch is a local mock.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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

const EVIL_TITLE = '=HYPERLINK("http://x","y")';
const affRows = [
  { institution: "Shrinking Institute", recent_count: 20, prior_count: 30, growth: -10, low_base: false },
];
const curateRows = [
  { title: EVIL_TITLE, doi: "10.1/a", journal: "Lancet", year: 2021, cited_by_count: 50, topic: "+cmd" },
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
let xlsxSheet = null;
// aoa_to_sheet mirrors SheetJS: a JS string becomes a string cell (t "s"), a
// number a number cell (t "n"); the library never creates an "f" from a value.
const XLSX = {
  utils: {
    encode_col: c => { let s = ""; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; },
    encode_cell: a => XLSX.utils.encode_col(a.c) + (a.r + 1),
    encode_range: r => XLSX.utils.encode_cell(r.s) + ":" + XLSX.utils.encode_cell(r.e),
    decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: xlsxSheet._rows - 1, c: xlsxSheet._cols - 1 } }),
    aoa_to_sheet: aoa => {
      const ws = { _rows: aoa.length, _cols: Math.max(...aoa.map(r => r.length)) };
      aoa.forEach((row, r) => row.forEach((v, c) => {
        ws[XLSX.utils.encode_cell({ r, c })] = { v, t: typeof v === "number" ? "n" : typeof v === "boolean" ? "b" : "s" };
      }));
      ws["!ref"] = "A1:" + XLSX.utils.encode_cell({ r: ws._rows - 1, c: ws._cols - 1 });
      xlsxSheet = ws;
      return ws;
    },
    book_new: () => ({ sheets: [] }),
    book_append_sheet: (wb, ws) => wb.sheets.push(ws),
  },
  writeFile: () => {},
};
const sandbox = {
  console, Date, Math, JSON, Number, String, Object, Array, Promise, URLSearchParams, setTimeout, clearTimeout,
  alert: m => { throw new Error("unexpected alert: " + m); },
  localStorage: { getItem: () => null, setItem: () => {} },
  window: { location: { origin: "http://localhost" } },
  Blob: class { constructor(parts) { this.text = parts.join(""); blobs.push(this.text); } },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  XLSX,
  fetch: async url => {
    const body = url.startsWith("/affiliations") ? affRows : url.startsWith("/curate") ? curateRows : [];
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
    createElement: () => ({ click() {} }),
    body: { appendChild() {}, removeChild() {} },
  },
};
vm.createContext(sandbox);
vm.runInContext(section, sandbox, { filename: "index.html#export-section" });
const run = code => vm.runInContext(code, sandbox);
const lastBlob = () => blobs[blobs.length - 1];

// Minimal RFC4180 reader: quoted fields, doubled quotes, CRLF records.
function parseCSV(text) {
  const recs = []; let rec = [], f = "", q = false;
  text = text.replace(/^﻿/, "");
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
  // ── 1. neutralizeCell ──
  const hasFn = run("typeof neutralizeCell") === "function";
  check("neutralizeCell is a function in index.html", hasFn);
  const nc = v => (hasFn ? run("neutralizeCell")(v) : "<missing>");
  check('neutralizeCell("=1+1") -> "\'=1+1"', nc("=1+1") === "'=1+1");
  check('neutralizeCell("+1") -> "\'+1"', nc("+1") === "'+1");
  check('neutralizeCell("-1") -> "\'-1"', nc("-1") === "'-1");
  check('neutralizeCell("@SUM(A1)") -> "\'@SUM(A1)"', nc("@SUM(A1)") === "'@SUM(A1)");
  check("neutralizeCell(TAB x) is prefixed", nc("\tx") === "'\tx");
  check("neutralizeCell(CR x) is prefixed", nc("\rx") === "'\rx");
  check('neutralizeCell("Normal") unchanged', nc("Normal") === "Normal");
  check('neutralizeCell("") unchanged', nc("") === "");
  check("neutralizeCell(-33) stays the number -33", nc(-33) === -33 && typeof nc(-33) === "number");
  check("neutralizeCell(0) stays the number 0", nc(0) === 0 && typeof nc(0) === "number");
  check("neutralizeCell(1.5) stays the number 1.5", nc(1.5) === 1.5 && typeof nc(1.5) === "number");
  check("neutralizeCell(true / null) unchanged", nc(true) === true && nc(null) === null);

  // ── 2. CSV: Reading List row with an evil title and topic "+cmd" ──
  byId("read_topic").value = "+cmd";
  byId("read_sort").value = "citations";
  byId("read_lim").value = "15";
  byId("read_year").value = "0";
  byId("read_cites").value = "0";
  await run("runRead()");
  run('downloadCSV("read","r.csv")');
  const recs = parseCSV(lastBlob());
  const cols = recs[2];
  const evil = recs.slice(3).find(r => r.length === cols.length && r[cols.indexOf("doi")] === "10.1/a") || [];
  const titleCell = evil[cols.indexOf("title")];
  const topicCell = evil[cols.indexOf("topic")];
  check("CSV: the row stays one record with " + cols.length + " fields (got " + evil.length + ")", evil.length === cols.length);
  check("CSV: title cell starts with ' and keeps its text (got " + JSON.stringify(titleCell) + ")", titleCell === "'" + EVIL_TITLE);
  check('CSV: topic cell "+cmd" is "\'+cmd" (got ' + JSON.stringify(topicCell) + ")", topicCell === "'+cmd");
  check("CSV: raw file has the quoted+doubled form after the prefix", lastBlob().includes('"\'=HYPERLINK(""http://x"",""y"")"'));
  check("CSV: no field starts with = + - @ TAB or CR", recs.slice(3).every(r => r.every(c => !/^[=+\-@\t\r]/.test(c))));

  // ── 3. XLSX: same row ──
  run('downloadXLSX("read","r.xlsx")');
  const ws = xlsxSheet;
  const addrs = Object.keys(ws).filter(k => /^[A-Z]+\d+$/.test(k));
  const hdr = []; for (let c = 0; c < ws._cols; c++) hdr.push(ws[XLSX.utils.encode_cell({ r: 1, c })].v);
  const tCell = ws[XLSX.utils.encode_cell({ r: 2, c: hdr.indexOf("title") })] || {};
  const pCell = ws[XLSX.utils.encode_cell({ r: 2, c: hdr.indexOf("topic") })] || {};
  check('XLSX: title cell type "s" (got ' + JSON.stringify(tCell.t) + ")", tCell.t === "s");
  check("XLSX: title value starts with ' (got " + JSON.stringify(tCell.v) + ")", typeof tCell.v === "string" && tCell.v === "'" + EVIL_TITLE);
  check('XLSX: topic value "\'+cmd" (got ' + JSON.stringify(pCell.v) + ")", pCell.v === "'+cmd");
  check("XLSX: no cell has an f (formula) property", addrs.every(a => !("f" in ws[a])));
  check("XLSX: no string cell starts with = + - @ TAB or CR",
    addrs.every(a => ws[a].t !== "s" || !/^[=+\-@\t\r]/.test(String(ws[a].v))));

  // ── 4. numeric growth stays a number (existing export_test behaviour) ──
  byId("aff_journal").value = "lancet";
  byId("aff_years").value = "5";
  byId("aff_thr").value = "2";
  byId("aff_minp").value = "13";
  byId("aff_lim").value = "59";
  await run("runAff()");
  run('downloadCSV("aff","a.csv")');
  const arecs = parseCSV(lastBlob());
  const acols = arecs[2];
  const shr = arecs[3] || [];
  check('CSV: growth_pct -33 is still "-33" (got ' + JSON.stringify(shr[acols.indexOf("growth_pct")]) + ")", shr[acols.indexOf("growth_pct")] === "-33");
  check('CSV: growth -10 is still "-10" (got ' + JSON.stringify(shr[acols.indexOf("growth")]) + ")", shr[acols.indexOf("growth")] === "-10");
  run('downloadXLSX("aff","a.xlsx")');
  const aws = xlsxSheet;
  const ahdr = []; for (let c = 0; c < aws._cols; c++) ahdr.push(aws[XLSX.utils.encode_cell({ r: 1, c })].v);
  const gp = aws[XLSX.utils.encode_cell({ r: 2, c: ahdr.indexOf("growth_pct") })] || {};
  check("XLSX: growth_pct -33 is still the number -33 (got " + JSON.stringify(gp.v) + " t=" + gp.t + ")", gp.v === -33 && gp.t === "n");

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall csv-injection checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
