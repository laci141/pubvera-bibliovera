// Style guard test (CSP style phase S0).
//
// Run: node tools/style_guard_test.js
//
// style-src-attr 'none' blocks every style attribute, also in HTML built by
// script (innerHTML) and setAttribute('style'). Script that assigns el.style.x
// keeps working, so that is not checked here. index.html therefore carries no
// style attribute, and the classes that replaced them must exist and be used:
//   G1 no style= anywhere in index.html, markup and script strings;
//   G2 no setAttribute("style" at all: the mesh PNG export copies computed
//      styles onto its serialised svg clone through the CSSOM, one
//      style.setProperty per property (S1b), which style-src-attr allows;
//   G3 each managed class is defined exactly once, in the doubled form .x.x
//      (specificity 0,2,0, so it wins where the inline style won), never in
//      the single form, and is used at least once;
//   G4 no u-/tone-/tier-/doi- class is used that is not defined;
//   G5 the closed lists equal the defined classes: tone-<key> per card key and
//      per modal, tier-0..tier-3 in MESH_TIER_CLASSES with MESH_TIER_COLORS;
//   G6 the data-driven sizes are set through the CSSOM (applyDataSizes).
"use strict";
const fs = require("fs");
const path = require("path");

const raw = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
if (!/<style\b/.test(raw) || !/<script\b/.test(raw)) {
  console.error("FAIL: no <style> or <script> found in index.html - refusing to pass silently");
  process.exit(1);
}
const lineOf = (s, i) => s.slice(0, i).split("\n").length;
const styleM = raw.match(/<style\b[^>]*>([\s\S]*?)<\/style>/);
const css = (styleM ? styleM[1] : "").replace(/\/\*[\s\S]*?\*\//g, "");
// Markup and scripts only: the style block blanked, line numbers kept.
const body = raw.replace(/<style\b[^>]*>[\s\S]*?<\/style>/, m => m.replace(/[^\n]/g, " "));

let ran = 0;
let failed = 0;
function check(label, ok) {
  ran++;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// ── G1: no style attribute, in any spelling (an escaped quote counts too) ──
const plain = [...raw.matchAll(/style=/g)];   // case-sensitive, like grep: ctx.fillStyle= is not an attribute
const spaced = [...raw.matchAll(/\sstyle\s*=\s*\\?["'`]/gi)];
check("G1 no style= in index.html (found " + plain.length + ")", plain.length === 0);
check("G1 no style = \"...\" with spaces either (found " + spaced.length + ")", spaced.length === 0);
for (const m of plain) console.log("      L" + lineOf(raw, m.index) + ": " + raw.slice(m.index, m.index + 40).split("\n")[0]);

// ── G2: no setAttribute("style"); meshPNG copies through the CSSOM ──
const setAttr = [...raw.matchAll(/setAttribute\s*\(\s*["'`]style["'`]/g)];
check("G2 no setAttribute(\"style\" in index.html (found " + setAttr.length + ")", setAttr.length === 0);
for (const m of setAttr) console.log("      L" + lineOf(raw, m.index) + ": " + raw.slice(m.index, m.index + 60).split("\n")[0]);
const pngStart = body.indexOf("meshPNG=()=>{");
const pngBody = pngStart < 0 ? "" : body.slice(pngStart, body.indexOf("\n  };\n", pngStart));
const copyLoop = /const from=src\.querySelectorAll\("\*"\), to=clone\.querySelectorAll\("\*"\);\n\s*for\(let i=0;i<from\.length;i\+\+\)\{\n\s*const cs=getComputedStyle\(from\[i\]\);\n\s*to\[i\]\.removeAttribute\("style"\);\n\s*props\.forEach\(q=>to\[i\]\.style\.setProperty\(q,cs\.getPropertyValue\(q\)\)\);\n\s*\}/;
check("G2 meshPNG clears each clone element's style and sets every prop with to[i].style.setProperty" +
  " (meshPNG at L" + (pngStart < 0 ? "-" : lineOf(body, pngStart)) + ")", copyLoop.test(pngBody));

// ── G3/G4: the managed classes ──
const TONE_KEYS = ["aff", "auth", "drift", "read", "rise", "mesh"];
const TIERS = ["tier-0", "tier-1", "tier-2", "tier-3"];
const MANAGED = [...TONE_KEYS.map(k => "tone-" + k), "u-ta-right", "doi-link", ...TIERS];

const classTokens = new Set();
for (const m of body.matchAll(/\bclass\s*=\s*\\?["']([^"'\\]*)/g)) {
  for (const t of m[1].split(/\s+/)) if (t) classTokens.add(t);
}
// The tier classes are picked from the closed list MESH_TIER_CLASSES.
const tierListM = body.match(/const MESH_TIER_CLASSES=\[([^\]]*)\];/);
const tierList = tierListM ? [...tierListM[1].matchAll(/"([^"]*)"/g)].map(m => m[1]) : [];
const tierUses = (body.match(/class="'\+\(MESH_TIER_CLASSES\[[^\]]+\]\|\|''\)\+'"/g) || []).length;

for (const c of MANAGED) {
  const doubled = (css.match(new RegExp("(^|[\\s,}])\\." + c + "\\." + c + "\\s*\\{", "g")) || []).length;
  const single = (css.match(new RegExp("(^|[\\s,}])\\." + c + "\\s*[{,:]", "g")) || []).length;
  check("G3 ." + c + " defined once as ." + c + "." + c + " (found " + doubled + " doubled, " + single + " single)",
    doubled === 1 && single === 0);
  const used = c.startsWith("tier-") ? tierList.includes(c) && tierUses > 0 : classTokens.has(c);
  check("G3 ." + c + " is used", used);
}
const managedLooking = [...classTokens].filter(t => /^(u|tone|tier|doi)-/.test(t));
const undef = managedLooking.filter(t => !MANAGED.includes(t));
check("G4 every u-/tone-/tier-/doi- class used is defined (undefined: " + (undef.join(", ") || "none") + ")", undef.length === 0);
const cssManaged = [...new Set([...css.matchAll(/\.((?:u|tone|tier|doi)-[a-z0-9-]+)/g)].map(m => m[1]))];
const extra = cssManaged.filter(c => !MANAGED.includes(c));
check("G4 no unmanaged u-/tone-/tier-/doi- rule in the style block (extra: " + (extra.join(", ") || "none") + ")", extra.length === 0);

// ── G5: the closed lists ──
const cardKeys = [...body.matchAll(/<button type="button" class="card tone-([a-z]+)" data-action="open-modal" data-modal="([a-z]+)"/g)];
check("G5 six cards, each tone-<key> equals its data-modal key (" + cardKeys.map(m => m[1] + "/" + m[2]).join(" ") + ")",
  cardKeys.length === 6 && cardKeys.every(m => m[1] === m[2]) &&
  JSON.stringify(cardKeys.map(m => m[1]).sort()) === JSON.stringify([...TONE_KEYS].sort()));
const modalKeys = [...body.matchAll(/<div class="modal" id="([a-z]+)Modal"><div class="mc tone-([a-z]+)"/g)];
check("G5 six modals, each .mc tone-<key> equals its id (" + modalKeys.map(m => m[1] + "/" + m[2]).join(" ") + ")",
  modalKeys.length === 6 && modalKeys.every(m => m[1] === m[2]) &&
  JSON.stringify(modalKeys.map(m => m[1]).sort()) === JSON.stringify([...TONE_KEYS].sort()));
check("G5 MESH_TIER_CLASSES is exactly " + TIERS.join(",") + " (found " + (tierList.join(",") || "none") + ")",
  JSON.stringify(tierList) === JSON.stringify(TIERS));
check("G5 the legend and the co-author list both take the tier class from the list (found " + tierUses + ")", tierUses === 2);
const colorsM = body.match(/const MESH_TIER_COLORS=\[([^\]]*)\];/);
const colors = colorsM ? [...colorsM[1].matchAll(/"([^"]*)"/g)].map(m => m[1]) : [];
const tierCss = TIERS.map(c => (css.match(new RegExp("\\." + c + "\\." + c + "\\s*\\{\\s*background\\s*:\\s*([^;}]+?)\\s*[;}]")) || [])[1]);
check("G5 .tier-N background equals MESH_TIER_COLORS[N] (css " + tierCss.join(",") + " / js " + colors.join(",") + ")",
  colors.length === 4 && tierCss.every((v, i) => v && v.toLowerCase() === colors[i].toLowerCase()));

// ── G6: data-driven sizes through the CSSOM ──
check("G6 the institution bar carries its scale in data-scale", /<div class="bar-chart" data-scale="'\+\(barPct\/100\)\+'"><\/div>/.test(body));
check("G6 both drift bars carry their width in data-w", (body.match(/<div class="drift-fill (?:rising|fading)" data-w="'\+w\+'"><\/div>/g) || []).length === 2);
check("G6 applyDataSizes sets transform and width through el.style",
  /el\.style\.transform="scaleX\("\+el\.dataset\.scale\+"\)"/.test(body) && /el\.style\.width=el\.dataset\.w\+"%"/.test(body));
check("G6 runAff and runDrift call applyDataSizes(res) right after the render",
  /res\.innerHTML=affTable\(data,j,p\);\n\s*applyDataSizes\(res\);/.test(body) &&
  /res\.innerHTML=driftChart\(data,j,w1,w2\);\n\s*applyDataSizes\(res\);/.test(body));

if (ran === 0) {
  console.error("FAIL: zero checks ran - refusing to pass silently");
  process.exit(1);
}
console.log((ran - failed) + "/" + ran + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
