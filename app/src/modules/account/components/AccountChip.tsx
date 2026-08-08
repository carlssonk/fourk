import { useAtomValue, useSetAtom } from "jotai";
import { Avatar } from "@shared/components/Avatar";
import { fmtKas } from "@shared/lib/match";
import { accountPanelAtom, balanceAtom, hasOwnedAccount, profileAtom } from "@shared/state";

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

  return (
    <button
      type="button"
      onClick={() => openPanel(owned ? "overview" : "get-started")}
      title={owned ? "Your account" : "Your profile"}
      className="relative flex cursor-pointer items-center gap-2 rounded-full border border-line bg-panel/60 py-1 pr-1.5 pl-3 text-sm backdrop-blur-xs hover:border-accent"
    >
      <span className={owned ? "font-mono" : "text-dim"}>
        {owned ? (balance === null ? "…" : `${fmtKas(balance)} KAS`) : profile.name || "Account"}
      </span>
      <Avatar code={profile.avatar} size={24} animate={false} className="shrink-0" />
    </button>
  );
};
