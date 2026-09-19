import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import * as cov from "@shared/lib/covenant";
import type { Match } from "@shared/lib/match";
import { modeOf } from "@shared/modes/registry";
import type { ClockSpec } from "@shared/modes/types";
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
  /** Fraction of the configured move window remaining, clamped to 0..1. */
  fractionRemaining: number;
}

/**
 * Countdown until the player to move forfeits. The mode says what the clock
 * is (see ClockSpec): the game UTXO's age up to a duration — every
 * transition creates a fresh UTXO, resetting it, exactly as claim_forfeit
 * reads it — or, for a shared picking cutoff, the chain's DAA score up to an
 * absolute target, which survives the opponent's transition. One chain
 * fetch per transition anchors a locally ticking deadline; no polling. Null
 * while inactive (lobby games have no timer by contract) or before the
 * anchor arrives. `spec` overrides the mode's own clock (the lobby exit).
 */
export function useMoveClock(match: Match, active: boolean, spec?: ClockSpec): MoveClock {
  const rpc = useAtomValue(rpcClientAtom);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The effect keys on txid — the UTXO whose age anchors the clock — not on
  // the match object, whose identity churns with every store update.
  const matchRef = useRef(match);
  matchRef.current = match;
  const txid = match.txid;
  const resolved = active ? (spec ?? modeOf(match).clock(match)) : null;
  const kind = resolved?.kind ?? null;
  const target = resolved?.daa ?? 0;

  useEffect(() => {
    setDeadline(null);
    if (!rpc || kind === null) return;
    let stale = false;
    const anchor =
      kind === "age"
        ? cov.gameUtxoAge(rpc, matchRef.current).then((age) => (age === null ? null : target - age))
        : rpc.getBlockDagInfo().then((info: any) => target - Number(info.virtualDaaScore));
    anchor
      .then((left) => {
        if (stale || left === null || !Number.isFinite(left)) return;
        setNow(Date.now());
        setDeadline(Date.now() + left * MS_PER_DAA);
      })
      .catch(() => {
        /* transient RPC error — the next transition re-anchors */
      });
    return () => {
      stale = true;
    };
  }, [rpc, kind, target, txid]);

  useEffect(() => {
    if (deadline === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline]);

  if (kind === null || deadline === null)
    return { text: null, expired: false, secondsLeft: null, fractionRemaining: 0 };
  const left = Math.max(0, deadline - now);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  // The window the fraction is drawn against: the configured picking window
  // (an absolute cutoff is one window past the round start).
  const window = kind === "age" ? target : match.state.moveTimeout;
  return {
    text: `${m}:${String(s).padStart(2, "0")}`,
    expired: left === 0,
    secondsLeft: Math.ceil(left / 1000),
    fractionRemaining: Math.max(0, Math.min(1, left / Math.max(1, window * MS_PER_DAA))),
  };
}
