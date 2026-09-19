/** Translate raw SDK/covenant errors into something a player can act on. */
export function friendlyError(message: string): string {
  if (/websocket|disconnect/i.test(message)) return "Connection lost. Please try again.";
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

/** The action was built on a game UTXO that no longer exists — it raced
 * another transition (usually the opponent's, landing mid-click). */
export function isStaleMatchError(message: string): boolean {
  return (
    message.includes("orphan") ||
    message.includes("already spent") ||
    message.includes("missing outpoint") ||
    message.includes("game UTXO not found")
  );
}
