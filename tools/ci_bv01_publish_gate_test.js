// CI publish gate test (audit BV-01).
//
// Run: node tools/ci_bv01_publish_gate_test.js
//
// deploy.yml must push :latest only from main. Both publish gates (the "Log in
// to GHCR" step condition and the "Build and push" push: flag) must check the
// ref as well as the event type, otherwise a manual workflow_dispatch run from
// any branch moves :latest. This static check reads .github/workflows/deploy.yml
// and asserts:
//   (a) the "Log in to GHCR" if: line is exactly the expected expression;
//   (b) the "Build and push" push: line is exactly the expected expression;
//   (c) the expected expression appears exactly twice in the file;
//   (d) workflow_dispatch: is still a trigger under on:.
"use strict";
const fs = require("fs");
const path = require("path");

const raw = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "deploy.yml"), "utf8");
const yml = raw.replace(/\r/g, "");

const EXPR = "github.event_name != 'pull_request' && github.ref == 'refs/heads/main'";
const EXPECTED_IF = "        if: " + EXPR;
const EXPECTED_PUSH = "          push: ${{ " + EXPR + " }}";

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

function lineStarting(step, prefix) {
  if (!step) return "";
  return step.body.split("\n").find((l) => l.trimStart().startsWith(prefix)) || "";
}

const login = steps.find((s) => s.name === "Log in to GHCR");
const push = steps.find((s) => s.name === "Build and push");

const loginIf = lineStarting(login, "if:");
check("(a) GHCR login if: line is \"" + EXPECTED_IF.trim() + "\" (got \"" + loginIf.trim() + "\")",
  !!login && loginIf === EXPECTED_IF);

const pushLine = lineStarting(push, "push:");
check("(b) build-push push: line is \"" + EXPECTED_PUSH.trim() + "\" (got \"" + pushLine.trim() + "\")",
  !!push && pushLine === EXPECTED_PUSH);

const count = yml.split(EXPR).length - 1;
check("(c) the expected expression appears exactly 2 times (got " + count + ")", count === 2);

check("(d) workflow_dispatch: is still present under on:",
  /^on:\n(?:(?: {2}.*|)\n)*? {2}workflow_dispatch:/m.test(yml));

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("all CI publish gate checks pass");
