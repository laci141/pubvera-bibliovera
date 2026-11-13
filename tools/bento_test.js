// Desktop bento layout: 3 columns x 2 rows from 769px up (owner decision: never 2x3, never 6 in one row), 1 column on
// phones. Overflow is prevented by minmax(0,1fr) tracks and wrapping labels, not by switching to auto-fit.
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
let fail = 0;
function check(name, ok) { console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fail++; }

// Returns the body of every @media block whose header matches re (whitespace removed), by brace matching.
function blocks(re) {
  const out = [];
  const g = new RegExp(re.source, "g");
  let m;
  while ((m = g.exec(src))) {
    let depth = 1, i = g.lastIndex;
    while (i < src.length && depth > 0) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; i++; }
    out.push(src.slice(g.lastIndex, i - 1).replace(/\s+/g, ""));
  }
  return out;
}

const h = blocks(/@media\s*\(\s*min-width\s*:\s*769px\s*\)\s*and\s*\(\s*max-width\s*:\s*999px\s*\)\s*\{/);
check("B1 exactly one @media(min-width:769px) and (max-width:999px) block (got " + h.length + ")", h.length === 1);
const old = blocks(/@media\s*\(\s*min-width\s*:\s*769px\s*\)\s*and\s*\(\s*max-width\s*:\s*1379px\s*\)\s*\{/);
check("B1b the old (max-width:1379px) auto-fit block is gone (got " + old.length + ")", old.length === 0);
const hb = h[0] || "";
check("B2 H block .bento keeps 3 columns: repeat(3,minmax(0,1fr))",
  /\.bento\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)[;}]/.test(hb));
const lb = (hb.match(/\.card\.lb,\.card\.sub\{[^}]*\}/) || [""])[0];
check("B3 H block .card .lb,.card .sub has white-space:normal and overflow-wrap:break-word",
  /white-space:normal/.test(lb) && /overflow-wrap:break-word/.test(lb));
const base = (src.match(/\n\s*\.bento\s*\{[^}]*\}/) || [""])[0].replace(/\s+/g, "");
check("B4 base .bento rule has repeat(3,minmax(0,1fr)) (equal tracks that may shrink below their text)",
  /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/.test(base) && !/repeat\(3,1fr\)/.test(base));
const bentoRules = [...src.matchAll(/\.bento\s*\{[^}]*\}/g)].map((m) => m[0].replace(/\s+/g, ""));
check("B6 no .bento rule uses auto-fit/auto-fill, which is what produced 2x3 (" + bentoRules.length + " rules)",
  bentoRules.length >= 3 && bentoRules.every((r) => !/auto-fit|auto-fill/.test(r)));
const lbBase = (src.match(/\n\s*\.card \.lb\s*\{[^}]*\}/) || [""])[0];
const subBase = (src.match(/\n\s*\.card \.sub\s*\{[^}]*\}/) || [""])[0];
check("B7 base .card .lb and .card .sub wrap (white-space:normal, no nowrap)",
  lbBase !== "" && subBase !== "" && !/nowrap/.test(lbBase + subBase) &&
  /white-space:normal/.test(lbBase) && /white-space:normal/.test(subBase));
const m359 = blocks(/@media\s*\(\s*max-width\s*:\s*359px\s*\)\s*\{/);
const m768 = blocks(/@media\s*\(\s*max-width\s*:\s*768px\s*\)\s*\{/);
check("B5a @media(max-width:359px) keeps .card .lb,.card .sub wrap rule",
  m359.length === 1 && m359[0].includes(".card.lb,.card.sub{white-space:normal;overflow-wrap:anywhere}"));
check("B5b @media(max-width:768px) keeps single-column .bento rule",
  m768.length === 1 && /\.bento\{grid-template-columns:1fr;/.test(m768[0]));
process.exit(fail ? 1 : 0);
