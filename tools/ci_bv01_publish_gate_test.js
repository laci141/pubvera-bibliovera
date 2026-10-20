// CI publish gate test (audit BV-01).
//
// Run: node tools/ci_bv01_publish_gate_test.js
//
// deploy.yml must push :latest only from main, and pull_request must never
// publish. The build job runs on every event, so it must not log in to GHCR or
// push; only the publish job does, and its job-level if: must check the ref,
// otherwise a manual workflow_dispatch run from any branch moves :latest. This
// static check reads .github/workflows/deploy.yml, splits it into job blocks
// and asserts:
//   (a) the build block contains no "docker/login-action", no "push: ${{" and
//       no "push: true";
//   (b) the publish if: line contains "github.ref == 'refs/heads/main'";
//   (c) the publish if: line does not contain "pull_request";
//   (d) workflow_dispatch: is still a trigger under on:.
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

// Split the jobs: section into blocks, one per "  <name>:" line, in file order.
const jobsAt = yml.search(/^jobs:$/m);
if (jobsAt < 0) {
  console.error("FAIL: no jobs: section in deploy.yml - refusing to pass silently");
  process.exit(1);
}
const jobsText = yml.slice(jobsAt);
const jobs = {};
const re = /^ {2}([a-z-]+):$/gm;
const starts = [];
let m;
while ((m = re.exec(jobsText)) !== null) starts.push({ name: m[1], start: m.index });
for (let i = 0; i < starts.length; i++) {
  jobs[starts[i].name] = jobsText.slice(starts[i].start, i + 1 < starts.length ? starts[i + 1].start : jobsText.length);
}
if (starts.length === 0) {
  console.error("FAIL: no jobs found in deploy.yml - refusing to pass silently");
  process.exit(1);
}

const build = jobs["build"] || "";
const publish = jobs["publish"] || "";

check("(a) build job has no \"docker/login-action\", no \"push: ${{\" and no \"push: true\"",
  !!build && !build.includes("docker/login-action") && !build.includes("push: ${{") && !build.includes("push: true"));

const publishIf = publish.split("\n").find((l) => /^ {4}if:/.test(l)) || "";
check("(b) publish job if: line contains \"github.ref == 'refs/heads/main'\" (got \"" + publishIf.trim() + "\")",
  publishIf.includes("github.ref == 'refs/heads/main'"));
check("(c) publish job if: line does not contain \"pull_request\"",
  !!publishIf && !publishIf.includes("pull_request"));

check("(d) workflow_dispatch: is still present under on:",
  /^on:\n(?:(?: {2}.*|)\n)*? {2}workflow_dispatch:/m.test(yml));

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("all CI publish gate checks pass");
