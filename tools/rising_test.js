// Rising Papers test: one /curate?sort=per-year request, server-side
// citations_per_year as the rate, pub_date display (year fallback), client-side
// min-year / min-citations filters, stale-run handling, and the method text in
// the note and the export provenance.
//
// Run: node tools/rising_test.js
//
// Same loading pattern as tools/retraction_test.js: the inline script sections
// are sliced out of index.html and run in a vm sandbox with a minimal DOM shim.
// No server, no network: fetch is a local mock that answers /curate by hand.
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

// ── DOM shim: result containers hold HTML ──
const els = {};
function makeEl(id) {
  const el = { value: "", textContent: "", _html: "", style: {}, classList: { add() {}, remove() {} } };
  Object.defineProperty(el, "innerHTML", { get() { return el._html; }, set(h) { el._html = String(h); } });
  el.querySelector = sel => {
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
    if (sel === ".meta") {
      const m = /<span class="meta">([\s\S]*?)<span class="qcount">/.exec(el._html);
      return m ? { textContent: m[1].replace(/<[^>]*>/g, "") } : null;
    }
    return null;
  };
  return el;
}
const byId = id => (els[id] = els[id] || makeEl(id));

// ── fetch mock: every /curate call is recorded and handed to `curateHandler`,
// which returns a promise of the rows (or a rejection). /check answers "no
// retraction" at once. An aborted /curate rejects like fetch, unless ignoreAbort. ──
const blobs = [];
const curateCalls = [];
let curateHandler = () => Promise.resolve([]);
const sandbox = {
  ignoreAbort: false,
  console, Date, Math, JSON, Number, String, Object, Array, Promise, URLSearchParams, setTimeout, clearTimeout,
  AbortController, Error,
  alert: m => { throw new Error("unexpected alert: " + m); },
  localStorage: { getItem: () => null, setItem: () => {} },
  window: { location: { origin: "http://localhost" } },
  Blob: class { constructor(parts) { this.text = parts.join(""); blobs.push(this.text); } },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  XLSX: {},
  fetch: (url, opts) => {
    if (url.startsWith("/check")) {
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ retracted: false }) });
    }
    const q = new URLSearchParams(url.split("?")[1] || "");
    const call = { sort: q.get("sort"), limit: q.get("limit"), topic: q.get("topic"), journal: q.get("journal"), signal: opts && opts.signal };
    curateCalls.push(call);
    return new Promise((resolve, reject) => {
      const signal = call.signal;
      if (signal && !sandbox.ignoreAbort) signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      Promise.resolve(curateHandler(call)).then(rows => {
        resolve({ ok: true, status: 200, text: async () => JSON.stringify(rows) });
      }, reject);
    });
  },
  document: {
    querySelector: sel => {
      const m = /^#([\w-]+)(?:\s+(.+))?$/.exec(sel);
      if (!m) return null;
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

const tick = () => new Promise(r => setTimeout(r, 10));
const NOW_YEAR = new Date().getFullYear();
const paper = (title, doi, year, cites, cpy, pub) => ({ title, doi, journal: "Lancet", year, cited_by_count: cites, citations_per_year: cpy, pub_date: pub === undefined ? "" : pub });
const risen = () => run("lastData.rise") || [];
const dois = () => risen().map(r => r.doi);
const resHTML = () => byId("rise_res").innerHTML;

function setForm() {
  byId("rise_topic").value = "gene therapy"; byId("rise_year").value = "2000";
  byId("rise_cites").value = "0"; byId("rise_lim").value = "15"; byId("rise_journal").value = "";
}

(async () => {
  setForm();

  // ── Test A: one request, sort=per-year, limit=100; order and rate come from the server ──
  const rows = [
    paper("Hot", "10.1/hot", 2024, 40, 25.5, "2024-09-01"),
    paper("Mid", "10.1/mid", 2015, 900, 9.1, "2015-03-02"),
    paper("Cold", "10.1/cold", 2010, 5000, 2.2, ""),
  ];
  curateHandler = () => rows;
  curateCalls.length = 0;
  byId("rise_journal").value = "lancet";
  await run("runRise()"); await tick();
  byId("rise_journal").value = "";
  check("A: exactly one /curate request (" + curateCalls.length + ")", curateCalls.length === 1);
  check("A: sort=per-year, limit=100 (" + curateCalls[0].sort + "," + curateCalls[0].limit + ")", curateCalls[0].sort === "per-year" && curateCalls[0].limit === "100");
  check("A: topic and journal are forwarded", curateCalls[0].topic === "gene therapy" && curateCalls[0].journal === "lancet");
  check("A: server order is kept, not re-ranked by cited_count (" + dois().join(">") + ")", dois().join(">") === "10.1/hot>10.1/mid>10.1/cold");
  check("A: rate is the server's citations_per_year", risen()[0].citations_per_year === 25.5 && risen()[1].citations_per_year === 9.1);
  check("A: shown rate in the table", resHTML().includes('<span class="badge-velocity">25.5</span>'));

  // ── Test B: pub_date shown, year fallback when empty ──
  check("B: pub_date is displayed", resHTML().includes('<span class="year-pill">2024-09-01</span>'));
  check("B: empty pub_date falls back to the year", resHTML().includes('<span class="year-pill">2010</span>'));
  check("B: export rows carry pub_date and keep the existing columns",
    ["title", "doi", "year", "pub_date", "journal", "authors", "cited_by_count", "citations_per_year"].every(k => k in risen()[0]));

  // ── Test C: the slider only limits the rows shown ──
  byId("rise_lim").value = "2";
  await run("runRise()"); await tick();
  check("C: limit 2 shows the first two server rows (" + dois().join(",") + ")", dois().join(",") === "10.1/hot,10.1/mid");
  check("C: the request limit stays 100 (" + curateCalls[curateCalls.length - 1].limit + ")", curateCalls[curateCalls.length - 1].limit === "100");
  byId("rise_lim").value = "15";

  // ── Test D: client-side min year and min citations ──
  byId("rise_year").value = "2012";
  await run("runRise()"); await tick();
  check("D: min year drops older rows (" + dois().join(",") + ")", dois().join(",") === "10.1/hot,10.1/mid");
  byId("rise_year").value = "2000"; byId("rise_cites").value = "100";
  await run("runRise()"); await tick();
  check("D: min citations drops low-cited rows (" + dois().join(",") + ")", dois().join(",") === "10.1/mid,10.1/cold");
  byId("rise_cites").value = "0";

  // ── Test E: failure -> the existing error path ──
  curateHandler = () => Promise.reject(new Error("curate down"));
  await run("runRise()"); await tick();
  check("E: request failure shows the error", /<p class="err">curate down<\/p>/.test(resHTML()));

  // ── Test F: stale run. Run 1's response arrives after run 2 has finished. ──
  const held = [];
  sandbox.ignoreAbort = true;
  curateHandler = call => new Promise(resolve => held.push({ call, resolve }));
  const run1 = run("runRise()"); await tick();
  const run1Call = curateCalls[curateCalls.length - 1];
  curateHandler = () => [paper("Run two", "10.1/two", 2020, 50, 8, "2020-01-01")];
  await run("runRise()"); await tick();
  check("F: run 1's /curate request is aborted by run 2", !!run1Call.signal && run1Call.signal.aborted);
  const before = resHTML(), dataBefore = JSON.stringify(risen());
  held.forEach(h => h.resolve([paper("Stale", "10.1/stale", 2024, 99, 99, "2024-01-01")]));
  await run1; await tick();
  sandbox.ignoreAbort = false;
  check("F: run 1's late response leaves the result HTML unchanged", resHTML() === before && !/stale/i.test(resHTML()));
  check("F: run 1's late response leaves the row data unchanged", JSON.stringify(risen()) === dataBefore && dois().join(",") === "10.1/two");

  // ── Test G: rows without any valid year are excluded and counted ──
  curateHandler = () => [paper("No year", "10.1/ny", 0, 500, 50, ""), paper("Has year", "10.1/hy", 2020, 50, 5, "2020-05-05")];
  await run("runRise()"); await tick();
  check("G: row without a year is not shown (" + dois().join(",") + ")", dois().join(",") === "10.1/hy");
  check("G: the note counts the excluded row", /1 paper without a valid publication year/i.test(resHTML()));
  curateHandler = () => [paper("Date only", "10.1/do", undefined, 10, 3, "2019-02-03")];
  await run("runRise()"); await tick();
  check("G: pub_date-only row is shown with year 2019 (" + JSON.stringify(risen().map(r => r.year)) + ")", risen().length === 1 && risen()[0].year === 2019);

  // ── Test H: method text under the table and in the export provenance ──
  curateHandler = () => rows;
  await run("runRise()"); await tick();
  const method = "Ranked by average citations per year since publication (local Lancet mirror).";
  check("H: note under the table states the method and the age rule", resHTML().includes(method) && resHTML().includes("1 July of the publication year") && resHTML().includes("at least 0.25 years"));
  check("H: note says the filters are client-side on the top 100", resHTML().includes("applied to the top 100 ranked rows"));
  const head = run('exportHeader("rise", lastData.rise)');
  check("H: export header carries the method", head.includes(method));
  run('downloadJSON("rise","x.json")');
  const payload = JSON.parse(blobs[blobs.length - 1]);
  check("H: JSON export provenance carries the method", JSON.stringify(payload.export).includes(method));

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall rising-papers checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
