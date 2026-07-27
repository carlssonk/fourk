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
  if (message.includes("cannot cover") || message.includes("no UTXOs"))
    return "Your seat is out of funds — try again in a minute and it will top itself up.";
  if (
    message.includes("orphan") ||
    message.includes("already spent") ||
    message.includes("missing outpoint") ||
    message.includes("game UTXO not found")
  )
    return "That move crossed with another update — the board has refreshed, try again.";
  return message;
}
