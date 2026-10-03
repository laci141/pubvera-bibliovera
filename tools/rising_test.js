// Rising Papers test: candidate pool (most-cited + most-recent), merge and
// de-duplication, mid-year age estimate, ranking, one-pool-fails handling,
// stale-run handling, and the pool/age text in the note and the export provenance.
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
    const call = { sort: q.get("sort"), limit: q.get("limit"), topic: q.get("topic"), signal: opts && opts.signal };
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
const paper = (title, doi, year, cites) => ({ title, doi, journal: "Lancet", year, cited_by_count: cites });
const poolBySort = (cited, recent) => call => (call.sort === "date" ? recent : cited);
const risen = () => run("lastData.rise") || [];
const dois = () => risen().map(r => r.doi);
const resHTML = () => byId("rise_res").innerHTML;

function setForm() {
  byId("rise_topic").value = "gene therapy"; byId("rise_year").value = "2000";
  byId("rise_cites").value = "0"; byId("rise_lim").value = "15"; byId("rise_journal").value = "";
}

(async () => {
  setForm();

  // ── Test A: a high-velocity recent paper that exists only in the date pool ──
  const oldCited = [1, 2, 3, 4, 5].map(i => paper("Old " + i, "10.1/old" + i, NOW_YEAR - 10, 500 + i));
  const recentOnly = paper("Recent hot", "10.1/recent", NOW_YEAR, 40);
  curateHandler = poolBySort(oldCited, [recentOnly, paper("Recent cold", "10.1/cold", NOW_YEAR, 0)]);
  curateCalls.length = 0;
  await run("runRise()"); await tick();
  check("A: recent paper that is only in the date pool appears in the ranked result", dois().includes("10.1/recent"));
  check("A: it ranks first (velocity beats the old high-total papers)", dois()[0] === "10.1/recent");
  const sorts = curateCalls.map(c => c.sort).sort().join(",");
  check("A: exactly two /curate requests, sort=citations and sort=date (" + sorts + ")", sorts === "citations,date");
  check("A: both pools use limit=100 (" + curateCalls.map(c => c.limit).join(",") + ")", curateCalls.length === 2 && curateCalls.every(c => c.limit === "100"));

  // ── Test B: duplicates across the pools appear once (DOI, then normalized title) ──
  const shared = paper("Shared paper", "10.1/Shared", NOW_YEAR - 2, 100);
  const sharedUpper = paper("Shared paper", "https://doi.org/10.1/shared", NOW_YEAR - 2, 100);
  const noDoiA = paper("A  Paper: Without DOI!", "", NOW_YEAR - 3, 90);
  const noDoiB = paper("a paper without doi", "", NOW_YEAR - 3, 90);
  curateHandler = poolBySort([shared, noDoiA, paper("Only cited", "10.1/oc", NOW_YEAR - 4, 80)],
    [sharedUpper, noDoiB, paper("Only recent", "10.1/or", NOW_YEAR, 5)]);
  await run("runRise()"); await tick();
  const sharedCount = risen().filter(r => /^10\.1\/shared$/i.test(r.doi)).length;
  const noDoiCount = risen().filter(r => /paper without doi/i.test(r.title.replace(/[^\w ]/g, ""))).length;
  check("B: DOI duplicate across pools appears once (" + sharedCount + ")", sharedCount === 1);
  check("B: DOI-less duplicate (same normalized title) appears once (" + noDoiCount + ")", noDoiCount === 1);
  check("B: 4 unique papers in total (" + risen().length + ")", risen().length === 4);
  check("B: the note carries the real unique count", /\(4 unique\)/.test(resHTML()));

  // ── Test C: estimatePaperAgeYears at a fixed "now" ──
  if (run("typeof estimatePaperAgeYears") !== "function") {
    check("C: estimatePaperAgeYears exists", false);
  } else {
    const age = (y, now) => run("estimatePaperAgeYears")(y, now);
    const now = new Date(2026, 9, 3);   // 3 Oct 2026, local time
    check("C: current-year paper is younger than 1 year (" + age(2026, now) + ")", age(2026, now) > 0.25 && age(2026, now) < 1);
    check("C: previous-year paper is between 1 and 2 years (" + age(2025, now) + ")", age(2025, now) > 1 && age(2025, now) < 2);
    const early = new Date(2026, 0, 2);
    check("C: floor 0.25 for a current-year paper in early January (" + age(2026, early) + ")", age(2026, early) === 0.25);
    check("C: previous-year paper is (now - 1 July)/year (" + age(2025, now).toFixed(3) + ")",
      Math.abs(age(2025, now) - (now - new Date(2025, 6, 1)) / (365.25 * 86400000)) < 1e-9);
    const bad = [0, -5, null, undefined, NaN, "abc", "", 2026.5].map(y => age(y, now));
    check("C: missing / invalid year gives null, never a number (" + JSON.stringify(bad) + ")", bad.every(v => v === null));
    check("C: numeric string year is accepted", age("2025", now) === age(2025, now));
  }

  // ── Test D: same cited_by_count, different years -> the newer paper ranks higher ──
  curateHandler = poolBySort([paper("Older", "10.1/older", NOW_YEAR - 3, 100), paper("Newer", "10.1/newer", NOW_YEAR - 1, 100)], []);
  await run("runRise()"); await tick();
  check("D: newer paper ranks above the older one with equal citations (" + dois().join(" > ") + ")",
    dois().indexOf("10.1/newer") === 0 && dois().indexOf("10.1/older") === 1);
  curateHandler = poolBySort([paper("Last year", "10.1/ly", NOW_YEAR - 1, 100), paper("This year", "10.1/ty", NOW_YEAR, 100)], []);
  await run("runRise()"); await tick();
  check("D: current-year paper ranks above last year's with equal citations (" + dois().join(" > ") + ")", dois()[0] === "10.1/ty");

  // ── Test E: one pool fails -> the other pool plus a visible note ──
  const cited = [paper("Cited 1", "10.1/c1", NOW_YEAR - 5, 300)];
  const recent = [paper("Recent 1", "10.1/r1", NOW_YEAR, 30)];
  curateHandler = call => (call.sort === "date" ? Promise.reject(new Error("date pool failed")) : cited);
  await run("runRise()"); await tick();
  check("E: date pool fails -> rows from the citations pool (" + dois().join(",") + ")", dois().join(",") === "10.1/c1");
  check("E: visible note names the failed pool", /most-recent pool could not be loaded/i.test(resHTML()));
  curateHandler = call => (call.sort === "citations" ? Promise.reject(new Error("cited pool failed")) : recent);
  await run("runRise()"); await tick();
  check("E: citations pool fails -> rows from the date pool (" + dois().join(",") + ")", dois().join(",") === "10.1/r1");
  check("E: visible note names the failed pool (citations)", /most-cited pool could not be loaded/i.test(resHTML()));
  curateHandler = () => Promise.reject(new Error("both down"));
  await run("runRise()"); await tick();
  check("E: both pools fail -> the existing error path", /<p class="err">both down<\/p>/.test(resHTML()));

  // ── Test E2: stale run. Run 1's responses arrive after run 2 has finished. ──
  const held = [];
  sandbox.ignoreAbort = true;
  curateHandler = call => new Promise(resolve => held.push({ call, resolve }));
  const run1 = run("runRise()"); await tick();
  const run1Calls = curateCalls.slice(-2);
  curateHandler = poolBySort([paper("Run two", "10.1/two", NOW_YEAR - 1, 50)], []);
  await run("runRise()"); await tick();
  check("E2: run 1's two /curate requests are aborted by run 2", run1Calls.length === 2 && run1Calls.every(c => c.signal && c.signal.aborted));
  const before = resHTML(), dataBefore = JSON.stringify(risen());
  held.forEach(h => h.resolve(h.call.sort === "date" ? [paper("Stale", "10.1/stale", NOW_YEAR, 99)] : [paper("Stale cited", "10.1/stale2", NOW_YEAR - 1, 99)]));
  await run1; await tick();
  sandbox.ignoreAbort = false;
  check("E2: run 1's late responses leave the result HTML unchanged", resHTML() === before && !/stale/i.test(resHTML()));
  check("E2: run 1's late responses leave the row data unchanged", JSON.stringify(risen()) === dataBefore && dois().join(",") === "10.1/two");

  // ── Test F: invalid year excluded from the ranking and counted in the note ──
  curateHandler = poolBySort([paper("No year", "10.1/ny", 0, 500), paper("Has year", "10.1/hy", NOW_YEAR - 2, 50)], [paper("Bad year", "10.1/by", "n/a", 70)]);
  await run("runRise()"); await tick();
  check("F: rows without a valid year are not ranked (" + dois().join(",") + ")", dois().join(",") === "10.1/hy");
  check("F: the note counts the excluded rows", /2 papers? without a valid publication year/i.test(resHTML()));

  // ── Test G: transparency text under the table and in the export provenance ──
  curateHandler = poolBySort(oldCited, [recentOnly]);
  await run("runRise()"); await tick();
  const noteText = "Candidate pool: up to 100 most-cited + 100 most-recent matches (6 unique). Age is estimated from publication year (mid-year), so cites/year is approximate.";
  check("G: note under the table has the exact wording and the real N", resHTML().includes(noteText));
  const head = run('exportHeader("rise", lastData.rise)');
  check("G: export header carries the pool and age method", head.includes("Candidate pool: up to 100 most-cited + 100 most-recent matches (6 unique)") && head.includes("Age is estimated from publication year"));
  run('downloadJSON("rise","x.json")');
  const payload = JSON.parse(blobs[blobs.length - 1]);
  check("G: JSON export provenance carries the same text", /Candidate pool: up to 100 most-cited/.test(JSON.stringify(payload.export)) && /mid-year/.test(JSON.stringify(payload.export)));
  check("G: exported rows keep the existing columns",
    ["title", "doi", "year", "journal", "authors", "cited_by_count", "citations_per_year"].every(k => k in payload.rows[0]));
  const hot = payload.rows.find(r => r.doi === "10.1/recent");
  check("G: citations_per_year comes from the age estimate (" + (hot && hot.citations_per_year) + ")", !!hot && hot.citations_per_year > 40);

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall rising-papers checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
