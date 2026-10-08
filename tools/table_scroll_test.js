// Every results <table> built in index.html must sit in a scroll wrapper, and the CSS must scroll it.
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
let fail = 0;
function check(name, ok) { console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fail++; }

const WRAP = '<div class="table-scroll" role="region" tabindex="0" aria-label="';
const opens = src.match(/<table(?=[ >'])/g) || [];
const wrapped = src.match(/h\+='<div class="table-scroll" role="region" tabindex="0" aria-label="[^"]+"><table/g) || [];
const closes = src.match(/<\/tbody><\/table><\/div>/g) || [];
const bareCloses = src.match(/<\/tbody><\/table>(?!<\/div>)/g) || [];
check("found 4 table builders (got " + opens.length + ")", opens.length === 4);
check("every table builder is wrapped in .table-scroll region with tabindex=0 (" + wrapped.length + "/" + opens.length + ")", wrapped.length === opens.length);
check("every builder closes the wrapper (" + closes.length + "/" + opens.length + ")", closes.length === opens.length && bareCloses.length === 0);
check("no static <table> outside the builders", (src.match(/^\s*<table/gm) || []).length === 0);
const rule = (src.match(/\.table-scroll\s*\{[^}]*\}/) || [""])[0];
check("CSS .table-scroll has overflow-x: auto", /overflow-x:\s*auto/.test(rule));
check("CSS .table-scroll has max-width: 100%", /max-width:\s*100%/.test(rule));
check("CSS .table-scroll:focus-visible has an outline", /\.table-scroll:focus-visible\s*\{[^}]*outline:/.test(src));
check("no position:sticky on table cells", !/(?:th|td)[^{}]*\{[^}]*position:\s*sticky/.test(src));
check("no mobile table{display:block} override", !/(^|[;{}\s])table\{display:block/.test(src));
process.exit(fail ? 1 : 0);
