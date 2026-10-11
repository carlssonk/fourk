/**
 * Commitment salts, persisted so a committed pick survives a refresh.
 * Losing a salt after broadcasting the commit means the reveal is impossible
 * and the round is lost to the opponent's claim_timeout — so the salt is
 * written BEFORE the commit transaction leaves the browser, and pruned only
 * two weeks after its match leaves the stored list (a player who gave up on
 * a game that later turns out recoverable can still reveal).
 *
 * Deliberate limitation: salts are secret, so they cannot ride the share
 * code — a commitment made in this browser cannot be revealed from another
 * device. The timeout doors settle that case; the UI warns about it.
 */

const SALT_KEY = "fourk.salts"; // `${covenantId}:${round}` -> { col, salt }

interface SaltRecord {
  col: number;
  /** 64 hex chars. */
  salt: string;
  /** ms epoch the pick was sealed; absent on older records. */
  at?: number;
}

/** How long a salt outlives its match's record. */
const KEEP_ORPHAN_MS = 14 * 24 * 3600 * 1000;

function loadAll(): Record<string, SaltRecord> {
  try {
    const raw = JSON.parse(localStorage.getItem(SALT_KEY) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function saveSalt(covenantId: string, round: number, col: number, salt: string): void {
  localStorage.setItem(
    SALT_KEY,
    JSON.stringify({ ...loadAll(), [`${covenantId}:${round}`]: { col, salt, at: Date.now() } }),
  );
}

export function loadSalt(covenantId: string, round: number): SaltRecord | null {
  const rec = loadAll()[`${covenantId}:${round}`];
  if (
    !rec ||
    !Number.isInteger(rec.col) ||
    rec.col < 0 ||
    rec.col > 6 ||
    !/^[0-9a-f]{64}$/.test(rec.salt)
  )
    return null;
  return rec;
}

/** Drop salts of matches no longer stored, once they are two weeks old
 * (called alongside saveMatches). */
export function pruneSalts(keepCovenantIds: string[]): void {
  const all = loadAll();
  const keep = new Set(keepCovenantIds);
  const now = Date.now();
  const kept = Object.entries(all).filter(
    ([k, rec]) => keep.has(k.slice(0, k.lastIndexOf(":"))) || now - (rec?.at ?? 0) < KEEP_ORPHAN_MS,
  );
  if (kept.length !== Object.keys(all).length)
    localStorage.setItem(SALT_KEY, JSON.stringify(Object.fromEntries(kept)));
}
