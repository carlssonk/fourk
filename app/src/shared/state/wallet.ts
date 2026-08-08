/**
 * Two kinds of key, deliberately kept apart.
 *
 * The GUEST key is invisible infrastructure: created on first visit, never
 * shown, never given a recovery phrase, and funded entirely by the drip
 * dispenser. It signs free games and nothing else — a player who only ever
 * plays for fun never learns any of this exists.
 *
 * The OWNED key is one the player deliberately created or imported. It is
 * the only key that holds their own money, the only one with a balance on
 * screen, and the only one that can stake a game. Keeping the two apart is
 * what stops dispenser float from funding a wager or leaving as a cash-out.
 *
 * An owned account IS its recovery phrase — the key is derived on use,
 * never stored — so there is exactly one secret to write down. Switching
 * accounts sweeps the old key's balance across and forgets it (see
 * switchAccount in state/actions.ts); nothing accumulates a drawer of
 * retired private keys. The guest key never changes: free play keeps using
 * it forever.
 */

import type { PrivateKey } from "kaspa-wasm";
import { walletAddress, walletPubkey } from "../lib/covenant";
import type { Match } from "../lib/match";
import { phraseToKeyHex } from "../lib/mnemonic";
import { kaspa } from "../lib/sdk";

const ACCOUNT_STORAGE = "fourk.account";

export interface Wallet {
  key: PrivateKey;
  myPk: string;
}

interface OwnedAccount {
  /** The whole account: everything else about it is derived. */
  phrase: string;
}

interface StoredAccount {
  /** Shape marker: anything else is treated as absent and starts fresh. */
  v: 2;
  guest: string;
  owned?: OwnedAccount;
}

let stored: StoredAccount | undefined;
const wallets = new Map<string, Wallet>();
/** phrase -> derived key hex. Deriving runs a BIP-39 seed stretch, and
 * matchWallet is called every render — memoize it. */
const derived = new Map<string, string>();

function cachedWallet(hex: string): Wallet {
  let w = wallets.get(hex);
  if (!w) {
    const key = new kaspa.PrivateKey(hex);
    w = { key, myPk: walletPubkey(key) };
    wallets.set(hex, w);
  }
  return w;
}

export function phraseWallet(phrase: string): Wallet {
  let hex = derived.get(phrase);
  if (!hex) {
    hex = phraseToKeyHex(phrase);
    derived.set(phrase, hex);
  }
  return cachedWallet(hex);
}

function persist(account: StoredAccount): void {
  stored = account;
  try {
    localStorage.setItem(ACCOUNT_STORAGE, JSON.stringify(account));
  } catch (e) {
    // Storage unavailable (private mode, quota): the in-memory account keeps
    // this session working; adoptAccount separately refuses to proceed when
    // a write doesn't stick (see there), so a phrase can't be "saved" into
    // thin air.
    console.error("account record not saved — storage unavailable", e);
  }
}

/** Preserve a record we don't recognize before replacing it. Losing the only
 * copy of `owned.phrase` is losing money — a future format (v3), a
 * half-written record, or hand-edited JSON must never be flattened into a
 * fresh guest. Best effort: if even this write fails, the original record is
 * still in `raw` for this session's logs. */
function backupRecord(text: string): void {
  try {
    localStorage.setItem(`${ACCOUNT_STORAGE}.bak.${Date.now()}`, text);
  } catch (e) {
    console.error("could not back up unrecognized account record", e, text);
  }
}

const isHex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** A guest seat's key: 32 bytes from the platform CSPRNG. Drawn directly
 * rather than through the SDK's Keypair.random() so it behaves the same
 * under node (tests) as in a browser; a scalar outside the curve order is
 * a 1-in-2^128 event that simply redraws. */
function freshGuestKey(): string {
  for (;;) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    try {
      return new kaspa.PrivateKey(hex).toString();
    } catch {
      /* not a valid scalar — vanishingly rare, draw again */
    }
  }
}

/**
 * The stored account. Lazy because the wasm SDK must be initialized before
 * any key is constructed; re-persisted on read so a hand-edited or
 * partially-written record is normalized to the shape above exactly once.
 *
 * Salvage over destroy, field by field: `owned.phrase` is the only copy of
 * the player's money and survives whatever happened to the rest of the
 * record (a corrupt guest, a version we don't know, half-written JSON), and
 * the guest seat likewise survives an unreadable `owned`. A record that
 * isn't pristine v2 is backed up before the normalized shape replaces it —
 * this loader must never be the thing that loses a key.
 */
function loadAccount(): StoredAccount {
  if (stored) return stored;
  let rawText: string | null = null;
  try {
    rawText = localStorage.getItem(ACCOUNT_STORAGE);
  } catch {
    /* storage unavailable — run on an in-memory account */
  }
  let raw: any;
  if (rawText) {
    try {
      raw = JSON.parse(rawText);
    } catch {
      /* corrupt — salvage nothing, but back it up below */
    }
  }

  const guestOk = isHex64(raw?.guest);
  const phrase: string | undefined =
    typeof raw?.owned?.phrase === "string" && raw.owned.phrase ? raw.owned.phrase : undefined;
  const pristine = raw?.v === 2 && guestOk;
  if (!pristine && rawText) backupRecord(rawText);

  persist({
    v: 2,
    guest: guestOk ? raw.guest : freshGuestKey(),
    ...(phrase && { owned: { phrase } }),
  });
  return stored!;
}

/** The invisible free-play seat. Always exists. */
export function freeWallet(): Wallet {
  return cachedWallet(loadAccount().guest);
}

/** The player's own account, once they've made or imported one. */
export function ownedWallet(): Wallet | undefined {
  const { owned } = loadAccount();
  return owned ? phraseWallet(owned.phrase) : undefined;
}

export function hasOwnedAccount(): boolean {
  return !!loadAccount().owned;
}

/**
 * The key that should sign a game at this stake. Staked play is owned-only
 * by construction — the caller gates on `hasOwnedAccount()` first, so a
 * missing account here is a bug, not a user error.
 */
export function signingWallet(opts: { staked?: boolean }): Wallet {
  if (!opts.staked) return freeWallet();
  const owned = ownedWallet();
  if (!owned) throw new Error("NO_ACCOUNT");
  return owned;
}

/**
 * The wallet seated in this match: the owned key or the guest key.
 *
 * Undefined means neither holds a seat here: we're spectating, and there is
 * nothing to sign with. Callers must say which they mean rather than being
 * handed a key that can only produce a rejected transaction.
 */
export function matchWallet(m: Match): Wallet | undefined {
  const account = loadAccount();
  const candidates = [...(account.owned ? [phraseWallet(account.owned.phrase)] : []), freeWallet()];
  for (const w of candidates) {
    if (w.myPk === m.state.p1 || w.myPk === m.state.p2) return w;
  }
  return undefined;
}

/** What the money UI shows — undefined while the player is still a guest. */
export function activeAccount(): { address: string; phrase: string } | undefined {
  const { owned } = loadAccount();
  if (!owned) return undefined;
  return { address: walletAddress(phraseWallet(owned.phrase).key), phrase: owned.phrase };
}

/**
 * Adopt a phrase as the owned account, forgetting the previous one, and
 * reload — every consumer captured its wallet synchronously, so a reload is
 * the one reliable reset. Returns false (no reload) when it is already the
 * owned account.
 *
 * The only way an account is ever set, whether freshly generated or typed
 * in: there is no separate "create" that could leave a half-made account
 * behind, and no path that overwrites a funded one without moving its money
 * first. Whatever the old account held must already have been swept — this
 * drops the only reference to it — so go through `switchAccount`.
 */
/** Refuse up front when this browser can't persist an account — before any
 * money moves toward a record that would evaporate on reload. */
export function assertStorageWritable(): void {
  try {
    const probe = `${ACCOUNT_STORAGE}.probe`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
  } catch {
    throw new Error("ACCOUNT_NOT_SAVED: this browser is not persisting data");
  }
}

export function adoptAccount(phrase: string): boolean {
  const account = loadAccount();
  if (phrase === account.owned?.phrase) return false;
  persist({ ...account, owned: { phrase } });
  // The reload below drops every in-memory reference, so the write MUST have
  // stuck — a storage-less browser (private mode, quota) would otherwise
  // come back up as a guest with the player believing they're signed in.
  let readBack: string | null = null;
  try {
    readBack = localStorage.getItem(ACCOUNT_STORAGE);
  } catch {
    /* handled below */
  }
  if (!readBack || !readBack.includes('"phrase"'))
    throw new Error("ACCOUNT_NOT_SAVED: this browser is not persisting data");
  location.reload();
  return true;
}

// Cross-tab: another tab changed accounts; this tab's singletons and
// watchers all hold the old keys — reload to adopt them.
window.addEventListener("storage", (ev) => {
  if (ev.key === ACCOUNT_STORAGE) location.reload();
});
