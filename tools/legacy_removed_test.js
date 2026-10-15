// Legacy CSV removal test: index.html keeps exactly one CSV download function and
// its builder holds no "sep=," hint, no BOM and no provenance line.
//
// Run: node tools/legacy_removed_test.js
//
// Same harness as tools/csv_data_test.js: slice the inline export section out of
// index.html; here the checks read the source and run toCSV in a vm sandbox.
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

// The toCSV body, from its signature to the closing brace at line start.
const tcStart = section.indexOf("function toCSV(");
const tcEnd = section.indexOf("\n}", tcStart);
const toCSVSrc = tcStart >= 0 && tcEnd > tcStart ? section.slice(tcStart, tcEnd + 2) : "";

check("index.html holds no \"sep=\" string (" + (html.match(/sep=/g) || []).length + " found)", !/sep=/.test(html));
check("toCSV located in index.html", toCSVSrc !== "");
check("toCSV builds no BOM (U+FEFF)", toCSVSrc !== "" && !/FEFF/i.test(toCSVSrc) && !toCSVSrc.includes(String.fromCharCode(0xFEFF)));
check("toCSV has no opts.plain branch", toCSVSrc !== "" && !/plain/.test(toCSVSrc));
check("toCSV pushes no provenance header line", toCSVSrc !== "" && !/lines\.push\(cell\(header\)\)/.test(toCSVSrc));
const csvFns = [...html.matchAll(/function (download\w*CSV\w*)\(/g)].map(m => m[1]);
check("exactly one CSV download function (got " + JSON.stringify(csvFns) + ")", csvFns.length === 1);

// Behaviour: whatever is passed as header/opts, the output starts with the header row.
const sandbox = { console, JSON, Object, Array, String, Number, Math, Date,
  document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => ({}), addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
  window: { location: { origin: "http://localhost" } } };
vm.createContext(sandbox);
let out = "";
try {
  vm.runInContext(section, sandbox, { filename: "index.html#export-section" });
  sandbox.__rows = [{ title: "=1+1", doi: "10.1/a" }];
  out = String(vm.runInContext('toCSV(__rows,"Bibliovera export · x")', sandbox));
} catch (e) { console.log("      toCSV threw: " + e.message); }
const lines = out.split("\r\n");
check("toCSV output line 0 is the header \"title,doi\" (got " + JSON.stringify(lines[0]) + ")", lines[0] === "title,doi");
check("toCSV output holds no BOM and no provenance text", out !== "" && out.charCodeAt(0) !== 0xFEFF && !/Bibliovera export/.test(out));
check("toCSV still neutralizes \"=1+1\" (got " + JSON.stringify(lines[1]) + ")", lines[1] === "'=1+1,10.1/a");

if (failed) {
  console.error("\n" + failed + " check(s) FAILED");
  process.exit(1);
}
console.log("\nall legacy-removal checks passed");
