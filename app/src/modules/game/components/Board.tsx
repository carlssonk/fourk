import { COLS, ROWS, cellIndex, heightOf, type State } from "@shared/lib/game";

interface Props {
  state: State;
  interactive: boolean;
  winningCells?: Set<number>;
  onDrop: (col: number) => void;
  /** The creator's disc colour — pure paint over on-chain discs 1/2. */
  p1Color?: "red" | "blue";
}

export const Board = ({ state, interactive, winningCells, onDrop, p1Color = "red" }: Props) => {
  const DISC_COLOR =
    p1Color === "blue" ? ["bg-bg", "bg-blue", "bg-red"] : ["bg-bg", "bg-red", "bg-blue"];
  const rows = [];
  for (let r = ROWS - 1; r >= 0; r--) {
    const cells = [];
    for (let c = 0; c < COLS; c++) {
      const idx = cellIndex(c, r);
      const v = state.board[idx]!;
      cells.push(
        <div
          key={c}
          className={`m-[3px] h-[52px] w-[52px] rounded-full ${DISC_COLOR[v]}${winningCells?.has(idx) ? " shadow-[inset_0_0_0_3px_#fff]" : ""}`}
        />,
      );
    }
    rows.push(
      <div key={r} className="flex">
        {cells}
      </div>,
    );
  }

  return (
    <div className="mb-3 inline-block rounded-xl bg-frame p-2.5">
      {interactive && (
        <div className="flex">
          {[...Array(COLS).keys()].map((c) => {
            const colFull = heightOf(state.board, c) >= ROWS;
            return (
              <button
                key={c}
                disabled={colFull}
                className="m-[3px] h-[30px] w-[52px] cursor-pointer rounded-md border border-dashed border-ink/30 text-ink/60 hover:bg-white/25 disabled:cursor-default disabled:opacity-25 disabled:hover:bg-transparent"
                onClick={() => onDrop(c)}
                title={colFull ? "column full" : `drop in column ${c}`}
              >
                ▼
              </button>
            );
          })}
        </div>
      )}
      {rows}
    </div>
  );
};
