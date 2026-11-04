// The Go servers are started by csp.spec.js itself (beforeAll), on ports picked
// in code, so there is no webServer block and no fixed port here. One worker:
// every test shares those two servers.
"use strict";
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: ".",
  testMatch: "*.spec.js",
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
