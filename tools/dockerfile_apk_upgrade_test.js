// Dockerfile apk upgrade test (OpenSSL CVEs fixed in 3.5.9-r1, zlib CVE-2026-4738).
//
// Run: node tools/dockerfile_apk_upgrade_test.js [path/to/Dockerfile]
//
// The final stage (everything after the last FROM) must upgrade zlib,
// libcrypto3 and libssl3 by name in exactly one `apk upgrade --no-cache` line,
// before the USER line, and never run a bare `apk upgrade`.
// No RegExp and no backslashes: CR and LF are built with String.fromCharCode.
"use strict";
const fs = require("fs");
const path = require("path");

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const file = process.argv[2] || path.join(__dirname, "..", "Dockerfile");

let raw = fs.readFileSync(file, "utf8");
if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
raw = raw.split(CR + LF).join(LF);

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

const lines = raw.split(LF);
let lastFrom = -1;
lines.forEach((l, i) => {
  if (l.trim().toUpperCase().startsWith("FROM ")) lastFrom = i;
});
if (lastFrom < 0) {
  console.error("FAIL: no FROM found in " + file + " - refusing to pass silently");
  process.exit(1);
}
const final = lines.slice(lastFrom + 1).filter((l) => !l.trim().startsWith("#"));

const upIdx = [];
final.forEach((l, i) => { if (l.includes("apk upgrade")) upIdx.push(i); });
check("exactly one line containing `apk upgrade` in the final stage (found " + upIdx.length + ")", upIdx.length === 1);

const up = upIdx.length ? final[upIdx[0]] : "";
const words = up.split(" ");
for (const tok of ["--no-cache", "zlib", "libcrypto3", "libssl3"]) {
  check("upgrade line contains " + tok, words.includes(tok));
}

// Every `apk upgrade` must name a package before the command ends.
const bare = [];
final.forEach((l) => {
  const parts = l.split("apk upgrade");
  for (let p = 1; p < parts.length; p++) {
    let rest = parts[p];
    for (const stop of ["&&", "||", ";", "|"]) rest = rest.split(stop)[0];
    const args = rest.split(" ").filter((a) => a.trim() !== "" && !a.trim().startsWith("-"));
    if (args.length === 0) bare.push(l.trim());
  }
});
check("no `apk upgrade` without a package name" + (bare.length ? " (" + bare.join("; ") + ")" : ""), bare.length === 0);

const userIdx = final.findIndex((l) => l.trim().toUpperCase().startsWith("USER "));
check("final stage has a USER line", userIdx >= 0);
check("the upgrade line comes before USER", upIdx.length === 1 && userIdx >= 0 && upIdx[0] < userIdx);

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("all dockerfile apk upgrade checks pass");
