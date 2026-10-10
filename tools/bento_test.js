// Desktop bento overflow fix (769-1379 px): the H media block must exist and the other layouts must stay as they were.
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

const h = blocks(/@media\s*\(\s*min-width\s*:\s*769px\s*\)\s*and\s*\(\s*max-width\s*:\s*1379px\s*\)\s*\{/);
check("B1 exactly one @media(min-width:769px) and (max-width:1379px) block (got " + h.length + ")", h.length === 1);
const hb = h[0] || "";
check("B2 H block .bento uses repeat(auto-fit,minmax(min(100%,400px),1fr))",
  hb.includes(".bento{grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr))}"));
const lb = (hb.match(/\.card\.lb,\.card\.sub\{[^}]*\}/) || [""])[0];
check("B3 H block .card .lb,.card .sub has white-space:normal and overflow-wrap:break-word",
  /white-space:normal/.test(lb) && /overflow-wrap:break-word/.test(lb));
const base = (src.match(/\n\s*\.bento\s*\{[^}]*\}/) || [""])[0].replace(/\s+/g, "");
check("B4 base .bento rule still has repeat(3,1fr)", /grid-template-columns:repeat\(3,1fr\)/.test(base));
const m359 = blocks(/@media\s*\(\s*max-width\s*:\s*359px\s*\)\s*\{/);
const m768 = blocks(/@media\s*\(\s*max-width\s*:\s*768px\s*\)\s*\{/);
check("B5a @media(max-width:359px) keeps .card .lb,.card .sub wrap rule",
  m359.length === 1 && m359[0].includes(".card.lb,.card.sub{white-space:normal;overflow-wrap:anywhere}"));
check("B5b @media(max-width:768px) keeps single-column .bento rule",
  m768.length === 1 && /\.bento\{grid-template-columns:1fr;/.test(m768[0]));
process.exit(fail ? 1 : 0);
