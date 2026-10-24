// CI binary identity test.
//
// Run: node tools/ci_binary_identity_test.js
//
// The two govulncheck -mode=binary scans run on binaries taken from
// bibliovera-label-check:ci, the first build. The image that is pushed is the
// second build ("Build and export"). Image IDs cannot be compared (the second
// build adds labels and tags), so a build-job step compares the sha256 of both
// CLIs in the shipped image with the scanned binaries. This static check reads
// .github/workflows/deploy.yml and asserts:
//   (a) the step "Check the scanned binaries are the shipped binaries" occurs
//       exactly once;
//   (b) it is inside the build job, before the line that starts publish:;
//   (c) it comes after "Write image ID" and before "Upload image artifact";
//   (d) it creates its container from "$REGISTRY/$IMAGE_NAME:latest", not from
//       bibliovera-label-check;
//   (e) it copies both /app/thelancet and /app/retraction-checker into
//       shipped-bin;
//   (f) it runs sha256sum on both cli-bin and shipped-bin;
//   (g) a mismatch runs exit 1, and the script uses set -euo pipefail.
"use strict";
const fs = require("fs");
const path = require("path");

const raw = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "deploy.yml"), "utf8");
const yml = raw.replace(/\r/g, "");

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// Split the steps list into blocks, one per "- name:" entry, in file order.
const steps = [];
const re = /^ {6}- name: (.+)$/gm;
let m;
while ((m = re.exec(yml)) !== null) steps.push({ name: m[1].trim(), start: m.index });
for (let i = 0; i < steps.length; i++) {
  steps[i].body = yml.slice(steps[i].start, i + 1 < steps.length ? steps[i + 1].start : yml.length);
}
if (steps.length === 0) {
  console.error("FAIL: no steps found in deploy.yml - refusing to pass silently");
  process.exit(1);
}

const NAME = "Check the scanned binaries are the shipped binaries";
const matches = steps.filter((s) => s.name === NAME);
check("(a) the step \"" + NAME + "\" occurs exactly once (found " + matches.length + ")", matches.length === 1);

const idx = steps.findIndex((s) => s.name === NAME);
const step = steps[idx];
const body = step ? step.body : "";
const lines = body.split("\n").map((l) => l.trim());

const publishAt = yml.search(/^ {2}publish:$/m);
check("(b) the step is inside the build job (before publish:)", !!step && publishAt >= 0 && step.start < publishAt);

const iidIdx = steps.findIndex((s) => s.name === "Write image ID");
const uploadIdx = steps.findIndex((s) => s.name === "Upload image artifact");
check("(c) the step comes after \"Write image ID\" and before \"Upload image artifact\"",
  idx >= 0 && iidIdx >= 0 && uploadIdx >= 0 && iidIdx < idx && idx < uploadIdx);

check("(d) the step runs docker create \"$REGISTRY/$IMAGE_NAME:latest\"",
  lines.some((l) => l.includes("docker create \"$REGISTRY/$IMAGE_NAME:latest\"")));
check("(d) the step does not use bibliovera-label-check", !!step && !body.includes("bibliovera-label-check"));

for (const bin of ["thelancet", "retraction-checker"]) {
  check("(e) the step copies /app/" + bin + " into shipped-bin",
    lines.some((l) => l.startsWith("docker cp") && l.includes(":/app/" + bin + "\"") && l.includes("shipped-bin/" + bin)));
}

check("(f) the step runs sha256sum on cli-bin",
  lines.some((l) => l.includes("sha256sum") && l.includes("cli-bin")));
check("(f) the step runs sha256sum on shipped-bin",
  lines.some((l) => l.includes("sha256sum") && l.includes("shipped-bin")));

// The mismatch branch: from the comparing if line to its fi.
const ifAt = lines.findIndex((l) => l === "if [ \"$scanned\" != \"$shipped\" ]; then");
const fiAt = ifAt >= 0 ? lines.indexOf("fi", ifAt) : -1;
const branch = ifAt >= 0 && fiAt > ifAt ? lines.slice(ifAt + 1, fiAt) : [];
check("(g) a mismatch runs exit 1", branch.includes("exit 1"));
check("(g) the step uses set -euo pipefail", lines.includes("set -euo pipefail"));

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("all CI binary identity checks pass");
