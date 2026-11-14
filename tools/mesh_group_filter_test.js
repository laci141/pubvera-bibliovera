// Collaboration Network group filter: the source contract of a selected group.
// B1: non-members, their labels and every link that is not member-to-member are display:none (set through d3,
//     never a style="" attribute in an HTML string), not dimmed; pickAt skips them.
// B2: updateLabels runs when the fly-to transition ends.
// B4: All, the same button again and Escape (pin first, then group) clear the group and restore the view.
//
// Run: node tools/mesh_group_filter_test.js
//
// Same loading pattern as tools/mesh_groups_test.js (index.html read as text, source sliced by regex).
// No server, no network, no DOM. The behaviour itself is covered by tools/browser/csp.spec.js T12.
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
let fail = 0, total = 0;
function check(name, ok) { total++; console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fail++; }

// A function nested in drawMeshGraph (2-space indent), from "  function name(" to the brace at column 2.
const inner = (name) => (src.match(new RegExp("^ {2}function " + name + "\\([^)]*\\)\\{[\\s\\S]*?^ {2}\\}", "m")) || [""])[0];
const draw = (src.match(/^function drawMeshGraph\(pairs\)\{[\s\S]*?^\}/m) || [""])[0];
const pickAt = inner("pickAt"), groupVis = inner("applyGroupVis"), labelVis = inner("applyLabelVis"), focus = inner("applyFocus");
const clear = inner("clearGroup"), select = inner("selectGroup"), rows = inner("pinnedRows"), inGroup = inner("inGroup");
const noFocus = (focus.match(/if\(!id\)\{[\s\S]*?return;\s*\}/) || [""])[0];

check("F0 drawMeshGraph and the group functions are found", !!draw && !!pickAt && !!groupVis && !!labelVis && !!focus && !!clear && !!select && !!rows && !!inGroup);
check("F1 inGroup(d) is true with no group and for a member of the selected group",
  /return !selGroup\|\|selGroup\.set\.has\(d\.id\);/.test(inGroup));
// B1
check("F2 applyGroupVis hides non-member nodes with display none",
  /node\.style\("display",selGroup\?d=>inGroup\(d\)\?null:"none":null\)/.test(groupVis));
check("F3 applyGroupVis hides every link that is not member-to-member with display none",
  /link\.style\("display",selGroup\?l=>\(inGroup\(l\.source\)&&inGroup\(l\.target\)\)\?null:"none":null\)/.test(groupVis));
check("F4 labels of non-members are display none (applyLabelVis)",
  /label\.style\("display",d=>!inGroup\(d\)\|\|/.test(labelVis));
check("F5 applyFocus applies the group visibility first, on every call",
  /^ {2}function applyFocus\(id\)\{\n\s*applyGroupVis\(\);/m.test(focus));
check("F6 no dimming for the group: the no-focus branch sets no .15 opacity and no selGroup-dependent opacity",
  !!noFocus && !/\.15/.test(noFocus) && !/opacity",selGroup/.test(noFocus) && /node\.style\("opacity",null\)/.test(noFocus));
check("F7 no style=\"...\" attribute is written in an HTML string inside drawMeshGraph (CSP style-src-attr 'none')",
  !!draw && !/style=\\?["']/.test(draw) && !/setAttribute\(\s*["']style["']/.test(draw));
// pickAt skip
check("F8 pickAt skips non-members: meshSim.find (which cannot filter) only with no group, the scan skips !inGroup",
  /if\(!selGroup&&meshSim&&typeof meshSim\.find==="function"\)/.test(pickAt) && /if\(!inGroup\(d\)\) continue;/.test(pickAt));
check("F9 pinFocus refuses a hidden author", /if\(!neighbours\.has\(id\)\|\|!inGroup\(nodeMap\.get\(id\)\)\) return;/.test(inner("pinFocus")));
check("F10 inside a group a focus and the co-author list reach members only",
  /const near=selGroup\?new Set\(\[\.\.\.neighbours\.get\(id\)\]\.filter\(x=>selGroup\.set\.has\(x\)\)\):neighbours\.get\(id\);/.test(focus) &&
  /inGroup\(l\.source\)&&inGroup\(l\.target\)/.test(rows));
// B2
check("F11 updateLabels runs when the fly-to transition ends (zoom cap 2.5 kept)",
  /Math\.min\(2\.5,/.test(select) && /\.scale\(gk\)\)\s*\.on\("end",updateLabels\)/.test(select));
// B4
check("F12 clearGroup: selGroup=null, then focus, buttons and labels are redone, and the pre-group view flies back",
  /selGroup=null; applyFocus\(pinnedId\); syncGroupButtons\(\); updateLabels\(\);/.test(clear) &&
  /zoom\.transform,back\)\.on\("end",updateLabels\)/.test(clear) && /return true;/.test(clear));
check("F13 the view is saved only when going from no group to a group (a switch keeps the first one)",
  /if\(!selGroup\) preGroupView=d3\.zoomTransform\(svg\.node\(\)\);/.test(select));
check("F14 the same group button again clears the group", /if\(selGroup&&selGroup\.id===id\)\{ clearGroup\(\); return; \}/.test(select));
check("F15 the All button clears the group", /getAttribute\("data-group"\)==="all"\) clearGroup\(\);/.test(draw));
check("F16 Escape: the pin first, then the group, then the modal",
  /meshEscape&&meshEscape\(\)\) return;[\s\S]{0,200}meshGroupEscape&&meshGroupEscape\(\)\) return;/.test(src) && /meshGroupEscape=clearGroup;/.test(draw));
check("F17 a pin or candidate outside the newly selected group is dropped",
  /if\(candidate&&!inGroup\(candidate\)\) setCandidate\(null\);/.test(select) && /if\(pinnedId&&!selGroup\.set\.has\(pinnedId\)\)\{ pinnedId=null;/.test(select));
check("F18 aria-pressed is still kept in sync on the group buttons", /setAttribute\("aria-pressed",selGroup&&String\(selGroup\.id\)===/.test(draw));
// B6: the PNG copies the computed display, so hidden nodes are not drawn; exports read pairs, not the DOM.
check("F19 the PNG clone copies the computed display (hidden nodes stay hidden in the image)",
  /const props=\[[^\]]*"display"/.test(src.replace(/\n\s*/g, "")));

console.log("\n" + (total - fail) + "/" + total + " passed");
process.exit(fail ? 1 : 0);
