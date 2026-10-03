// Retraction state test: unique element ids in the Reading List / Rising Papers
// rows, stale /check responses ignored after a newer run, retraction_status and
// retraction_checked_at in the JSON/CSV/XLSX exports, and the badge wording.
//
// Run: node tools/retraction_test.js
//
// Same loading pattern as tools/export_test.js: the inline script sections are
// sliced out of index.html and run in a vm sandbox with a minimal DOM shim.
// No server, no network: fetch is a local mock whose /check answers the test
// delivers by hand.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
const s1 = html.indexOf('"use strict";\nconst $=');
const e1 = html.indexOf("// ── Collaboration network");
const s2 = html.indexOf("// ── Shared retraction check");
const q2 = html.indexOf("function updateQcount");
const e2 = q2 < 0 ? -1 : html.indexOf("\n}\n", q2) + 3;
if (s1 < 0 || e1 <= s1 || s2 < 0 || e2 <= s2) {
  console.error("FAIL: could not locate the module / retraction sections in index.html");
  process.exit(1);
}

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// ── DOM shim: result containers hold HTML; cells exist only while the current
// HTML of their container carries that id, and start fresh on every render ──
const stripTags = s => String(s).replace(/<[^>]*>/g, "");
const els = {};
const cells = {};
function makeEl(id) {
  const el = { value: "", textContent: "", _html: "", style: {}, classList: { add() {}, remove() {} } };
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html; },
    set(h) {
      el._html = String(h);
      for (const k of Object.keys(cells)) if (cells[k].owner === id) delete cells[k];
    },
  });
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
const byId = id => (els[id] = els[id] || makeEl(id));
function cellById(id) {
  if (cells[id]) return cells[id];
  for (const owner of ["read_res", "rise_res"]) {
    if (els[owner] && els[owner]._html.includes('id="' + id + '"')) {
      const c = { owner, _html: "" };
      Object.defineProperty(c, "innerHTML", { get() { return c._html; }, set(h) { c._html = String(h); } });
      return (cells[id] = c);
    }
  }
  return null;
}

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

// ── fetch mock: /curate answers from `curateRows`; every /check call parks on
// a deferred the test settles by hand. An aborted request rejects like fetch. ──
let curateRows = [];
const pending = [];   // {doi, resolve, reject, signal}
const sandbox = {
  ignoreAbort: false,   // true: the response is already on the wire, abort cannot stop it
  console, Date, Math, JSON, Number, String, Object, Array, Promise, URLSearchParams, setTimeout, clearTimeout,
  AbortController, Error,
  alert: m => { throw new Error("unexpected alert: " + m); },
  localStorage: { getItem: () => null, setItem: () => {} },
  window: { location: { origin: "http://localhost" } },
  Blob: class { constructor(parts) { this.text = parts.join(""); blobs.push(this.text); } },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  XLSX,
  fetch: (url, opts) => {
    if (url.startsWith("/check")) {
      const doi = decodeURIComponent(url.split("doi=")[1]);
      return new Promise((resolve, reject) => {
        const signal = opts && opts.signal;
        const p = { doi, resolve, reject, signal };
        pending.push(p);
        if (signal && !sandbox.ignoreAbort) signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    const body = url.startsWith("/curate") ? curateRows : [];
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  },
  document: {
    querySelector: sel => {
      const m = /^#([\w-]+)(?:\s+(.+))?$/.exec(sel);
      if (!m) return null;
      if (/^r?st-\d+$/.test(m[1])) return cellById(m[1]);
      return m[2] ? byId(m[1]).querySelector(m[2]) : byId(m[1]);
    },
    querySelectorAll: () => [],
    getElementById: id => byId(id),
    createElement: () => ({ click() {} }),
    body: { appendChild() {}, removeChild() {} },
  },
};
vm.createContext(sandbox);
vm.runInContext(html.slice(s1, e1), sandbox, { filename: "index.html#modules" });
vm.runInContext(html.slice(s2, e2), sandbox, { filename: "index.html#retraction" });
const run = code => vm.runInContext(code, sandbox);

const tick = () => new Promise(r => setTimeout(r, 5));
const answer = (doi, body) => {   // settle the oldest open request for this DOI
  const p = pending.find(x => x.doi === doi && !x.done && !(x.signal && x.signal.aborted));
  if (!p) return false;
  p.done = true;
  p.resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  return true;
};
// A request that was already aborted still "arrives late" in the race test:
// the caller delivers it by hand, as a real late network response would.
const answerLate = (doi, body) => {
  const p = pending.find(x => x.doi === doi && !x.done);
  if (!p) return false;
  p.done = true;
  p.resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  return true;
};

const paper = (title, doi, extra) => Object.assign({ title, doi, journal: "Lancet", year: 2021, cited_by_count: 10 }, extra);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const lastBlob = () => blobs[blobs.length - 1];

function parseCSV(text) {
  const lines = text.replace(/^﻿/, "").split("\r\n");
  const cols = lines[2].split(",");
  return lines.slice(3).map(l => { const c = l.split(","); const o = {}; cols.forEach((k, i) => (o[k] = c[i])); return o; });
}
function exportAs(fmt, key) {
  if (fmt === "json") { run('downloadJSON("' + key + '","x.json")'); return JSON.parse(lastBlob()).rows; }
  if (fmt === "csv") { run('downloadCSV("' + key + '","x.csv")'); return parseCSV(lastBlob()); }
  run('downloadXLSX("' + key + '","x.xlsx")');
  const ws = xlsxSheet, hdr = [];
  for (let c = 0; c < ws._cols; c++) hdr.push(ws[XLSX.utils.encode_cell({ r: 1, c })].v);
  const rows = [];
  for (let r = 2; r < ws._rows; r++) {
    const o = {};
    hdr.forEach((k, c) => { const cell = ws[XLSX.utils.encode_cell({ r, c })]; o[k] = cell ? cell.v : ""; });
    rows.push(o);
  }
  return rows;
}
const idsIn = h => [...h.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);

(async () => {
  byId("read_topic").value = "gene therapy"; byId("read_sort").value = "citations"; byId("read_lim").value = "15";
  byId("read_year").value = "0"; byId("read_cites").value = "0";
  byId("rise_topic").value = "gene therapy"; byId("rise_year").value = "2000"; byId("rise_cites").value = "0"; byId("rise_lim").value = "15";
  // ── Test A: unique ids in rendered rows ──
  curateRows = [paper("A1", "10.1/a1"), paper("A2", "10.1/a2"), paper("A3", "")];
  await run("runRead()");
  let ids = idsIn(byId("read_res").innerHTML);
  check("A: Reading List ids unique (" + ids.join(",") + ")", new Set(ids).size === ids.length && ids.length > 0);
  await run("runRise()");
  ids = idsIn(byId("rise_res").innerHTML);
  check("A: Rising Papers ids unique (" + ids.join(",") + ")", new Set(ids).size === ids.length && ids.length > 0);

  // ── Test B: race. Run A, then run B, then A's late response arrives. ──
  for (const [mod, runFn, key, pre, resId] of [["Reading List", "runRead()", "read", "st-", "read_res"], ["Rising Papers", "runRise()", "rise", "rst-", "rise_res"]]) {
    pending.length = 0;
    sandbox.ignoreAbort = true;
    curateRows = [paper("A1", "10.1/a1"), paper("A2", "10.1/a2")];
    await run(runFn); await tick();
    const runA = pending.slice();
    curateRows = [paper("B1", "10.1/b1"), paper("B2", "10.1/b2")];
    await run(runFn); await tick();
    check("B: " + mod + " run A's in-flight /check requests are aborted by run B", runA.length === 2 && runA.every(p => p.signal && p.signal.aborted));
    answer("10.1/b1", { retracted: true });
    answer("10.1/b2", { retracted: false });
    await tick();
    const domB = [cellById(pre + 0), cellById(pre + 1)].map(c => c && c.innerHTML);
    const dataB = JSON.stringify(run("lastData." + key));
    // Run A's responses arrive late, with answers that differ from B's.
    answerLate("10.1/a1", { retracted: false });
    answerLate("10.1/a2", { retracted: true });
    await tick();
    const domAfter = [cellById(pre + 0), cellById(pre + 1)].map(c => c && c.innerHTML);
    sandbox.ignoreAbort = false;
    check("B: " + mod + " DOM cells unchanged by run A's late response (" + JSON.stringify(domB) + " -> " + JSON.stringify(domAfter) + ")",
      JSON.stringify(domB) === JSON.stringify(domAfter));
    check("B: " + mod + " row data unchanged by run A's late response",
      dataB === JSON.stringify(run("lastData." + key)));
  }

  // ── Test C: export columns, 4 statuses + a still-pending row ──
  for (const [mod, runFn, key] of [["Reading List", "runRead()", "read"], ["Rising Papers", "runRise()", "rise"]]) {
    pending.length = 0;
    curateRows = [paper("R1", "10.1/r1"), paper("R2", "10.1/r2"), paper("R3", "10.1/r3"), paper("R4", ""), paper("R5", "10.1/r5")];
    await run(runFn); await tick();
    // Before any answer: every DOI row is unverified, the DOI-less row is no_doi.
    const early = exportAs("json", key);
    const byT = (rows, t) => rows.find(r => r.title === t) || {};
    check("C: " + mod + " pending rows export unverified, DOI-less row no_doi",
      ["R1", "R2", "R3", "R5"].every(t => byT(early, t).retraction_status === "unverified") && byT(early, "R4").retraction_status === "no_doi");
    answer("10.1/r1", { retracted: true });
    answer("10.1/r2", { retracted: false });
    answer("10.1/r3", { error: "checker busy" });
    await tick();   // R5 stays unanswered
    const want = { R1: "retracted", R2: "no_retraction_found", R3: "unverified", R4: "no_doi", R5: "unverified" };
    for (const fmt of ["json", "csv", "xlsx"]) {
      const rows = exportAs(fmt, key);
      const okStatus = Object.keys(want).every(t => byT(rows, t).retraction_status === want[t]);
      check("C: " + mod + " " + fmt + " retraction_status " + JSON.stringify(Object.keys(want).map(t => byT(rows, t).retraction_status)), okStatus);
      const stamped = ["R1", "R2", "R3"].every(t => ISO.test(String(byT(rows, t).retraction_checked_at)));
      const unstamped = ["R4", "R5"].every(t => !byT(rows, t).retraction_checked_at);
      check("C: " + mod + " " + fmt + " retraction_checked_at ISO UTC for checked rows, empty otherwise", stamped && unstamped);
    }
    check("C: " + mod + " export provenance names the retraction source", /Crossref/.test(JSON.parse((run('downloadJSON("' + key + '","x.json")'), lastBlob())).export.retraction_source || ""));
  }

  // ── Test D: badge text ──
  pending.length = 0;
  curateRows = [paper("D1", "10.1/d1"), paper("D2", "10.1/d2"), paper("D3", "10.1/d3")];
  await run("runRead()"); await tick();
  answer("10.1/d1", { retracted: false });
  answer("10.1/d2", { error: "busy" });
  answer("10.1/d3", { retracted: true });
  await tick();
  const d1 = cellById("st-0").innerHTML, d2 = cellById("st-1").innerHTML;
  check("D: clean result badge reads 'No retraction found' (" + d1 + ")", /badge-ok">✓ No retraction found</.test(d1));
  check("D: the word 'clean' is gone from the badge", !/clean/i.test(d1) && !/badge-ok">✓ clean/.test(html));
  check("D: failed /check shows 'unverified', not the green badge (" + d2 + ")", /unverified/.test(d2) && !/badge-ok/.test(d2));

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall retraction checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
