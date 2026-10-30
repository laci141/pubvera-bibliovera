// Export menu: the four per-row export buttons are ONE "Export" menu button (WAI-ARIA APG menu button pattern).
// Checks the rendered markup of metaRow(), the open/close/keyboard JS, and the glass CSS of the menu panel.
//
// Run: node tools/export_menu_test.js
//
// Source check, same loading pattern as tools/a11y_test.js and tools/toolbar_wrap_test.js (index.html read as text).
// metaRow() is pure string building, so it is executed in a vm sandbox and its real output is asserted.
// No server, no network, no browser: behaviour is verified separately with pw-xbrowser/export-menu.mjs.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
let fail = 0, total = 0;
function check(name, ok) { total++; console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fail++; }
const count = (s, re) => (s.match(re) || []).length;
// Source of a top-level function, from "function name(" to the closing brace at column 0.
function fn(name) {
  const B = String.fromCharCode(92);   // backslash
  const m = src.match(new RegExp("^function " + name + B + "([^)]*" + B + ")" + B + "{[^]*?^" + B + "}", "m"));
  return m ? m[0] : "";
}

// Render one real result row: metaRow(text, key, filename, extra).
const sandbox = {};
vm.createContext(sandbox);
let html = "";
try {
  vm.runInContext(fn("metaRow"), sandbox);
  html = vm.runInContext("metaRow('3 rows','aff','bibliovera-aff.json','<button class=\"dl\" id=\"extra-x\">X</button>')", sandbox);
} catch (e) { html = ""; }
const menuMatch = html.match(/<div[^>]*role="menu"[^>]*>[\s\S]*?<\/div>/);
const menuHtml = menuMatch ? menuMatch[0] : "";

check("E1 the row has exactly one aria-haspopup=\"menu\" trigger and one role=\"menu\" (" +
  count(html, /aria-haspopup="menu"/g) + ", " + count(html, /role="menu"(?!item)/g) + ")",
  count(html, /aria-haspopup="menu"/g) === 1 && count(html, /role="menu"(?!item)/g) === 1 &&
  /<div class="dl-menu" role="menu"/.test(html) &&
  /<button type="button" class="dl" aria-haspopup="menu" aria-expanded="false" aria-controls="([\w-]+)"/.test(html) &&
  new RegExp('<div[^>]*role="menu"[^>]*id="' + ((html.match(/aria-controls="([\w-]+)"/) || [0, "-"])[1]) + '"[^>]*hidden|<div[^>]*id="' + ((html.match(/aria-controls="([\w-]+)"/) || [0, "-"])[1]) + '"[^>]*role="menu"[^>]*hidden').test(html));

const items = [...menuHtml.matchAll(/<button type="button" role="menuitem"([^>]*)>([^<]*)<\/button>/g)];
const want = [
  ["Excel", 'data-action="export" data-call="downloadXLSX" data-key="aff" data-name="bibliovera-aff.xlsx"'],
  ["CSV", 'data-action="export" data-call="downloadCSVData" data-key="aff" data-name="bibliovera-aff.csv"', "Plain CSV (RFC 4180) for pandas, R, Zotero. For Excel, use Excel (.xlsx)."],
  ["JSON", 'data-action="export" data-call="downloadJSON" data-key="aff" data-name="bibliovera-aff.json"'],
  ["BibTeX", 'data-action="export" data-call="downloadBibTeX" data-key="aff" data-name="bibliovera-aff.bib"'],
];
const okItems = items.length === 4 && want.every(([label, call, title], i) =>
  items[i] && items[i][2] === label && items[i][1].includes(call) &&
  (title === undefined || items[i][1].includes(' title="' + title + '"')));
check("E2 the menu has four role=\"menuitem\" buttons (Excel, CSV, JSON, BibTeX) in this order; CSV calls downloadCSVData with <base>.csv and the plain-CSV title (" + items.length + " items: " + items.map(m => m[2]).join(" | ") + ")", okItems);
check("E2b no menu item calls the legacy downloadCSV (sep= line, provenance line, BOM)", !/data-call="downloadCSV"/.test(menuHtml));

const toggle = fn("toggleExportMenu"), closeAll = fn("closeExportMenus");
check("E3 trigger has aria-expanded=\"false\" and the open/close JS sets \"true\" and \"false\"",
  /aria-expanded="false"/.test(html) &&
  /setAttribute\("aria-expanded","true"\)/.test(toggle) && /setAttribute\("aria-expanded","false"\)/.test(closeAll) &&
  /\.hidden\s*=\s*false/.test(toggle) && /\.hidden\s*=\s*true/.test(closeAll));

// The delegated keydown listener of the export menu: from its comment marker to the end of the listener.
const kd = (src.match(/document\.addEventListener\("keydown",e=>\{\s*\n\s*const menu=[\s\S]*?\n\}\);/) || [""])[0];
check("E4 Escape handler exists, stops the modal Escape and returns focus to the trigger",
  /e\.key\s*===\s*"Escape"/.test(kd) && /closeExportMenus\(true\)/.test(kd) && /stopImmediatePropagation\(\)/.test(kd) &&
  /if\(refocus\)\w+\.focus\(\)/.test(closeAll));

check("E5 arrow-key handler in the menu: ArrowDown/ArrowUp wrap, Home/End jump, Tab closes",
  /"ArrowDown"/.test(kd) && /"ArrowUp"/.test(kd) && /"Home"/.test(kd) && /"End"/.test(kd) && /"Tab"/.test(kd) &&
  /%items\.length/.test(kd) && /\.focus\(\)/.test(kd));

const clickOnNonControl = count(src, /<(div|span|li|tr|article)[^>]*data-action/g) + count(html, /<(div|span|li|tr|article)[^>]*data-action/g);
check("E6 no data-action on div/span/li/tr/article (" + clickOnNonControl + ")", clickOnNonControl === 0);

// The menu panel shares the glass rule of .errcard/.mesh-groups (so the global glass line count stays what it was).
const style = src.slice(src.indexOf("<style"), src.indexOf("</style>"));
const rules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].split(",").map((s) => s.trim()), body: m[2] }));
const glass = rules.find((r) => r.sel.includes(".dl-menu") && /(^|[;\s])backdrop-filter:/.test(r.body) && /-webkit-backdrop-filter:/.test(r.body));
const phone = rules.find((r) => r.sel.includes(".dl-menu") && /--mg-blur:12px/.test(r.body));
check("E7 .dl-menu has backdrop-filter and -webkit-backdrop-filter (15px desktop, 12px under 600px via --mg-blur)",
  !!glass && /blur\(var\(--mg-blur,15px\)\)/.test(glass.body) && !!phone);

const filterAt = html.indexOf('class="qfilter"');
const menuAt = menuMatch ? menuMatch.index : -1;
check("E8 the filter input is rendered once, outside the menu",
  count(html, /class="qfilter"/g) === 1 && menuAt >= 0 && !menuHtml.includes("qfilter") && filterAt >= 0 && filterAt < menuAt);

const at = src.indexOf('document.addEventListener("click",e=>{') ;
const outside = at < 0 ? "" : src.slice(at, src.indexOf(String.fromCharCode(10), at));
check("E9 outside click closes without refocus and ignores untrusted clicks (the download anchor click)",
  outside.includes("e.isTrusted") && outside.includes('.closest(".dl-wrap")') && outside.includes("closeExportMenus(false)"));

// The panel must hide the table text under it: the .dl-menu background is one colour with alpha >= 0.9.
const bgRule = rules.filter((r) => r.sel.includes(".dl-menu")).map((r) => (r.body.match(/(?:^|[;\s])background(?:-color)?:\s*([^;]+)/) || [])[1]).filter(Boolean).pop() || "";
const bgM = bgRule.match(/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+)\s*)?\)$/) || bgRule.match(/^#[0-9a-f]{6}$/i);
const bgAlpha = bgM ? (bgM[1] === undefined ? 1 : parseFloat(bgM[1])) : 0;
check("E10 .dl-menu background is a solid colour or rgba with alpha >= 0.9 (\"" + bgRule + "\", alpha " + bgAlpha + ")", bgAlpha >= 0.9);

console.log(`\n${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
