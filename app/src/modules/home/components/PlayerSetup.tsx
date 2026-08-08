import { useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Avatar } from "@shared/components/Avatar";
import { KaspaStamp } from "@shared/components/KaspaStamp";
import {
  GENE_KEYS,
  GENE_LABELS,
  codeToGenes,
  genesToCode,
  randomGenes,
  type Genes,
} from "@shared/lib/avatar";
import { MAX_NAME_LEN } from "@shared/lib/match";
import { discColorAtom, profileAtom, saveDiscColor, saveProfile } from "@shared/state";

interface Props {
  actionLabel: string;
  busy: boolean;
  onSubmit: () => void;
  /** Placeholder headline action (e.g. matchmaking): rendered first with
   * primary styling but disabled, demoting the submit button to a ghost. */
  headlineLabel?: string;
  /** What kind of game to start (mode, clock, stake), rendered inside the
   * card below the identity section — create flow only; the join flow
   * inherits every setting from the invite. */
  settings?: React.ReactNode;
  /** Offer the disc-colour choice. Hosts pick; joiners always take the
   * other colour, so showing them a picker would promise a choice the
   * invite has already made. */
  pickDiscColor?: boolean;
}

type GeneKey = (typeof GENE_KEYS)[number];

/** Seven candidates: with the reroll cell they fill the 8-column grid. */
const rollBatch = (): Genes[] => Array.from({ length: 7 }, randomGenes);

/**
 * The pre-game seat setup, shared by both players: Player 1 sees it on the
 * home screen before creating a game, Player 2 when opening an invite link.
 * Picks the username, the procedural avatar (slot-machine style: spin a
 * single gene of the held avatar, or spin the candidate batch and adopt
 * one), and the disc colour — all of it about the player rather than the
 * match, saved as the local profile on submit and carried to the opponent
 * by link or join payload.
 */
export const PlayerSetup = ({
  actionLabel,
  busy,
  onSubmit,
  headlineLabel,
  settings,
  pickDiscColor = false,
}: Props) => {
  const profile = useAtomValue(profileAtom);
  const discColor = useAtomValue(discColorAtom);
  const [name, setName] = useState(profile.name);
  const [genes, setGenes] = useState<Genes>(() => codeToGenes(profile.avatar));
  const [batch, setBatch] = useState<Genes[]>(rollBatch);
  /** Submit was pressed without a username: highlight the input until typed. */
  const [nudged, setNudged] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const code = genesToCode(genes);
  const noName = !name.trim();

  const rerollGene = (k: GeneKey) => {
    setGenes({ ...genes, [k]: randomGenes()[k] });
  };

  const rerollBatch = () => {
    setBatch(rollBatch());
  };

  const adopt = (g: Genes) => {
    setGenes(g);
  };

  return (
    <div className="relative mx-auto my-5 w-fit max-w-full">
      <div className="card w-115 max-w-full p-4 text-left">
        <div className="flex flex-wrap items-stretch gap-4">
          <div className="rounded-xl bg-field p-2">
            <Avatar code={code} size={88} />
          </div>
          <div className="flex min-w-56 flex-1 flex-col justify-between gap-2">
            {/* wrapper keeps the input out of the flex column: .input's
             * flex-1 would otherwise stretch it vertically */}
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                id="username"
                className={`input ${nudged && noName ? "border-red" : ""}`}
                maxLength={MAX_NAME_LEN}
                value={name}
                placeholder="Username"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                data-form-type="other"
                onChange={(e) => setName(e.target.value)}
              />
              {/* Your colour, beside your name: identity, not a match
               * setting — the opponent always takes the other one. */}
              {pickDiscColor && (
                <>
                  <div className="flex shrink-0 gap-1">
                    {(["blue", "red"] as const).map((c) => (
                      <button
                        key={c}
                        type="button"
                        title={`your discs are ${c}`}
                        aria-label={`play as ${c}`}
                        aria-pressed={discColor === c}
                        onClick={() => saveDiscColor(c)}
                        className={`size-6 cursor-pointer rounded-full border-2 ${
                          c === "red" ? "bg-red" : "bg-blue"
                        } ${discColor === c ? "border-ink" : "border-transparent opacity-40"}`}
                      >
                        <KaspaStamp />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {GENE_KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  title={`reroll ${GENE_LABELS[k].toLowerCase()} only`}
                  onClick={() => rerollGene(k)}
                  className="cursor-pointer rounded-md border border-line px-2 py-1 text-xs text-dim hover:border-accent hover:text-ink"
                >
                  ↻ {GENE_LABELS[k]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-8 gap-1.5 max-sm:grid-cols-4">
          {batch.map((g, i) => (
            <button
              key={i}
              type="button"
              title="use this one"
              onClick={() => adopt(g)}
              className="cursor-pointer rounded-md border border-line bg-field p-1 hover:border-accent"
            >
              <Avatar code={genesToCode(g)} size={44} animate={false} fluid className="block" />
            </button>
          ))}
          <button
            type="button"
            title="new batch"
            onClick={rerollBatch}
            className="cursor-pointer rounded-md border border-line bg-field text-lg text-dim hover:border-accent hover:text-ink"
          >
            ↻
          </button>
        </div>
        {settings}
      </div>
      <div className="mt-4 flex flex-wrap justify-center gap-2.5">
        {headlineLabel && (
          <button type="button" disabled className="btn cursor-default px-8 py-2.5 text-lg">
            {headlineLabel}
            <span className="ml-2 rounded-sm bg-line px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase text-dim">
              soon
            </span>
          </button>
        )}
        <button
          className={`btn ${headlineLabel ? "btn-ghost" : ""} px-8 py-2.5 text-lg`}
          disabled={busy}
          onClick={() => {
            if (noName) {
              setNudged(true);
              inputRef.current?.focus();
              return;
            }
            saveProfile({ name, avatar: code });
            onSubmit();
          }}
        >
          {actionLabel}
        </button>
      </div>
      {noName && (
        <p className={`mt-1.5 text-center text-xs ${nudged ? "text-red" : "text-dim"}`}>
          pick a username first
        </p>
      )}
    </div>
  );
};
