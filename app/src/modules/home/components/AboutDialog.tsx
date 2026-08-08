import { Dialog } from "@shared/components/Dialog";

/** What this site is, for the player who wants to know what's under it. */
export const AboutDialog = ({ onDismiss }: { onDismiss: () => void }) => (
  <Dialog
    title="About fourk"
    onDismiss={onDismiss}
    width="max-w-130"
    className="space-y-3 text-left"
  >
    <p className="text-sm text-dim">
      Fourk is Connect Four played on{" "}
      <a
        href="https://kaspa.org"
        target="_blank"
        rel="noreferrer"
        className="font-medium text-ink underline"
      >
        Kaspa
      </a>
      , a real-time, decentralized proof-of-work blockDAG. Each match is a small contract on the
      chain: every move is a transaction, and the chain itself enforces the rules. Whose turn it is,
      where a disc can land, who takes the pot: none of it can be cheated, not even by us.
    </p>
    <p className="text-sm text-dim">
      There is no server behind this. The site is static files, your key is created and kept in your
      browser, and the players' browsers talk only to the Kaspa network. Games are shared as invite
      links.
    </p>
    <p className="text-sm text-dim">
      Free games cost nothing and fund themselves. With an account you can stake KAS on a match
      instead: the pot sits locked in the contract while you play and pays out to the winner. For
      now everything runs on Kaspa's testnet, so the money is test money.
    </p>
    <p className="text-sm text-dim">
      Two ways to play: <b className="font-medium text-ink">Classic</b> is the usual alternating
      turns. <b className="font-medium text-ink">Fourk</b> is simultaneous: both players pick a
      column in secret, then the discs drop together.
    </p>
    <p className="text-sm text-dim">
      The whole thing is open source:{" "}
      <a
        href="https://github.com/carlssonk/fourk"
        target="_blank"
        rel="noreferrer"
        className="underline hover:text-ink"
      >
        github.com/carlssonk/fourk
      </a>
    </p>
  </Dialog>
);
