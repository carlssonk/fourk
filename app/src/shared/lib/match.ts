/**
 * The match file: the stored-match JSON schema (kept schema-compatible with
 * the retired Python CLI's match.json). Share codes in invite links use the
 * compact binary codec from sharecode.ts.
 */

import { z } from "zod";
import { CELLS, MOVE_TIMEOUT_DAA, ZERO_PK, isOpen, type State } from "./game";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  decodeMatchBinary,
  encodeMatchBinary,
} from "./sharecode";

/** Off-chain player identity: a display name and a 16-hex avatar gene code
 * (see shared/lib/avatar). P1's rides the invite link; P2's rides the join
 * transaction's payload. Cosmetic and unauthenticated by design. */
export interface PlayerProfile {
  name: string;
  avatar: string;
}

export const MAX_NAME_LEN = 20;

/** Cap a display name at MAX_NAME_LEN UTF-16 units (what input maxLength and
 * the schema's .max count) without ever splitting a surrogate pair — a plain
 * .slice can cut an emoji in half and leave a lone surrogate that encodes as
 * U+FFFD on the wire. */
export function trimName(name: string): string {
  const chars = [...name];
  while (chars.join("").length > MAX_NAME_LEN) chars.pop();
  return chars.join("");
}

export interface Match {
  network: string;
  covenantId: string;
  state: State;
  txid: string;
  /** Current pot in sompi. */
  value: bigint;
  /** Whatever identities we've learned; merged as they arrive. */
  profiles?: { p1?: PlayerProfile; p2?: PlayerProfile };
  /** How the game ended, recorded the moment it was seen to finish — so a
   * reopened match shows its real outcome, not a generic "game over". */
  result?: string;
  /** The creator's chosen disc colour — pure paint, picked at creation and
   * carried by the invite link. On-chain discs are only 1 (creator) and 2
   * (joiner); absent means the classic mapping (p1 red). */
  p1Color?: "red" | "blue";
}

export const NETWORK_ID = "testnet-10";
export const SOMPI_PER_KAS = 100_000_000n;

/** Human duration for a DAA block count (~10 blocks/s). */
export function fmtDaaDuration(daa: number): string {
  const mins = Math.round(daa / 600);
  if (mins < 60) return `${mins} min`;
  const hours = mins / 60;
  if (hours < 48) return Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`;
  return `${Math.round(hours / 24)} d`;
}

export function fmtKas(sompi: bigint): string {
  const whole = sompi / SOMPI_PER_KAS;
  const frac = ((sompi % SOMPI_PER_KAS) * 10000n) / SOMPI_PER_KAS;
  if (whole === 0n && frac === 0n && sompi > 0n) return "<0.0001";
  return frac === 0n
    ? String(whole)
    : `${whole}.${String(frac).padStart(4, "0").replace(/0+$/, "")}`;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** phase field of the covenant state (0 open, 1 live) — derived, like the TS reference. */
export function phaseOf(s: State): number {
  return isOpen(s) ? 0 : 1;
}

export function matchToJson(m: Match): string {
  return JSON.stringify(
    {
      network: m.network,
      covenantId: m.covenantId,
      p1: m.state.p1,
      p2: m.state.p2,
      board: toHex(m.state.board),
      moveCount: m.state.moveCount,
      phase: phaseOf(m.state),
      txid: m.txid,
      value: Number(m.value),
      moveTimeout: m.state.moveTimeout,
      deadline: m.state.deadline,
      ...(m.profiles && { profiles: m.profiles }),
      ...(m.p1Color && { p1Color: m.p1Color }),
      ...(m.result && { result: m.result }),
    },
    null,
    2,
  );
}

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 hex chars");

const profileSchema = z.object({
  name: z.string().max(MAX_NAME_LEN),
  avatar: z.string().regex(/^[0-9a-f]{16}$/, "bad avatar code"),
});

/** The match.json shape shared with the Python CLI — validated strictly
 * because it arrives from untrusted places (localStorage, legacy share
 * codes pasted by strangers). Board bytes are cell values 0/1/2 in hex. */
const matchJsonSchema = z.object({
  network: z.string().min(1),
  covenantId: hex64,
  p1: hex64,
  p2: hex64,
  board: z.string().regex(new RegExp(`^(0[0-2]){${CELLS}}$`), "bad board"),
  moveCount: z.number().int().min(0).max(CELLS),
  phase: z.union([z.literal(0), z.literal(1)]),
  txid: hex64,
  value: z.number().int().nonnegative(),
  // Absent in pre-timing records: those games ran the old constants.
  moveTimeout: z.number().int().positive().optional(),
  deadline: z.number().int().nonnegative().optional(),
  profiles: z.object({ p1: profileSchema.optional(), p2: profileSchema.optional() }).optional(),
  p1Color: z.enum(["red", "blue"]).optional(),
  result: z.string().optional(),
});

export function matchFromJson(json: string): Match {
  const raw = matchJsonSchema.parse(JSON.parse(json));
  const state: State = {
    p1: raw.p1,
    p2: raw.p2,
    board: fromHex(raw.board),
    moveCount: raw.moveCount,
    // The reference derives everything else; stake mirrors the pot per player.
    stake: BigInt(raw.value) / (raw.phase === 1 ? 2n : 1n),
    moveTimeout: raw.moveTimeout ?? MOVE_TIMEOUT_DAA,
    deadline: raw.deadline ?? 0,
  };
  if (raw.phase === 0 && state.p2 !== ZERO_PK) throw new Error("bad match file: open with p2 set");
  return {
    network: raw.network,
    covenantId: raw.covenantId,
    state,
    txid: raw.txid,
    value: BigInt(raw.value),
    ...(raw.profiles && {
      profiles: {
        ...(raw.profiles.p1 && { p1: raw.profiles.p1 }),
        ...(raw.profiles.p2 && { p2: raw.profiles.p2 }),
      },
    }),
    ...(raw.p1Color && { p1Color: raw.p1Color }),
    ...(raw.result && { result: raw.result }),
  };
}

/** Compact binary share code (see sharecode.ts) — ~190 chars in a link. */
export function encodeShareCode(m: Match): string {
  return bytesToBase64Url(encodeMatchBinary(m));
}

/** Decode a share code (compact binary; throws on anything else). */
export function decodeShareCode(code: string): Match {
  return decodeMatchBinary(base64UrlToBytes(code.trim()));
}

/** The more advanced of two snapshots of the same match. */
export function fresherOf(a: Match, b: Match): Match {
  return a.state.moveCount >= b.state.moveCount ? a : b;
}

export const LIST_KEY = "fourk.matches";

/** All stored matches, most recently touched first. Pure read (safe in a
 * StrictMode-double-invoked initializer). */
export function loadMatches(): Match[] {
  const out: Match[] = [];
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (raw) for (const item of JSON.parse(raw) as string[]) out.push(matchFromJson(item));
  } catch {
    /* corrupt list — start over rather than brick the app */
  }
  return out;
}

export function saveMatches(list: Match[]): void {
  localStorage.setItem(LIST_KEY, JSON.stringify(list.map(matchToJson)));
  // Bookkeeping for pruning follows the list: forget timestamps and
  // checkpoints of matches that are no longer stored.
  const seen = loadFinishedSeen();
  const kept = Object.entries(seen).filter(([id]) => list.some((m) => m.covenantId === id));
  if (kept.length !== Object.keys(seen).length) saveFinishedSeen(Object.fromEntries(kept));
  const cps = loadCheckpoints();
  const keptCps = Object.entries(cps).filter(([id]) => list.some((m) => m.covenantId === id));
  if (keptCps.length !== Object.keys(cps).length)
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(Object.fromEntries(keptCps)));
}

// Chain checkpoints: a recent block hash per match, captured while the game
// UTXO is known alive. Spends are discovered by scanning blocks forward from
// here, so it must survive reloads — a host who closes the tab after sharing
// the invite link still needs to find the join that happened while away.

const CHECKPOINT_KEY = "fourk.checkpoints"; // covenantId -> block hash

function loadCheckpoints(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CHECKPOINT_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function loadCheckpoint(covenantId: string): string | null {
  return loadCheckpoints()[covenantId] ?? null;
}

export function saveCheckpoint(covenantId: string, blockHash: string): void {
  localStorage.setItem(
    CHECKPOINT_KEY,
    JSON.stringify({ ...loadCheckpoints(), [covenantId]: blockHash }),
  );
}

/** Finished matches linger under "Open matches" this long before auto-pruning,
 * so a result reached while the player was away can still be seen. */
const FINISHED_PRUNE_MS = 24 * 60 * 60 * 1000;

const FINISHED_KEY = "fourk.finished"; // covenantId -> ms timestamp first seen finished

function loadFinishedSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(FINISHED_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveFinishedSeen(seen: Record<string, number>): void {
  localStorage.setItem(FINISHED_KEY, JSON.stringify(seen));
}

/** Note that a match was seen finished; true once it has lingered past the
 * grace period and should be pruned from the stored list. */
export function finishedLongAgo(covenantId: string): boolean {
  const seen = loadFinishedSeen();
  const first = seen[covenantId] ?? Date.now();
  if (!(covenantId in seen)) saveFinishedSeen({ ...seen, [covenantId]: first });
  return Date.now() - first > FINISHED_PRUNE_MS;
}
