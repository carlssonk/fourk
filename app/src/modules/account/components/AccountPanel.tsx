import { useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { Dialog } from "@shared/components/Dialog";
import * as cov from "@shared/lib/covenant";
import { friendlyCatch } from "@shared/lib/errors";
import { generatePhrase, parsePhrase } from "@shared/lib/mnemonic";
import { fmtKas, parseKas } from "@shared/lib/match";
import {
  FEE_MARGIN,
  accountPanelAtom,
  activeAccount,
  adoptAccount,
  balanceAtom,
  forgetAccount,
  phraseWallet,
  getRpc,
  hasOwnedAccount,
  listAccounts,
  ownedWallet,
  matchesAtom,
  refreshBalance,
  unfinishedGamesOn,
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
  // dismiss one, and here it would skip past the words silently. Going BACK
  // is different: nothing exists until Done, so the Back row below stays —
  // a curious visitor needs a visible way out, not a trap.
  const dismissable = view !== "new-phrase";
  // The phrase screens (shown on new-phrase/backup, typed on sign-in) get
  // the privacy backdrop.
  const shroud = view === "new-phrase" || view === "backup" || view === "sign-in";
  return (
    <Dialog
      title={TITLES[view]}
      className="text-left"
      shroud={shroud}
      {...(!isRoot(view) && { onBack: () => setView(rootView()) })}
      {...(dismissable && { onDismiss: () => setView(null) })}
    >
      <PanelBody view={view} setView={setView} />
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
  remove: "Remove from this device",
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
    case "remove":
      return <Remove setView={setView} />;
  }
};

/** What a guest sees: no balance, no addresses — just what an account buys
 * you and the two ways to get one. */
const GetStarted = ({ setView }: { setView: (v: AccountView) => void }) => (
  <>
    <p className="mb-4 text-sm text-dim">
      An account is only needed to play for stakes: it's what holds your funds, and it comes with a
      recovery phrase so you can get back to it from any device.
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
    try {
      adoptAccount(phrase); // reloads the page
    } catch (e) {
      setNote(friendlyCatch(e));
      setBusy(false);
    }
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

/** One line of the overview's management list: navigation dressed as
 * navigation — left-aligned, quiet, a chevron promising another screen —
 * so the two money buttons above stay the only things shaped like
 * actions. */
const NavRow = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex w-full cursor-pointer items-center justify-between py-2.5 text-sm text-dim transition-colors hover:text-ink"
  >
    {label}
    <span aria-hidden className="text-dim/60">
      ›
    </span>
  </button>
);

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
      {/* The screen's two verbs, side by side; everything below is just
       * somewhere to go. */}
      <div className="mb-2 flex gap-2">
        <button className="btn flex-1" onClick={() => setView("add-funds")}>
          Add funds
        </button>
        <button className="btn btn-ghost flex-1" onClick={() => setView("cash-out")}>
          Cash out
        </button>
      </div>
      <div className="divide-y divide-white/8">
        <NavRow label="Back up account" onClick={() => setView("backup")} />
        <NavRow label="Use a different account" onClick={() => setView("sign-in")} />
        <NavRow label="Remove from this device" onClick={() => setView("remove")} />
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
      setError(friendlyCatch(e));
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

const shortAddress = (a: string) => `${a.slice(0, 14)}…${a.slice(-6)}`;

const SignIn = () => {
  const [input, setInput] = useState("");
  const [note, setNote] = useState<string | null>(null);

  // Switching is a pointer change: every account stays saved on this
  // device, funds stay where they are, and games seated by any of them
  // stay playable — so nothing here needs a warning or a confirmation.
  const accounts = listAccounts();
  const others = accounts.filter((a) => !a.active);

  const switchTo = (phrase: string) => {
    setNote(null);
    try {
      // adoptAccount reloads the page; false = already the active one.
      if (!adoptAccount(phrase)) setNote("You're already using that account.");
    } catch (e) {
      setNote(friendlyCatch(e));
    }
  };

  const submit = () => {
    setNote(null);
    let phrase: string;
    try {
      phrase = parsePhrase(input);
    } catch (e) {
      setNote(friendlyCatch(e));
      return;
    }
    switchTo(phrase);
  };

  return (
    <>
      {others.length > 0 && (
        <>
          <p className="mb-2 text-sm text-dim">Accounts saved on this device — pick one:</p>
          <div className="mb-4 flex flex-col items-stretch gap-1.5">
            {others.map((a) => (
              <button
                key={a.address}
                className="btn btn-ghost font-mono text-sm"
                title={a.address}
                onClick={() => switchTo(a.phrase)}
              >
                {shortAddress(a.address)}
              </button>
            ))}
          </div>
        </>
      )}
      <p className="mb-3 text-sm text-dim">
        {others.length > 0 ? "Or paste" : "Paste"} the recovery phrase (12 or 24 words) of the
        account you want to use.
        {accounts.length > 0 &&
          " The account you're using now stays saved here — switch back any time."}
      </p>
      <textarea
        className="input mb-2 h-20 resize-none"
        placeholder="recovery phrase…"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      {note && <p className="mb-2 text-sm text-red">{note}</p>}
      <button className="btn" disabled={!input.trim()} onClick={submit}>
        Sign in
      </button>
    </>
  );
};

/** The panel's one destructive act: this device forgets the active
 * account's phrase. The account still exists wherever the phrase does, so
 * the gate is holding another copy — a checkbox, with Back up alongside for
 * anyone who skipped it — rather than a retype ceremony. */
const Remove = ({ setView }: { setView: (v: AccountView) => void }) => {
  const matches = useAtomValue(matchesAtom);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const account = activeAccount();
  if (!account) return null; // guests have nothing to remove
  // Forgetting the key mid-game turns that seat into a spectator view while
  // its move timer keeps running — worth its own warning, not a surprise.
  const open = unfinishedGamesOn(matches, phraseWallet(account.phrase).myPk).length;

  const remove = () => {
    setNote(null);
    setBusy(true);
    try {
      forgetAccount(account.phrase); // reloads the page
    } catch (e) {
      setNote(friendlyCatch(e));
      setBusy(false);
    }
  };

  return (
    <>
      <p className="mb-3 text-sm text-dim">
        This device will forget the recovery phrase of{" "}
        <span className="font-mono text-ink">{shortAddress(account.address)}</span>. The account
        itself isn't deleted — signing in with the phrase brings it back, balance and all — but
        nobody can restore a lost phrase. If your only copy is on this device, the balance is gone
        with it.
      </p>
      {open > 0 && (
        <p className="mb-3 text-sm text-red">
          This account is still seated in{" "}
          {open === 1 ? "an unfinished game" : `${open} unfinished games`} — after removal this
          device can't play {open === 1 ? "it" : "them"} out, and the move timers keep running.
        </p>
      )}
      <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        My recovery phrase is saved somewhere else
      </label>
      {note && <p className="mb-2 text-sm text-red">{note}</p>}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-danger" disabled={!confirmed || busy} onClick={remove}>
          {busy ? "Removing…" : "Remove"}
        </button>
        <button className="btn btn-ghost" onClick={() => setView("backup")}>
          Back up first
        </button>
      </div>
    </>
  );
};

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
