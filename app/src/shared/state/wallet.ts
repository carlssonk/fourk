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
 * never stored — so each account is exactly one secret to write down. Every
 * account this browser has created or been given stays in the stored list;
 * switching only changes which one is active. Funds never move on a switch,
 * and a game seated by any stored account stays playable (see matchWallet).
 * The guest key never changes: free play keeps using it forever.
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
  v: 3;
  guest: string;
  /** Every account this browser knows, most recently used first — owned[0]
   * is the active one. */
  owned: OwnedAccount[];
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

/** Phrases salvaged from an `owned` field in any shape this app has ever
 * written: the v3 list, or the single v2 object. Order preserved, deduped. */
function salvagePhrases(owned: any): string[] {
  const entries = Array.isArray(owned) ? owned : [owned];
  const phrases = entries
    .map((o) => (typeof o?.phrase === "string" && o.phrase ? (o.phrase as string) : undefined))
    .filter((p): p is string => !!p);
  return [...new Set(phrases)];
}

/**
 * The stored account. Lazy because the wasm SDK must be initialized before
 * any key is constructed; re-persisted on read so a hand-edited or
 * partially-written record is normalized to the shape above exactly once.
 *
 * Salvage over destroy, field by field: the owned phrases are the only copy
 * of the player's money and survive whatever happened to the rest of the
 * record (a corrupt guest, a version we don't know, half-written JSON), and
 * the guest seat likewise survives an unreadable `owned`. A record that
 * isn't pristine v3 is backed up before the normalized shape replaces it —
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
  const phrases = salvagePhrases(raw?.owned);
  const pristine =
    raw?.v === 3 &&
    guestOk &&
    Array.isArray(raw.owned) &&
    raw.owned.length === phrases.length &&
    raw.owned.every((o: any, i: number) => o?.phrase === phrases[i]);
  if (!pristine && rawText) backupRecord(rawText);

  persist({
    v: 3,
    guest: guestOk ? raw.guest : freshGuestKey(),
    owned: phrases.map((phrase) => ({ phrase })),
  });
  return stored!;
}

/** The invisible free-play seat. Always exists. */
export function freeWallet(): Wallet {
  return cachedWallet(loadAccount().guest);
}

/** The player's active account, once they've made or imported one. */
export function ownedWallet(): Wallet | undefined {
  const active = loadAccount().owned[0];
  return active ? phraseWallet(active.phrase) : undefined;
}

export function hasOwnedAccount(): boolean {
  return loadAccount().owned.length > 0;
}

/** A stored account as the UI sees it: the derived address, plus the phrase
 * so it can be handed straight back to adoptAccount to switch. */
export interface AccountRow {
  address: string;
  phrase: string;
}

function accountRow(o: OwnedAccount): AccountRow {
  return { address: walletAddress(phraseWallet(o.phrase).key), phrase: o.phrase };
}

/** Every account stored on this device, active first — what the sign-in
 * screen lists. */
export function listAccounts(): (AccountRow & { active: boolean })[] {
  return loadAccount().owned.map((o, i) => ({ ...accountRow(o), active: i === 0 }));
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
 * The wallet seated in this match: any stored account's key or the guest
 * key — a game stays playable however many times the player has switched
 * accounts since starting it.
 *
 * Undefined means none of them holds a seat here: we're spectating, and
 * there is nothing to sign with. Callers must say which they mean rather
 * than being handed a key that can only produce a rejected transaction.
 */
export function matchWallet(m: Match): Wallet | undefined {
  const account = loadAccount();
  const candidates = [...account.owned.map((o) => phraseWallet(o.phrase)), freeWallet()];
  for (const w of candidates) {
    if (w.myPk === m.state.p1 || w.myPk === m.state.p2) return w;
  }
  return undefined;
}

/** What the money UI shows — undefined while the player is still a guest. */
export function activeAccount(): AccountRow | undefined {
  const active = loadAccount().owned[0];
  return active ? accountRow(active) : undefined;
}

/**
 * Make `phrase` the active account — adding it to the front of the stored
 * list if it's new — and reload: every consumer captured its wallet
 * synchronously, so a reload is the one reliable reset. Returns false (no
 * reload) when it is already the active account.
 *
 * The only way an account is ever set or switched, whether freshly
 * generated or typed in: there is no separate "create" that could leave a
 * half-made account behind. The previously active account stays in the
 * list, funds and seats untouched — switching is a pointer change, not a
 * move of money.
 */
export function adoptAccount(phrase: string): boolean {
  const account = loadAccount();
  if (phrase === account.owned[0]?.phrase) return false;
  const others = account.owned.filter((o) => o.phrase !== phrase);
  persist({ ...account, owned: [{ phrase }, ...others] });
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

/**
 * Make this device forget `phrase`: it comes off the stored list (and out
 * of any backup record), the next stored account — or the guest seat —
 * takes over on the reload. The account itself is untouched: the phrase
 * still opens it, from here or anywhere. The UI's job is making sure the
 * player holds another copy before this runs; ours is making sure the
 * forgetting actually happened — a browser that won't persist the removal
 * gets an error, not a reload that quietly brings the account back.
 * Returns false when the phrase isn't stored here.
 */
export function forgetAccount(phrase: string): boolean {
  const account = loadAccount();
  if (!account.owned.some((o) => o.phrase === phrase)) return false;
  persist({ ...account, owned: account.owned.filter((o) => o.phrase !== phrase) });
  scrubBackups(phrase);
  let readBack: string | null = null;
  try {
    readBack = localStorage.getItem(ACCOUNT_STORAGE);
  } catch {
    /* no storage at all — then it never held the phrase past this session */
  }
  if (readBack?.includes(phrase))
    throw new Error("ACCOUNT_NOT_REMOVED: this browser did not persist the removal");
  location.reload();
  return true;
}

/** Backup records exist so damage never costs a phrase (see backupRecord) —
 * but a phrase the player asked this device to forget must not outlive the
 * removal in one. Best effort: where enumeration fails, storage generally
 * has too, and the main record's read-back check above still decides
 * whether the removal counts. */
function scrubBackups(phrase: string): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith(`${ACCOUNT_STORAGE}.bak.`)) continue;
      if (localStorage.getItem(k)?.includes(phrase)) localStorage.removeItem(k);
    }
  } catch {
    /* best effort only */
  }
}

/** Cross-tab (called once from initStateLayer): another tab changed
 * accounts; this tab's singletons and watchers all hold the old keys —
 * reload to adopt them. */
export function wireAccountCrossTab(): void {
  window.addEventListener("storage", (ev) => {
    if (ev.key === ACCOUNT_STORAGE) location.reload();
  });
}
