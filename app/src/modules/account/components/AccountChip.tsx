import { useAtomValue, useSetAtom } from "jotai";
import { Avatar } from "@shared/components/Avatar";
import { fmtKas, isStaked } from "@shared/lib/match";
import {
  accountPanelAtom,
  balanceAtom,
  currentMatchAtom,
  pendingInviteAtom,
  hasOwnedAccount,
  profileAtom,
} from "@shared/state";

/**
 * The door to the player's account. A guest sees only their face — free
 * mode shows no money, which is the whole point of it — and clicking it
 * offers an account rather than a balance. Once they have one, the chip
 * carries the balance.
 */
export const AccountChip = () => {
  const balance = useAtomValue(balanceAtom);
  const profile = useAtomValue(profileAtom);
  const openPanel = useSetAtom(accountPanelAtom);
  const owned = hasOwnedAccount();
  const current = useAtomValue(currentMatchAtom);
  const invite = useAtomValue(pendingInviteAtom);
  const game = current ?? invite;
  const showBalance = owned && (!game || isStaked(game));

  return (
    <button
      type="button"
      aria-label={owned ? "Your account" : "Account"}
      onClick={() => openPanel(owned ? "overview" : "get-started")}
      title={owned ? "Your account" : "Your profile"}
      className="relative flex cursor-pointer items-center gap-2 rounded-full border border-line bg-panel/60 py-1 pr-1.5 pl-3 text-sm backdrop-blur-xs hover:border-accent"
    >
      {/* A fixed "Account" rather than the username: the name already lives
       * in the setup card, and the chip's job is naming the door, not the
       * player. */}
      <span className={showBalance ? "font-mono" : "text-dim"}>
        {showBalance ? (balance === null ? "…" : `${fmtKas(balance)} KAS`) : "Account"}
      </span>
      <Avatar code={profile.avatar} size={24} animate={false} className="shrink-0" />
    </button>
  );
};
