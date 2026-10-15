// XLSX layout test: the Excel export puts the column header in row 1 and the
// first data row in row 2 (pandas read_excel() default), and moves the
// provenance metadata to a second sheet named "About" (key | value).
//
// Run: node tools/xlsx_layout_test.js
//
// The fixture rows carry 19 keys, as many as the live reading list export has.
//
// Same harness as tools/csv_data_test.js: slice the inline export section out
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

const curateRows = [
  { title: "Autism spectrum disorder", doi: "10.1/a", journal: "Lancet", year: 2018, cited_by_count: 900, authors: ["Jun Li", "Zoe Young"], citations_per_year: 1, pub_date: "2018-01-01", fwci: 2.5, is_oa: true, oa_url: "", type: "article", language: "en", openalex_id: "W1", primary_topic: "Autism", abstract: "", volume: "1", issue: "2", pages: "3-4" },
  { title: "Gene therapy", doi: "10.1/b", journal: "Lancet", year: 2008, cited_by_count: 90, authors: ["Anna Brown"], citations_per_year: 1, pub_date: "2018-01-01", fwci: 2.5, is_oa: true, oa_url: "", type: "article", language: "en", openalex_id: "W1", primary_topic: "Autism", abstract: "", volume: "1", issue: "2", pages: "3-4" },
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

// XLSX shim: keeps every appended sheet with its name, in workbook order.
let lastBook = null;
const XLSX = {
  utils: {
    encode_cell: ({ r, c }) => String.fromCharCode(65 + c) + (r + 1),
    encode_range: ({ s, e }) => XLSX.utils.encode_cell(s) + ":" + XLSX.utils.encode_cell(e),
    decode_range: ref => {
      const m = /^([A-Z])(\d+):([A-Z])(\d+)$/.exec(ref);
      return { s: { r: +m[2] - 1, c: m[1].charCodeAt(0) - 65 }, e: { r: +m[4] - 1, c: m[3].charCodeAt(0) - 65 } };
    },
    aoa_to_sheet: aoa => {
      const ws = { _rows: aoa.length, _cols: Math.max(...aoa.map(r => r.length)) };
      aoa.forEach((row, r) => row.forEach((v, c) => { ws[XLSX.utils.encode_cell({ r, c })] = { v }; }));
      ws["!ref"] = "A1:" + XLSX.utils.encode_cell({ r: ws._rows - 1, c: ws._cols - 1 });
      return ws;
    },
    book_new: () => ({ names: [], sheets: [] }),
    book_append_sheet: (wb, ws, name) => { wb.names.push(name); wb.sheets.push(ws); },
  },
  writeFile: wb => { lastBook = wb; },
};
const sandbox = {
  console, Date, Math, JSON, Number, String, Object, Array, Promise, URLSearchParams, setTimeout, clearTimeout,
  alert: m => { throw new Error("unexpected alert: " + m); },
  localStorage: { getItem: () => null, setItem: () => {} },
  window: { location: { origin: "http://localhost" } },
  Blob: class { constructor(parts, opts) { this.text = parts.join(""); this.type = opts && opts.type; blobs.push(this); } },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  XLSX,
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
    createElement: () => ({ click() {} }),
    body: { appendChild() {}, removeChild() {} },
  },
};
vm.createContext(sandbox);
vm.runInContext(section, sandbox, { filename: "index.html#export-section" });
const run = code => vm.runInContext(code, sandbox);
const rowOf = (ws, r) => {
  const out = [];
  for (let c = 0; c < ws._cols; c++) { const cell = ws[XLSX.utils.encode_cell({ r, c })]; out.push(cell ? cell.v : undefined); }
  return out;
};

(async () => {
  byId("read_topic").value = "autism";
  byId("read_sort").value = "citations";
  byId("read_lim").value = "15";
  byId("read_year").value = "0";
  byId("read_cites").value = "0";
  await run("runRead()");

  // The plain CSV header is the reference for the 19 column names and their order.
  run('downloadCSVData("read","r.csv")');
  const csvCols = blobs[blobs.length - 1].text.split("\r\n")[0].split(",");
  const header = run('exportHeader("read",exportRows("read").rows)');

  run('downloadXLSX("read","r.xlsx")');
  const wb = lastBook || { names: [], sheets: [] };
  const ws = wb.sheets[0] || { _rows: 0, _cols: 0 };
  const row1 = rowOf(ws, 0), row2 = rowOf(ws, 1);

  check("sheet 1 is \"Bibliovera\" (got " + JSON.stringify(wb.names[0]) + ")", wb.names[0] === "Bibliovera");
  check("CSV reference header has 19 columns (got " + csvCols.length + ")", csvCols.length === 19);
  check("sheet 1 row 1 is the 19 column names in CSV order (got " + JSON.stringify(row1) + ")",
    JSON.stringify(row1) === JSON.stringify(csvCols));
  const t = row2[row1.indexOf("title")];
  check("sheet 1 row 2 is the first data row, title \"Autism spectrum disorder\" (got " + JSON.stringify(t) + ")", t === "Autism spectrum disorder");
  check("sheet 1 has header + " + curateRows.length + " data rows (got " + ws._rows + " rows)", ws._rows === curateRows.length + 1);
  check("autofilter starts at A1 (got " + JSON.stringify(ws["!autofilter"] && ws["!autofilter"].ref) + ")",
    !!ws["!autofilter"] && /^A1:/.test(ws["!autofilter"].ref));
  check("no metadata text in sheet 1", !Object.keys(ws).some(k => /^[A-Z]+\d+$/.test(k) && /Bibliovera export/.test(String(ws[k].v))));

  const ai = wb.names.indexOf("About");
  check("a sheet named \"About\" exists (sheets " + JSON.stringify(wb.names) + ")", ai >= 0);
  const about = wb.sheets[ai] || { _rows: 0, _cols: 0 };
  const kv = {};
  for (let r = 0; r < about._rows; r++) { const [k, v] = rowOf(about, r); kv[k] = v; }
  check("About has two columns, key and value (got " + JSON.stringify(rowOf(about, 0)) + ")",
    about._cols === 2 && JSON.stringify(rowOf(about, 0)) === JSON.stringify(["key", "value"]));
  check("About query holds the topic \"autism\" (got " + JSON.stringify(kv.query) + ")", typeof kv.query === "string" && kv.query.includes("autism"));
  check("About source is \"OpenAlex (CC0)\" (got " + JSON.stringify(kv.source) + ")", kv.source === "OpenAlex (CC0)");
  // No data is dropped: every About value appears, in order, in the metadata
  // line, and what is left of the line is only " · " separators and "key: " labels.
  let rest = header, at = 0, inOrder = true;
  for (let r = 1; r < about._rows; r++) {
    const v = String(rowOf(about, r)[1]);
    const i = rest.indexOf(v, at);
    if (i < 0) { inOrder = false; break; }
    rest = rest.slice(0, i) + " " + rest.slice(i + v.length);
    at = i + 1;
  }
  const leftover = rest.replace(/ /g, "").replace(/ · /g, "").replace(/query: ""/g, "").replace(/[a-z ]+: /g, "");
  check("every metadata part is on the About sheet, in order (leftover " + JSON.stringify(leftover) + ")",
    about._rows > 1 && inOrder && leftover === "");

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall XLSX layout checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
