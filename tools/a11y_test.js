// Keyboard and screen-reader contract of index.html: the six cards are real buttons, the six modals are
// WAI-ARIA APG modal dialogs (role, label, focus in/out, Tab trap, inert background, Escape), and the glass panel CSS is untouched.
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
let fail = 0, total = 0;
function check(name, ok) { total++; console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fail++; }
const count = (re) => (src.match(re) || []).length;
// Source of a top-level function, from "function name(" to the closing brace at column 0.
function fn(name) {
  const m = src.match(new RegExp("^function " + name + "\\([^)]*\\)\\{[\\s\\S]*?^\\}", "m"));
  return m ? m[0] : "";
}

const buttons = count(/<button type="button" class="card"/g);
const divCards = count(/<div class="card"/g);
check("A1 six <button type=\"button\" class=\"card\"> and no <div class=\"card\"> (" + buttons + " buttons, " + divCards + " divs)", buttons === 6 && divCards === 0);

const clickOnNonControl = count(/<(div|span|li|tr|article)[^>]*onclick/g);
check("A2 no onclick on div/span/li/tr/article (" + clickOnNonControl + ")", clickOnNonControl === 0);

const dialogs = count(/role="dialog"/g), modalAria = count(/aria-modal="true"/g);
check("A3 six role=\"dialog\" and six aria-modal=\"true\" (" + dialogs + ", " + modalAria + ")", dialogs === 6 && modalAria === 6);

const labelledby = [...src.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
const missing = labelledby.filter((id) => !new RegExp('id="' + id + '"').test(src));
check("A4 every aria-labelledby has a matching id (" + labelledby.length + " refs, " + missing.length + " missing)", labelledby.length === 6 && missing.length === 0);

const open = fn("openModal");
check("A5 open path stores the opener and focuses an element inside the dialog",
  /document\.activeElement/.test(open) && /\.focus\(\)/.test(open) && /querySelector\("\.mc"\)|\.mc\b/.test(open));

const close = fn("closeModal");
check("A6 close path restores focus to the stored opener", /\.focus\(\)/.test(close) && /isConnected|contains\(/.test(close) && /Opener/.test(close));

check("A7 Tab handler wraps first/last",
  /key\s*[!=]==\s*"Tab"/.test(src) && /shiftKey/.test(src) && /first\.focus\(\)/.test(src) && /last\.focus\(\)/.test(src));

check("A8 inert is set on open and removed on close", /\.inert\s*=\s*true/.test(open) && /\.inert\s*=\s*false/.test(close));

check("A9 .card:focus-visible rule exists", /\.card:focus-visible\s*\{[^}]*outline:/.test(src));

const backdrop = (src.match(/querySelectorAll\("\.modal"\)\.forEach\([^\n]*/) || [""])[0];
check("A10 backdrop click calls the shared close function", /closeModal\(/.test(backdrop) && !/classList\.remove/.test(backdrop));

// Counted on main with: git show main:index.html | grep -c <pattern>   (lines, not occurrences)
const lines = src.split("\n");
const lineCount = (s) => lines.filter((l) => l.includes(s)).length;
check("A11 glass panel unchanged: backdrop-filter lines " + lineCount("backdrop-filter") + "/13, -webkit-backdrop-filter lines " + lineCount("-webkit-backdrop-filter") + "/10, body::before lines " + lineCount("body::before") + "/1",
  lineCount("backdrop-filter") === 13 && lineCount("-webkit-backdrop-filter") === 10 && lineCount("body::before") === 1);

// Every modal close button is an icon-only "×": it needs an accessible name.
const closeBtns = count(/<button class="x"/g), closeBtnsLabelled = count(/<button class="x" aria-label="Close"/g);
check("A12 six <button class=\"x\"> and all six carry aria-label=\"Close\" (" + closeBtnsLabelled + "/" + closeBtns + ")", closeBtns === 6 && closeBtnsLabelled === 6);

// WCAG 1.4.10: card text must wrap, never be hidden. Check the .lb and .sub rules (and any later rule for them).
const lbSubRules = [...src.matchAll(/[^{}]*\.(?:lb|sub)\b[^{}]*\{[^}]*\}/g)].map((m) => m[0]);
const ellipsisRules = lbSubRules.filter((r) => /text-overflow\s*:\s*ellipsis/.test(r));
check("A13 no text-overflow:ellipsis on .lb/.sub (" + lbSubRules.length + " rules checked, " + ellipsisRules.length + " with ellipsis)", lbSubRules.length > 0 && ellipsisRules.length === 0);

console.log((fail ? "FAIL " : "PASS ") + (total - fail) + "/" + total);
process.exit(fail ? 1 : 0);
