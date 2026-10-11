import { useAtomValue } from "jotai";
import type { Match } from "@shared/lib/match";
import { modeOf } from "@shared/modes/registry";
import { currentMatchAtom, matchWallet, matchesAtom } from "@shared/state";
import { useAutopilot } from "./hooks/useAutopilot";
import { useMatchWatcher } from "./hooks/useMatchWatcher";

/** Follows one game off screen: its watcher and its automatic duties. */
const Keeper = ({ match }: { match: Match }) => {
  const { result, finish } = useMatchWatcher(match);
  useAutopilot(match, modeOf(match), { result, busy: false, finish, background: true });
  return null;
};

/**
 * Every unfinished game this browser holds a seat in, except the one on
 * screen (Game runs its own), keeps being followed: a reveal is owed the
 * moment both picks are in, and leaving the game screen ("the game is not
 * paused") must not turn that into a forfeit.
 */
export const MatchKeepers = () => {
  const matches = useAtomValue(matchesAtom);
  const current = useAtomValue(currentMatchAtom);
  const kept = matches.filter(
    (m) => !m.result && m.covenantId !== current?.covenantId && matchWallet(m) !== null,
  );
  return (
    <>
      {kept.map((m) => (
        <Keeper key={m.covenantId} match={m} />
      ))}
    </>
  );
};
