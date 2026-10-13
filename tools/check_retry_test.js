// /check retry test: ONE bounded automatic retry for HTTP 503/429 and a per-row
// Retry button for rows that stay unverified.
//
// Run: node tools/check_retry_test.js
//
// Same loading pattern as tools/retraction_test.js: the inline script sections
// are sliced out of index.html and run in a vm sandbox with a minimal DOM shim.
// No server, no network. fetch is a local mock that parks every /check request
// until the test settles it from a per-DOI script, and setTimeout is a manual
// clock, so retry delays are asserted exactly and nothing sleeps for real.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
const s1 = html.indexOf('"use strict";\nconst $=');
const e1 = html.indexOf("// ── Collaboration network");
const s2 = html.indexOf("// ── Shared retraction check");
const e2 = html.indexOf("// ── Export menu (WAI-ARIA");
if (s1 < 0 || e1 <= s1 || s2 < 0 || e2 <= s2) {
  console.error("FAIL: could not locate the module / retraction sections in index.html");
  process.exit(1);
}

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// ── Manual clock. Every setTimeout lands here; advance() fires what is due. ──
let now = 0, timers = [], timerId = 0;
const timerLog = [];   // {ms} of every timer set since reset()
const fakeSetTimeout = (fn, ms) => { const t = { id: ++timerId, at: now + ms, fn }; timers.push(t); timerLog.push({ ms }); return t.id; };
const fakeClearTimeout = id => { timers = timers.filter(t => t.id !== id); };
const flush = async () => { for (let k = 0; k < 6; k++) await new Promise(r => setImmediate(r)); };
async function advance(ms) {
  const target = now + ms;
  for (;;) {
    await flush();
    const due = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) break;
    timers = timers.filter(t => t !== due);
    now = due.at;
    due.fn();
  }
  now = target;
  await flush();
}
// The retry waits: every timer except the 20 s request timeout of fetchJSONTimeout.
const waits = () => timerLog.map(t => t.ms).filter(ms => ms !== 20000);

// ── DOM shim: results containers hold HTML; a status cell exists only while the
// current HTML of its container carries that id (same idea as retraction_test) ──
const els = {};
const cells = {};
function makeEl(id) {
  const el = { value: "", textContent: "", _html: "", style: {}, classList: { add() {}, remove() {} } };
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html; },
    set(h) { el._html = String(h); for (const k of Object.keys(cells)) if (cells[k].owner === id) delete cells[k]; },
  });
  el.querySelector = sel => {
    if (sel === ".meta") {
      const m = /<span class="meta">([\s\S]*?)<span class="qcount">/.exec(el._html);
      return m ? { textContent: m[1].replace(/<[^>]*>/g, "") } : null;
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
const cellHTML = id => { const c = cellById(id); return c ? c.innerHTML : null; };

// Delegated listeners the page registers on document while the slice loads.
const docListeners = [];

const blobs = [];
let curateRows = [];

// ── fetch mock: each /check call parks until settle(); the outcome comes from
// script[doi], consumed in order (default: 200 {retracted:false}). ──
let script = {};
let calls = {};
let parked = [];
let inflight = 0, maxInflight = 0;
const respOf = step => {
  const headers = step.h || {};
  return {
    ok: step.s >= 200 && step.s < 300,
    status: step.s,
    headers: { get: n => { const k = Object.keys(headers).find(x => x.toLowerCase() === String(n).toLowerCase()); return k ? headers[k] : null; } },
    text: async () => JSON.stringify(step.b === undefined ? {} : step.b),
  };
};
function settle(p) {
  if (p.done) return;
  p.done = true; inflight--;
  const q = script[p.doi] || [];
  const step = q.length ? q.shift() : { s: 200, b: { retracted: false } };
  if (step.abort) return p.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  if (step.net) return p.reject(new TypeError("Failed to fetch"));
  p.resolve(respOf(step));
}
const releaseAll = () => parked.slice().forEach(settle);
const step = async () => { await flush(); releaseAll(); await flush(); };

const sandbox = {
  console, Date, Math, JSON, Number, String, Object, Array, Promise, URLSearchParams, Error, TypeError,
  setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
  AbortController,
  alert: m => { throw new Error("unexpected alert: " + m); },
  localStorage: { getItem: () => null, setItem: () => {} },
  window: { location: { origin: "http://localhost" } },
  Blob: class { constructor(parts) { this.text = parts.join(""); blobs.push(this.text); } },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  XLSX: { utils: {}, writeFile: () => {} },
  fetch: (url, opts) => {
    if (url.startsWith("/check")) {
      const doi = decodeURIComponent(url.split("doi=")[1]);
      calls[doi] = (calls[doi] || 0) + 1;
      return new Promise((resolve, reject) => {
        const signal = opts && opts.signal;
        const p = { doi, resolve, reject, signal, done: false };
        parked.push(p); inflight++; maxInflight = Math.max(maxInflight, inflight);
        if (signal) signal.addEventListener("abort", () => {
          if (p.done) return;
          p.done = true; inflight--;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
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
    addEventListener: (type, fn) => docListeners.push({ type, fn }),
    body: { appendChild() {}, removeChild() {} },
  },
};
vm.createContext(sandbox);
vm.runInContext(html.slice(s1, e1), sandbox, { filename: "index.html#modules" });
vm.runInContext(html.slice(s2, e2), sandbox, { filename: "index.html#retraction" });
const run = code => vm.runInContext(code, sandbox);

const paper = (title, doi) => ({ title, doi, journal: "Lancet", year: 2021, cited_by_count: 10 });
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const UNVERIFIED = '<span class="badge-checking">unverified</span>';
const RETRYING = '<span class="badge-checking">retrying…</span>';
const retryBtn = i => '<button type="button" class="retry-check" data-i="' + i + '" aria-label="Retry retraction check for row ' + (i + 1) + '">Retry</button>';

// Abort every run, drop parked requests and timers, clear the counters.
async function reset() {
  run("startRetractionRun('read'); startRetractionRun('rise')");
  await flush();
  parked = []; script = {}; calls = {}; timers = []; timerLog.length = 0;
  inflight = 0; maxInflight = 0;
}
async function startRun(mod, papers) {
  curateRows = papers;
  await run(mod === "read" ? "runRead()" : "runRise()");
  await flush();
}
const prefixOf = mod => (mod === "read" ? "st-" : "rst-");
const store = mod => run("lastData." + mod);

// A click as the page's delegated listener sees it. The fake button mirrors the
// current cell: it is found only when that cell holds a Retry button.
function clickRetry(cellId) {
  const h = cellHTML(cellId);
  const m = h && /<button[^>]*class="retry-check"[^>]*>/.exec(h);
  if (!m) return false;
  const tag = m[0];
  const td = { id: cellId };
  const btn = {
    disabled: /\sdisabled(\s|>|=)/.test(tag),
    getAttribute: n => { const a = new RegExp("\\s" + n + '="([^"]*)"').exec(tag); return a ? a[1] : null; },
    closest: sel => (sel === "td" ? td : null),
  };
  const target = { closest: sel => (sel === "button.retry-check" ? btn : null) };
  docListeners.filter(l => l.type === "click").forEach(l => l.fn({ target }));
  return true;
}

async function main() {
  byId("read_topic").value = "gene therapy"; byId("read_sort").value = "citations"; byId("read_lim").value = "50";
  byId("read_year").value = "0"; byId("read_cites").value = "0";
  byId("rise_topic").value = "gene therapy"; byId("rise_year").value = "2000"; byId("rise_cites").value = "0"; byId("rise_lim").value = "50";

  // ── R1: 503 then 200 -> retried once, final status from the second answer ──
  await reset();
  script["10.1/a"] = [{ s: 503, b: { error: "busy" } }, { s: 200, b: { retracted: false } }];
  await startRun("read", [paper("A", "10.1/a")]);
  await step();
  check("R1: after the 503 the cell shows 'retrying…' (" + cellHTML("st-0") + ")", cellHTML("st-0") === RETRYING);
  check("R1: the retry waits 750-2000 ms without Retry-After (waits " + JSON.stringify(waits()) + ")",
    waits().length === 1 && waits()[0] >= 750 && waits()[0] <= 2000);
  check("R1: no second fetch before the delay has passed (" + calls["10.1/a"] + ")", calls["10.1/a"] === 1);
  const exportWhileWaiting = () => { run('downloadJSON("read","x.json")'); return JSON.parse(blobs[blobs.length - 1]).rows[0]; };
  check("R11: a row that is still waiting exports retraction_status 'unverified'",
    exportWhileWaiting().retraction_status === "unverified" && !exportWhileWaiting().retraction_checked_at);
  await advance(2000);
  await step();
  check("R1: status no_retraction_found (" + store("read")[0].retraction_status + ")", store("read")[0].retraction_status === "no_retraction_found");
  check("R1: exactly 2 fetches for the DOI (" + calls["10.1/a"] + ")", calls["10.1/a"] === 2);
  check("R1: cell shows the green badge, no Retry button (" + cellHTML("st-0") + ")",
    /badge-ok">✓ No retraction found</.test(cellHTML("st-0")) && !/retry-check/.test(cellHTML("st-0")));
  check("R1: retraction_checked_at is ISO UTC", ISO.test(store("read")[0].retraction_checked_at));

  // ── R2: 503, 503 -> unverified plus a Retry button, still 2 fetches ──
  await reset();
  script["10.1/a"] = [{ s: 503 }, { s: 503 }];
  script["10.1/b"] = [{ s: 503 }, { s: 503 }];
  await startRun("read", [paper("A", "10.1/a"), paper("B", "10.1/b")]);
  await step(); await advance(2000); await step(); await advance(10000);
  check("R2: status unverified (" + store("read").map(r => r.retraction_status).join(",") + ")", store("read").every(r => r.retraction_status === "unverified"));
  check("R2: cell 0 = unverified badge + Retry button (" + cellHTML("st-0") + ")", cellHTML("st-0").includes(UNVERIFIED) && cellHTML("st-0").includes(retryBtn(0)));
  check("R2: cell 1 carries data-i=1 and aria-label for row 2", cellHTML("st-1").includes(retryBtn(1)));
  check("R2: exactly 2 fetches per DOI (" + calls["10.1/a"] + "," + calls["10.1/b"] + "), no third after waiting",
    calls["10.1/a"] === 2 && calls["10.1/b"] === 2);

  // ── R3: other failures are not retried ──
  await reset();
  script["10.1/n"] = [{ s: 404, b: { error: "not found" } }];
  script["10.1/e"] = [{ s: 200, b: { error: "checker busy" } }];
  script["10.1/f"] = [{ s: 500, b: { error: "boom" } }];
  script["10.1/g"] = [{ s: 403 }];
  await startRun("read", [paper("N", "10.1/n"), paper("E", "10.1/e"), paper("F", "10.1/f"), paper("G", "10.1/g")]);
  await step(); await advance(10000); await step();
  check("R3: 404, 200-with-error, 500 and 403 each fetch exactly once (" + ["n", "e", "f", "g"].map(k => calls["10.1/" + k]).join(",") + ")",
    ["n", "e", "f", "g"].every(k => calls["10.1/" + k] === 1));
  check("R3: all four are unverified (" + store("read").map(r => r.retraction_status).join(",") + ")", store("read").every(r => r.retraction_status === "unverified"));
  check("R3: no retry wait was scheduled (" + JSON.stringify(waits()) + ")", waits().length === 0);

  // ── R4: Retry-After in seconds is honoured and capped at 5000 ms ──
  for (const [header, want, label] of [["2", 2000, "Retry-After: 2"], ["60", 5000, "Retry-After: 60 (capped)"]]) {
    await reset();
    script["10.1/a"] = [{ s: 503, h: { "Retry-After": header } }, { s: 200, b: { retracted: false } }];
    await startRun("read", [paper("A", "10.1/a")]);
    await step();
    check("R4: " + label + " schedules a " + want + " ms wait (" + JSON.stringify(waits()) + ")", waits().length === 1 && waits()[0] === want);
    await advance(want - 1);
    check("R4: " + label + " no retry at " + (want - 1) + " ms (" + calls["10.1/a"] + " fetch)", calls["10.1/a"] === 1);
    await advance(1);
    check("R4: " + label + " retry sent at " + want + " ms (" + calls["10.1/a"] + " fetches)", calls["10.1/a"] === 2);
  }
  await reset();
  script["10.1/a"] = [{ s: 503, h: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" } }, { s: 200, b: { retracted: false } }];
  await startRun("read", [paper("A", "10.1/a")]);
  await step();
  check("R4: an HTTP-date Retry-After falls back to the 750-2000 ms jitter (" + JSON.stringify(waits()) + ")",
    waits().length === 1 && waits()[0] >= 750 && waits()[0] <= 2000);

  // ── R5: abort during the wait -> no retry, old run touches nothing ──
  await reset();
  script["10.1/a"] = [{ s: 503 }, { s: 200, b: { retracted: true } }];
  await startRun("read", [paper("A", "10.1/a")]);
  await step();
  const oldData = store("read");
  const oldRow = JSON.stringify(oldData[0]);
  check("R5: old run is waiting (" + cellHTML("st-0") + ")", cellHTML("st-0") === RETRYING);
  await startRun("read", [paper("B", "10.1/b")]);   // new search: aborts the old run, re-renders the table
  await advance(5000);
  check("R5: the aborted wait sends no retry (" + calls["10.1/a"] + " fetch for the old DOI)", calls["10.1/a"] === 1);
  check("R5: the new run's cell is untouched by the old run (the shim starts cells empty: " + cellHTML("st-0") + ")", cellHTML("st-0") === "");
  check("R5: the old run's row data is untouched", JSON.stringify(oldData[0]) === oldRow);

  // ── R6: Retry button -> exactly one new fetch, cell and store updated ──
  for (const mod of ["read", "rise"]) {
    const pre = prefixOf(mod);
    await reset();
    script["10.1/a"] = [{ s: 503 }, { s: 503 }, { s: 200, b: { retracted: false, expression_of_concern: true, concern_date: "2020-01-02", concern_notice_doi: "10.1/notice" } }];
    await startRun(mod, [paper("A", "10.1/a")]);
    await step(); await advance(2000); await step();
    const before = calls["10.1/a"];
    check("R6 " + mod + ": failed row shows the Retry button (" + cellHTML(pre + 0) + ")", cellHTML(pre + 0).includes(retryBtn(0)));
    check("R6 " + mod + ": store row is unverified before the click", store(mod)[0].retraction_status === "unverified");
    const clicked = clickRetry(pre + 0);
    await flush();
    check("R6 " + mod + ": click sends exactly one new fetch (" + before + " -> " + calls["10.1/a"] + ")", clicked && calls["10.1/a"] === before + 1);
    check("R6 " + mod + ": while running the cell shows 'checking…' and the button is disabled (" + cellHTML(pre + 0) + ")",
      /badge-checking">checking…</.test(cellHTML(pre + 0)) && /retry-check[^>]*\sdisabled/.test(cellHTML(pre + 0)));
    clickRetry(pre + 0); clickRetry(pre + 0);
    await flush();
    check("R6 " + mod + ": clicking the disabled button again sends nothing (" + calls["10.1/a"] + ")", calls["10.1/a"] === before + 1);
    await step();
    const row = store(mod)[0];
    check("R6 " + mod + ": store updated like finish() (" + row.retraction_status + ", concern " + row.expression_of_concern + ")",
      row.retraction_status === "no_retraction_found" && ISO.test(row.retraction_checked_at) &&
      row.expression_of_concern === true && row.concern_date === "2020-01-02" && row.concern_notice_doi === "10.1/notice");
    check("R6 " + mod + ": cell shows the concern badge, the Retry button is gone (" + cellHTML(pre + 0) + ")",
      /badge-concern/.test(cellHTML(pre + 0)) && !/retry-check/.test(cellHTML(pre + 0)));
    check("R6 " + mod + ": still exactly one new fetch (" + calls["10.1/a"] + ")", calls["10.1/a"] === before + 1);
  }
  // A manual check follows the same automatic-retry rule: 503 then 200 inside one click.
  await reset();
  script["10.1/a"] = [{ s: 503 }, { s: 503 }, { s: 503 }, { s: 200, b: { retracted: true } }];
  await startRun("read", [paper("A", "10.1/a")]);
  await step(); await advance(2000); await step();
  clickRetry("st-0"); await step();
  check("R6: a click that meets a 503 shows 'retrying…' with a disabled button (" + cellHTML("st-0") + ")",
    cellHTML("st-0").includes("retrying…") && /retry-check[^>]*\sdisabled/.test(cellHTML("st-0")));
  await advance(2000); await step();
  check("R6: the click's own automatic retry gives the final answer (" + store("read")[0].retraction_status + ", " + calls["10.1/a"] + " fetches)",
    store("read")[0].retraction_status === "retracted" && calls["10.1/a"] === 4);
  // A click from a run that is no longer current is ignored.
  await reset();
  script["10.1/a"] = [{ s: 503 }, { s: 503 }];
  await startRun("read", [paper("A", "10.1/a")]);
  await step(); await advance(2000); await step();
  const staleCell = cellHTML("st-0");
  const staleTd = { id: "st-0" };
  const staleBtn = { disabled: false, getAttribute: () => "0", closest: sel => (sel === "td" ? staleTd : null) };
  run("startRetractionRun('read')");   // a newer search has started; its /curate has not answered yet
  const n = calls["10.1/a"];
  docListeners.filter(l => l.type === "click").forEach(l => l.fn({ target: { closest: sel => (sel === "button.retry-check" ? staleBtn : null) } }));
  await flush();
  check("R6: a click after the run changed is ignored (" + n + " -> " + calls["10.1/a"] + ")", staleCell.includes("retry-check") && calls["10.1/a"] === n);

  // ── R7: never more than 4 requests in flight, retries included ──
  await reset();
  const many = [];
  for (let k = 0; k < 20; k++) { many.push(paper("P" + k, "10.1/p" + k)); script["10.1/p" + k] = [{ s: 503 }, { s: 200, b: { retracted: false } }]; }
  await startRun("read", many);
  for (let k = 0; k < 120 && store("read").some(r => r.retraction_status !== "no_retraction_found"); k++) { await step(); await advance(2000); }
  check("R7: all 20 rows ended no_retraction_found", store("read").every(r => r.retraction_status === "no_retraction_found"));
  check("R7: every DOI was fetched exactly twice", many.every(p => calls[p.doi] === 2));
  check("R7: max requests in flight = " + maxInflight + " (<= 4, and the limit was reached)", maxInflight === 4);

  // ── R8: 429 is retried like 503 ──
  await reset();
  script["10.1/a"] = [{ s: 429, h: { "Retry-After": "1" } }, { s: 200, b: { retracted: false } }];
  await startRun("read", [paper("A", "10.1/a")]);
  await step(); await advance(1000); await step();
  check("R8: 429 then 200 -> no_retraction_found with 2 fetches (" + store("read")[0].retraction_status + ", " + calls["10.1/a"] + ")",
    store("read")[0].retraction_status === "no_retraction_found" && calls["10.1/a"] === 2);

  // ── R9: timeout / AbortError and network errors are not retried ──
  await reset();
  script["10.1/t"] = [{ abort: true }];
  script["10.1/w"] = [{ net: true }];
  await startRun("read", [paper("T", "10.1/t"), paper("W", "10.1/w")]);
  await step(); await advance(10000); await step();
  check("R9: timeout (AbortError) and network error fetch once each (" + calls["10.1/t"] + "," + calls["10.1/w"] + ")", calls["10.1/t"] === 1 && calls["10.1/w"] === 1);
  check("R9: both end unverified with a Retry button", store("read").every(r => r.retraction_status === "unverified") &&
    cellHTML("st-0").includes(retryBtn(0)) && cellHTML("st-1").includes(retryBtn(1)));
  check("R9: no retry wait was scheduled (" + JSON.stringify(waits()) + ")", waits().length === 0);

  // ── R10: no inline handler, one delegated click listener ──
  await reset();
  script["10.1/a"] = [{ s: 404, b: { error: "x" } }];
  await startRun("read", [paper("A", "10.1/a")]);
  await step();
  check("R10: the Retry button has no inline onclick (" + cellHTML("st-0") + ")", /retry-check/.test(cellHTML("st-0")) && !/onclick/i.test(cellHTML("st-0")));
  check("R10: exactly one delegated click listener (" + docListeners.filter(l => l.type === "click").length + ")", docListeners.filter(l => l.type === "click").length === 1);
  let threw = false;
  try { docListeners.filter(l => l.type === "click").forEach(l => l.fn({ target: { closest: () => null } })); } catch (e) { threw = true; }
  check("R10: a click on anything else is ignored without error", !threw);
}

main().then(() => {
  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall check-retry checks passed");
}).catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
