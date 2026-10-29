// CalVer release workflow test.
//
// Run: node tools/release_workflow_test.js
//
// Every non-pull_request run on main gets a version YYYY.MM.DD.N, stamped into
// the binary, an image tag, the OCI label, a git tag and a GitHub Release. This
// static check reads .github/workflows/deploy.yml and the Dockerfile and
// asserts the pieces are wired together.
//
// Bibliovera has two jobs: build (every event, read-only token) computes the
// version and builds the image with it; publish (push or workflow_dispatch
// from main only) pushes the version tag and creates the release. The jobs are
// sliced the same way tools/ci_bv02_jobs_test.js does: one block per
// "  <name>:" line under "jobs:", in file order.
//
// The workflow is checked line by line, never with a regex that spans lines:
// one such regex hung with catastrophic backtracking in the Retractis pilot.
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const lines = fs.readFileSync(path.join(root, ".github", "workflows", "deploy.yml"), "utf8").split(/\r?\n/);
const docker = fs.readFileSync(path.join(root, "Dockerfile"), "utf8").split(/\r?\n/);

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// Jobs: a line with exactly two spaces of indent and a key, inside "jobs:".
const jobsAt = lines.findIndex((l) => l === "jobs:");
if (jobsAt < 0) {
  console.error("FAIL: no jobs: section in deploy.yml - refusing to pass silently");
  process.exit(1);
}
const jobs = [];
for (let j = jobsAt + 1; j < lines.length; j++) {
  const m = lines[j].match(/^  ([a-z-]+):$/);
  if (m) jobs.push({ name: m[1], start: j });
}
jobs.forEach((jb, i) => { jb.end = i + 1 < jobs.length ? jobs[i + 1].start : lines.length; });
const job = (name) => jobs.find((jb) => jb.name === name) || { name: "", start: -1, end: -1 };
const jobOf = (idx) => jobs.find((jb) => idx >= jb.start && idx < jb.end) || { name: "" };
const jobLines = (jb) => (jb.start < 0 ? [] : lines.slice(jb.start, jb.end));
// The permission lines of a job: the indented block under its "permissions:".
function perms(jb) {
  const p = jobLines(jb).findIndex((l) => l.trim() === "permissions:");
  if (p < 0) return [];
  const out = [];
  for (let j = jb.start + p + 1; j < jb.end && /^      \S/.test(lines[j]); j++) out.push(lines[j].trim());
  return out;
}

// The lines of one step, from its "- name:" to the next step or the end of
// its job. start is the index of the "- name:" line, -1 when missing.
function step(name) {
  const start = lines.findIndex((l) => l.trim() === "- name: " + name);
  if (start < 0) return { start: -1, lines: [] };
  const end = jobOf(start).end || lines.length;
  const out = [lines[start]];
  for (let j = start + 1; j < end && !/^\s*- name:/.test(lines[j]); j++) out.push(lines[j]);
  return { start, lines: out };
}
const has = (s, text) => s.lines.some((l) => l.includes(text));
const at = (s, text) => s.lines.findIndex((l) => l.includes(text));
const ifLine = (s) => s.lines.find((l) => /^\s*if:/.test(l)) || "";

const build = job("build");
const publish = job("publish");
check("build job exists", build.start >= 0);
check("publish job exists", publish.start >= 0);

// Every non-pull_request event on main (push and workflow_dispatch) is
// versioned: a workflow_dispatch run also pushes :latest, so it must not ship
// as "dev".
const NONPR_MAIN = /github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/;
const nonPRMain = (cond) => cond !== "" && NONPR_MAIN.test(cond) && !/event_name\s*==\s*'push'/.test(cond);

// Version step: in the build job, after Checkout.
const verCount = lines.filter((l) => l.trim() === "- name: Compute version").length;
check("version step exists once (found " + verCount + ")", verCount === 1);
const ver = step("Compute version");
check("version step is in the build job", ver.start >= 0 && jobOf(ver.start).name === "build");
check("version step has id: version", has(ver, "id: version"));
check("version step comes after Checkout",
  ver.start >= 0 && lines.slice(build.start, ver.start).some((l) => l.trim() === "- name: Checkout"));
check("version step if: is non-PR main and not event_name == 'push'", nonPRMain(ifLine(ver)));
check("version step uses date -u +%Y.%m.%d", has(ver, "date -u +%Y.%m.%d"));
check("version step uses git ls-remote --tags", has(ver, "git ls-remote --tags"));
check("version step writes GITHUB_OUTPUT", has(ver, "GITHUB_OUTPUT"));

// The publish job reads the version through needs.build.outputs.version.
const bl = jobLines(build);
const outAt = bl.findIndex((l) => l === "    outputs:");
check("build job has a job-level outputs: exposing steps.version.outputs.version",
  outAt >= 0 && (bl[outAt + 1] || "").trim() === "version: ${{ steps.version.outputs.version }}");
const bp = perms(build);
check("build job keeps contents: read", bp.includes("contents: read"));
check("build job has no contents: write", !bp.includes("contents: write") && !bl.some((l) => l.trim() === "contents: write"));

// Both image builds pass the version, so the label-check image and the
// exported image share their gha cache layers and say the same version.
for (const name of ["Build image for the label check", "Build and export"]) {
  const s = step(name);
  const argIdx = at(s, "build-args:");
  check(name + " is in the build job", s.start >= 0 && jobOf(s.start).name === "build");
  check(name + " passes build-args APP_VERSION",
    argIdx >= 0 && s.lines.slice(argIdx + 1).some((l) => l.trim() === "APP_VERSION=${{ steps.version.outputs.version || 'dev' }}"));
  check(name + " carries no version image tag",
    s.start >= 0 && !has(s, "format(") && !has(s, ":${{ steps.version") && !has(s, ":${{ needs.build"));
}
check("Build and export keeps outputs: type=docker", has(step("Build and export"), "outputs: type=docker"));

const pp = perms(publish);
check("publish job has contents: write", pp.includes("contents: write"));
check("publish job keeps packages: write", pp.includes("packages: write"));
check("publish job keeps needs: build", jobLines(publish).some((l) => l.trim() === "needs: build"));

// Load and push: tags the loaded :latest with the version and pushes it.
const lp = step("Load and push");
check("Load and push is in the publish job", lp.start >= 0 && jobOf(lp.start).name === "publish");
check("Load and push reads VERSION from needs.build.outputs.version",
  has(lp, "VERSION: ${{ needs.build.outputs.version }}"));
const testAt = lp.lines.findIndex((l) => l.trim().startsWith("test -n \"$VERSION\""));
const loadAt = lp.lines.findIndex((l) => l.trim().startsWith("docker load"));
const tagAt = lp.lines.findIndex((l) => l.trim() === "docker tag \"$REGISTRY/$IMAGE_NAME:latest\" \"$REGISTRY/$IMAGE_NAME:$VERSION\"");
const pushAt = lp.lines.findIndex((l) => l.trim().startsWith("docker push \"$REGISTRY/$IMAGE_NAME:$VERSION\""));
check("Load and push fails early on an empty VERSION", testAt >= 0 && loadAt >= 0 && testAt < loadAt);
check("Load and push tags :latest as :$VERSION after docker load", tagAt > loadAt && loadAt >= 0);
check("Load and push pushes :$VERSION after tagging it", pushAt > tagAt && tagAt >= 0);
check("Load and push keeps set -euo pipefail", lp.lines.some((l) => l.trim() === "set -euo pipefail"));
check("Load and push keeps the :latest and :sha pushes",
  lp.lines.some((l) => l.trim().startsWith("docker push \"$REGISTRY/$IMAGE_NAME:latest\"")) &&
  lp.lines.some((l) => l.trim().startsWith("docker push \"$REGISTRY/$IMAGE_NAME:${GITHUB_SHA}\"")));

// Release step: last in publish, after the pushes.
const rel = step("Create GitHub release");
check("release step exists", rel.start >= 0);
check("release step is in the publish job", rel.start >= 0 && jobOf(rel.start).name === "publish");
check("release step comes after Load and push", lp.start >= 0 && rel.start > lp.start);
check("release step reads VERSION from needs.build.outputs.version",
  has(rel, "VERSION: ${{ needs.build.outputs.version }}"));
check("release step uses GH_TOKEN: ${{ github.token }}", has(rel, "GH_TOKEN: ${{ github.token }}"));
check("release step runs gh release create --repo --target",
  rel.lines.some((l) => l.includes("gh release create") && l.includes("--repo \"$GITHUB_REPOSITORY\"") && l.includes("--target")));
// No checkout in publish, so gh cannot infer the repository from a clone.
const ghLines = rel.lines.filter((l) => /\bgh release\b/.test(l));
check("every gh call in the release step passes --repo (" + ghLines.length + " found)",
  ghLines.length > 0 && ghLines.every((l) => l.includes("--repo \"$GITHUB_REPOSITORY\"")));

for (const jb of jobs) {
  if (jb.name !== "publish") {
    check("job " + jb.name + " has no contents: write", !perms(jb).includes("contents: write"));
  }
}
check("no workflow-level contents: write", !lines.some((l) => /^  contents:\s*write/.test(l)));

// The default for every job is read-only: a top-level "permissions:" block
// holding exactly contents: read, before "jobs:".
const topAt = lines.findIndex((l) => l === "permissions:");
const topPerms = [];
for (let j = topAt + 1; topAt >= 0 && j < lines.length; j++) {
  const l = lines[j];
  if (l.trim() === "" || l.trim().startsWith("#")) continue;
  if (!/^ /.test(l)) break;
  topPerms.push(l.trim());
}
check("top-level permissions is contents: read (found " + JSON.stringify(topPerms) + ")",
  topAt >= 0 && topAt < jobsAt && JSON.stringify(topPerms) === JSON.stringify(["contents: read"]));

// The build checkout keeps no token in .git/config (the repository is public).
const checkout = step("Checkout");
check("build Checkout has persist-credentials: false",
  checkout.start >= 0 && jobOf(checkout.start).name === "build" && checkout.lines.some((l) => l.trim() === "persist-credentials: false"));

// The image artifact lives one day: it also runs on pull requests.
const upload = step("Upload image artifact");
check("Upload image artifact has retention-days: 1",
  upload.start >= 0 && jobOf(upload.start).name === "build" && upload.lines.some((l) => l.trim() === "retention-days: 1"));

// The existing concurrency block stays as it is: PR runs cancel, main runs
// queue (cancel-in-progress is false on main).
const concs = lines.map((l, i) => (l === "concurrency:" ? i : -1)).filter((i) => i >= 0);
check("exactly one concurrency block (found " + concs.length + ")", concs.length === 1);
const conc = concs[0];
check("concurrency group is per workflow and ref",
  conc >= 0 && (lines[conc + 1] || "").trim() === "group: ${{ github.workflow }}-${{ github.ref }}");
check("cancel-in-progress only on pull_request",
  conc >= 0 && (lines[conc + 2] || "").trim() === "cancel-in-progress: ${{ github.event_name == 'pull_request' }}");

// Dockerfile: the version reaches the binary and the image label.
const fromAt = (re) => docker.findIndex((l) => re.test(l));
const webAt = fromAt(/^FROM .* AS web-builder$/);
const runAt = docker.reduce((last, l, i) => (/^FROM /.test(l) ? i : last), -1);
const argAts = docker.map((l, i) => (l.trim() === "ARG APP_VERSION=dev" ? i : -1)).filter((i) => i >= 0);
check("Dockerfile has ARG APP_VERSION=dev twice (found " + argAts.length + ")", argAts.length === 2);
check("Dockerfile declares APP_VERSION right after the web-builder FROM", webAt >= 0 && argAts.includes(webAt + 1));
check("Dockerfile declares APP_VERSION in the runtime stage", runAt > webAt && argAts.some((i) => i > runAt));
check("Dockerfile ldflags set -X ....appVersion=", docker.some((l) => /\bgo build\b/.test(l) && l.includes("-X ") && l.includes(".appVersion=")));
check("Dockerfile has the org.opencontainers.image.version label",
  docker.some((l) => l.trim() === "LABEL org.opencontainers.image.version=${APP_VERSION}"));

// Bibliovera's web-builder names its Go files on the COPY line. A COPY that
// drops version.go, or a build of ./main.go alone, breaks the image build
// (handleVersion undefined) while go test stays green.
check("Dockerfile copies version.go (COPY *.go or by name)",
  docker.some((l) => /^COPY\s/.test(l) && (/(^|\s)\*\.go(\s|$)/.test(l) || /\bversion\.go\b/.test(l))));
const goBuilds = docker.filter((l) => /\bgo build\b/.test(l));
check("Dockerfile has a go build line and none targets ./main.go",
  goBuilds.length > 0 && goBuilds.every((l) => !/\.\/main\.go\b/.test(l)));

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("all release workflow checks pass");
