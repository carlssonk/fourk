/**
 * The matchmaker's core (docs/adr/0003): pair two players who both pressed
 * Quick Match in the same game mode, have the one who waited longer host,
 * and forward the host's share code to the partner once the chain holds
 * that lobby.
 *
 * It holds no keys and moves no money. Every transaction is built and signed
 * in the players' browsers, and the joiner re-checks the terms before taking
 * the seat, so the worst this process can do is pair badly or not at all.
 *
 * A ticket's poll answers one of:
 * - `waiting`: in the queue, or paired and waiting for the host's lobby.
 * - `host`: paired as host; open the lobby and post its code to /hosted.
 * - `hosted`: the lobby is verified and the partner is being handed it.
 * - `open`: the lobby is verified but the partner left before taking it;
 *   back in the queue, and the next seeker gets it, so keep it open.
 * - `join` (with `code`): check the terms and take the seat.
 * - `matched`: the joiner has the code; stop polling.
 * - `gone`: the ticket was dropped. Seek again (a host cancels its lobby
 *   first if it opened one).
 */

import { randomUUID } from "node:crypto";
import { gameTimeLeft } from "../src/shared/lib/covenant";
import * as engine from "../src/shared/lib/engine";
import { decodeShareCode, type Match } from "../src/shared/lib/match";
import { QUICK_MATCH_CAP_BOUNDS, isQuickMatchTerms } from "../src/shared/lib/quickMatch";
import { MODES, modeOf } from "../src/shared/modes/registry";
import type { GameModeKey } from "../src/shared/modes/types";
import { createLimiter } from "./limit";
import { MAX_BODY_BYTES, type Reply } from "./sweeper";

/** A ticket not polled for this long has left: its tab closed or slept. */
export const POLL_GRACE_MS = 10_000;
/** How long a host has, from pairing, to post a lobby the chain holds. It
 * covers the whole open (a fresh guest's dispenser claim and the open's
 * confirmation on testnet), so it is generous; a host that is gone is
 * caught by POLL_GRACE_MS long before. */
export const HOST_GRACE_MS = 90_000;
export const MAX_TICKETS = 1000;
/** Per-client requests per window: a seeker polls about every 2 s, so
 * this fits two players behind one address (CF-Connecting-IP). */
export const REQUEST_LIMIT = 120;
/** Per-client seeks per window. Each one may become a lobby the dispenser
 * pays for, so this is what bounds a script that keeps requeueing. */
export const SEEK_LIMIT = 6;

interface Ticket {
  pk: string;
  /** The game mode this ticket queues for: only equal modes pair. */
  mode: GameModeKey;
  /** When this ticket last seeked or polled. */
  seen: number;
  /** The ticket this one is paired with, and whether this one hosts. A
   * host keeps `hosts` and `pairedAt` (its grace) across partners. */
  partner?: string;
  hosts?: boolean;
  pairedAt?: number;
  /** The host's verified share code, for the partner to take. */
  code?: string;
  /** Set on both sides once the partner has been handed the code: the pair
   * is done, and either one leaving no longer requeues the other. */
  taken?: boolean;
}

const json = (status: number, body: object): Reply => ({ status, body: JSON.stringify(body) });

/** The request's JSON object, or null for anything else. */
function parse(body: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const PK = /^[0-9a-f]{64}$/;

/** Per-client limits; raised where every client shares one address. */
export interface MatchmakerLimits {
  seekLimit?: number;
  requestLimit?: number;
}

export function createMatchmaker(
  rpc: engine.Rpc,
  now: () => number = Date.now,
  { seekLimit = SEEK_LIMIT, requestLimit = REQUEST_LIMIT }: MatchmakerLimits = {},
) {
  const tickets = new Map<string, Ticket>();
  const requests = createLimiter(requestLimit, now);
  const seeks = createLimiter(seekLimit, now);

  /** The reply that refuses this request before it is read, if any. */
  function gate(body: string, client: string): Reply | null {
    if (requests(client)) return json(429, { error: "slow down" });
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return json(413, { error: "too large" });
    return null;
  }

  /** Drop who has left (or hosted nothing in time), requeue their partners,
   * and pair whoever is waiting: oldest first, the older one hosting. */
  function settle(): void {
    for (const [id, t] of tickets) {
      const late = t.hosts && !t.code && now() - t.pairedAt! > HOST_GRACE_MS;
      if (late || now() - t.seen > POLL_GRACE_MS) tickets.delete(id);
    }
    // A host stays host when its partner leaves: its lobby (open, or still
    // opening) goes to the next seeker, and its grace keeps running.
    for (const t of tickets.values())
      if (t.partner && !t.taken && !tickets.has(t.partner))
        Object.assign(
          t,
          t.hosts
            ? { partner: undefined }
            : { partner: undefined, hosts: undefined, pairedAt: undefined },
        );
    const waiting = [...tickets].filter(([, t]) => !t.partner);
    // Hosts first. Within each group the order is the wait: tickets is a Map,
    // so it iterates in insertion order (oldest seek first), and
    // Array.prototype.sort is stable, so the sort keeps that order. Hence the
    // older of each pair hosts.
    waiting.sort(([, x], [, y]) => Number(!!y.hosts) - Number(!!x.hosts));
    while (waiting.length > 1) {
      const [hostId, host] = waiting.shift()!;
      const i = waiting.findIndex(([, t]) => t.pk !== host.pk && t.mode === host.mode && !t.hosts);
      if (i < 0) continue;
      const [id, t] = waiting.splice(i, 1)[0]!;
      Object.assign(host, { partner: id, hosts: true, pairedAt: host.pairedAt ?? now() });
      Object.assign(t, { partner: hostId, hosts: false, pairedAt: now() });
    }
  }

  /** POST /match/seek: join the queue. */
  async function seek(body: string, client: string): Promise<Reply> {
    const refused = gate(body, client);
    if (refused) return refused;
    if (seeks(client)) return json(429, { error: "slow down" });
    const req = parse(body);
    const pk = req?.pk;
    if (typeof pk !== "string" || !PK.test(pk)) return json(400, { error: "bad key" });
    const mode = req?.mode;
    if (typeof mode !== "string" || !Object.hasOwn(MODES, mode))
      return json(400, { error: "bad mode" });
    settle();
    if (tickets.size >= MAX_TICKETS) return json(503, { error: "busy" });
    const id = randomUUID();
    tickets.set(id, { pk, mode: mode as GameModeKey, seen: now() });
    settle();
    return json(200, { ticket: id });
  }

  /** GET /match/<ticket>: where this ticket stands. */
  async function poll(id: string, client: string): Promise<Reply> {
    const refused = gate("", client);
    if (refused) return refused;
    settle();
    const t = tickets.get(id);
    if (!t) return json(404, { state: "gone" });
    t.seen = now();
    if (t.hosts) {
      const state = t.taken ? "matched" : !t.code ? "host" : t.partner ? "hosted" : "open";
      return json(200, { state });
    }
    // Repeated until the joiner stops polling: a lost reply must not lose the game.
    if (t.taken) return json(200, { state: "join", code: t.code });
    const host = t.partner ? tickets.get(t.partner) : undefined;
    if (!host?.code) return json(200, { state: "waiting" });
    host.taken = t.taken = true;
    t.code = host.code;
    return json(200, { state: "join", code: t.code });
  }

  /** POST /match/hosted: the host's lobby, forwarded once the chain has it. */
  async function hosted(body: string, client: string): Promise<Reply> {
    const refused = gate(body, client);
    if (refused) return refused;
    const req = parse(body);
    if (typeof req?.ticket !== "string" || typeof req.code !== "string")
      return json(400, { error: "bad request" });
    const { ticket, code } = req as { ticket: string; code: string };
    let lobby: Match;
    try {
      lobby = decodeShareCode(code);
    } catch {
      return json(400, { error: "not a share code" });
    }
    settle();
    const t = tickets.get(ticket);
    if (!t) return json(410, { error: "no such ticket" });
    if (!t.hosts || lobby.state.p1 !== t.pk) return json(403, { error: "not your lobby to host" });
    // Posting is the host's poll while it waits for the node to index the lobby.
    t.seen = now();
    if (!isQuickMatchTerms(lobby, t.mode)) return json(400, { error: "not Quick Match terms" });
    // The cap is an absolute score: held to the preset's against our node's.
    const left = await gameTimeLeft(rpc, lobby);
    const { min, max } = QUICK_MATCH_CAP_BOUNDS;
    if (left < min || left > max) return json(400, { error: "game limit off the terms" });
    const entry = await engine.fetchGameUtxo(rpc, modeOf(lobby), lobby);
    // Value from the chain, as in the sweeper: a lobby holds the host's stake.
    if (!entry || engine.withEntry(lobby, entry).value !== lobby.state.stake)
      return json(404, { error: "no such lobby" });
    // Other requests ran during the lookup; the pairing may have moved on.
    if (tickets.get(ticket) !== t || !t.hosts) return json(410, { error: "no such ticket" });
    t.code = code;
    return json(202, {});
  }

  return { seek, poll, hosted };
}
