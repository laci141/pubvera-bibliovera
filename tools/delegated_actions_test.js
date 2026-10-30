// Delegated data-action / data-mirror / data-input listeners test (CSP phase 0).
//
// Run: node tools/delegated_actions_test.js
//
// index.html carries data-action, data-mirror and data-input instead of inline
// on*= handlers; two named listeners in the classic script act on them.
// no_inline_handlers_test.js proves the handlers are gone; this proves the
// replacement works:
//   T4 each listener function is defined once and registered on document once;
//   T5 every data-action / data-input value used in index.html (markup and
//      JS-built HTML) has a branch in its listener, and every branch is used
//      (both directions); the data-mirror targets are exactly the ten range
//      labels, each used once; the counts per action match the old handlers;
//   T6 the real listener functions run in a vm sandbox and call the real
//      function names with the old arguments, one case per action, per modal,
//      per export format, per range mirror and per slider.
// A listener that cannot be found is a FAIL, never a silent pass.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const raw = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
// HTML comments are blanked character by character so line numbers still match.
const html = raw.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, " "));
const lineOf = i => html.slice(0, i).split("\n").length;

let ran = 0;
let failed = 0;
function check(label, ok) {
  ran++;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}
const count = s => html.split(s).length - 1;

// A listener runs from "function NAME(e){" at the start of a line to the first
// "\n}" after it; the opening must occur exactly once.
function cut(name) {
  const open = "\nfunction " + name + "(e){";
  const n = count(open);
  if (n !== 1) return { found: n, code: "" };
  const at = html.indexOf(open) + 1;
  const end = html.indexOf("\n}", at);
  if (end < 0) return { found: 1, code: "" };
  return { found: 1, code: html.slice(at, end + 2), line: lineOf(at) };
}

// ── T4: definitions and registrations ──
const fnOf = { click: "onActionClick", input: "onActionInput" };
const L = {};
for (const t of Object.keys(fnOf)) {
  L[t] = cut(fnOf[t]);
  check("T4 " + fnOf[t] + " defined exactly once (found " + L[t].found +
    (L[t].line ? ", L" + L[t].line : "") + ")", L[t].found === 1 && L[t].code !== "");
  const reg = 'document.addEventListener("' + t + '",' + fnOf[t] + ");";
  check("T4 " + reg + " exactly once (found " + count(reg) + ")", count(reg) === 1);
}

// ── T5: used values vs handled branches ──
function usedValues(attr) {
  const used = new Map();
  const re = new RegExp(attr + "\\s*=\\s*\\\\?[\"']([^\"'\\\\]*)", "g");
  html.split("\n").forEach((ln, i) => {
    if (/^\s*\/\//.test(ln)) return;
    for (const m of ln.matchAll(re)) {
      if (!used.has(m[1])) used.set(m[1], []);
      used.get(m[1]).push(i + 1);
    }
  });
  return used;
}
const clickBranches = [...new Set([...L.click.code.matchAll(/\ba==="([^"]*)"/g)].map(m => m[1]))];
const usedActions = usedValues("data-action");
console.log("      onActionClick branches: " + (clickBranches.join(", ") || "(none)"));
console.log("      data-action used: " +
  ([...usedActions].map(([v, ls]) => v + " (" + ls.length + "x)").join(", ") || "(none)"));
const missingA = [...usedActions.keys()].filter(v => !clickBranches.includes(v));
const deadA = clickBranches.filter(v => !usedActions.has(v));
check("T5 onActionClick has at least one branch (found " + clickBranches.length + ")", clickBranches.length > 0);
check("T5 every data-action has a branch (missing: " + (missingA.join(", ") || "none") + ")", missingA.length === 0);
check("T5 every onActionClick branch is used (dead: " + (deadA.join(", ") || "none") + ")", deadA.length === 0);

const inputBranches = [...new Set([...L.input.code.matchAll(/\bd\.input==="([^"]*)"/g)].map(m => m[1]))];
const usedInputs = usedValues("data-input");
console.log("      onActionInput data-input branches: " + (inputBranches.join(", ") || "(none)"));
const missingI = [...usedInputs.keys()].filter(v => !inputBranches.includes(v));
const deadI = inputBranches.filter(v => !usedInputs.has(v));
check("T5 every data-input has a branch (missing: " + (missingI.join(", ") || "none") + ")", inputBranches.length > 0 && missingI.length === 0);
check("T5 every data-input branch is used (dead: " + (deadI.join(", ") || "none") + ")", deadI.length === 0);

const MIRRORS = ["aff_years_v", "aff_thr_v", "aff_minp_v", "aff_lim_v", "auth_minw_v", "auth_lim_v",
  "drift_top_v", "read_lim_v", "rise_lim_v", "mesh_lim_v"];
const mirrorUse = usedValues("data-mirror");
check("T5 data-mirror targets are the ten range labels (found " + ([...mirrorUse.keys()].sort().join(", ") || "none") + ")",
  JSON.stringify([...mirrorUse.keys()].sort()) === JSON.stringify([...MIRRORS].sort()));
for (const id of MIRRORS) {
  check("T5 data-mirror=\"" + id + "\" used once and the label id exists once (" +
    (mirrorUse.get(id) || []).length + ", " + count('id="' + id + '"') + ")",
    (mirrorUse.get(id) || []).length === 1 && count('id="' + id + '"') === 1);
}

const MODALS = ["aff", "auth", "drift", "read", "rise", "mesh"];
for (const m of MODALS) {
  const open = 'data-action="open-modal" data-modal="' + m + '"';
  const close = 'data-action="close-modal" data-modal="' + m + '"';
  const run = 'data-action="run-' + m + '"';
  check("T5 " + open + " once (found " + count(open) + ")", count(open) === 1);
  check("T5 " + close + " once (found " + count(close) + ")", count(close) === 1);
  check("T5 " + run + " once (found " + count(run) + ")", count(run) === 1);
  check("T5 the modal element id=\"" + m + "Modal\" exists once (found " + count('id="' + m + 'Modal"') + ")",
    count('id="' + m + 'Modal"') === 1);
}
for (const s of ["export", "toggle-export-menu", "mesh-png", "sign-in"]) {
  const n = (usedActions.get(s) || []).length;
  check("T5 data-action=\"" + s + "\" used exactly once (found " + n + ")", n === 1);
}
for (const s of ["set-w1", "set-w2"]) {
  const n = (usedInputs.get(s) || []).length;
  check("T5 data-input=\"" + s + "\" used exactly once (found " + n + ")", n === 1);
}
const SLIDERS = ["read_year", "read_cites", "rise_year", "rise_cites"];
for (const id of SLIDERS) {
  const tag = 'data-input="num-from-slider" data-id="' + id + '"';
  check("T5 " + tag + " once and its number field id=\"" + id + "_n\" exists (" + count(tag) + ", " + count('id="' + id + '_n"') + ")",
    count(tag) === 1 && count('id="' + id + '_n"') === 1);
}
// The four export formats the JS-built menu item can name.
for (const c of ["downloadXLSX", "downloadCSVData", "downloadJSON", "downloadBibTeX"]) {
  check("T5 export item built for " + c + " in metaRow (found " + count('item("' + c + '"') + ")", count('item("' + c + '"') === 1);
}

// ── T6: drive the real listeners in a vm sandbox (fresh sandbox per case) ──
function harness() {
  const calls = [];
  const show = a => (a && a.__el ? "<el>" : a === undefined ? "undefined" : JSON.stringify(a));
  const rec = name => (...args) => { calls.push(name + "(" + args.map(show).join(",") + ")"); };
  const labels = {};
  const sb = {
    openModal: rec("openModal"), closeModal: rec("closeModal"),
    runAff: rec("runAff"), runAuth: rec("runAuth"), runDrift: rec("runDrift"),
    runRead: rec("runRead"), runRise: rec("runRise"), runMesh: rec("runMesh"),
    toggleExportMenu: rec("toggleExportMenu"), closeExportMenus: rec("closeExportMenus"),
    downloadXLSX: rec("downloadXLSX"), downloadCSVData: rec("downloadCSVData"),
    downloadJSON: rec("downloadJSON"), downloadBibTeX: rec("downloadBibTeX"),
    downloadMeshPNG: rec("downloadMeshPNG"), pubveraSignIn: rec("pubveraSignIn"),
    setW1: rec("setW1"), setW2: rec("setW2"), numFromSlider: rec("numFromSlider"),
    document: { getElementById: id => (id === "missing_v" ? null : (labels[id] = labels[id] || { textContent: "" })) },
  };
  vm.createContext(sb);
  vm.runInContext(L.click.code + "\n" + L.input.code, sb);
  // The click target is a child inside the button; closest() walks up to it.
  const click = el => sb.onActionClick({ target: { closest: s => (s === "[data-action]" ? el : null) } });
  const input = (dataset, value) => sb.onActionInput({ target: { dataset, value } });
  return { calls, labels, click, input };
}
function tcase(label, fn, want) {
  let got = null, why = "";
  try { got = fn(harness()); } catch (e) { why = " (threw: " + e.message + ")"; }
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check("T6 " + label + why + (ok || why ? "" : " (got " + JSON.stringify(got) + ")"), ok);
}
const clickCase = (label, dataset, want, extra) =>
  tcase(label, h => { h.click(Object.assign({ __el: true, dataset }, extra || {})); return h.calls; }, want);

for (const m of MODALS) {
  const Fn = "run" + m[0].toUpperCase() + m.slice(1);
  clickCase("open-modal " + m + " passes the card element as the opener", { action: "open-modal", modal: m }, ['openModal("' + m + '",<el>)']);
  clickCase("close-modal " + m, { action: "close-modal", modal: m }, ['closeModal("' + m + '")']);
  clickCase("run-" + m, { action: "run-" + m }, [Fn + "()"]);
}
clickCase("toggle-export-menu passes the trigger button", { action: "toggle-export-menu" }, ["toggleExportMenu(<el>)"]);
for (const c of ["downloadXLSX", "downloadCSVData", "downloadJSON", "downloadBibTeX"]) {
  clickCase("export " + c + " calls it with key and name, then closes the menus with focus",
    { action: "export", call: c, key: "aff", name: "bibliovera-aff.x" }, [c + '("aff","bibliovera-aff.x")', "closeExportMenus(true)"]);
}
clickCase("export with an unknown call only closes the menus", { action: "export", call: "evil", key: "k", name: "n" }, ["closeExportMenus(true)"]);
clickCase("mesh-png", { action: "mesh-png" }, ["downloadMeshPNG()"]);
clickCase("sign-in", { action: "sign-in" }, ["pubveraSignIn()"]);
clickCase("unknown data-action does nothing", { action: "nope" }, []);
clickCase("a disabled button does nothing", { action: "run-aff" }, [], { disabled: true });
tcase("click outside any [data-action] does nothing", h => { h.click(null); return h.calls; }, []);
for (const id of MIRRORS) {
  tcase("range input mirrors into " + id, h => { h.input({ mirror: id }, "17"); return [h.labels[id] && h.labels[id].textContent]; }, ["17"]);
}
tcase("mirror to a missing label does nothing and does not throw", h => { h.input({ mirror: "missing_v" }, "5"); return h.calls; }, []);
tcase("set-w1", h => { h.input({ input: "set-w1" }, "2012"); return h.calls; }, ['setW1("2012")']);
tcase("set-w2", h => { h.input({ input: "set-w2" }, "2018"); return h.calls; }, ['setW2("2018")']);
for (const id of SLIDERS) {
  tcase("num-from-slider " + id, h => { h.input({ input: "num-from-slider", id }, "9"); return h.calls; }, ['numFromSlider("' + id + '")']);
}
tcase("input without any data attribute does nothing", h => { h.input({}, "99"); return h.calls; }, []);

if (ran === 0) {
  console.error("FAIL: zero checks ran - refusing to pass silently");
  process.exit(1);
}
console.log((ran - failed) + "/" + ran + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
