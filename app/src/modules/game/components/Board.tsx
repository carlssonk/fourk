import { useRef, useState, type CSSProperties } from "react";
import {
  COLS,
  ROWS,
  cellIndex,
  discOf,
  heightOf,
  playerToMove,
  type State,
} from "@shared/lib/game";
import { KASPA_K_PATH, KASPA_RING_PATH } from "@shared/lib/kaspaMark";

interface Props {
  state: State;
  interactive: boolean;
  winningCells?: Set<number>;
  onDrop: (col: number) => void;
  /** The creator's disc colour — pure paint over on-chain discs 1/2. */
  p1Color?: "red" | "blue";
  /** Disc value (1/2) staged "on deck" above the board — the colour that
   * falls next — "both" in fourk mode's commit phase (both players are
   * picking) — or null to leave the slot empty (game over, lobby…). */
  nextDisc?: 1 | 2 | "both" | null;
  /** With nextDisc "both": which disc lands underneath on a same-column
   * collision this round — drawn in front of the pair. */
  priorityDisc?: 1 | 2;
  /** Hover-ghost disc value; defaults to whoever is to move (classic). Fourk
   * mode passes the local player's own disc — picks aren't turn-based. */
  ghostDisc?: 1 | 2;
  /** Fourk mode: the column of my sealed pick this round — held as a
   * persistent ghost at its landing slot until the round resolves. */
  myPick?: number | null;
}

/** Gap between holes in px, folded into each cell's pitch (--pitch below)
 * so the cell faceplates tile the board seamlessly. Wide relative to the
 * holes on purpose: more board face between them reads less toylike. */
const GAP = 10;

/** Gravity in rows/s², not px/s²: perceived pace is rows-per-second, so
 * anchoring it to the pitch makes a drop feel the same on phone and desktop
 * cells alike. The backdrop's 4000 px/s² over 15px cells works out to ~267
 * rows/s²; the live board's discs are big and near, so they fall at a
 * deliberately weightier pace — visibly kin, not frantic. Tuned by eye. */
const GRAVITY_ROWS = 80;

/** Restitution variants, deadest to liveliest (the backdrop's values): a
 * disc hitting the board floor gets the liveliest bounce, one notch deader
 * per disc already beneath it. */
const BOUNCE_E = [0.12, 0.18, 0.24, 0.3] as const;

/** Exact quadratic ease-in/out — degree-elevated Béziers of y = x², so each
 * animation segment is the true gravity parabola rather than a lookalike. */
const QUAD_IN = "cubic-bezier(0.33, 0, 0.67, 0.33)";
const QUAD_OUT = "cubic-bezier(0.33, 0.67, 0.67, 1)";

/** The Kaspa mark stamped into the coin face: the uneven roundel as an
 * inner border ring hugging the rim, the K in its logo position inside it.
 * The viewBox squares up around the roundel's centre (~98.3, 98.3), sized
 * so the ring spans ~92% of the face. */
const KaspaStamp = () => (
  <svg viewBox="36.3 36.3 124 124" aria-hidden className="size-full">
    <path d={KASPA_RING_PATH} fill="none" stroke="rgba(0, 0, 0, 0.2)" strokeWidth="4" />
    <path d={KASPA_K_PATH} fill="rgba(0, 0, 0, 0.2)" />
  </svg>
);

/** Drop a freshly landed disc in from just above the frame's top edge with
 * the backdrop's kinematics: free fall over `fell` rows, then one rebound at
 * e·v — deader the taller the stack beneath (`row` discs), with a little
 * scatter so same-height landings don't look cloned. `delayMs` staggers the
 * second disc of a fourk-mode double drop (it hides at -drop until then). */
function dropIn(el: HTMLElement, fell: number, row: number, delayMs = 0) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // The pitch is the cell wrapper's height (gap included) — the hole and
  // the disc in it are deliberately smaller than the cell.
  const cell = el.closest<HTMLElement>("[data-cell]");
  const drop = (cell ? cell.offsetHeight : el.offsetHeight + GAP) * fell;
  const t1 = Math.sqrt((2 * fell) / GRAVITY_ROWS);
  const cap = Math.max(0, BOUNCE_E.length - 1 - row);
  const e = BOUNCE_E[Math.max(0, cap - (Math.random() < 0.3 ? 1 : 0))]!;
  el.animate(
    [
      { offset: 0, transform: `translateY(${-drop}px)`, easing: QUAD_IN },
      { offset: 1 / (1 + 2 * e), transform: "translateY(0)", easing: QUAD_OUT },
      {
        offset: (1 + e) / (1 + 2 * e),
        transform: `translateY(${-e * e * drop}px)`,
        easing: QUAD_IN,
      },
      { transform: "translateY(0)" },
    ],
    { duration: t1 * (1 + 2 * e) * 1000, delay: delayMs, fill: "backwards" },
  );
}

/** The cells fresh discs just landed in — one per classic move, up to two
 * per fourk-mode resolution. A resync that jumps further (or replaces the
 * match) changes more than that — then there's nothing sensible to animate.
 * Ordered lower-row-first so a same-column pair animates as a stack. */
function landedCells(prev: Uint8Array, next: Uint8Array): number[] {
  const landed: number[] = [];
  for (let i = 0; i < next.length; i++) {
    if (prev[i] === next[i]) continue;
    if (prev[i] !== 0 || landed.length >= 2) return [];
    landed.push(i);
  }
  return landed.sort((a, b) => (a % ROWS) - (b % ROWS));
}

export const Board = ({
  state,
  interactive,
  winningCells,
  onDrop,
  p1Color = "red",
  nextDisc = null,
  priorityDisc,
  ghostDisc,
  myPick = null,
}: Props) => {
  const DISC = p1Color === "blue" ? ["", "disc-blue", "disc-red"] : ["", "disc-red", "disc-blue"];

  // Diff each new board against the last one seen, so the fresh discs drop
  // in — for both seats: our own moves and the opponent's arrive here the
  // same way, as a new board. State adjusted during render keeps the diff
  // to exactly once per move.
  const [seen, setSeen] = useState<{ board: Uint8Array; landed: number[] }>({
    board: state.board,
    landed: [],
  });
  if (seen.board !== state.board)
    setSeen({ board: state.board, landed: landedCells(seen.board, state.board) });

  // Cells already animated for this board — ref callbacks re-fire on every
  // render (and the clock re-renders every second), so gate each drop to
  // once per new board.
  const animated = useRef<{ board: Uint8Array; done: Set<number> }>({
    board: state.board,
    done: new Set(),
  });

  const ghost = interactive ? DISC[ghostDisc ?? discOf(playerToMove(state))] : "";
  // The sealed pick keeps its colour even while the board isn't interactive
  // (i.e. the whole waiting-for-opponent stretch).
  const pickGhost = DISC[ghostDisc ?? discOf(playerToMove(state))];

  const columns = [...Array(COLS).keys()].map((c) => {
    const colHeight = heightOf(state.board, c);
    const canDrop = interactive && colHeight < ROWS;
    const cells = [];
    for (let r = ROWS - 1; r >= 0; r--) {
      const idx = cellIndex(c, r);
      const v = state.board[idx]!;
      // Rows travelled falling in from just above the frame's top edge.
      const fell = ROWS - r;
      const landedAt = seen.landed.indexOf(idx);
      cells.push(
        <div
          key={r}
          data-cell
          className="cell-face flex size-(--pitch) items-center justify-center"
        >
          <div className="hole size-[calc(var(--cell)*0.88)]">
            {v !== 0 ? (
              <div
                className={`size-full rounded-full ${DISC[v]}${winningCells?.has(idx) ? " disc-win" : ""}`}
                ref={
                  landedAt !== -1
                    ? (el) => {
                        if (animated.current.board !== state.board)
                          animated.current = { board: state.board, done: new Set() };
                        if (el && !animated.current.done.has(idx)) {
                          animated.current.done.add(idx);
                          // The second disc of a double drop waits a beat —
                          // in one column they stack, across two they still
                          // read as one resolution, not one move.
                          dropIn(el, fell, r, landedAt === 0 ? 0 : 220);
                        }
                      }
                    : undefined
                }
              >
                <KaspaStamp />
              </div>
            ) : myPick === c && r === colHeight ? (
              // The sealed pick: held above its landing slot until the round
              // resolves (or the pick becomes visible to the opponent).
              <div className={`size-full animate-pulse rounded-full opacity-55 ${pickGhost}`}>
                <KaspaStamp />
              </div>
            ) : canDrop && r === colHeight ? (
              // Where the disc will land: a ghost of it appears while the
              // column is hovered.
              <div
                className={`size-full rounded-full opacity-0 transition-opacity group-hover:opacity-60 ${ghost}`}
              >
                <KaspaStamp />
              </div>
            ) : null}
          </div>
        </div>,
      );
    }
    return (
      <button
        key={c}
        disabled={!canDrop}
        onClick={() => onDrop(c)}
        aria-label={canDrop ? `drop a disc in column ${c + 1}` : `column ${c + 1}`}
        className="group flex cursor-pointer flex-col disabled:cursor-default"
      >
        {cells}
      </button>
    );
  });

  // Fill most of what the viewport allows — width-bound on phones, height-
  // bound on desktops, backed off to 90% so the board breathes. The reserves
  // cover the app shell's padding plus the Game screen's top bar, button
  // row, the on-deck slot and the frame's own padding/gaps.
  const cell = "max(2rem, calc(min((100dvw - 6rem) / 7, (100dvh - 17rem) / 6) * 0.9))";

  return (
    <div
      className="flex flex-col items-center"
      style={{ "--cell": cell, "--pitch": `calc(var(--cell) + ${GAP}px)` } as CSSProperties}
    >
      {/* On deck: the colour that falls next, waiting above the board. The
       * slot keeps its height when empty so the board never jumps. */}
      <div
        aria-hidden
        className="mb-2 flex h-[calc(var(--cell)*0.5)] items-center justify-center gap-2"
      >
        {nextDisc === "both" ? (
          // Fourk mode: both colours are in play at once. The round's
          // collision-priority disc sits in front — it lands underneath if
          // both players pick the same column.
          (() => {
            const first = priorityDisc ?? 1;
            const second = first === 1 ? 2 : 1;
            return (
              <div
                className="flex items-center"
                title="If both players pick the same column, the front disc lands underneath — priority alternates every round."
              >
                <div className={`z-10 size-[calc(var(--cell)*0.5)] rounded-full ${DISC[first]}`}>
                  <KaspaStamp />
                </div>
                <div
                  className={`-ml-3 size-[calc(var(--cell)*0.5)] rounded-full opacity-70 ${DISC[second]}`}
                >
                  <KaspaStamp />
                </div>
              </div>
            );
          })()
        ) : (
          nextDisc !== null && (
            <div className={`size-[calc(var(--cell)*0.5)] rounded-full ${DISC[nextDisc]}`}>
              <KaspaStamp />
            </div>
          )
        )}
      </div>
      {/* p-1.75 + the half-gap inside each cell's pitch keeps the old 12px
       * breathing room between the outer holes and the frame edge. */}
      <div className="board-frame inline-block p-1.75">
        <div className="flex">{columns}</div>
      </div>
    </div>
  );
};
