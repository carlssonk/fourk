/**
 * The account layer: secret parsing/derivation (lib/mnemonic.ts) and the
 * staked flag's JSON round-trip. Loads the kaspa wasm from disk — no
 * network, no chain. Lives under app/ (not test/) because "kaspa-wasm"
 * only resolves from inside the app workspace.
 */

import fs from "node:fs";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import kaspaInit, { Mnemonic } from "kaspa-wasm";
import { generatePhrase, parsePhrase, phraseToKeyHex } from "../src/shared/lib/mnemonic";
import {
  FREE_STAKE,
  SOMPI_PER_KAS,
  STAKE_PRESETS,
  isStaked,
  matchFromJson,
  matchToJson,
  type Match,
} from "../src/shared/lib/match";
import { CELLS, ZERO_PK } from "../src/shared/lib/game";

const KASPA_WASM = new URL("../../vendor/kaspa-wasm/kaspa_bg.wasm", import.meta.url);

/** wallet.ts is browser-shaped (localStorage, a storage listener, and a
 * reload when the account changes) — give it just enough of one to run
 * under node. */
const bag = new Map<string, string>();
let reloads = 0;
const shim = {
  localStorage: {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => void bag.set(k, String(v)),
    removeItem: (k: string) => void bag.delete(k),
  },
  location: { reload: () => void reloads++ },
  // wasm-bindgen's entropy shim treats a defined `window` as "this is a
  // browser" and reaches for window.crypto — so the stub must carry it, or
  // every randomness call inside wasm traps.
  window: { addEventListener: () => {}, crypto: globalThis.crypto },
};

beforeAll(async () => {
  await kaspaInit(fs.readFileSync(KASPA_WASM));
  for (const [k, v] of Object.entries(shim)) vi.stubGlobal(k, v);
});

// The canonical BIP-39 test phrase, derived through the SDK's standard
// Kaspa path (m/44'/111111'/0', receive 0) — pins the derivation so a
// refactor can't silently strand every phrase-restored account.
const VECTOR_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VECTOR_KEY = "24cd8d2875e8e17e4f88fbc554834a89b7b3e0c6f9d84fae36883604359ba440";

describe("parsePhrase", () => {
  test("a 12-word phrase is the account: it derives the standard receive-0 key", () => {
    expect(parsePhrase(VECTOR_PHRASE)).toBe(VECTOR_PHRASE);
    expect(phraseToKeyHex(VECTOR_PHRASE)).toBe(VECTOR_KEY);
  });

  test("case and stray whitespace are forgiven", () => {
    const messy = `  ${VECTOR_PHRASE.toUpperCase().split(" ").join("   ")} \n`;
    expect(parsePhrase(messy)).toBe(VECTOR_PHRASE);
  });

  test("a 24-word phrase parses too", () => {
    const phrase = Mnemonic.random(24).phrase;
    expect(parsePhrase(phrase)).toBe(phrase);
    expect(phraseToKeyHex(phrase)).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ["empty", ""],
    ["word salad", "correct horse battery staple"],
    ["11 words", VECTOR_PHRASE.split(" ").slice(1).join(" ")],
    ["bad checksum", VECTOR_PHRASE.replace(/about$/, "abandon")],
    // A bare private key is a valid secret elsewhere, but not an account
    // here: every account is a phrase, so there is one thing to write down.
    ["a bare account key", VECTOR_KEY],
    ["63 hex chars", VECTOR_KEY.slice(1)],
  ])("garbage (%s) throws BAD_SECRET", (_label, input) => {
    expect(() => parsePhrase(input)).toThrow("BAD_SECRET");
  });
});

describe("generatePhrase", () => {
  test("fresh accounts are 12 valid words", () => {
    const phrase = generatePhrase();
    expect(phrase.split(" ")).toHaveLength(12);
    expect(Mnemonic.validate(phrase)).toBe(true);
    expect(parsePhrase(phrase)).toBe(phrase);
  });
});

describe("staked is read from the stake, not claimed by the invite", () => {
  const at = (stake: bigint): Match => ({
    network: "testnet-10",
    covenantId: "ab".repeat(32),
    txid: "cd".repeat(32),
    value: stake,
    state: {
      p1: "11".repeat(32),
      p2: ZERO_PK,
      board: new Uint8Array(CELLS),
      moveCount: 0,
      stake,
      moveTimeout: 36_000,
      deadline: 0,
    },
  });

  test("the free stake alone reads as free play", () => {
    expect(isStaked(at(FREE_STAKE))).toBe(false);
    expect(isStaked(at(5n * SOMPI_PER_KAS))).toBe(true);
    // Neighbouring amounts are staked: only the exact sentinel is free.
    expect(isStaked(at(FREE_STAKE - 1n))).toBe(true);
    expect(isStaked(at(FREE_STAKE + 1n))).toBe(true);
  });

  test("no stake a player can pick collides with the free stake", () => {
    // The whole scheme rests on this: if a preset ever equalled FREE_STAKE,
    // a real wager would be seated (and dispenser-funded) as a free game.
    expect(STAKE_PRESETS).not.toContain(FREE_STAKE);
  });

  test("nothing about it survives into stored JSON — it is derived", () => {
    expect(matchToJson(at(FREE_STAKE))).not.toContain("staked");
    expect(isStaked(matchFromJson(matchToJson(at(FREE_STAKE))))).toBe(false);
    expect(isStaked(matchFromJson(matchToJson(at(25n * SOMPI_PER_KAS))))).toBe(true);
  });
});

describe("guest and owned keys", () => {
  /** wallet.ts memoizes its account, so each case needs a fresh module —
   * which also hands it a fresh (uninitialized) wasm instance to re-init. */
  async function freshWallet(seed: Record<string, string> = {}) {
    bag.clear();
    for (const [k, v] of Object.entries(seed)) bag.set(k, v);
    vi.resetModules();
    const wasm = await import("kaspa-wasm");
    await wasm.default(fs.readFileSync(KASPA_WASM));
    const mod = await import("../src/shared/state/wallet");
    mod.freeWallet(); // the account loads lazily, on first use
    return mod;
  }
  const readStored = () => JSON.parse(bag.get("fourk.account")!);
  const GUEST = "ab".repeat(32);
  const seatedBy = (pk: string): Match => ({
    network: "testnet-10",
    covenantId: "ab".repeat(32),
    txid: "cd".repeat(32),
    value: 1n,
    state: {
      p1: pk,
      p2: ZERO_PK,
      board: new Uint8Array(CELLS),
      moveCount: 0,
      stake: 1n,
      moveTimeout: 36_000,
      deadline: 0,
    },
  });

  beforeEach(() => {
    reloads = 0;
  });

  test("a fresh visitor is a guest: a key, no account, no phrase", async () => {
    const w = await freshWallet();
    expect(w.hasOwnedAccount()).toBe(false);
    expect(w.ownedWallet()).toBeUndefined();
    expect(w.activeAccount()).toBeUndefined();
    expect(w.freeWallet().myPk).toMatch(/^[0-9a-f]{64}$/);
    const stored = readStored();
    expect(stored.v).toBe(2);
    expect(stored.owned).toBeUndefined();
    expect(stored.guest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("free play never needs an account; staked play always does", async () => {
    const w = await freshWallet();
    expect(w.signingWallet({}).myPk).toBe(w.freeWallet().myPk);
    expect(() => w.signingWallet({ staked: true })).toThrow("NO_ACCOUNT");
  });

  test("a stored account is its phrase; the key is derived, never kept", async () => {
    const w = await freshWallet({
      "fourk.account": JSON.stringify({ v: 2, guest: GUEST, owned: { phrase: VECTOR_PHRASE } }),
    });
    expect(w.ownedWallet()!.key.toString()).toBe(VECTOR_KEY);
    expect(w.activeAccount()?.phrase).toBe(VECTOR_PHRASE);
    expect(JSON.stringify(readStored())).not.toContain(VECTOR_KEY);
  });

  test.each([
    ["absent", undefined],
    ["corrupt", "{{{"],
    ["a bad guest key", JSON.stringify({ v: 2, guest: "nope" })],
  ])("an unreadable record (%s) starts a fresh guest", async (_label, raw) => {
    const w = await freshWallet(raw === undefined ? {} : { "fourk.account": raw });
    expect(w.hasOwnedAccount()).toBe(false);
    expect(readStored().guest).toMatch(/^[0-9a-f]{64}$/);
    expect(readStored().guest).not.toBe(GUEST);
  });

  const backups = () =>
    [...bag.keys()].filter((k) => k.startsWith("fourk.account.bak.")).map((k) => bag.get(k)!);

  test("THE INVARIANT: a recovery phrase survives whatever happened around it", async () => {
    // The phrase is the only copy of the player's money. A corrupt guest
    // field, a version this build doesn't know, or any other damage to the
    // record must never take `owned.phrase` down with it.
    const mangledGuest = JSON.stringify({
      v: 2,
      guest: "nope",
      owned: { phrase: VECTOR_PHRASE },
    });
    let w = await freshWallet({ "fourk.account": mangledGuest });
    expect(w.hasOwnedAccount()).toBe(true);
    expect(w.activeAccount()?.phrase).toBe(VECTOR_PHRASE);
    expect(readStored().guest).toMatch(/^[0-9a-f]{64}$/); // fresh guest beside it

    const futureVersion = JSON.stringify({
      v: 9,
      guest: GUEST,
      owned: { phrase: VECTOR_PHRASE },
      someFutureField: true,
    });
    w = await freshWallet({ "fourk.account": futureVersion });
    expect(w.activeAccount()?.phrase).toBe(VECTOR_PHRASE);
    expect(readStored().guest).toBe(GUEST); // the valid guest is salvaged too
  });

  test("a record that isn't pristine v2 is backed up before being replaced", async () => {
    const strange = JSON.stringify({ v: 9, guest: GUEST, owned: { phrase: VECTOR_PHRASE } });
    await freshWallet({ "fourk.account": strange });
    expect(backups()).toContain(strange); // the original bytes, untouched

    const garbage = "{{{";
    await freshWallet({ "fourk.account": garbage });
    expect(backups()).toContain(garbage);
  });

  test("a pristine record is normalized in place, no backup noise", async () => {
    await freshWallet({
      "fourk.account": JSON.stringify({ v: 2, guest: GUEST, owned: { phrase: VECTOR_PHRASE } }),
    });
    expect(backups()).toEqual([]);
  });

  test("an unusable account is dropped, but never takes the guest seat with it", async () => {
    const w = await freshWallet({
      "fourk.account": JSON.stringify({ v: 2, guest: GUEST, owned: { key: VECTOR_KEY } }),
    });
    expect(w.hasOwnedAccount()).toBe(false); // no phrase, no account
    expect(w.freeWallet().key.toString()).toBe(GUEST); // games it seats stay playable
  });

  test("adopting a phrase is the only way an account is ever set", async () => {
    const w = await freshWallet();
    const guestBefore = readStored().guest;
    // Creating and signing in are the same operation: the UI generates the
    // phrase, shows it, and adopts it only once the player acknowledges —
    // so there is no half-made account, and no second path that could
    // overwrite a funded one without moving its money first.
    expect(w.adoptAccount(VECTOR_PHRASE)).toBe(true);
    expect(w.hasOwnedAccount()).toBe(true);
    expect(readStored().guest).toBe(guestBefore);
    expect(readStored().owned).toEqual({ phrase: VECTOR_PHRASE });
    expect(w.signingWallet({ staked: true }).myPk).toBe(w.ownedWallet()!.myPk);
    expect(w.signingWallet({}).myPk).toBe(w.freeWallet().myPk);
    expect(w.ownedWallet()!.myPk).not.toBe(w.freeWallet().myPk);
  });

  test("adopting another phrase forgets the old account but never the guest", async () => {
    const w = await freshWallet();
    const first = generatePhrase();
    w.adoptAccount(first);
    const firstOwned = w.ownedWallet()!.myPk;
    const guest = readStored().guest;

    expect(w.adoptAccount(VECTOR_PHRASE)).toBe(true);
    expect(reloads).toBe(2);
    expect(w.ownedWallet()!.key.toString()).toBe(VECTOR_KEY);
    expect(w.ownedWallet()!.myPk).not.toBe(firstOwned);
    expect(readStored().guest).toBe(guest);
    // Nothing keeps a retired key around — the whole record is one phrase
    // and one guest seat.
    expect(Object.keys(readStored()).sort()).toEqual(["guest", "owned", "v"]);
    expect(JSON.stringify(readStored())).not.toContain(first);
  });

  test("adopting the account you already have is a no-op", async () => {
    const w = await freshWallet();
    w.adoptAccount(VECTOR_PHRASE);
    reloads = 0;
    expect(w.adoptAccount(VECTOR_PHRASE)).toBe(false);
    expect(reloads).toBe(0);
  });

  test("both live seats stay signable; a stranger's game is spectated", async () => {
    const w = await freshWallet();
    w.adoptAccount(VECTOR_PHRASE);

    for (const pk of [w.ownedWallet()!.myPk, w.freeWallet().myPk])
      expect(w.matchWallet(seatedBy(pk))?.myPk).toBe(pk);
    expect(w.matchWallet(seatedBy("99".repeat(32)))).toBeUndefined();
  });
});
