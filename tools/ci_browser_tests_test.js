// Browser tests in CI.
//
// Run: node tools/ci_browser_tests_test.js
//
// tools/browser/csp.spec.js drives the real index.html under the real CSP
// headers, but only if CI runs it. This static check reads
// .github/workflows/deploy.yml, tools/browser/package.json,
// tools/browser/package-lock.json and .dockerignore and asserts:
//   (a) the build job has a "Run browser tests" step;
//   (b) it sits after "Run JS tests" and before "Set up Buildx";
//   (c) its working-directory is tools/browser;
//   (d) it runs "npm ci --ignore-scripts" (no install scripts from the
//       registry), installs chromium and runs playwright test;
//   (e) it has a timeout-minutes and no uses: line;
//   (f) package.json pins @playwright/test to an exact version (no ^ or ~);
//   (g) package-lock.json resolves @playwright/test to that same version;
//   (h) .dockerignore lists tools/browser/node_modules/ and
//       tools/browser/test-results/.
//
// The workflow is checked line by line, never with a regex that spans lines,
// as tools/release_workflow_test.js does.
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const lines = fs.readFileSync(path.join(root, ".github", "workflows", "deploy.yml"), "utf8").split(/\r?\n/);

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

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
const build = jobs.find((jb) => jb.name === "build") || { start: -1, end: -1 };
check("build job exists", build.start >= 0);

// Index of a step's "- name:" line inside the build job, -1 when missing.
const stepAt = (name) => {
  for (let j = build.start; j >= 0 && j < build.end; j++) if (lines[j].trim() === "- name: " + name) return j;
  return -1;
};
const stepLines = (start) => {
  if (start < 0) return [];
  const out = [lines[start]];
  for (let j = start + 1; j < build.end && !/^\s*- name:/.test(lines[j]); j++) out.push(lines[j]);
  return out;
};

const js = stepAt("Run JS tests");
const bt = stepAt("Run browser tests");
const bx = stepAt("Set up Buildx");
check("(a) build job has a \"Run browser tests\" step", bt >= 0);
check("(b) order: Run JS tests (" + js + ") < Run browser tests (" + bt + ") < Set up Buildx (" + bx + ")",
  js >= 0 && bt > js && bx > bt);
const s = stepLines(bt).map((l) => l.trim());
check("(c) working-directory: tools/browser", s.includes("working-directory: tools/browser"));
check("(d) runs npm ci --ignore-scripts", s.includes("npm ci --ignore-scripts"));
check("(d) installs chromium with its dependencies", s.includes("npx playwright install --with-deps chromium"));
check("(d) runs npx playwright test", s.some((l) => l.startsWith("npx playwright test")));
check("(e) has timeout-minutes", s.some((l) => /^timeout-minutes: [0-9]+$/.test(l)));
check("(e) has no uses: line", !!s.length && !s.some((l) => l.startsWith("uses:")));

const readJSON = (p) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, p), "utf8")); } catch (_) { return null; }
};
const pkg = readJSON("tools/browser/package.json");
const want = pkg && pkg.devDependencies && pkg.devDependencies["@playwright/test"];
check("(f) package.json pins @playwright/test exactly (got " + JSON.stringify(want) + ")",
  typeof want === "string" && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(want));
const lock = readJSON("tools/browser/package-lock.json");
const locked = lock && lock.packages && lock.packages["node_modules/@playwright/test"];
check("(g) package-lock.json has @playwright/test " + want + " (got " + JSON.stringify(locked && locked.version) + ")",
  !!locked && locked.version === want);

let dockerignore = [];
try {
  dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
} catch (_) { /* reported below */ }
check("(h) .dockerignore lists tools/browser/node_modules/", dockerignore.includes("tools/browser/node_modules/"));
check("(h) .dockerignore lists tools/browser/test-results/", dockerignore.includes("tools/browser/test-results/"));

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("all browser-test CI checks pass");
