// Min year / Min citations filter test: every such slider (Reading List, Rising
// Papers) has a numeric text field next to it. The FIELD is the source of truth
// for the filter; empty means "no filter" and the label reads "Any".
//
// Run: node tools/filters_test.js
//
//   a) slider at min -> field "" / "Min year · Any"; min+1 -> field "<min+1>"
//   b) field below the slider minimum (1990) is the filter value; slider sits at its min
//   c) invalid year values -> inline message, aria-invalid, focus, Run sends no request
//   d) citations: "" / "50" / "-1" / "1e3"
//   e) restore of old saved slider values (min -> empty field) and of the new keys
//   f) .concern-link keeps "notice ↗" on one line
//   g) valid values keep exactly the rows the old slider path kept
//
// Same loading pattern as tools/rising_test.js: the inline script sections are
// sliced out of index.html and run in a vm sandbox with a minimal DOM shim. No
// server, no network: fetch is a local mock.
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
// A check whose body may throw (the function under test may not exist yet): a throw is a FAIL line.
function guarded(label, fn) {
  let ok = false, note = "";
  try { ok = !!fn(); } catch (e) { note = " (threw: " + (e && e.message) + ")"; }
  check(label + note, ok);
}

const NOW_YEAR = new Date().getFullYear();

// ── Sandbox factory: `saved` is what localStorage holds when the page loads ──
function makeSandbox(saved) {
  const els = {}, curateCalls = [];
  function makeEl(id) {
    const attrs = {}, listeners = {};
    const el = {
      id, value: "", textContent: "", _html: "", style: {}, classList: { add() {}, remove() {} },
      focused: 0, focus() { el.focused++; },
      setAttribute(k, v) { attrs[k] = String(v); },
      removeAttribute(k) { delete attrs[k]; },
      getAttribute(k) { return k in attrs ? attrs[k] : null; },
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
      fire(t) { (listeners[t] || []).forEach(fn => fn()); },
    };
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
  const store = { bibliovera_form: saved === undefined ? null : JSON.stringify(saved) };
  const sandbox = {
    console, Date, Math, JSON, Number, String, Object, Array, Promise, URLSearchParams, setTimeout, clearTimeout,
    AbortController, Error, RegExp, parseInt, isNaN,
    alert: m => { throw new Error("unexpected alert: " + m); },
    localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    window: { location: { origin: "http://localhost" } },
    Blob: class {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }, XLSX: {},
    curateRows: [],
    fetch: url => {
      if (url.startsWith("/check")) {
        return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ retracted: false }) });
      }
      curateCalls.push(url);
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(sandbox.curateRows) });
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
  // The real sliders carry min/max in the markup; the shim has to say the same.
  byId("read_year").min = "2005"; byId("read_year").max = "2026"; byId("read_year").value = "2005";
  byId("rise_year").min = "2005"; byId("rise_year").max = "2024"; byId("rise_year").value = "2018";
  byId("read_cites").min = "0"; byId("read_cites").max = "500"; byId("read_cites").value = "0";
  byId("rise_cites").min = "0"; byId("rise_cites").max = "500"; byId("rise_cites").value = "0";
  vm.createContext(sandbox);
  vm.runInContext(html.slice(s1, e1), sandbox, { filename: "index.html#modules" });
  vm.runInContext(html.slice(s2, e2), sandbox, { filename: "index.html#retraction" });
  return { sandbox, byId, curateCalls, store, run: code => vm.runInContext(code, sandbox) };
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const paper = (doi, year, cites) => ({ title: "T " + doi, doi, journal: "Lancet", year, cited_by_count: cites, citations_per_year: 1, pub_date: "" });

// What the page calls when the slider moves / the field changes.
// A missing handler (unchanged page) leaves the state as it is: the check after it FAILs.
const quietly = fn => { try { fn(); } catch (e) { /* reported by the check that follows */ } };
const sliderMoved = (t, id, v) => { t.byId(id).value = String(v); quietly(() => t.run("numFromSlider('" + id + "')")); };
const fieldTyped = (t, id, v) => { t.byId(id + "_n").value = v; quietly(() => t.run("numFromField('" + id + "')")); };

(async () => {
  // ── Markup: a real <label for>, a numeric text field, "Any", no "(all)" ──
  for (const [id, word] of [["read_year", "year"], ["read_cites", "citations"], ["rise_year", "year"], ["rise_cites", "citations"]]) {
    const label = new RegExp('<label for="' + id + '_n">Min ' + word + '[^<]*· <span class="val" id="' + id + '_v">(Any|[0-9]+)</span></label>');
    check("markup: " + id + " has <label for=" + id + "_n> reading Min " + word + " · <value>", label.test(html));
    const input = new RegExp('<input[^>]*id="' + id + '_n"[^>]*>').exec(html);
    const tag = input ? input[0] : "";
    check("markup: " + id + "_n is type=text inputmode=numeric pattern=[0-9]* placeholder=Any",
      /type="text"/.test(tag) && /inputmode="numeric"/.test(tag) && /pattern="\[0-9\]\*"/.test(tag) && /placeholder="Any"/.test(tag));
    check("markup: " + id + "_n has aria-describedby and a polite message element",
      tag.includes('aria-describedby="' + id + '_n_msg"') && new RegExp('id="' + id + '_n_msg"[^>]*aria-live="polite"').test(html));
  }
  check('markup: no "(all)" label left', !/\(all\)/.test(html));

  // ── a) slider -> field and label ──
  {
    const t = makeSandbox();
    sliderMoved(t, "read_year", 2005);
    guarded('a) read_year slider at min -> field "" and label "Min year · Any"',
      () => t.byId("read_year_n").value === "" && t.byId("read_year_v").textContent === "Any");
    sliderMoved(t, "read_year", 2006);
    guarded('a) read_year slider at min+1 -> field "2006" and label "Min year · 2006"',
      () => t.byId("read_year_n").value === "2006" && t.byId("read_year_v").textContent === "2006");
    sliderMoved(t, "rise_year", 2005);
    guarded('a) rise_year slider at min -> field "" and "Any"',
      () => t.byId("rise_year_n").value === "" && t.byId("rise_year_v").textContent === "Any");
    sliderMoved(t, "rise_year", 2006);
    guarded('a) rise_year slider at min+1 -> field "2006"',
      () => t.byId("rise_year_n").value === "2006" && t.byId("rise_year_v").textContent === "2006");
    sliderMoved(t, "read_cites", 0);
    guarded('d) read_cites slider at 0 -> field "" and label "Min citations · Any"',
      () => t.byId("read_cites_n").value === "" && t.byId("read_cites_v").textContent === "Any");
    sliderMoved(t, "read_cites", 50);
    guarded('d) read_cites slider at 50 -> field "50" and label "Min citations · 50"',
      () => t.byId("read_cites_n").value === "50" && t.byId("read_cites_v").textContent === "50");
  }

  // ── b) field below the slider minimum is the filter ──
  {
    const t = makeSandbox();
    t.sandbox.curateRows = [paper("10.1/a1989", 1989, 10), paper("10.1/b1995", 1995, 10), paper("10.1/c2010", 2010, 10)];
    t.byId("read_topic").value = "gene therapy"; t.byId("read_sort").value = "citations"; t.byId("read_lim").value = "15";
    fieldTyped(t, "read_year", "1990");
    guarded('b) field "1990" -> slider at its minimum position (2005)', () => t.byId("read_year").value === "2005");
    guarded('b) field "1990" -> label "Min year · 1990"', () => t.byId("read_year_v").textContent === "1990");
    await t.run("runRead()"); await tick();
    const kept = (t.run("lastData.read") || []).map(r => r.doi).join(",");
    guarded('b) field "1990" is the filter value: 1989 dropped, 1995 kept (' + kept + ")", () => kept === "10.1/b1995,10.1/c2010");
    guarded('b) field "1990" reaches the export filters ("from 1990")', () => /from 1990/.test(t.run("queryFilters.read.join(' | ')")));
    fieldTyped(t, "read_year", "2015");
    guarded('b) field "2015" moves the slider to 2015', () => t.byId("read_year").value === "2015");
    fieldTyped(t, "rise_year", String(NOW_YEAR));
    guarded("b) a valid year above the slider max (2024) is clamped for the slider position only",
      () => t.byId("rise_year").value === "2024" && t.byId("rise_year_n").value === String(NOW_YEAR) && t.byId("rise_year_v").textContent === String(NOW_YEAR));
    fieldTyped(t, "read_year", "");
    guarded('b) field "" -> slider at its minimum and label "Min year · Any"', () => t.byId("read_year").value === "2005" && t.byId("read_year_v").textContent === "Any");
  }

  // ── c) year: empty means no filter; invalid values block Run ──
  {
    const t = makeSandbox();
    t.sandbox.curateRows = [paper("10.1/old", 1989, 5), paper("10.1/new", 2020, 5)];
    t.byId("read_topic").value = "gene therapy"; t.byId("read_sort").value = "citations"; t.byId("read_lim").value = "15";
    t.byId("rise_topic").value = "gene therapy"; t.byId("rise_lim").value = "15"; t.byId("rise_journal").value = "";
    fieldTyped(t, "read_year", "");
    await t.run("runRead()"); await tick();
    const keptRead = (t.run("lastData.read") || []).map(r => r.doi).join(",");
    guarded('c) read: field "" keeps every year (' + keptRead + ")", () => keptRead === "10.1/old,10.1/new");
    guarded('c) read: field "" adds no "from" to the export filters', () => !/from/.test(t.run("queryFilters.read.join(' | ')")));
    fieldTyped(t, "rise_year", "");
    await t.run("runRise()"); await tick();
    const keptRise = (t.run("lastData.rise") || []).map(r => r.doi).join(",");
    guarded('c) rise: field "" keeps every year (' + keptRise + ")", () => keptRise === "10.1/old,10.1/new");

    for (const bad of ["abc", String(NOW_YEAR + 75), "1799", "20.5"]) {
      for (const [run, id, res] of [["runRead()", "read_year", "read_res"], ["runRise()", "rise_year", "rise_res"]]) {
        const before = t.curateCalls.length;
        const field = t.byId(id + "_n");
        field.value = bad; field.focused = 0;
        t.byId(res).innerHTML = "";
        await t.run(run); await tick();
        const msg = t.byId(id + "_n_msg").textContent;
        guarded("c) " + id + ' "' + bad + '": Run sends no request', () => t.curateCalls.length === before && t.byId(res).innerHTML === "");
        guarded("c) " + id + ' "' + bad + '": message names the range (' + JSON.stringify(msg) + ")",
          () => msg === "Enter a year between 1800 and " + NOW_YEAR);
        guarded("c) " + id + ' "' + bad + '": aria-invalid=true and focus on the field',
          () => field.getAttribute("aria-invalid") === "true" && field.focused === 1);
      }
    }
    // boundaries are valid
    for (const good of ["1800", String(NOW_YEAR)]) {
      const before = t.curateCalls.length;
      t.byId("read_year_n").value = good;
      await t.run("runRead()"); await tick();
      guarded("c) read_year \"" + good + '" is valid: request sent, no message',
        () => t.curateCalls.length === before + 1 && t.byId("read_year_n_msg").textContent === "" && t.byId("read_year_n").getAttribute("aria-invalid") === null);
    }
    // debounce: typing an invalid value shows the message after 600 ms; a valid value clears it at once
    const f = t.byId("read_year_n"), m = t.byId("read_year_n_msg");
    f.value = "1799"; f.fire("input");
    guarded("c) invalid typing: no message at once (debounced)", () => m.textContent === "");
    await tick(700);
    guarded("c) invalid typing: message after the debounce", () => m.textContent !== "" && f.getAttribute("aria-invalid") === "true");
    f.value = "1999"; f.fire("input");
    guarded("c) valid typing clears the message and aria-invalid immediately", () => m.textContent === "" && f.getAttribute("aria-invalid") === null);
    f.value = "1799"; f.fire("blur");
    guarded("c) blur shows the message without waiting", () => m.textContent !== "");
  }

  // ── d) citations ──
  {
    const t = makeSandbox();
    t.sandbox.curateRows = [paper("10.1/low", 2020, 10), paper("10.1/mid", 2020, 50), paper("10.1/high", 2020, 900)];
    t.byId("read_topic").value = "gene therapy"; t.byId("read_sort").value = "citations"; t.byId("read_lim").value = "15";
    t.byId("rise_topic").value = "gene therapy"; t.byId("rise_lim").value = "15"; t.byId("rise_journal").value = "";
    fieldTyped(t, "read_cites", "");
    guarded('d) field "" -> label "Min citations · Any"', () => t.byId("read_cites_v").textContent === "Any");
    await t.run("runRead()"); await tick();
    guarded('d) read: field "" keeps all rows', () => t.run("lastData.read").length === 3);
    fieldTyped(t, "read_cites", "50");
    guarded('d) field "50" -> label "Min citations · 50" and slider at 50', () => t.byId("read_cites_v").textContent === "50" && t.byId("read_cites").value === "50");
    await t.run("runRead()"); await tick();
    const k = t.run("lastData.read").map(r => r.doi).join(",");
    guarded('d) read: field "50" is the filter value (' + k + ")", () => k === "10.1/mid,10.1/high" && /min 50 citations/.test(t.run("queryFilters.read.join(' | ')")));
    fieldTyped(t, "rise_cites", "50");
    await t.run("runRise()"); await tick();
    const kr = t.run("lastData.rise").map(r => r.doi).join(",");
    guarded('d) rise: field "50" is the filter value (' + kr + ")", () => kr === "10.1/mid,10.1/high");
    for (const bad of ["-1", "1e3", "abc", "1.5", "10000001"]) {
      for (const [run, id, res] of [["runRead()", "read_cites", "read_res"], ["runRise()", "rise_cites", "rise_res"]]) {
        const before = t.curateCalls.length;
        const field = t.byId(id + "_n");
        field.value = bad; field.focused = 0;
        t.byId(res).innerHTML = "";
        await t.run(run); await tick();
        const msg = t.byId(id + "_n_msg").textContent;
        guarded("d) " + id + ' "' + bad + '": Run sends no request, message "' + msg + '", aria-invalid, focus',
          () => t.curateCalls.length === before && /^Enter a whole number/.test(msg) &&
            field.getAttribute("aria-invalid") === "true" && field.focused === 1);
      }
    }
    for (const good of ["0", "10000000"]) {
      const before = t.curateCalls.length;
      t.byId("read_cites_n").value = good;
      await t.run("runRead()"); await tick();
      guarded('d) read_cites "' + good + '" is valid: request sent', () => t.curateCalls.length === before + 1 && t.byId("read_cites_n_msg").textContent === "");
    }
  }

  // ── e) save / restore ──
  {
    let t = makeSandbox({ ryear: "2005", rcites: "0", ricites: "0" });
    guarded('e) old saved read year = slider min (2005) -> empty field and "Any"',
      () => t.byId("read_year_n").value === "" && t.byId("read_year_v").textContent === "Any" && t.byId("read_year").value === "2005");
    guarded('e) old saved read cites 0 -> empty field and "Any"', () => t.byId("read_cites_n").value === "" && t.byId("read_cites_v").textContent === "Any");
    guarded('e) old saved rise cites 0 -> empty field and "Any"', () => t.byId("rise_cites_n").value === "" && t.byId("rise_cites_v").textContent === "Any");
    t = makeSandbox({ ryear: "2012", rcites: "120", ricites: "30" });
    guarded('e) old saved read year 2012 -> field "2012", slider 2012, label "2012"',
      () => t.byId("read_year_n").value === "2012" && t.byId("read_year").value === "2012" && t.byId("read_year_v").textContent === "2012");
    guarded('e) old saved cites 120 / 30 -> fields "120" / "30"', () => t.byId("read_cites_n").value === "120" && t.byId("rise_cites_n").value === "30");
    t = makeSandbox({ ryear_n: "1990", rcites_n: "7", ricites_n: "" });
    guarded('e) new saved "1990" (below the slider minimum) -> field "1990", slider at its minimum',
      () => t.byId("read_year_n").value === "1990" && t.byId("read_year").value === "2005" && t.byId("read_year_v").textContent === "1990");
    guarded('e) new saved cites "7" -> field "7"', () => t.byId("read_cites_n").value === "7" && t.byId("read_cites_v").textContent === "7");
    t = makeSandbox({ ryear_n: "2005" });
    guarded('e) new saved explicit "2005" stays "2005" (a real filter, not "Any")', () => t.byId("read_year_n").value === "2005" && t.byId("read_year_v").textContent === "2005");
    t = makeSandbox({ ryear_n: "abc", rcites_n: "-4", ryear: "zzz" });
    guarded("e) a tampered saved value is ignored", () => t.byId("read_year_n").value === "" && t.byId("read_cites_n").value === "");
    t = makeSandbox();
    t.byId("read_topic").value = "x"; t.byId("rise_topic").value = "x";
    t.byId("read_year_n").value = "1990"; t.byId("read_cites_n").value = "50"; t.byId("rise_cites_n").value = "";
    t.run("save()");
    const saved = JSON.parse(t.store.bibliovera_form);
    guarded("e) save() stores the field values", () => saved.ryear_n === "1990" && saved.rcites_n === "50" && saved.ricites_n === "");
    t = makeSandbox(saved);
    guarded("e) a saved state restores to the same fields", () => t.byId("read_year_n").value === "1990" && t.byId("read_cites_n").value === "50" && t.byId("rise_cites_n").value === "");
  }

  // ── f) notice link ──
  {
    const rule = /\.concern-link\s*\{([^}]*)\}/.exec(html);
    check("f) .concern-link rule contains white-space:nowrap (" + (rule ? rule[1].trim() : "no rule") + ")",
      !!rule && /white-space\s*:\s*nowrap/.test(rule[1]));
  }

  // ── g) valid values keep exactly the rows the old slider path kept ──
  {
    const rows = [paper("10.1/p1", 2004, 5), paper("10.1/p2", 2008, 60), paper("10.1/p3", 2012, 400),
      paper("10.1/p4", 2015, 0), paper("10.1/p5", 2020, 1200), paper("10.1/p6", 2024, 49), paper("10.1/p7", 2025, 50)];
    const oldRead = (minY, minC) => {                      // index.html at a431ca5, runRead
      let r = rows;
      if (minY > 2005 || minC > 0) r = r.filter(x => (minY <= 2005 || Number(x.year) >= minY) && (Number(x.cited_by_count) >= minC));
      return r.map(x => x.doi).join(",");
    };
    const oldRise = (minYear, minC) => rows.filter(x => x.year >= minYear && x.cited_by_count >= minC).map(x => x.doi).join(",");
    const t = makeSandbox();
    t.sandbox.curateRows = rows;
    t.byId("read_topic").value = "gene therapy"; t.byId("read_sort").value = "citations"; t.byId("read_lim").value = "15";
    t.byId("rise_topic").value = "gene therapy"; t.byId("rise_lim").value = "15"; t.byId("rise_journal").value = "";
    for (const [y, c] of [[2006, 0], [2010, 50], [2012, 400], [2020, 0], [2006, 1200], [2024, 49], [2025, 50], [2026, 10]]) {
      fieldTyped(t, "read_year", String(y)); fieldTyped(t, "read_cites", String(c));
      await t.run("runRead()"); await tick();
      const got = (t.run("lastData.read") || []).map(r => r.doi).join(",");
      guarded("g) read year " + y + " cites " + c + ": same rows as the old slider path (" + got + ")", () => got === oldRead(y, c));
      fieldTyped(t, "rise_year", String(y)); fieldTyped(t, "rise_cites", String(c));
      await t.run("runRise()"); await tick();
      const gotR = (t.run("lastData.rise") || []).map(r => r.doi).join(",");
      guarded("g) rise year " + y + " cites " + c + ": same rows as the old slider path (" + gotR + ")", () => gotR === oldRise(y, c));
    }
    // read with no year and a citation floor: the old path at the slider minimum
    fieldTyped(t, "read_year", ""); fieldTyped(t, "read_cites", "50");
    await t.run("runRead()"); await tick();
    const got0 = (t.run("lastData.read") || []).map(r => r.doi).join(",");
    guarded("g) read year Any cites 50: same rows as the old slider at 2005 (" + got0 + ")", () => got0 === oldRead(2005, 50));
  }

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall filter checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
