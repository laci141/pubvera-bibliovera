// Field length limit test: the UI mirrors the server's text-param limits (BUG-09).
//
// Run: node tools/limits_test.js
//
// The pure part of index.html (FIELD_LIMITS + checkLength) is sliced out between
// two marker comments and run in a vm sandbox. No server, no network, no DOM.
//   a) drift: limits parsed from main.go equal FIELD_LIMITS for every param with a text input
//   b) runes, not UTF-16 units: LIMIT astral chars is valid, LIMIT+1 is over by 1
//   c) message text: singular / plural
//   d) the server trims before counting (strings.TrimSpace), so the UI must too
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8").replace(/\r\n/g, "\n");
const go = fs.readFileSync(path.join(root, "main.go"), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// Params that have a text input in index.html (journal is a <select>, doi and pmid have no input).
const PARAMS = ["topic", "institution", "org"];

// ── Go side: param -> constant -> value ──
const consts = {};
for (const m of go.matchAll(/^\s*(max\w+Chars)\s*=\s*(\d+)/gm)) consts[m[1]] = Number(m[2]);
const goLimits = {};
for (const m of go.matchAll(/textParam\(q,\s*"(\w+)",\s*(max\w+Chars)\)/g)) goLimits[m[1]] = consts[m[2]];
check("Go source: limits parsed for " + PARAMS.join(", "), PARAMS.every(p => Number.isInteger(goLimits[p])));
check("Go source: textParam trims before counting runes",
  /strings\.TrimSpace\(q\.Get\(name\)\)\s*\n\s*if utf8\.RuneCountInString\(v\) > max/.test(go));

// ── JS side ──
const s = html.indexOf("// ── Field length limits");
const e = html.indexOf("// ── end field length limits");
let FIELD_LIMITS = null, checkLength = null;
if (s < 0 || e <= s) {
  check("index.html: field length limits section found", false);
} else {
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(html.slice(s, e) + "\nthis.FIELD_LIMITS=FIELD_LIMITS;this.checkLength=checkLength;", sb);
  FIELD_LIMITS = sb.FIELD_LIMITS;
  checkLength = sb.checkLength;
  check("index.html: field length limits section found", !!FIELD_LIMITS && typeof checkLength === "function");
}

// a) drift
for (const p of PARAMS) {
  check("drift: " + p + " JS limit " + (FIELD_LIMITS && FIELD_LIMITS[p]) + " == Go limit " + goLimits[p],
    !!FIELD_LIMITS && FIELD_LIMITS[p] === goLimits[p]);
}

if (checkLength && FIELD_LIMITS) {
  for (const p of PARAMS) {
    const L = FIELD_LIMITS[p];
    // b) rune counting
    check(p + ": " + L + " ASCII chars is valid", checkLength(p, "a".repeat(L)).over === 0);
    check(p + ": " + (L + 1) + " ASCII chars is over by 1", checkLength(p, "a".repeat(L + 1)).over === 1);
    check(p + ": " + L + " astral chars is valid", checkLength(p, "😀".repeat(L)).over === 0);
    check(p + ": " + (L + 1) + " astral chars is over by 1", checkLength(p, "😀".repeat(L + 1)).over === 1);
    // d) trim
    check(p + ": surrounding spaces are not counted", checkLength(p, "  " + "a".repeat(L) + "  ").over === 0);
    check(p + ": inner spaces are counted", checkLength(p, "a".repeat(L) + " b").over === 2);
  }
  // c) message text
  const L = FIELD_LIMITS.topic;
  const m1 = checkLength("topic", "a".repeat(L + 1));
  const m12 = checkLength("topic", "a".repeat(L + 12));
  check("message: over by 1 -> '1 character too many' (got " + JSON.stringify(m1.message) + ")",
    m1.message.includes("1 character too many") && !m1.message.includes("1 characters"));
  check("message: over by 12 -> '12 characters too many' (got " + JSON.stringify(m12.message) + ")",
    m12.message.includes("12 characters too many"));
  check("message: valid value -> empty message", checkLength("topic", "ok").message === "");
}

console.log(failed ? "\n" + failed + " check(s) FAILED" : "\nall checks passed");
process.exit(failed ? 1 : 0);
