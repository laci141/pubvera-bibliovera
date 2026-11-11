// Runtime zlib test (CVE-2026-4738).
//
// Run: node tools/runtime_zlib_test.js
//
// The runtime image is alpine:3.24. Its base layer shipped zlib 1.3.2-r1, which
// is affected by CVE-2026-4738; the fixed package is 1.4-r0. The final stage
// upgrades exactly that one package with `apk upgrade --no-cache zlib`, the
// same fix as pubvera-recallis and pubvera-corpova. This static check reads the
// Dockerfile and asserts:
//   (a) the last FROM is alpine:3.24, optionally pinned with @sha256:<digest>;
//   (b) the final stage has a RUN containing `apk upgrade --no-cache zlib`;
//   (c) that RUN comes before USER, so it still runs as root;
//   (d) no `apk upgrade` anywhere without a package name: a bare upgrade pulls
//       whatever the mirror has that day and makes the image non-reproducible.
// The build stages are deliberately NOT hashed: a Go bump would break that.
"use strict";
const fs = require("fs");
const path = require("path");

const raw = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// Join backslash continuations so one instruction is one logical line.
// lineNo[i] is the 1-based physical line where logical line i starts.
const lines = [];
const lineNo = [];
raw.split(/\r?\n/).forEach((l, i) => {
  const cont = lines.length > 0 && /\\\s*$/.test(lines[lines.length - 1]);
  if (cont) lines[lines.length - 1] = lines[lines.length - 1].replace(/\\\s*$/, " ") + l;
  else { lines.push(l); lineNo.push(i + 1); }
});
const fromIdx = [];
lines.forEach((l, i) => { if (/^\s*FROM\s/i.test(l)) fromIdx.push(i); });
if (fromIdx.length === 0) {
  console.error("FAIL: no FROM found in Dockerfile - refusing to pass silently");
  process.exit(1);
}
const lastFrom = fromIdx[fromIdx.length - 1];
const final = lines.slice(lastFrom);

check("(a) last FROM is alpine:3.24 (optional @sha256 digest): \"" + lines[lastFrom].trim() + "\"",
  /^\s*FROM\s+alpine:3\.24(@sha256:[0-9a-f]{64})?\s*$/i.test(lines[lastFrom]));

const runIdx = final.findIndex((l) => /^\s*RUN\s/i.test(l) && /apk\s+upgrade\s+--no-cache\s+zlib\b/.test(l));
check("(b) final stage has a RUN with `apk upgrade --no-cache zlib`", runIdx >= 0);

const userIdx = final.findIndex((l) => /^\s*USER\s/i.test(l));
check("(c) final stage has a USER instruction", userIdx >= 0);
check("(c) the zlib upgrade RUN comes before USER", runIdx >= 0 && userIdx >= 0 && runIdx < userIdx);

// Every `apk upgrade` must name at least one package (a non-flag argument)
// before the command ends at &&, ||, ;, | or end of line.
const bare = [];
lines.forEach((l, i) => {
  if (/^\s*#/.test(l)) return;
  const re = /apk\s+upgrade\b([^&|;]*)/g;
  let m;
  while ((m = re.exec(l)) !== null) {
    const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith("-"));
    if (args.length === 0) bare.push("line " + lineNo[i] + ": " + l.trim());
  }
});
check("(d) no `apk upgrade` without a package name" + (bare.length ? " (" + bare.join("; ") + ")" : ""),
  bare.length === 0);

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("all runtime zlib checks pass");
