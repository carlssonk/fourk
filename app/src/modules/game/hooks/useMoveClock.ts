import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import * as cov from "@shared/lib/covenant";
import type { Match } from "@shared/lib/match";
import { rpcClientAtom } from "@shared/state";

/** testnet-10 mines ~10 blocks/s, so one DAA block ≈ 100ms of clock. */
const MS_PER_DAA = 100;

export interface MoveClock {
  /** "m:ss" countdown, or null while inactive / before the anchor arrives. */
  text: string | null;
  /** The mover's time is up — the waiting player can claim the forfeit.
   * A local estimate (the claim re-checks the age on-chain). */
  expired: boolean;
  /** Whole seconds remaining (0 once expired), or null with no anchor. */
  secondsLeft: number | null;
}

/**
 * Countdown until the player to move forfeits. The game UTXO's age IS the
 * clock (every move creates a fresh UTXO, resetting it — see claim_forfeit
 * in the covenant), so one age fetch per transition anchors a locally
 * ticking deadline; no polling. Null while inactive (lobby games have no
 * timer by contract) or before the anchor arrives.
 */
export function useMoveClock(match: Match, active: boolean): MoveClock {
  const rpc = useAtomValue(rpcClientAtom);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The effect keys on txid — the UTXO whose age anchors the clock — not on
  // the match object, whose identity churns with every store update.
  const matchRef = useRef(match);
  matchRef.current = match;
  const txid = match.txid;

  useEffect(() => {
    setDeadline(null);
    if (!rpc || !active) return;
    let stale = false;
    cov
      .gameUtxoAge(rpc, matchRef.current)
      .then((age) => {
        if (stale || age === null) return;
        setNow(Date.now());
        setDeadline(Date.now() + (matchRef.current.state.moveTimeout - age) * MS_PER_DAA);
      })
      .catch(() => {
        /* transient RPC error — the next transition re-anchors */
      });
    return () => {
      stale = true;
    };
  }, [rpc, active, txid]);

  useEffect(() => {
    if (deadline === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline]);

  if (!active || deadline === null) return { text: null, expired: false, secondsLeft: null };
  const left = Math.max(0, deadline - now);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return {
    text: `${m}:${String(s).padStart(2, "0")}`,
    expired: left === 0,
    secondsLeft: Math.ceil(left / 1000),
  };
}
