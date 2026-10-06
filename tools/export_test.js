// Export test: booleans as Yes/No, growth_pct next to growth (same helper as
// the page), XLSX autofilter on the header row, and the query inputs of each
// module in the export "filters".
//
// Run: node tools/export_test.js
//
// The export suite and the module renderers live inline in index.html; this
// test slices that script section out and executes it in a vm sandbox with a
// minimal DOM shim, then drives the real run -> render -> export path.
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

// ── fixtures: /affiliations in main.go order (normal rows, then low_base) ──
const affRows = [
  { institution: "University College London", recent_count: 186, prior_count: 106, growth: 80, low_base: false },
  { institution: "University of Oxford", recent_count: 88, prior_count: 63, growth: 25, low_base: false },
  { institution: "Shrinking Institute", recent_count: 20, prior_count: 30, growth: -10, low_base: false },
  { institution: "Amsterdam University Medical Centers", recent_count: 24, prior_count: 0, growth: 24, low_base: true },
  { institution: "Small Base Institute", recent_count: 10, prior_count: 4, growth: 6, low_base: true },
];
const curateRows = [
  { title: "Gene therapy A", doi: "10.1/a", journal: "Lancet", year: 2021, cited_by_count: 50, topic: "gt" },
  { title: "Gene therapy B", doi: "10.1/b", journal: "Lancet", year: 2008, cited_by_count: 90, topic: "gt" },
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
const XLSX = {
  utils: {
    encode_col: c => { let s = ""; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; },
    encode_cell: a => XLSX.utils.encode_col(a.c) + (a.r + 1),
    encode_range: r => XLSX.utils.encode_cell(r.s) + ":" + XLSX.utils.encode_cell(r.e),
    decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: xlsxSheet._rows - 1, c: xlsxSheet._cols - 1 } }),
    aoa_to_sheet: aoa => {
      const ws = { _rows: aoa.length, _cols: Math.max(...aoa.map(r => r.length)) };
      aoa.forEach((row, r) => row.forEach((v, c) => { ws[XLSX.utils.encode_cell({ r, c })] = { v }; }));
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
    return { ok: true, status: 200, text: async () => JSON.stringify(JSON.parse(JSON.stringify(body))) };
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

function lastBlob() { return blobs[blobs.length - 1]; }
function parseCSV(text) {
  // Fixture values hold no quotes or commas, so a plain split is exact.
  const lines = text.replace(/^﻿/, "").split("\r\n");
  const cols = lines[2].split(",");
  const rows = lines.slice(3).map(l => { const c = l.split(","); const o = {}; cols.forEach((k, i) => (o[k] = c[i])); return o; });
  return { header: lines[1], cols, rows };
}

(async () => {
  // ── Affiliations: run, render, export ──
  byId("aff_journal").value = "lancet";
  byId("aff_years").value = "5";
  byId("aff_thr").value = "2";
  byId("aff_minp").value = "13";
  byId("aff_lim").value = "59";
  await run("runAff()");
  const page = byId("aff_res").innerHTML;

  run('downloadCSV("aff","a.csv")');
  const csv = parseCSV(lastBlob());
  const ucl = csv.rows.find(r => r.institution === "University College London") || {};
  const ams = csv.rows.find(r => r.institution === "Amsterdam University Medical Centers") || {};
  const oxf = csv.rows.find(r => r.institution === "University of Oxford") || {};
  const shr = csv.rows.find(r => r.institution === "Shrinking Institute") || {};
  const small = csv.rows.find(r => r.institution === "Small Base Institute") || {};
  // 1. CSV
  check('CSV: UCL low_base is "No" (got ' + JSON.stringify(ucl.low_base) + ")", ucl.low_base === "No");
  check('CSV: Amsterdam UMC low_base is "Yes"', ams.low_base === "Yes");
  check("CSV: UCL growth 80 (absolute, unchanged)", ucl.growth === "80");
  check("CSV: UCL growth_pct 75 (got " + JSON.stringify(ucl.growth_pct) + ")", ucl.growth_pct === "75");
  check("CSV: Oxford growth_pct 40 (63 -> 88, rounded not floored; got " + JSON.stringify(oxf.growth_pct) + ")", oxf.growth_pct === "40");
  check("CSV: Shrinking growth_pct -33 (got " + JSON.stringify(shr.growth_pct) + ")", shr.growth_pct === "-33");
  check("CSV: Amsterdam UMC (prior 0) growth_pct empty (got " + JSON.stringify(ams.growth_pct) + ")", ams.growth_pct === "");
  check("CSV: low_base row with prior > 0 still gets its real percent, 150 (got " + JSON.stringify(small.growth_pct) + ")", small.growth_pct === "150");
  check("CSV: growth_pct sits right after growth (" + csv.cols.join(",") + ")", csv.cols.indexOf("growth_pct") === csv.cols.indexOf("growth") + 1);
  check("CSV provenance carries the aff filters incl. limit", /5y window/.test(csv.header) && /limit 59/.test(csv.header));

  // 2. XLSX
  run('downloadXLSX("aff","a.xlsx")');
  const ws = xlsxSheet;
  const hdr = []; for (let c = 0; c < ws._cols; c++) hdr.push(ws[XLSX.utils.encode_cell({ r: 1, c })].v);
  const lbCol = hdr.indexOf("low_base");
  let uclRow = -1; for (let r = 2; r < ws._rows; r++) if (ws["A" + (r + 1)].v === "University College London") uclRow = r;
  const lbCell = lbCol >= 0 && uclRow >= 0 ? ws[XLSX.utils.encode_cell({ r: uclRow, c: lbCol })].v : undefined;
  check('XLSX: UCL low_base cell is "No" (got ' + JSON.stringify(lbCell) + ")", lbCell === "No");
  const wantRef = "A2:F" + (affRows.length + 2);
  const gotRef = ws["!autofilter"] && ws["!autofilter"].ref;
  check("XLSX: autofilter ref " + wantRef + " (got " + JSON.stringify(gotRef) + ")", gotRef === wantRef);

  // 3. JSON
  run('downloadJSON("aff","a.json")');
  const json = JSON.parse(lastBlob());
  check("JSON: growth_pct present on every row", json.rows.every(r => "growth_pct" in r));
  check("JSON: UCL growth_pct 75, Amsterdam null", json.rows[0].growth_pct === 75 && json.rows.find(r => r.prior_count === 0).growth_pct === null);
  check('JSON: export.filters contains "5y window" (got ' + JSON.stringify(json.export.filters) + ")", /5y window/.test(json.export.filters));
  check('JSON: export.filters contains "limit"', /\blimit 59\b/.test(json.export.filters));

  // 4. one helper for page and export
  check("growthPct is a function in index.html", run("typeof growthPct") === "function");
  const affSrc = (/function affTable\([\s\S]*?\n}\n/.exec(html) || [""])[0];
  check("affTable computes its percent through growthPct(r)", /growthPct\(r\)/.test(affSrc) && !/Math\.round\(\(recent-prior\)/.test(affSrc));
  const uclTr = (/<tr data-i="\d+"><td class="n">\d+<\/td><td>University College London<\/td>[\s\S]*?<\/tr>/.exec(page) || [""])[0];
  const oxfTr = (/<tr data-i="\d+"><td class="n">\d+<\/td><td>University of Oxford<\/td>[\s\S]*?<\/tr>/.exec(page) || [""])[0];
  check("page: UCL cell shows +75%", />\+75%</.test(uclTr));
  check("page: Oxford cell shows +40% (same rounding as the export)", />\+40%</.test(oxfTr));
  check("page: low_base row still shows the low-base badge, no percent", /Small Base Institute[\s\S]*?low base/.test(page) && !/>\+150%</.test(page));

  // 5. read module: client-side min year reaches export.filters
  byId("read_topic").value = "gene therapy";
  byId("read_sort").value = "citations";
  byId("read_lim").value = "15";
  byId("read_year_n").value = "2010";
  byId("read_cites").value = "0";
  await run("runRead()");
  run('downloadJSON("read","r.json")');
  const rj = JSON.parse(lastBlob());
  check('read JSON: export.filters names the min year (got ' + JSON.stringify(rj.export.filters) + ")", /2010/.test(rj.export.filters));
  check("read JSON: export.filters names the limit", /\blimit 15\b/.test(rj.export.filters));
  run('downloadBibTeX("read","r.bib")');
  check("read BibTeX provenance names the min year", /^% .*2010/.test(lastBlob()));

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall export checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
