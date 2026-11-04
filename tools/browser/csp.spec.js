// Browser tests: index.html under the real Content-Security-Policy headers.
//
// Run: cd tools/browser && npm ci --ignore-scripts && npx playwright install chromium && npx playwright test
//
// The Go server is built from this checkout into the OS temp directory (so the
// binary never shows up in git status) and started twice on free ports picked
// at run time: server A without a Supabase config, server B with one whose
// host is example.supabase.co. No CLI binary is needed: CLI_BIN,
// RETRACTION_CHECKER_BIN and THELANCET_DB point at paths that do not exist,
// and only the data routes (/affiliations /authors /drift /curate /mesh
// /check /version) are intercepted with canned JSON. The page, /config.json,
// /healthz and /csp-report come from the real server.
//
// The enforcing policy (csp.go contentSecurityPolicy) is nonce-based
// script-src with script-src-attr 'none', so an onclick= attribute does not
// run: every control below works only through the delegated listeners. The
// same header enforces connect-src ('self', plus the Supabase origin on server
// B, csp.go cspConnectSrc) and names the report endpoints. There is no
// Report-Only header.
"use strict";
const { test, expect } = require("@playwright/test");
const { execFileSync, spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");

const repo = path.join(__dirname, "..", "..");
const tmp = path.join(os.tmpdir(), "bibliovera-browser-test");
const bin = path.join(tmp, process.platform === "win32" ? "bibliovera.exe" : "bibliovera");

const SUPA_ORIGIN = "https://example.supabase.co";
// The enforcing policy, written out so a change to any directive fails T5.
const policy = (nonce, origin) => "script-src 'nonce-" + nonce + "' 'strict-dynamic' https: 'unsafe-inline'; script-src-attr 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'" + (origin ? " " + origin : "") + "; report-to csp; report-uri /csp-report";
const TAIL_A = "; connect-src 'self'; report-to csp; report-uri /csp-report";
const TAIL_B = "; connect-src 'self' " + SUPA_ORIGIN + "; report-to csp; report-uri /csp-report";
const VERSION = "9.9.9-browser-test";
// The 6 cards on the start page, in page order (index.html data-modal=).
const CARDS = ["aff", "auth", "drift", "read", "rise", "mesh"];

let serverA, serverB;
let urlA, urlB;
// The servers' log output (the standard log package writes to stderr).
let serverLog = "";

// Port 0 lets the OS choose; the listener is closed again and the port handed
// to the server. Another process could take it in between, which would make
// the health wait below fail loudly rather than test the wrong server.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function startServer(env) {
  const port = await freePort();
  const url = "http://127.0.0.1:" + port;
  const proc = spawn(bin, [], {
    cwd: repo,
    env: {
      ...process.env,
      // ADDR wins over PORT in main.go; loopback only.
      ADDR: "127.0.0.1:" + port,
      PORT: "",
      CLI_BIN: path.join(tmp, "no-such-cli"),
      RETRACTION_CHECKER_BIN: path.join(tmp, "no-such-retraction-checker"),
      THELANCET_DB: path.join(tmp, "no-such.db"),
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  proc.stderr.on("data", d => { serverLog += d; });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(url + "/healthz");
      if (res.ok) break;
    } catch (_) { /* not listening yet */ }
    if (proc.exitCode !== null) throw new Error("server exited with " + proc.exitCode + ": " + serverLog);
    if (Date.now() > deadline) throw new Error("server did not answer /healthz on " + url);
    await new Promise(r => setTimeout(r, 100));
  }
  return { proc, url };
}

async function stopServer(proc) {
  if (proc && proc.exitCode === null) {
    const exited = new Promise(r => proc.once("exit", r));
    proc.kill();
    await exited;
  }
}

test.beforeAll(async () => {
  execFileSync("go", ["build", "-o", bin, "."], { cwd: repo, stdio: "inherit" });
  ({ proc: serverA, url: urlA } = await startServer({ SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "" }));
  ({ proc: serverB, url: urlB } = await startServer({ SUPABASE_URL: SUPA_ORIGIN, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" }));
});

test.afterAll(async () => {
  await stopServer(serverA);
  await stopServer(serverB);
});

// Every console message and page error, so each test can assert that nothing
// was refused by the CSP and that no script threw.
function watch(page) {
  const log = { console: [], pageErrors: [] };
  page.on("console", m => log.console.push(m.type() + ": " + m.text()));
  page.on("pageerror", e => log.pageErrors.push(String(e)));
  return log;
}
const CSP_RE = /Content Security Policy|script-src-attr|inline event handler|Refused to execute/i;
function expectNoCSPViolations(log, violations) {
  expect(log.console.filter(m => CSP_RE.test(m)), "CSP messages on the console").toEqual([]);
  expect(violations, "securitypolicyviolation events").toEqual([]);
  expect(log.pageErrors, "page errors").toEqual([]);
}
const CONNECT_RE = /connect-src|Refused to connect/i;
function expectNoConnectSrc(log, violations) {
  expect(log.console.filter(m => CONNECT_RE.test(m)), "connect-src console messages").toEqual([]);
  expect(violations.filter(v => v.directive.startsWith("connect-src")), "connect-src violations").toEqual([]);
}
const violations = page => page.evaluate(() => window.__cspViolations);

// Canned answers for the data routes, so no CLI call is ever made.
const DATA = {
  "/affiliations": [{ institution: "Institution A", recent_count: 12, prior_count: 3 }],
  "/authors": [],
  "/drift": [],
  "/curate": [],
  "/mesh": [],
  "/check": {},
  "/version": { version: VERSION },
};

async function load(page, { origin = urlA, realSupabaseJS = false } = {}) {
  // xlsx-js-style (and supabase-js, outside the sign-out test) come from
  // jsdelivr; an empty body keeps the run fast. supabase-js is loaded for real
  // only where a test signs out through it: its SRI hash rules out a stub.
  await page.route("https://cdn.jsdelivr.net/**", r => (realSupabaseJS && r.request().url().includes("/@supabase/supabase-js@"))
    ? r.continue()
    : r.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  const data = [];
  await page.route(u => u.origin === origin && Object.prototype.hasOwnProperty.call(DATA, u.pathname), r => {
    const p = new URL(r.request().url()).pathname;
    data.push(p);
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DATA[p]) });
  });
  // Recorded in the page from the first script on, so a violation raised
  // while the page loads is not missed.
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", e => {
      window.__cspViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI || "", disposition: e.disposition, line: e.lineNumber });
    });
  });
  const log = watch(page);
  log.data = data;
  const res = await page.goto(origin + "/");
  expect(res.status()).toBe(200);
  log.headers = res.headers();
  return log;
}

// T1
for (const [name, origin, auth] of [["A (no Supabase config)", () => urlA, "off"], ["B (Supabase config)", () => urlB, "unavailable"]]) {
  test("T1 the page loads under script-src with no CSP violation and no page error, server " + name, async ({ page }) => {
    const log = await load(page, { origin: origin() });
    expect(log.headers["content-security-policy"]).toMatch(/^script-src 'nonce-[A-Za-z0-9+/]{22}' /);
    // All three inline blocks ran, not just loaded: a function from the main
    // block, the auth stub from the module, the footer from the /version block.
    expect(await page.evaluate(() => typeof window.openModal)).toBe("function");
    await expect(page.locator("#app-version")).toHaveText("Bibliovera v" + VERSION);
    if (auth === "off") {
      expect(await page.evaluate(() => window.pubveraAuth && window.pubveraAuth.enabled)).toBe(false);
      await expect(page.locator("#authBar")).toBeHidden();
    } else {
      // supabase-js is stubbed here, so its SRI check fails and the page says so.
      await expect(page.locator("#authUnavailable")).toBeVisible();
    }
    expectNoCSPViolations(log, await violations(page));
  });
}

// T2. Not a document.createElement("script"): the policy carries
// 'strict-dynamic', which trusts every script that is not parser-inserted, so
// such a script runs (measured with Chromium from @playwright/test 1.63.0).
// The two injections below are the ones the policy blocks: markup put into
// the page through innerHTML, whose on* handler hits script-src-attr 'none',
// and a parser-inserted inline script without the nonce, in a srcdoc frame
// (which inherits the page's policy) so it does not replace the page.
test("T2 an injected inline script does not run and raises a script-src violation", async ({ page }) => {
  const log = await load(page);
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.innerHTML = '<img src="data:," onerror="window.__pwnedAttr=1">';
    document.body.appendChild(d);
  });
  await expect.poll(() => violations(page)).toEqual([{ directive: "script-src-attr", blocked: "inline", disposition: "enforce", line: expect.any(Number) }]);
  expect(await page.evaluate(() => window.__pwnedAttr)).toBeUndefined();

  await page.evaluate(() => {
    const f = document.createElement("iframe");
    f.srcdoc = "<script>parent.__pwnedFrame=1<\/script>";
    document.body.appendChild(f);
  });
  const frame = () => page.frames().find(f => f.url() === "about:srcdoc");
  await expect.poll(async () => frame() ? frame().evaluate(() => window.__cspViolations.map(v => v.directive + " " + v.disposition)) : null)
    .toEqual(["script-src-elem enforce"]);
  expect(await page.evaluate(() => window.__pwnedFrame)).toBeUndefined();
  expect(log.console.filter(m => /^error: Executing inline (event handler|script) violates/.test(m))).toHaveLength(2);
  expect(log.pageErrors).toEqual([]);
});

// T3
test("T3 a script with the header's nonce runs, a plain inline script does not", async ({ page }) => {
  await page.route("https://cdn.jsdelivr.net/**", r => r.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  await page.route(u => u.origin === urlA && Object.prototype.hasOwnProperty.call(DATA, u.pathname),
    r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DATA[new URL(r.request().url()).pathname]) }));
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", e => {
      window.__cspViolations.push({ directive: e.violatedDirective, line: e.lineNumber });
    });
  });
  let nonce = "";
  let plainLine = 0;
  await page.route(urlA + "/", async route => {
    const res = await route.fetch();
    const m = /'nonce-([^']+)'/.exec(res.headers()["content-security-policy"] || "");
    nonce = m ? m[1] : "";
    // Each injected script sits on its own line, so a violation's line number
    // says which of the two it was (the policy has no report-sample).
    const body = (await res.text()).replace("</body>",
      '\n<script nonce="' + nonce + '">window.__nonced=1</script>\n<script>window.__plain=1</script>\n</body>');
    plainLine = body.split("\n").findIndex(l => l.includes("window.__plain")) + 1;
    const headers = { ...res.headers() };
    delete headers["content-length"];
    delete headers["content-encoding"];
    await route.fulfill({ status: res.status(), headers, body });
  });
  await page.goto(urlA + "/");
  expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}$/);
  expect(await page.evaluate(() => window.__nonced)).toBe(1);
  expect(await page.evaluate(() => window.__plain)).toBeUndefined();
  const v = await page.evaluate(() => window.__cspViolations);
  // Exactly one violation, and it is the plain script's line.
  expect(v).toHaveLength(1);
  expect(v[0].directive).toMatch(/^script-src/);
  expect(plainLine).toBeGreaterThan(0);
  expect(v[0].line).toBe(plainLine);
});

test("T3 the nonce is not readable from the DOM", async ({ page }) => {
  const log = await load(page);
  const nonce = (/'nonce-([^']+)'/.exec(log.headers["content-security-policy"]) || [])[1];
  expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}$/);
  // The page's own 5 script tags (index.html), all nonced; the browser hides
  // the attribute value once the policy is applied.
  const attrs = await page.evaluate(() => Array.from(document.scripts, s => s.getAttribute("nonce")));
  expect(attrs.length).toBeGreaterThanOrEqual(5);
  expect(attrs.every(a => a === "")).toBe(true);
  expect(await page.evaluate(n => document.documentElement.outerHTML.includes(n), nonce)).toBe(false);
});

// T4
test("T4 each of the 6 cards opens its modal and the close control closes it", async ({ page }) => {
  const log = await load(page);
  // No on* attribute anywhere: script-src-attr 'none' would block it.
  const onAttrs = await page.evaluate(() => Array.from(document.querySelectorAll("*"))
    .flatMap(el => Array.from(el.attributes, a => a.name)).filter(n => /^on/i.test(n)));
  expect(onAttrs).toEqual([]);
  expect(await page.locator(".card[data-action='open-modal']").count()).toBe(CARDS.length);
  for (const k of CARDS) {
    const modal = page.locator("#" + k + "Modal");
    await expect(modal).not.toHaveClass(/\bactive\b/);
    await page.locator(".card[data-modal='" + k + "']").click();
    await expect(modal).toHaveClass(/\bactive\b/);
    await modal.locator(".x[data-action='close-modal']").click();
    await expect(modal).not.toHaveClass(/\bactive\b/);
  }
  expectNoCSPViolations(log, await violations(page));
});

// T5
// fetch joins repeated headers with ", ", so a second Content-Security-Policy
// header breaks the exact match, and get() is null only when the header is
// absent.
for (const [name, origin, supa] of [["A", () => urlA, ""], ["B", () => urlB, SUPA_ORIGIN]]) {
  test("T5 headers on server " + name + ": one enforcing policy with connect-src, no Report-Only header", async () => {
    const res = await fetch(origin() + "/");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") || "";
    const nonce = (/^script-src 'nonce-([A-Za-z0-9+/]{22})' /.exec(csp) || [])[1];
    expect(nonce).toBeDefined();
    expect(csp).toBe(policy(nonce, supa));
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
    expect(res.headers.get("reporting-endpoints")).toBe('csp="/csp-report"');
  });
}

// T6
test("T6 the unauthenticated page raises no connect-src violation", async ({ page }) => {
  const log = await load(page);
  await page.locator(".card[data-modal='aff']").click();
  await page.locator("#affModal button[data-action='run-aff']").click();
  await expect(page.locator("#aff_res tbody tr")).toHaveCount(1);
  expect(log.data).toContain("/affiliations");
  expectNoConnectSrc(log, await violations(page));
  expectNoCSPViolations(log, await violations(page));
});

// T7
test("T7 a fetch outside connect-src is refused, never leaves the page and raises one (distinct) enforced violation", async ({ page }) => {
  let blocked = 0;
  await page.route("https://blocked.invalid/**", r => {
    blocked++;
    return r.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, body: "ok" });
  });
  const requests = [];
  page.on("request", r => { if (r.url().startsWith("https://blocked.invalid/")) requests.push(r.url()); });
  const log = await load(page);
  expect(log.headers["content-security-policy"].endsWith(TAIL_A)).toBe(true);
  const result = await page.evaluate(() => fetch("https://blocked.invalid/x").then(r => "resolved " + r.status, e => "rejected " + e.name));
  // Enforced: the browser refuses the fetch before any request is made.
  expect(result).toBe("rejected TypeError");
  // Chromium (from @playwright/test 1.63.0) fires the event twice for this
  // one fetch (measured). So the count is of distinct violations, and every
  // event must be that one violation.
  await expect.poll(async () => (await violations(page)).filter(v => v.directive.startsWith("connect-src")).length).toBeGreaterThan(0);
  const v = (await violations(page)).filter(v => v.directive.startsWith("connect-src"));
  const distinct = [...new Set(v.map(x => x.directive + " " + x.blocked + " " + x.disposition))];
  expect(distinct).toEqual(["connect-src https://blocked.invalid/x enforce"]);
  const lines = log.console.filter(m => CONNECT_RE.test(m));
  expect(lines.length).toBeGreaterThan(0);
  // Two distinct lines (measured): the CSP message, and the Fetch API one
  // that says "Refused to connect".
  expect([...new Set(lines)]).toEqual([
    "error: Connecting to 'https://blocked.invalid/x' violates the following Content Security Policy directive: \"connect-src 'self'\". The action has been blocked.",
    "error: Fetch API cannot load https://blocked.invalid/x. Refused to connect because it violates the document's Content Security Policy.",
  ]);
  expect(blocked).toBe(0);
  expect(requests).toEqual([]);
  expect(log.pageErrors).toEqual([]);
});

// T8: the fake session sits under supabase-js's default storage key,
// sb-<first label of the host>-auth-token (index.html passes no storageKey).
// Every request to example.supabase.co is stubbed; no real Supabase host is
// contacted.
function fakeSession() {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 7200;
  const user = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "pw@example.invalid" };
  return {
    access_token: b64({ alg: "HS256", typ: "JWT" }) + "." + b64({ sub: user.id, aud: "authenticated", role: "authenticated", email: user.email, exp }) + ".sig",
    token_type: "bearer", expires_in: 7200, expires_at: exp, refresh_token: "fake-refresh-token", user,
  };
}

test("T8 signed in with Supabase, Sign out under enforced connect-src reaches /auth/v1/logout with no violation", async ({ page }) => {
  const supa = [];
  await page.route(SUPA_ORIGIN + "/**", r => {
    supa.push(r.request().method() + " " + new URL(r.request().url()).pathname);
    return r.fulfill({
      status: 204,
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" },
    });
  });
  await page.addInitScript(s => localStorage.setItem("sb-example-auth-token", JSON.stringify(s)), fakeSession());
  const log = await load(page, { origin: urlB, realSupabaseJS: true });
  await expect(page.locator("#authEmail")).toHaveText("pw@example.invalid");
  await page.locator("#authSignOutBtn").click();
  await expect(page.locator("#authSignInBtn")).toBeVisible();
  expect(supa.filter(s => s === "POST /auth/v1/logout")).toHaveLength(1);
  expectNoConnectSrc(log, await violations(page));
  expectNoCSPViolations(log, await violations(page));
  // Last, so a missing origin shows up as the refused logout first.
  expect(log.headers["content-security-policy"].endsWith(TAIL_B)).toBe(true);
  expect(log.headers["content-security-policy-report-only"]).toBeUndefined();
});

// T9: the endpoint on the real server and mux, posted to directly.
test("T9 POST /csp-report on the real server answers 204 and logs one line without the query", async () => {
  const marker = "pw-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const res = await fetch(urlA + "/csp-report", {
    method: "POST",
    headers: { "Content-Type": "application/csp-report" },
    body: JSON.stringify({ "csp-report": {
      "document-uri": urlA + "/" + marker + "?q=QUERYSECRET", "effective-directive": "connect-src", "disposition": "report",
      "blocked-uri": "https://blocked.example/collect?code=SECRET&x=1",
    } }),
  });
  expect(res.status).toBe(204);
  expect(await res.text()).toBe("");
  const want = "csp-violation disposition=report directive=connect-src blocked=https://blocked.example page=/" + marker;
  await expect.poll(() => serverLog.split(/\r?\n/).filter(l => l.includes(marker)).length).toBe(1);
  const line = serverLog.split(/\r?\n/).find(l => l.includes(marker));
  expect(line.endsWith(" " + want)).toBe(true);
  expect(serverLog).not.toContain("QUERYSECRET");
  expect(serverLog).not.toContain("SECRET");

  const get = await fetch(urlA + "/csp-report");
  expect(get.status).toBe(405);
  expect(get.headers.get("allow")).toBe("POST");
});
