/**
 * The sweeper process: HTTP routes behind the node's Cloudflare Tunnel
 * (POST /sweep, and the Quick Match matchmaker under /match), a health
 * check for compose (GET /healthz), and a loop that sends due sweeps
 * through the local kaspad. See sweeper.ts and match.ts for what each
 * trusts, and infra/node/README.md for the deploy.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import kaspaInit from "kaspa-wasm";
import fourkInit from "fourk-wasm";
import * as engine from "../src/shared/lib/engine";
import { limitFromEnv } from "./limit";
import { createMatchmaker } from "./match";
import { MAX_BODY_BYTES, createSweeper, type Reply } from "./sweeper";

const NODE_URL = process.env.NODE_URL ?? "ws://kaspad:17210";
const PORT = Number(process.env.PORT ?? 8080);
const TICK_MS = 5000;
/** Exit (and let compose restart us) after this long without the node. */
const MAX_OFFLINE_MS = 120_000;

const here = path.dirname(fileURLToPath(import.meta.url));
await kaspaInit({ module_or_path: fs.readFileSync(path.join(here, "kaspa_bg.wasm")) });
await fourkInit({ module_or_path: fs.readFileSync(path.join(here, "fourk_wasm_bg.wasm")) });

/** The node may still be syncing after a restart; wait it out. */
async function connect(): Promise<engine.Rpc> {
  for (;;) {
    try {
      return await engine.connect(NODE_URL);
    } catch (e) {
      console.error(`waiting for ${NODE_URL}: ${e instanceof Error ? e.message : String(e)}`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

// Set once the node is reachable; until then every route answers 503.
let rpc: engine.Rpc | null = null;
let sweeper: ReturnType<typeof createSweeper> | null = null;
let matchmaker: ReturnType<typeof createMatchmaker> | null = null;

/** The POST routes. Each reaches its service when called, and the server
 * answers 503 until both exist (the node may still be syncing). */
const ROUTES = new Map<string, (body: string, client: string) => Promise<Reply>>([
  ["/sweep", (body, client) => sweeper!.intake(body, client)],
  ["/match/seek", (body, client) => matchmaker!.seek(body, client)],
  ["/match/hosted", (body, client) => matchmaker!.hosted(body, client)],
]);
/** GET /match/<ticket>: a seeker's poll. */
const TICKET_PATH = /^\/match\/([0-9a-f-]{36})$/;

// No credentials ride these routes, so any origin may call them.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function send(res: http.ServerResponse, { status, body }: Reply): void {
  res.writeHead(status, { ...CORS, "Content-Type": "text/plain" }).end(body);
}

http
  .createServer((req, res) => {
    const online = !!rpc?.isConnected;
    if (req.url === "/healthz" && req.method === "GET")
      return send(res, online ? { status: 200, body: "ok" } : { status: 503, body: "no node" });
    // Known paths first, so an unknown one is a 404 even while the node is
    // still starting (the health workflow tells the two apart).
    const url = req.url ?? "";
    const ticket = TICKET_PATH.exec(url)?.[1];
    const route = ROUTES.get(url);
    if (!ticket && !route) return send(res, { status: 404, body: "not found" });
    if (req.method === "OPTIONS") return send(res, { status: 204, body: "" });
    if (!sweeper || !matchmaker || !online) return send(res, { status: 503, body: "starting" });
    const client = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "");
    const reply = (p: Promise<Reply>) =>
      p
        .then((r) => send(res, r))
        .catch((e) => {
          console.error(`${req.url}: ${String(e)}`);
          send(res, { status: 500, body: "error" });
        });

    if (ticket) {
      if (req.method !== "GET") return send(res, { status: 405, body: "GET only" });
      return void reply(matchmaker.poll(ticket, client));
    }
    if (!route) return send(res, { status: 404, body: "not found" }); // checked above; narrows
    if (req.method !== "POST") return send(res, { status: 405, body: "POST only" });

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY_BYTES) chunks.push(c);
      else if (!res.headersSent) {
        // Answer now and close once it is sent; the rest of the body is
        // read and dropped (a destroy here could cut the reply off).
        res.setHeader("Connection", "close");
        send(res, { status: 413, body: "too large" });
      }
    });
    req.on("end", () => {
      if (res.headersSent) return;
      void reply(route(Buffer.concat(chunks).toString("utf8"), client));
    });
  })
  .listen(PORT, () => console.log(`sweeper on :${PORT}, node ${NODE_URL}`));

// Serve 503s while the node syncs, then start sweeping.
const node = await connect();
const ready = createSweeper(node);
rpc = node;
sweeper = ready;
// Local runs (localnet/dev.sh, browser.sh) put every client on 127.0.0.1.
const limit = (name: string) => {
  const raw = process.env[name];
  const n = limitFromEnv(raw);
  if (raw && n === undefined) console.error(`ignoring ${name}=${raw}: not a positive whole number`);
  return n;
};
matchmaker = createMatchmaker(node, Date.now, {
  seekLimit: limit("MATCH_SEEK_LIMIT"),
  requestLimit: limit("MATCH_REQUEST_LIMIT"),
});
let lastOnline = Date.now();
setInterval(() => {
  if (node.isConnected) {
    lastOnline = Date.now();
    void ready.tick();
  } else if (Date.now() - lastOnline > MAX_OFFLINE_MS) {
    console.error("lost the node; restarting");
    process.exit(1);
  }
}, TICK_MS);
