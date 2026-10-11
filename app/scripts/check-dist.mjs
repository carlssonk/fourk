#!/usr/bin/env node
// Smoke-test a production build: serve dist/ and load it in Chromium until it
// opens a websocket to a Kaspa node. Dev servers and builds with a pinned
// VITE_NODE_URL never exercise the resolver path, which is how a minified
// bundle that could not connect at all once went unnoticed.
//
//     pnpm build && node scripts/check-dist.mjs [--timeout 60]
//
// Needs network access to the public resolver for the built network.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";

const timeoutArg = process.argv.indexOf("--timeout");
const timeoutMs = 1000 * Number(timeoutArg > 0 ? process.argv[timeoutArg + 1] : 60);
const port = 4199;
const url = `http://localhost:${port}/`;

const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let failed = true;
try {
  for (let i = 0; ; i++) {
    if (i > 60) throw new Error("vite preview did not start");
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const connected = new Promise((resolve) =>
      page.on("websocket", (ws) => {
        if (/^wss?:\/\//.test(ws.url())) resolve(ws.url());
      }),
    );
    await page.goto(url);
    const node = await Promise.race([connected, sleep(timeoutMs).then(() => null)]);
    if (!node) {
      const body = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(
        `no node connection within ${timeoutMs / 1000}s. Page: "${body}"` +
          (errors.length ? `. Errors: ${errors.join("; ")}` : ""),
      );
    }
    console.log(`ok: the build connected to ${node}`);
    failed = false;
  } finally {
    await browser.close();
  }
} catch (e) {
  console.error(`check-dist: ${e.message ?? e}`);
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
