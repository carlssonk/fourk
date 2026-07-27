import { useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Avatar } from "@shared/components/Avatar";
import {
  GENE_KEYS,
  GENE_LABELS,
  codeToGenes,
  genesToCode,
  randomGenes,
  type Genes,
} from "@shared/lib/avatar";
import { MAX_NAME_LEN } from "@shared/lib/match";
import { profileAtom, saveProfile } from "@shared/state";

interface Props {
  actionLabel: string;
  busy: boolean;
  onSubmit: () => void;
  /** Placeholder headline action (e.g. matchmaking): rendered first with
   * primary styling but disabled, demoting the submit button to a ghost. */
  headlineLabel?: string;
  /** Per-match settings (colour, timers), rendered as a sibling card beside
   * the identity card; the action button sits centered below both. */
  children?: React.ReactNode;
  /** Mode/opponent pickers, rendered inside the main card under the avatar
   * section (create flow only). */
  modes?: React.ReactNode;
}

type GeneKey = (typeof GENE_KEYS)[number];

/** Seven candidates: with the reroll cell they fill the 8-column grid. */
const rollBatch = (): Genes[] => Array.from({ length: 7 }, randomGenes);

/**
 * The pre-game seat setup, shared by both players: Player 1 sees it on the
 * home screen before creating a game, Player 2 when opening an invite link.
 * Picks the username and the procedural avatar, slot-machine style: spin a
 * single gene of the held avatar, or spin the candidate batch and adopt one;
 * saved as the local profile on submit, then carried to the opponent by link
 * or join payload.
 */
export const PlayerSetup = ({
  actionLabel,
  busy,
  onSubmit,
  headlineLabel,
  children,
  modes,
}: Props) => {
  const profile = useAtomValue(profileAtom);
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
            <div>
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
        {modes}
      </div>
      {/* Match settings hang off the identity card's right edge on wide
       * screens (mirroring the open-matches list on the left), keeping the
       * identity card on the page's center axis; stacked below otherwise. */}
      {children && (
        <div className="card mx-auto mt-3 w-full max-w-115 p-4 text-left xl:absolute xl:top-0 xl:left-full xl:mt-0 xl:ml-6 xl:w-56">
          {children}
        </div>
      )}
      <div className="mt-4 flex flex-wrap justify-center gap-2.5">
        {headlineLabel && (
          <button type="button" disabled className="btn cursor-default px-8 py-2.5 text-lg">
            {headlineLabel}
            <span className="ml-2 rounded-sm bg-field/30 px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase">
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
