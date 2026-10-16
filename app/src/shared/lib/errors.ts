/** Translate raw SDK/covenant errors into something a player can act on. */
export function friendlyError(message: string): string {
  if (/websocket|disconnect/i.test(message)) return "Connection lost. Please try again.";
  if (message.includes("FREE_PLAY_UNAVAILABLE"))
    return "Free games are only on the test network. Create an account to play.";
  if (message.includes("DISPENSER_EMPTY"))
    return "Free games are temporarily unavailable. Please try again later.";
  if (message.includes("DISPENSER_COOLING"))
    return "New games are temporarily unavailable. Try again in a minute.";
  if (message.includes("SEAT_SETUP_FAILED"))
    return "Your seat isn't ready yet. Please try again shortly.";
  if (message.includes("NO_ACCOUNT")) return "Create an account to join a staked game.";
  if (message.includes("NOT_SEATED"))
    return "You're watching this game. Only the players can make moves.";
  if (message.includes("LOW_BALANCE")) return "Insufficient balance. Add funds and try again.";
  if (message.includes("BAD_SECRET"))
    return "Enter a valid 12- or 24-word recovery phrase. Check for typos and try again.";
  if (message.includes("BAD_ADDRESS")) return "Enter a valid Kaspa address.";
  if (message.includes("DEADLINE_TOO_CLOSE"))
    return "This game is too close to its time limit. Ask the host for a new invite.";
  if (message.includes("DEADLINE_TOO_FAR"))
    return "This game's time limit isn't what it should be. Look for another game.";
  if (message.includes("WRONG_NETWORK"))
    return "That invite is for a different Kaspa network than this app is connected to.";
  if (message.includes("ACCOUNT_NOT_SAVED"))
    return "Account could not be saved. Check your browser's storage settings and try again. Nothing was changed.";
  if (message.includes("ACCOUNT_NOT_REMOVED"))
    return "Account could not be removed. It is still saved on this device.";
  if (message.includes("cannot cover") || message.includes("no UTXOs"))
    return "Unable to prepare this action. Try again shortly or check your account balance.";
  if (isStaleMatchError(message))
    return "The game updated before your move was accepted. Please try again.";
  return message;
}

/** friendlyError for a caught value: unwrap the message, then translate. */
export function friendlyCatch(e: unknown): string {
  return friendlyError(String((e as Error)?.message ?? e));
}

/**
 * What a failed chain action means for whoever retries it. The node's wRPC
 * rejections carry no structured reason, only rusty-kaspa's error text
 * (mining/errors/src/mempool.rs, consensus/core/src/errors/tx.rs), so the
 * text is the contract; app/test/failures.test.ts pins each form.
 *
 *   stale      an input it spent is gone: another transition (usually the
 *              opponent's) or a wallet spend got there first. Resync, rebuild.
 *   premature  a lock time or sequence lock the chain has not reached yet.
 *   known      the node already has this very transaction: it went through.
 *   transient  the connection failed; the request may never have arrived.
 *   script     the covenant itself refused it (fourk-wasm ran the script
 *              before submitting): retrying the same spend cannot help.
 *   other      anything else.
 */
export type Failure = "stale" | "premature" | "known" | "transient" | "script" | "other";

// First match wins: "already spent" must read as stale before "already" can
// read as known.
const FAILURES: ReadonlyArray<readonly [Failure, RegExp]> = [
  ["script", /script rejected: input #/],
  [
    "stale",
    /already spent by transaction|is an orphan|lacking a matching UTXO entry|missing from current utxo context|game UTXO not found/,
  ],
  ["premature", /is not finalized|sequence locks conditions was not met|pick deadline not reached/],
  ["known", /is already in the mempool|was already accepted by the consensus/],
  [
    "transient",
    /websocket|disconnect|not connected|connection|timed? ?out|failed to fetch|networkerror/i,
  ],
];

export function classifyFailure(e: unknown): Failure {
  const message = String((e as Error)?.message ?? e);
  return FAILURES.find(([, pattern]) => pattern.test(message))?.[0] ?? "other";
}

/** The action was built on a game UTXO that no longer exists: it raced
 * another transition (usually the opponent's, landing mid-click). */
export function isStaleMatchError(message: string): boolean {
  return classifyFailure(message) === "stale";
}
