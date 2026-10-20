// CI job split test (audit BV-02).
//
// Run: node tools/ci_bv02_jobs_test.js
//
// The build job runs on pull_request too, so it must not hold packages: write.
// It builds the image once and uploads it as an artifact; a separate publish
// job, gated on a push or workflow_dispatch from main, downloads it and
// pushes. This static check reads .github/workflows/deploy.yml, splits it
// into job blocks and asserts:
//   (a) the build block contains no "packages: write";
//   (b) the build block contains "outputs: type=docker";
//   (c) the build block contains no "push: true" and no "push: ${{";
//   (d) the publish block contains "packages: write" and "needs: build";
//   (e) the publish if: line contains "refs/heads/main", "workflow_dispatch"
//       and "'push'";
//   (f) build uses upload-artifact, publish uses download-artifact;
//   (g) the publish block prints digests but never compares them: no line
//       contains "iid" together with "!=" or "exit 1".
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

check("(a) build job has no \"packages: write\"", !!build && !build.includes("packages: write"));
check("(b) build job has \"outputs: type=docker\"", build.includes("outputs: type=docker"));
check("(c) build job has no \"push: true\" and no \"push: ${{\"",
  !!build && !build.includes("push: true") && !build.includes("push: ${{"));
check("(d) publish job has \"packages: write\" and \"needs: build\"",
  publish.includes("packages: write") && publish.includes("needs: build"));
const publishIf = publish.split("\n").find((l) => /^ {4}if:/.test(l)) || "";
check("(e) publish job if: line contains \"refs/heads/main\", \"workflow_dispatch\" and \"'push'\" (got \"" + publishIf.trim() + "\")",
  publishIf.includes("refs/heads/main") && publishIf.includes("workflow_dispatch") && publishIf.includes("'push'"));
check("(f) build uses upload-artifact, publish uses download-artifact",
  build.includes("upload-artifact") && publish.includes("download-artifact"));
const iidCompare = publish.split("\n").filter((l) => l.includes("iid") && (l.includes("!=") || l.includes("exit 1")));
check("(g) publish job has no line with \"iid\" and \"!=\" or \"exit 1\" (got " + iidCompare.length + ")",
  !!publish && iidCompare.length === 0);

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("all CI job split checks pass");
