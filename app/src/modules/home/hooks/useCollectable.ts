import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import type { Match } from "@shared/lib/match";
import { modeOf } from "@shared/modes/registry";
import { getRpc, matchWallet, matchesAtom } from "@shared/state";

/**
 * Which stored matches hold a payout the player can send from the list
 * (`ModeActions.collectWait`), so a winner who closed the game does not have
 * to reopen it. A match still inside its window is checked again when the
 * window ends.
 */
export function useCollectable(): Record<string, boolean> {
  const matches = useAtomValue(matchesAtom);
  const [collectable, setCollectable] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let stale = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const check = async (m: Match) => {
      const actions = modeOf(m).actions;
      const myPk = matchWallet(m)?.myPk;
      if (!actions.collectWait || !myPk) return;
      if (m.result) {
        setCollectable((r) => (r[m.covenantId] ? { ...r, [m.covenantId]: false } : r));
        return;
      }
      let wait: number | null;
      try {
        wait = await actions.collectWait(await getRpc(), m, myPk);
      } catch {
        // Transient RPC trouble: look again shortly.
        if (!stale) timers.push(setTimeout(() => void check(m), 10_000));
        return;
      }
      if (stale) return;
      setCollectable((r) => ({ ...r, [m.covenantId]: wait === 0 }));
      // DAA blocks to ms at 10 per second, padded so the lock has passed.
      if (wait) timers.push(setTimeout(() => void check(m), wait * 100 + 2000));
    };
    for (const m of matches) void check(m);
    return () => {
      stale = true;
      timers.forEach(clearTimeout);
    };
  }, [matches]);

  return collectable;
}
