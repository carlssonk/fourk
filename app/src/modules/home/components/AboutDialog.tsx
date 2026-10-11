import { Dialog } from "@shared/components/Dialog";

/** What this site is, for the player who wants to know what's under it. */
export const AboutDialog = ({ onDismiss }: { onDismiss: () => void }) => (
  <Dialog
    title="About fourk.io"
    onDismiss={onDismiss}
    width="max-w-130"
    className="space-y-3 text-left"
  >
    <p className="text-sm text-dim">
      <b>fourk.io</b> is free online Connect Four. Invite a friend, connect four discs, and play
      again. No account needed.
    </p>
    <p className="text-sm text-dim">
      You can also play for stakes. Create an account and choose an amount when setting up a game.
      (The beta runs on Kaspa's testnet, so any stakes are test money).
    </p>
    <p className="text-sm text-dim">
      The game runs on{" "}
      <a
        href="https://kaspa.org"
        target="_blank"
        rel="noreferrer"
        className="font-medium text-ink underline"
      >
        Kaspa
      </a>
      . Every match is a small contract on the chain and every move is a transaction, which means
      the chain itself enforces the rules: whose turn it is, where a disc can land, and who wins.
    </p>
    <p className="text-sm text-dim">
      There's no server behind it. The site is just static files, your key is generated and stored
      in your browser, and both players' browsers talk directly to the Kaspa network. To start a
      game you send someone an invite link.
    </p>
    <p className="text-sm text-dim">
      The code is open source at{" "}
      <a
        href="https://github.com/carlssonk/fourk"
        target="_blank"
        rel="noreferrer"
        className="underline hover:text-ink"
      >
        github.com/carlssonk/fourk
      </a>
      .
    </p>
    <p className="ml-auto w-fit text-xs text-dim">
      Version: <span className="font-mono">{__COMMIT_HASH__}</span>
    </p>
  </Dialog>
);
