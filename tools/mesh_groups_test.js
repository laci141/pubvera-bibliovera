// Collaboration Network groups + collision-free labels: meshCommunities (Louvain + connected components),
// pickVisibleLabels (greedy, priority desc), and the source contract of the groups panel.
//
// Run: node tools/mesh_groups_test.js
//
// Same loading pattern as tools/a11y_test.js (index.html read as text, source sliced by regex) and
// tools/rising_test.js (the sliced function runs in a vm sandbox). No server, no network, no DOM.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
let fail = 0, total = 0;
function check(name, ok) { total++; console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fail++; }

// Source of a top-level function, from "function name(" to the closing brace at column 0.
function fn(name) {
  const m = src.match(new RegExp("^function " + name + "\\([^)]*\\)\\{[\\s\\S]*?^\\}", "m"));
  return m ? m[0] : "";
}
const sandbox = {};
vm.createContext(sandbox);
for (const name of ["meshCommunities", "pickVisibleLabels", "labelFontPx"]) {
  const code = fn(name);
  if (code) vm.runInContext(code, sandbox, { filename: "index.html#" + name });
}
const communities = (nodes, links) => sandbox.meshCommunities ? sandbox.meshCommunities(nodes, links) : null;
const pick = (boxes) => sandbox.pickVisibleLabels ? sandbox.pickVisibleLabels(boxes) : null;

const N = (...ids) => ids.map((id) => ({ id }));
const L = (a, b, weight) => ({ source: a, target: b, weight: weight || 1 });
const ids = (g) => g.members.slice().sort();

// True when every group is one connected piece of the (undirected) graph.
function allConnected(groups, links) {
  const adj = new Map();
  for (const l of links) {
    const a = typeof l.source === "object" ? l.source.id : l.source, b = typeof l.target === "object" ? l.target.id : l.target;
    if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b); adj.get(b).add(a);
  }
  return groups.every((g) => {
    const inG = new Set(g.members), seen = new Set([g.members[0]]), stack = [g.members[0]];
    while (stack.length) for (const v of adj.get(stack.pop()) || []) if (inG.has(v) && !seen.has(v)) { seen.add(v); stack.push(v); }
    return seen.size === g.members.length;
  });
}

// ── G: meshCommunities ──
const triangles = { nodes: N("a", "b", "c", "d", "e", "f"),
  links: [L("a", "b", 5), L("b", "c", 5), L("a", "c", 5), L("d", "e", 5), L("e", "f", 5), L("d", "f", 5), L("c", "d", 1)] };
const g1 = communities(triangles.nodes, triangles.links);
check("G1 two triangles joined by one weak link -> 2 groups of 3",
  !!g1 && g1.length === 2 && g1.every((g) => g.members.length === 3) &&
  JSON.stringify(g1.map(ids)) === JSON.stringify([["a", "b", "c"], ["d", "e", "f"]]));

// Louvain can return a community that is not connected (Traag et al. 2019): this graph is one of them.
const tricky = { // found by a seeded random search: raw Louvain puts disconnected pieces in one community here
  nodes: Array.from({ length: 24 }, (_, i) => "n" + String(i).padStart(2, "0")),
  links: [
    ["n00","n09",2], ["n00","n13",8], ["n00","n17",5], ["n01","n08",9],
    ["n01","n16",3], ["n01","n22",7], ["n02","n05",7], ["n02","n17",6],
    ["n03","n10",1], ["n03","n13",1], ["n03","n20",9], ["n04","n05",9],
    ["n04","n10",9], ["n04","n14",9], ["n05","n07",9], ["n05","n14",4],
    ["n05","n17",5], ["n05","n22",4], ["n05","n23",1], ["n07","n17",1],
    ["n08","n15",4], ["n09","n14",5], ["n09","n16",5], ["n09","n22",5],
    ["n10","n15",3], ["n10","n17",8], ["n10","n21",2], ["n10","n23",8],
    ["n12","n14",5], ["n12","n18",7], ["n13","n17",7], ["n13","n22",4],
    ["n14","n16",5], ["n14","n21",9], ["n14","n22",8], ["n15","n16",9],
    ["n15","n18",2], ["n16","n20",4], ["n16","n21",3], ["n17","n23",5],
    ["n19","n21",5], ["n20","n21",5], ["n21","n22",4], ["n21","n23",6],
    ["n22","n23",8]] };
const g2 = communities(N(...tricky.nodes), tricky.links.map(([a, b, w]) => L(a, b, w)));
check("G2 graph whose Louvain community is disconnected -> every returned group is connected",
  !!g2 && g2.length > 0 && allConnected(g2, tricky.links.map(([a, b, w]) => L(a, b, w))) &&
  g2.reduce((s, g) => s + g.members.length, 0) === tricky.nodes.length);

const a3 = communities(tricky.nodes.map((id) => ({ id })), tricky.links.map(([a, b, w]) => L(a, b, w)));
check("G3 determinism: two calls on the same input give identical output",
  !!g2 && !!a3 && JSON.stringify(g2) === JSON.stringify(a3));

const sizes = [3, 5, 4, 2].map((k, gi) => Array.from({ length: k }, (_, i) => "g" + gi + "_" + i));
const sn = sizes.flat(), sl = [];
sizes.forEach((m) => { for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) sl.push(L(m[i], m[j], 4)); });
const g4 = communities(sn.map((id) => ({ id })), sl);
check("G4 groups sorted by size desc (" + (g4 ? g4.map((g) => g.members.length).join(",") : "none") + ")",
  !!g4 && g4.length === 4 && g4.every((g, i) => i === 0 || g4[i - 1].members.length >= g.members.length) &&
  g4[0].members.length === 5 && g4.every((g) => g.top && g.members.includes(g.top) && g.id !== undefined));

// ── L: pickVisibleLabels ──
const box = (id, priority, x, y) => ({ id, priority, x, y, w: 40, h: 12 });
const l1 = pick([box("lo", 1, 0, 0), box("hi", 9, 10, 4)]);
check("L1 two overlapping boxes -> only the higher priority kept",
  !!l1 && l1.size === 1 && l1.has("hi") && !l1.has("lo"));
const l2 = pick([box("a", 3, 0, 0), box("b", 2, 100, 0), box("c", 1, 0, 100)]);
check("L2 non-overlapping boxes -> all kept", !!l2 && l2.size === 3);
const l3 = pick([box("b", 5, 0, 0), box("a", 5, 10, 2)]);
const l3r = pick([box("a", 5, 10, 2), box("b", 5, 0, 0)]);
check("L3 tie on priority -> lower id kept (deterministic, input order irrelevant)",
  !!l3 && l3.size === 1 && l3.has("a") && !!l3r && l3r.size === 1 && l3r.has("a"));
const l4 = pick([box("a", 1, 0, 0), { id: "b", priority: 1, x: 40, y: 0, w: 40, h: 12 }]);
check("L4 1 px padding: boxes that merely touch collide, boxes 2 px apart do not",
  !!l4 && l4.size === 1 && pick([box("a", 1, 0, 0), { id: "b", priority: 1, x: 42, y: 0, w: 40, h: 12 }]).size === 2);

// ── S: source contract ──
const details = src.match(/<details class="mesh-groups"[^>]*>[\s\S]{0,400}?<\/summary>/);
check("S1 index.html has <details class=\"mesh-groups\" and its summary contains Groups (",
  !!details && /<summary[^>]*>[^<]*Groups \(/.test(details[0]) && !/<details class="mesh-groups"[^>]*\bopen\b/.test(details[0]));
check("S2 the group buttons are built with aria-pressed", /<button type="button"[^>]*aria-pressed="false"/.test(src) && /data-group=/.test(src));
// The rule that styles .mesh-groups (alone or in a selector list) must carry both the standard and the -webkit- blur.
const rules = [...src.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter((m) => /\.mesh-groups(?![\w-])/.test(m[1]) && /backdrop-filter/.test(m[2]));
check("S3 the .mesh-groups CSS has both backdrop-filter and -webkit-backdrop-filter",
  rules.some((m) => /(^|[;\s])backdrop-filter\s*:/.test(m[2]) && /-webkit-backdrop-filter\s*:/.test(m[2])));
const onKey = fn("onModalKey"), esc = onKey.match(/if\(e\.key==="Escape"\)\{[\s\S]*?\n  \}/);
const iPin = esc ? esc[0].indexOf("meshEscape") : -1, iGroup = esc ? esc[0].indexOf("meshGroupEscape") : -1, iClose = esc ? esc[0].indexOf("closeModal(k)") : -1;
check("S4 the Esc handler checks the selected group after the pin and before closing the modal",
  iPin >= 0 && iGroup > iPin && iClose > iGroup);

// ── S5-S7: measured label boxes, constant on-screen size ──
// updateLabels and applyZoomScale are closures inside drawMeshGraph, so they are sliced by their two-space indent.
const upd = (src.match(/^ {2}function updateLabels\(\)\{[\s\S]*?^ {2}\}/m) || [""])[0];
check("S5 the box builder calls getBBox and does not use the 0.6 char-width estimate",
  upd.length > 0 && /getBBox\(/.test(upd) && !/\*\s*0\.6\b/.test(upd));
const zs = (src.match(/^ {2}function applyZoomScale\(k\)\{[\s\S]*?^ {2}\}/m) || [""])[0];
const lfp = fn("labelFontPx");
check("S6 label font size is a target divided by the zoom scale k, targets 13 and 15, breakpoint 600",
  /\bfontPx\([^)]*\)\s*\/\s*ks/.test(zs) && /const ks=zoomK\*viewS/.test(zs) && /const fontPx=d=>labelFontPx\(/.test(src) &&
  /\b13\b/.test(lfp) && /\b15\b/.test(lfp) && /\b600\b/.test(lfp));
const fp = (t, w) => sandbox.labelFontPx ? sandbox.labelFontPx(t, w) : null;
const s7 = [fp(1, 360), fp(2, 360), fp(3, 360), fp(0, 360), fp(1, 1380), fp(2, 1380), fp(3, 1380), fp(1, 600), fp(1, 601)];
check("S7 labelFontPx(tier, viewportW): 15/14/13 at 360, 17/16/15 at 1380 (" + s7.join(",") + ")",
  JSON.stringify(s7) === JSON.stringify([15, 14, 13, 13, 17, 16, 15, 15, 17]));

console.log((fail ? "FAIL " : "PASS ") + (total - fail) + "/" + total);
process.exit(fail ? 1 : 0);
