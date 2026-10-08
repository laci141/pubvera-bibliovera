// Expression-of-concern test: the /check fields expression_of_concern,
// concern_date, concern_notice_url / concern_notice_doi show up in the status
// badge (Reading List + Rising Papers) and as three export columns after
// retraction_checked_at, without changing retraction_status.
//
// Run: node tools/concern_test.js
//
// Same loading pattern as tools/retraction_test.js: the inline script sections
// are sliced out of index.html and run in a vm sandbox with a minimal DOM shim.
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

  const SURGI = { retracted: true, expression_of_concern: true, concern_date: "2020-06-03", concern_source: "retraction-watch",
    concern_notice_doi: "10.1016/s0140-6736(20)31290-3", concern_notice_url: "https://doi.org/10.1016/s0140-6736(20)31290-3" };
  const cases = [
    ["conc", { expression_of_concern: true, concern_date: "2021-02-01", concern_notice_url: "https://example.org/notice?a=1&b=2", concern_notice_doi: "10.9/n" }],
    ["both", SURGI],
    ["retr", { retracted: true }],
    ["none", { retracted: false }],
    ["false", { retracted: false, expression_of_concern: false, concern_date: "2020-01-01" }],
    ["doionly", { expression_of_concern: true, concern_notice_doi: "10.9/n(1)" }],
    ["nolink", { expression_of_concern: true, concern_date: "2022-03-04" }],
    ["evil", { expression_of_concern: true, concern_date: "2022-03-04", concern_notice_url: "javascript:alert(1)", concern_notice_doi: "" }],
    ["evil2", { retracted: true, expression_of_concern: true, concern_date: "2022-03-04", concern_notice_url: "javascript:alert(1)" }],
    ["strtrue", { retracted: false, expression_of_concern: "true" }],
    ["err", { error: "checker busy" }],
  ];
  const T = {};   // "mod:case" -> cell html
  for (const mod of ["read", "rise"]) {
    const pre = mod === "read" ? "st-" : "rst-";
    pending.length = 0;
    curateRows = cases.map(([n]) => paper("T-" + n, "10.1/" + n)).concat([paper("T-nodoi", "")]);
    await run(mod === "read" ? "runRead()" : "runRise()"); await tick();
    for (const [n, body] of cases) { answer("10.1/" + n, body); await tick(); }
    cases.forEach(([n], i) => { T[mod + ":" + n] = (cellById(pre + i) || { innerHTML: "" }).innerHTML; });
    const hrefs = h => [...h.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
    const lab = s => mod + " " + s;

    // a) concern only
    let h = T[mod + ":conc"];
    check(lab("a: concern-only badge reads 'Expression of concern' (" + h + ")"), /Expression of concern/.test(h) && /badge-concern/.test(h));
    check(lab("a: concern-only badge carries the date"), /2021-02-01/.test(h));
    check(lab("a: concern-only link href = concern_notice_url, & escaped"), hrefs(h).includes("https://example.org/notice?a=1&amp;b=2"));
    check(lab("a: link opens safely (_blank + noopener noreferrer)"), /target="_blank"/.test(h) && /rel="noopener noreferrer"/.test(h));
    check(lab("a: concern-only is not the retracted or the OK badge"), !/badge-retracted/.test(h) && !/No retraction found/.test(h));

    // b) retracted + concern
    h = T[mod + ":both"];
    check(lab("b: retracted badge stays (" + h + ")"), /badge-retracted">⚠️ RETRACTED</.test(h));
    check(lab("b: secondary line 'Also: expression of concern (2020-06-03)'"), /Also: expression of concern \(2020-06-03\)/.test(h));
    check(lab("b: secondary line links to the notice"), hrefs(h).includes(SURGI.concern_notice_url));
    check(lab("b: no amber badge when retracted"), !/badge-concern/.test(h));

    // c) concern keys absent
    for (const n of ["retr", "none"]) {
      h = T[mod + ":" + n];
      const ok = n === "none" ? /badge-ok">✓ No retraction found</.test(h) : /badge-retracted">⚠️ RETRACTED</.test(h);
      check(lab("c: keys absent -> '" + n + "' unchanged (" + h + ")"), ok && !/oncern/.test(h));
    }

    // d) false / missing date / missing url with doi
    h = T[mod + ":false"];
    check(lab("d: expression_of_concern false -> No retraction found, no concern text"), /No retraction found/.test(h) && !/oncern/.test(h) && !/2020-01-01/.test(h));
    h = T[mod + ":strtrue"];
    check(lab("d: only boolean true counts (string 'true' ignored)"), /No retraction found/.test(h) && !/oncern/.test(h));
    h = T[mod + ":doionly"];
    check(lab("d: missing date + url, doi present -> badge, no 'undefined'/'null' (" + h + ")"), /Expression of concern/.test(h) && !/undefined|null/.test(h));
    check(lab("d: doi.org fallback link"), hrefs(h).some(u => u.startsWith("https://doi.org/10.9/n")));
    h = T[mod + ":nolink"];
    check(lab("d: both url and doi missing -> badge, date, no link"), /Expression of concern/.test(h) && /2022-03-04/.test(h) && !/<a /.test(h));

    // e) javascript: URL
    for (const n of ["evil", "evil2"]) {
      h = T[mod + ":" + n];
      check(lab("e: javascript: URL renders no link (" + n + ")"), !/<a /.test(h) && !/javascript/i.test(h) && /oncern/.test(h));
    }
    check(lab("err: /check error -> unverified, no concern text"), /unverified/.test(T[mod + ":err"]) && !/oncern/.test(T[mod + ":err"]));

    // f) export rows
    for (const fmt of ["json", "csv", "xlsx"]) {
      const rows = exportAs(fmt, mod);
      const R = n => rows.find(r => r.title === "T-" + n) || {};
      const yes = fmt === "json" ? true : "Yes", no = fmt === "json" ? false : "No";
      check(lab("f: " + fmt + " retraction_status unchanged"),
        R("conc").retraction_status === "no_retraction_found" && R("both").retraction_status === "retracted" &&
        R("retr").retraction_status === "retracted" && R("none").retraction_status === "no_retraction_found" &&
        R("err").retraction_status === "unverified" && R("nodoi").retraction_status === "no_doi");
      check(lab("f: " + fmt + " concern row values " + JSON.stringify([R("conc").expression_of_concern, R("conc").concern_date, R("conc").concern_notice_doi])),
        R("conc").expression_of_concern === yes && R("conc").concern_date === "2021-02-01" && R("conc").concern_notice_doi === "10.9/n");
      check(lab("f: " + fmt + " retracted+concern row values"),
        R("both").expression_of_concern === yes && R("both").concern_date === "2020-06-03" && R("both").concern_notice_doi === SURGI.concern_notice_doi);
      check(lab("f: " + fmt + " checked row without concern -> false, empty date/doi"),
        R("none").expression_of_concern === no && !R("none").concern_date && !R("none").concern_notice_doi &&
        R("retr").expression_of_concern === no);
      check(lab("f: " + fmt + " unchecked rows (error, no DOI) keep the columns empty"),
        ["err", "nodoi"].every(n => R(n).expression_of_concern === "" && !R(n).concern_date && !R(n).concern_notice_doi));
    }
    run('downloadCSV("' + mod + '","x.csv")');
    const hdr = lastBlob().replace(/^﻿/, "").split("\r\n")[2].split(",");
    const tail = hdr.slice(hdr.indexOf("retraction_status"));
    // Rising appends its 4 velocity columns after the concern columns; Read ends with them.
    const wantTail = "retraction_status,retraction_checked_at,expression_of_concern,concern_date,concern_notice_doi" +
      (mod === "rise" ? ",velocity,citations_last_year,fwci,citation_normalized_percentile" : "");
    check(lab("f: CSV columns end " + wantTail + " (" + tail.join(",") + ")"),
      tail.join(",") === wantTail);
    run('downloadXLSX("' + mod + '","x.xlsx")');
    const xh = []; for (let c = 0; c < xlsxSheet._cols; c++) xh.push(xlsxSheet[XLSX.utils.encode_cell({ r: 1, c })].v);
    check(lab("f: XLSX header order identical to CSV"), xh.slice(xh.indexOf("retraction_status")).join(",") === tail.join(","));
  }

  // g) formula injection in the title and the new columns
  pending.length = 0;
  curateRows = [paper("=SUM(1)", "10.1/inj")];
  await run("runRead()"); await tick();
  answer("10.1/inj", { retracted: false, expression_of_concern: true, concern_date: "=2020", concern_notice_doi: "=10.9/x", concern_notice_url: "https://doi.org/x" });
  await tick();
  run('downloadCSV("read","x.csv")');
  const csvText = lastBlob();
  check("g: CSV title '=SUM(1)' neutralized", /'=SUM\(1\)/.test(csvText) && !/[,\n]=SUM/.test(csvText));
  check("g: CSV concern_date '=2020' neutralized", /'=2020/.test(csvText) && !/[,\n]=2020/.test(csvText));
  check("g: CSV concern_notice_doi '=10.9/x' neutralized", /'=10\.9\/x/.test(csvText) && !/[,\n]=10\.9\/x/.test(csvText));
  run('downloadXLSX("read","x.xlsx")');
  const xr = []; for (let c = 0; c < xlsxSheet._cols; c++) xr.push(xlsxSheet[XLSX.utils.encode_cell({ r: 1, c })].v);
  const xv = k => xlsxSheet[XLSX.utils.encode_cell({ r: 2, c: xr.indexOf(k) })];
  check("g: XLSX concern_date / concern_notice_doi neutralized",
    !!xv("concern_date") && xv("concern_date").v === "'=2020" && !!xv("concern_notice_doi") && xv("concern_notice_doi").v === "'=10.9/x");

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall concern checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
