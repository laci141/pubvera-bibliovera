// Result header (.meta-row) desktop wrap: the count text must wrap onto its own line instead of
// being squeezed by the export group, and the mobile (<=768px) stacking rules must stay unchanged.
//
// Run: node tools/toolbar_wrap_test.js
//
// CSS-source check, same loading pattern as tools/a11y_test.js (index.html read as text, sliced by regex).
// No server, no network, no browser: layout is verified separately with pw-xbrowser/toolbar.mjs.
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
let fail = 0, total = 0;
function check(name, ok) { total++; console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fail++; }

// Desktop CSS = everything before the first @media(max-width:768px) block; mobile = that block's body.
const mediaAt = src.search(/@media\(max-width:768px\)\{/);
const desktop = mediaAt < 0 ? src : src.slice(0, mediaAt);
const mobile = mediaAt < 0 ? "" : src.slice(mediaAt).split(/\n  \}\n/)[0];

// Declarations of a rule whose selector is exactly `sel` (whitespace-free), or "".
function rule(css, sel) {
  let from = 0;
  for (;;) {
    const i = css.indexOf(sel + "{", from);
    if (i < 0) return "";
    const prev = i ? css[i - 1] : " ";
    if (/[\s}]/.test(prev)) {
      return css.slice(i + sel.length + 1, css.indexOf("}", i)).split(/\s+/).join(" ").trim();
    }
    from = i + 1;
  }
}
const has = (decls, d) => (";" + decls.split("; ").join(";") + ";").includes(";" + d + ";");

const row = rule(desktop, ".meta-row");
const meta = rule(desktop, ".meta");
const group = rule(desktop, ".dl-group");

check("W1 .meta-row desktop rule has flex-wrap:wrap", has(row, "flex-wrap:wrap"));

// min-width:0 lives in the base rule; the flex-basis lives in the @media(min-width:769px) block (checked by W5).
const bm = src.match(/@media\s*\(min-width:769px\)\s*\{\s*\.meta\{[^}]*?flex:[\d.]+ [\d.]+ ([\d.]+)px/) ||
  src.match(/@media\s*\(min-width:769px\)\s*\{\s*\.meta\{[^}]*?flex-basis:([\d.]+)px/);
const basisPx = bm ? parseFloat(bm[1]) : 0;
check("W2 .meta has min-width:0 and flex-basis >= 240px", has(meta, "min-width:0") && basisPx >= 240);

check("W3 .dl-group desktop rule allows wrapping and has max-width:100%",
  has(group, "flex-wrap:wrap") && has(group, "max-width:100%"));

check("W4 mobile .meta-row/.dl-group/.qfilter rules unchanged",
  mobile.includes(".meta-row{flex-direction:column;align-items:stretch}") &&
  mobile.includes(".dl-group{flex-wrap:wrap}") &&
  mobile.includes(".dl-group .qfilter{flex:1 1 100%;width:auto}"));

// W5: the flex-basis of .meta is desktop-only. On phones .meta-row is flex-direction:column, so a flex-basis
// there sets HEIGHT (measured: meta_lines=10 at 360-768px). It must live in a @media(min-width:769px) block,
// never in the base rules and never in the @media(max-width:768px) block.
const style = src.slice(src.indexOf("<style"), src.indexOf("</style>"));

// Bodies of every @media block whose head matches headRe (brace-matched), plus the CSS left without them.
function mediaSplit(css, headRe) {
  const re = new RegExp(headRe.source, "g");
  const bodies = [];
  let rest = "", last = 0, m;
  while ((m = re.exec(css))) {
    let depth = 1, i = re.lastIndex;
    for (; i < css.length && depth; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    bodies.push(css.slice(re.lastIndex, i - 1));
    rest += css.slice(last, m.index);
    last = i;
    re.lastIndex = i;
  }
  return { bodies, rest: rest + css.slice(last) };
}
const basisOf = (decls) => {
  const b = decls.match(/(?:^|;)flex:[\d.]+ [\d.]+ ([\d.]+)px/) || decls.match(/(?:^|;)flex-basis:([\d.]+)px/);
  return b ? parseFloat(b[1]) : 0;
};

const wideBlocks = mediaSplit(style, /@media\s*\(min-width:769px\)\s*\{/);
const wide = wideBlocks.bodies.map((b) => rule(b, ".meta")).join(";");
const baseCss = mediaSplit(wideBlocks.rest, /@media[^{]*\{/).rest;
const narrow = mediaSplit(style, /@media\s*\(max-width:768px\)\s*\{/).bodies.map((b) => rule(b, ".meta")).join(";");
check("W5 .meta flex-basis only in @media(min-width:769px); none in base or @media(max-width:768px)",
  basisOf(wide) >= 240 && basisOf(rule(baseCss, ".meta")) === 0 && basisOf(narrow) === 0);

console.log(`\n${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
