// Export query test: the "query" field of the exports (JSON export.query, the
// XLSX About "query" row, the BibTeX comment line) holds only the keyword the
// search was run with, not the meta row text ("15 papers · "autism" · ...").
//
// Run: node tools/export_query_test.js
//
// Same harness as tools/xlsx_layout_test.js: slice the inline export section out
// of index.html (plus runMesh, which sits after that section) and execute it in
// a vm sandbox with a minimal DOM shim, then drive the real run functions.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The worktree may hold CRLF (core.autocrlf); the index holds LF.
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
const start = html.indexOf('"use strict";\nconst $=');
const end = html.indexOf("// ── Collaboration network");
const ms = html.indexOf("async function runMesh(){");
const me = html.indexOf("\n}\n", ms);
if (start < 0 || end < 0 || end <= start || ms < 0 || me < 0) {
  console.error("FAIL: could not locate the export/module section or runMesh in index.html");
  process.exit(1);
}
const section = html.slice(start, end) + "\n" + html.slice(ms, me + 3);

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

const paper = (title, doi) => ({ title, doi, journal: "Lancet", year: 2018, cited_by_count: 900, authors: ["Jun Li"], citations_per_year: 1, pub_date: "2018-01-01" });
const authorRows = [{ author: "Jun Li", works: 12, citations: 300, institution: "Harvard University" }];
const affRows = [{ institution: "Harvard University", recent: 10, prior: 1, growth: 9 }];
const driftRows = [{ topic: "Autism", w1: 1, w2: 5, delta: 4 }];

// ── DOM shim ──
const stripTags = s => String(s).replace(/<[^>]*>/g, "");
function makeEl() {
  const el = { value: "", textContent: "", _html: "", style: {}, classList: { add() {}, remove() {} } };
  Object.defineProperty(el, "innerHTML", { get() { return el._html; }, set(h) { el._html = String(h); } });
  el.querySelector = sel => {
    if (sel === ".meta") {
      const m = /<span class="meta">([\s\S]*?)<span class="qcount">/.exec(el._html) || /<p class="meta">([\s\S]*?)<\/p>/.exec(el._html);
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
  console, Date, Math, JSON, Number, String, Object, Array, Set, Promise, URLSearchParams, setTimeout, clearTimeout, AbortController,
  alert: m => { throw new Error("unexpected alert: " + m); },
  localStorage: { getItem: () => null, setItem: () => {} },
  window: { location: { origin: "http://localhost" } },
  Blob: class { constructor(parts, opts) { this.text = parts.join(""); this.type = opts && opts.type; blobs.push(this); } },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  XLSX,
  fetch: async url => {
    let body = [];
    if (url.startsWith("/curate")) body = [paper("Autism spectrum disorder", "10.1/a"), paper("Gene therapy", "10.1/b")];
    else if (url.startsWith("/authors")) body = authorRows;
    else if (url.startsWith("/affiliations")) body = affRows;
    else if (url.startsWith("/drift")) body = driftRows;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  },
  // Defined after the sliced section in index.html; not under test here.
  updateQcount: () => {},
  checkRetractions: async () => {},
  stopMeshSim: () => {},
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
const tick = () => new Promise(r => setTimeout(r, 10));
const q = key => run("moduleQuery(" + JSON.stringify(key) + ")");
const keywordOnly = (got, want) => got === want && !/[·"]|\d+\s*(papers|rows)/.test(got);

(async () => {
  // No search ran yet.
  for (const key of ["aff", "auth", "drift", "read", "rise", "mesh"]) {
    check(key + ": query is \"\" before any search (got " + JSON.stringify(q(key)) + ")", q(key) === "");
  }

  byId("read_topic").value = "  autism  ";
  byId("read_sort").value = "citations"; byId("read_lim").value = "15";
  byId("read_year").value = "0"; byId("read_cites").value = "0";
  await run("runRead()"); await tick();
  check("read: query is the topic \"autism\" only (got " + JSON.stringify(q("read")) + ")", keywordOnly(q("read"), "autism"));

  byId("rise_topic").value = "gene therapy"; byId("rise_year").value = "";
  byId("rise_cites").value = "0"; byId("rise_lim").value = "15"; byId("rise_journal").value = "";
  await run("runRise()"); await tick();
  check("rise: query is the topic \"gene therapy\" only (got " + JSON.stringify(q("rise")) + ")", keywordOnly(q("rise"), "gene therapy"));

  byId("auth_inst").value = " Harvard University "; byId("auth_journal").value = "lancet";
  byId("auth_minw").value = "3"; byId("auth_lim").value = "25";
  await run("runAuth()"); await tick();
  check("auth: query is the institution \"Harvard University\" only (got " + JSON.stringify(q("auth")) + ")", keywordOnly(q("auth"), "Harvard University"));
  byId("auth_inst").value = "";
  await run("runAuth()"); await tick();
  check("auth: query is \"\" when no institution was given (got " + JSON.stringify(q("auth")) + ")", q("auth") === "");

  byId("mesh_org").value = "Karolinska Institutet"; byId("mesh_lim").value = "50";
  await run("runMesh()"); await tick();
  check("mesh: query is the org \"Karolinska Institutet\" only (got " + JSON.stringify(q("mesh")) + ")", keywordOnly(q("mesh"), "Karolinska Institutet"));

  byId("aff_journal").value = "lancet"; byId("aff_years").value = "3"; byId("aff_thr").value = "5";
  byId("aff_minp").value = "2"; byId("aff_lim").value = "25";
  await run("runAff()"); await tick();
  check("aff: query is \"\" after a search (got " + JSON.stringify(q("aff")) + ")", q("aff") === "");

  byId("drift_journal").value = "lancet"; byId("drift_w1").value = "2005";
  byId("drift_w2").value = "2015"; byId("drift_top").value = "10";
  await run("runDrift()"); await tick();
  check("drift: query is \"\" after a search (got " + JSON.stringify(q("drift")) + ")", q("drift") === "");

  // The three export surfaces, on the reading list (a real run above).
  run('downloadJSON("read","r.json")');
  const json = JSON.parse(blobs[blobs.length - 1].text);
  check("JSON export.query is \"autism\" (got " + JSON.stringify(json.export.query) + ")", json.export.query === "autism");

  run('downloadXLSX("read","r.xlsx")');
  const wb = lastBook || { names: [], sheets: [] };
  const about = wb.sheets[wb.names.indexOf("About")];
  let aboutQuery;
  if (about) for (let r = 0; r < about._rows; r++) if (about["A" + (r + 1)] && about["A" + (r + 1)].v === "query") aboutQuery = about["B" + (r + 1)].v;
  check("XLSX About query is \"autism\" (got " + JSON.stringify(aboutQuery) + ")", aboutQuery === "autism");

  run('downloadBibTeX("read","r.bib")');
  const line1 = blobs[blobs.length - 1].text.split("\n")[0];
  check("BibTeX comment line has query: \"autism\" (got " + JSON.stringify(line1) + ")", line1.includes(' · query: "autism" · '));

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall export query checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
