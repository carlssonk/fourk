/** Translate raw SDK/covenant errors into something a player can act on. */
export function friendlyError(message: string): string {
  if (/websocket|disconnect/i.test(message))
    return "The connection blipped mid-action — it usually works on the next try.";
  if (message.includes("DISPENSER_EMPTY"))
    return "The seat dispenser is out of funds — it needs a refill before new seats open.";
  if (message.includes("DISPENSER_COOLING"))
    return "The seat dispenser is catching its breath — try again in a minute or two.";
  if (message.includes("SEAT_SETUP_FAILED"))
    return "Your seat funds haven't arrived yet — give it a moment and try again.";
  if (message.includes("NO_ACCOUNT"))
    return "Staked games need an account — create one and your funds live there.";
  if (message.includes("NOT_SEATED"))
    return "You're watching this game, not playing in it — none of your accounts holds a seat.";
  if (message.includes("LOW_BALANCE"))
    return "Your balance can't cover that — add funds to your account and try again.";
  if (message.includes("BAD_SECRET"))
    return "That doesn't look like a recovery phrase — it should be 12 or 24 words. Check for typos and try again.";
  if (message.includes("MOVE_FAILED"))
    return "Couldn't move your balance to the other account — nothing has changed, so check your connection and try again.";
  if (message.includes("MOVE_UNCERTAIN"))
    return "The connection dropped while your balance was moving, so it may be on either account — you stay signed in here and nothing is lost. Wait a minute, then try the switch again.";
  if (message.includes("BAD_ADDRESS"))
    return "That doesn't look like a valid address — double-check it and try again.";
  if (message.includes("DEADLINE_TOO_CLOSE"))
    return "This game's time cap is already spent — joining now wouldn't leave room to play. Ask the host for a fresh invite.";
  if (message.includes("WRONG_NETWORK"))
    return "That invite is for a different Kaspa network than this app is connected to.";
  if (message.includes("ACCOUNT_NOT_SAVED"))
    return "This browser isn't saving data (private mode?), so an account can't survive here — nothing was changed. Try a regular window.";
  if (message.includes("cannot cover") || message.includes("no UTXOs"))
    return "Your balance can't quite cover that right now — free games top themselves up in a minute; staked games need added funds.";
  if (isStaleMatchError(message))
    return "That move crossed with another update — the board has refreshed, try again.";
  return message;
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
