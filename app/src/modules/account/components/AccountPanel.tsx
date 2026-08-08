import { useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { Dialog } from "@shared/components/Dialog";
import * as cov from "@shared/lib/covenant";
import { friendlyError } from "@shared/lib/errors";
import { generatePhrase, parsePhrase } from "@shared/lib/mnemonic";
import { fmtKas, parseKas } from "@shared/lib/match";
import {
  FEE_MARGIN,
  accountPanelAtom,
  activeAccount,
  askConfirm,
  balanceAtom,
  getRpc,
  hasOwnedAccount,
  ownedWallet,
  matchesAtom,
  refreshBalance,
  unfinishedGamesOn,
  switchAccount,
  type AccountView,
} from "@shared/state";

/** Copy-to-clipboard with the standard 1.5s "Copied!" flip. */
const useCopy = () => {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return { copied, copy };
};

const Row = ({ value, copied, onCopy }: { value: string; copied: boolean; onCopy: () => void }) => (
  <div className="flex items-center gap-2">
    <input
      className="input font-mono text-sm"
      readOnly
      value={value}
      onFocus={(e) => e.target.select()}
    />
    <button className="btn" onClick={onCopy}>
      {copied ? "Copied!" : "Copy"}
    </button>
  </div>
);

/**
 * The player's money, in one overlay: balance, deposit address ("Add
 * funds"), withdrawals ("Cash out"), the recovery phrase ("Back up"), and
 * account switching ("Sign in"). Strictly everyday vocabulary — the chain
 * stays backstage.
 */
export const AccountPanel = () => {
  const [view, setView] = useAtom(accountPanelAtom);
  if (!view) return null;
  // The freshly-minted phrase is the one screen that must actually be read,
  // so it has exactly one way onward — its own acknowledgement. That has to
  // include the backdrop: clicking beside a dialog is the reflex way to
  // dismiss one, and here it would skip past the words silently.
  const dismissable = view !== "new-phrase";
  // The phrase screens (shown on new-phrase/backup, typed on sign-in) get
  // the privacy backdrop.
  const shroud = view === "new-phrase" || view === "backup" || view === "sign-in";
  return (
    <Dialog
      title={TITLES[view]}
      className="text-left"
      shroud={shroud}
      {...(dismissable && { onDismiss: () => setView(null) })}
    >
      <PanelBody view={view} setView={setView} />
      {/* Its own row: the screens above end in their own action, and a
       * "Back" tucked alongside one reads as part of it. */}
      {dismissable && !isRoot(view) && (
        <div className="mt-4">
          <button className="btn btn-muted" onClick={() => setView(rootView())}>
            Back
          </button>
        </div>
      )}
    </Dialog>
  );
};

/** The header band says where you are, so each screen no longer carries its
 * own heading. */
const TITLES: Record<AccountView, string> = {
  "get-started": "Your account",
  "new-phrase": "Save your recovery phrase",
  overview: "Your account",
  "add-funds": "Add funds",
  "cash-out": "Cash out",
  backup: "Back up your account",
  "sign-in": "Use a different account",
};

/** The panel's home screen depends on who's looking: a guest has no money
 * to manage, only an invitation to get an account. */
const rootView = (): AccountView => (hasOwnedAccount() ? "overview" : "get-started");
const isRoot = (v: AccountView) => v === rootView();

const PanelBody = ({
  view,
  setView,
}: {
  view: AccountView;
  setView: (v: AccountView | null) => void;
}) => {
  switch (view) {
    case "get-started":
      return <GetStarted setView={setView} />;
    case "new-phrase":
      return <NewPhrase />;
    case "overview":
      return <Overview setView={setView} />;
    case "add-funds":
      return <AddFunds />;
    case "cash-out":
      return <CashOut />;
    case "backup":
      return <Backup />;
    case "sign-in":
      return <SignIn />;
  }
};

/** What a guest sees: no balance, no addresses — just what an account buys
 * you and the two ways to get one. */
const GetStarted = ({ setView }: { setView: (v: AccountView) => void }) => (
  <>
    <p className="mb-4 text-sm text-dim">
      You're all set for free games — nothing to sign up for. An account is only needed to play for
      stakes: it's what holds your funds, and it comes with a recovery phrase so you can get back to
      it from any device.
    </p>
    <div className="flex flex-col items-stretch gap-2">
      <button className="btn" onClick={() => setView("new-phrase")}>
        Create an account
      </button>
      <button className="btn btn-ghost" onClick={() => setView("sign-in")}>
        I already have one
      </button>
    </div>
  </>
);

/** The one screen that must actually be read — and the one that creates the
 * account. The phrase is generated here and lives nowhere else until the
 * player acknowledges it, so abandoning this screen by any route (the Done
 * button is the only way onward, but a refresh or a closed tab isn't ours to
 * intercept) leaves nothing half-made behind. Adopting it reloads, which is
 * what re-wires every consumer around the new account. */
const NewPhrase = () => {
  const [phrase] = useState(generatePhrase);
  const { copied, copy } = useCopy();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const done = () => {
    setNote(null);
    setBusy(true);
    switchAccount(phrase).catch((e) => {
      setNote(friendlyError(String((e as Error)?.message ?? e)));
      setBusy(false);
    });
  };

  return (
    <>
      <p className="mb-3 text-sm text-dim">
        These 12 words are the only way back into your account. Write them down and keep them
        somewhere safe — anyone who has them controls your funds, and nobody can restore them for
        you.
      </p>
      <ol className="mb-3 grid grid-cols-3 gap-1.5">
        {phrase.split(" ").map((w, i) => (
          <li key={i} className="rounded-lg border border-white/8 bg-white/5 px-2 py-1 text-sm">
            <span className="mr-1.5 text-xs text-dim">{i + 1}</span>
            {w}
          </li>
        ))}
      </ol>
      <button className="btn btn-ghost mb-3" onClick={() => copy(phrase)}>
        {copied ? "Copied!" : "Copy"}
      </button>
      <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I've written down my recovery phrase
      </label>
      {note && <p className="mb-2 text-sm text-red">{note}</p>}
      <button className="btn" disabled={!confirmed || busy} onClick={done}>
        {busy ? "Setting up…" : "Done"}
      </button>
    </>
  );
};

const Overview = ({ setView }: { setView: (v: AccountView) => void }) => {
  const balance = useAtomValue(balanceAtom);
  return (
    <>
      {/* The balance is the thing on display here, so it sits in a well of
       * its own rather than as loose text on the floor. */}
      <div className="well mb-4 px-4 py-3 text-center">
        <div className="text-xs text-dim">Your balance</div>
        <div className="font-mono text-3xl font-bold">
          {balance === null ? "…" : `${fmtKas(balance)} KAS`}
        </div>
      </div>
      <div className="flex flex-col items-stretch gap-2">
        <button className="btn" onClick={() => setView("add-funds")}>
          Add funds
        </button>
        <button className="btn btn-ghost" onClick={() => setView("cash-out")}>
          Cash out
        </button>
        <button className="btn btn-ghost" onClick={() => setView("backup")}>
          Back up account
        </button>
        <button className="btn btn-muted" onClick={() => setView("sign-in")}>
          Use a different account
        </button>
      </div>
    </>
  );
};

const AddFunds = () => {
  const { copied, copy } = useCopy();
  const address = activeAccount()?.address;
  if (!address) return null; // guests have no deposit address to show
  return (
    <>
      <p className="mb-3 text-sm text-dim">
        Send KAS to your deposit address and it lands in your balance, usually within seconds.
      </p>
      <Row value={address} copied={copied} onCopy={() => copy(address)} />
    </>
  );
};

const CashOut = () => {
  const balance = useAtomValue(balanceAtom);
  const matches = useAtomValue(matchesAtom);
  const [dest, setDest] = useState("");
  const [amount, setAmount] = useState("");
  const [maxed, setMaxed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  // While one of THIS account's games is unfinished, hold back the fee
  // margin so it can still be played out. Free games don't count — the
  // guest key pays their fees out of dispenser funds.
  const ownedPk = ownedWallet()?.myPk;
  const playing = !!ownedPk && unfinishedGamesOn(matches, ownedPk).length > 0;
  const maxOut = balance === null ? null : playing ? bigMax(balance - FEE_MARGIN, 0n) : balance;

  const submit = async () => {
    setError(null);
    setSent(null);
    setBusy(true);
    try {
      const rpc = await getRpc();
      const key = ownedWallet()?.key;
      if (!key) throw new Error("NO_ACCOUNT");
      // "Max" with no games sweeps everything (fee comes out of the sent
      // amount); otherwise the typed amount arrives exactly.
      const value = maxed && !playing ? ("all" as const) : (parseKas(amount) ?? 0n);
      if (value !== "all" && (value <= 0n || (maxOut !== null && value > maxOut)))
        throw new Error("LOW_BALANCE");
      const res = await cov.sendTo(rpc, key, dest.trim(), value);
      setSent(`Sent — ${fmtKas(res.amount)} KAS is on its way.`);
      setAmount("");
      void refreshBalance();
    } catch (e) {
      setError(friendlyError(String((e as Error)?.message ?? e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="mb-3 text-sm text-dim">
        Send some or all of your balance to any Kaspa address.
      </p>
      <input
        className="input mb-2 font-mono text-sm"
        placeholder="Kaspa address (kaspa…)"
        value={dest}
        onChange={(e) => setDest(e.target.value)}
      />
      <div className="mb-1 flex items-center gap-2">
        <input
          className="input"
          placeholder="Amount (KAS)"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setMaxed(false);
          }}
        />
        <button
          type="button"
          className="btn btn-muted px-2.5 py-1 text-sm"
          disabled={maxOut === null}
          onClick={() => {
            if (maxOut === null) return;
            setAmount(fmtKas(maxOut).replace("<", ""));
            setMaxed(true);
          }}
        >
          Max
        </button>
      </div>
      {playing && (
        <p className="mb-2 text-xs text-dim">
          We're keeping {fmtKas(FEE_MARGIN)} KAS aside so you can finish your open games.
        </p>
      )}
      {error && <p className="mb-2 text-sm text-red">{error}</p>}
      {sent && <p className="mb-2 text-sm text-ok">{sent}</p>}
      <button
        className="btn"
        disabled={busy || !dest.trim() || (!maxed && parseKas(amount) === null)}
        onClick={() => void submit()}
      >
        {busy ? "Sending…" : "Cash out"}
      </button>
    </>
  );
};

const Backup = () => {
  const [revealed, setRevealed] = useState(false);
  const { copied, copy } = useCopy();
  const account = activeAccount();
  if (!account) return null; // guests have nothing to back up
  const { phrase } = account;

  return (
    <>
      <p className="mb-3 text-sm text-dim">
        Your recovery phrase is the only way back into this account. Write these 12 words down and
        keep them safe — anyone who has them controls your balance.
      </p>
      <div className="relative">
        <ol className={`mb-2 grid grid-cols-3 gap-1.5 ${revealed ? "" : "blur-sm select-none"}`}>
          {phrase.split(" ").map((w, i) => (
            <li key={i} className="rounded-lg border border-white/8 bg-white/5 px-2 py-1 text-sm">
              <span className="mr-1.5 text-xs text-dim">{i + 1}</span>
              {w}
            </li>
          ))}
        </ol>
        {!revealed && (
          <button
            className="btn absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
            onClick={() => setRevealed(true)}
          >
            Reveal
          </button>
        )}
      </div>
      {revealed && (
        <button className="btn btn-ghost" onClick={() => copy(phrase)}>
          {copied ? "Copied!" : "Copy"}
        </button>
      )}
    </>
  );
};

const SignIn = () => {
  const matches = useAtomValue(matchesAtom);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Switching forgets the current account's key, so any game it is sitting
  // in becomes unplayable — worth a word before, not an apology after.
  const ownedPk = ownedWallet()?.myPk;
  const leaving = ownedPk ? unfinishedGamesOn(matches, ownedPk).length : 0;

  const submit = async () => {
    setNote(null);
    let phrase: string;
    try {
      phrase = parsePhrase(input);
    } catch (e) {
      setNote(friendlyError(String((e as Error)?.message ?? e)));
      return;
    }
    if (
      leaving &&
      !(await askConfirm({
        title: `You have ${leaving} unfinished game${leaving === 1 ? "" : "s"}`,
        body:
          "Switching accounts means you can't play them out, and your opponent can claim the pot " +
          "once your clock runs out.",
        confirm: "Switch anyway",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    // switchAccount reloads the page on success; false = already active.
    switchAccount(phrase)
      .then((switched) => {
        if (!switched) setNote("You're already using that account.");
      })
      .catch((e) => setNote(friendlyError(String((e as Error)?.message ?? e))))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <p className="mb-3 text-sm text-dim">
        Paste the recovery phrase (12 or 24 words) of the account you want to use. Any balance left
        on this one moves over before the switch.
      </p>
      <textarea
        className="input mb-2 h-20 resize-none"
        placeholder="recovery phrase…"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      {note && <p className="mb-2 text-sm text-red">{note}</p>}
      <button className="btn" disabled={busy || !input.trim()} onClick={() => void submit()}>
        {busy ? "Moving your balance…" : "Sign in"}
      </button>
    </>
  );
};

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
