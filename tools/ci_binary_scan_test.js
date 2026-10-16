// CI binary vulnerability scan test.
//
// Run: node tools/ci_binary_scan_test.js
//
// `govulncheck ./...` only scans the web wrapper module. The two CLIs are built
// in the Dockerfile from a pinned upstream commit, so their dependencies are
// only covered by a `govulncheck -mode=binary` scan of the runtime binaries
// (audit BV-04). This static check reads .github/workflows/deploy.yml and
// asserts:
//   (a) /app/thelancet and /app/retraction-checker each have their own scan
//       step that runs govulncheck with -mode=binary;
//   (b) both scan steps come before the "Build and push" step;
//   (c) the scans install govulncheck at the existing GOVULNCHECK_VERSION;
//   (d) exit codes other than 0 fail the step (3 = findings, others = tool
//       error), so a scan that did not run is never a pass.
"use strict";
const fs = require("fs");
const path = require("path");

const yml = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "deploy.yml"), "utf8");

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

const pushIdx = steps.findIndex((s) => s.name === "Build and push");
check("deploy.yml has a \"Build and push\" step", pushIdx >= 0);

for (const bin of ["thelancet", "retraction-checker"]) {
  const idx = steps.findIndex((s) =>
    new RegExp("govulncheck\\s+-mode=binary\\s+\\S*\\b" + bin + "\\b").test(s.body));
  const step = steps[idx];
  check("(a) " + bin + ": a step runs govulncheck -mode=binary on it", idx >= 0);
  if (idx < 0) continue;
  check("(a) " + bin + ": the step name names the binary (\"" + step.name + "\")",
    step.name.includes(bin) && !/wrapper/i.test(step.name));
  check("(b) " + bin + ": the scan step comes before \"Build and push\"", pushIdx >= 0 && idx < pushIdx);
  check("(c) " + bin + ": govulncheck is installed at ${GOVULNCHECK_VERSION}",
    /govulncheck@\$\{GOVULNCHECK_VERSION\}/.test(step.body) || /govulncheck@\$\{\{\s*env\.GOVULNCHECK_VERSION\s*\}\}/.test(step.body));
  check("(c) " + bin + ": no new version pin", !/govulncheck@v\d/.test(step.body));
  check("(d) " + bin + ": exit code 3 fails the step", /\b3\)[\s\S]*?exit 1/.test(step.body));
  check("(d) " + bin + ": any other non-zero exit code fails the step", /\*\)[\s\S]*?exit 1/.test(step.body));
  check("(d) " + bin + ": only exit code 0 passes", /\b0\)/.test(step.body) && !/\|\|\s*true/.test(step.body));
}

// The binaries must come out of the locally built image.
const extract = steps.find((s) => /docker create/.test(s.body) && /docker cp/.test(s.body));
check("binaries are extracted with docker create + docker cp", !!extract);
check("the temporary container is removed with docker rm", !!extract && /docker rm/.test(extract.body));

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("all CI binary scan checks pass");
