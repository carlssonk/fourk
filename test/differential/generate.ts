/**
 * Differential vectors: the TS rulebooks (src/) against the compiled
 * covenant (contracts/build/artifact.json), door by door.
 *
 * The rulebooks and contracts/fourk.ag are two hand-kept sources of one rule
 * set. The property tests prove the TS self-consistent and the harness proves
 * the contract passes its scenarios, but neither proves the two agree. This
 * module walks seeded random games through each rulebook, attempts every door
 * from the states it visits (every signer, every timing boundary), and records
 * what the TS says about each attempt as a spend the contract must judge the
 * same way. wasm/tests/differential.rs replays the file through the app's own
 * transaction builder (fourk-wasm), so every vector also exercises the field
 * names the app derives addresses from.
 *
 * Three classes of vector, each proving one direction:
 *
 *   door    the door's own result (successor or payouts): accept iff the TS
 *           accepts. Accepted ones prove "TS accepts ⇒ contract accepts" with
 *           a byte-equal successor; rejected ones carry the would-be spend.
 *   shape   a door the TS refuses, spent anyway with the successor its shape
 *           builder (guards skipped) or its payout pattern implies: reject.
 *   mutant  an accepted door with one successor field changed, or a pinned
 *           payout sent to the wrong player: reject. Doors are deterministic,
 *           so any other successor is one the TS refuses; together with the
 *           door vectors this is "contract accepts ⇒ TS accepts" over every
 *           field the contract binds.
 *
 * Fees are outside the parity claim (the TS has no fee model): every terminal
 * spend pays a fixed FEE out of the pot, well under the contract's ceiling.
 *
 * Output is deterministic (own PRNG, fixed seed), so the committed file can be
 * regenerated and compared byte for byte.
 */

import * as classic from "../../src/rules.js";
import type { LineWitness, Payout } from "../../src/rules.js";
import {
  CELLS,
  COLS,
  DEADLINE_LIMIT,
  MAX_MOVE_TIMEOUT_DAA,
  ROWS,
  ZERO_PK,
  cellIndex,
  heightOf,
  isOpen,
  playerToMove,
  type State as ClassicState,
} from "../../src/state.js";
import * as simul from "../../src/simul/rules.js";
import {
  ZERO_HASH,
  isBoardFull,
  isSimulOpen,
  roundPhase,
  type SimulState,
} from "../../src/simul/state.js";
import { commitmentOf } from "../../src/simul/hash.js";
import * as v2 from "../../src/simul-v2/rules.js";

// --- Fixed world ---------------------------------------------------------------

/** x-only pubkeys of the secrets [1;32], [2;32], [3;32]: p1, p2, a stranger.
 * The replay signs with those secrets and pins these values. */
export const KEYS = [
  "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
  "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766",
  "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
] as const;
const [P1, , STRANGER] = KEYS;

const STAKE = 100_000_000n;
/** Paid out of the pot by every terminal spend. */
export const FEE = 10_000n;
/** The picking window / move clock every generated match uses. */
const T = 1200;
/** fourk2's reveal grace (600 <= R <= T). */
const R = 600;
const DEADLINE = 1_000_000;
/** u64::MAX: the score the node reports for an unaccepted output. */
const UNACCEPTED = "18446744073709551615";

// --- Vector file ---------------------------------------------------------------

export type Fields = Record<string, string | number>;
export type Arg = { sig: number } | { bytes: string } | { int: number };

/** One covenant UTXO: which actor holds it, its state fields, its value. */
export interface Utxo {
  actor: string;
  state: Fields;
  value: string;
}

export interface Vector {
  /** door | shape | mutant (see the module header). */
  class: "door" | "shape" | "mutant";
  /** The mutated field, on mutants. */
  field?: string;
  /** Index into `states` of the spent covenant UTXO. */
  input: number;
  entry: string;
  args: Arg[];
  lockTime: number;
  sequence: number;
  /** The spent UTXO's acceptance DAA score (u64, decimal). */
  daaScore: string;
  /** Key index paying a wallet funding input (continuations), or null. */
  funding: number | null;
  /** Index into `states` of the successor covenant output, or null. */
  next: number | null;
  /** Plain outputs, in order: pay `value` to the key `key`. */
  payouts: Array<{ key: string; value: string }>;
  accept: boolean;
}

export interface VectorFile {
  keys: readonly string[];
  fee: string;
  states: Utxo[];
  vectors: Vector[];
}

// --- Deterministic randomness ------------------------------------------------------

/** xorshift32: fixed output for a fixed seed, independent of any library. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  const next = () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
  return {
    int: (n: number) => next() % n,
    pick: <T>(xs: readonly T[]): T => xs[next() % xs.length]!,
    salt: () => {
      const s = new Uint8Array(32);
      for (let i = 0; i < 32; i++) s[i] = next() & 0xff;
      return s;
    },
  };
}
type Rng = ReturnType<typeof rng>;

// --- Collection -------------------------------------------------------------------

/** Thrown by a shape builder that has no successor to pose. */
const NO_SHAPE = "no shape";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The three clocks a door may read: the spend's lock time, its input's
 * sequence (UTXO age), and the input's acceptance score. */
interface Timing {
  lockTime: number;
  sequence: number;
  daa: number;
}

/** One attempted spend, before it is judged: the door call and its encoding. */
interface Attempt {
  entry: string;
  args: Arg[];
  lockTime?: number;
  sequence?: number;
  daaScore?: string;
  funding?: number | null;
  /** The TS door at the given clocks: a successor, payouts, or a throw. */
  run: (t: Timing) => unknown;
  /** Successors to propose when the door refuses (shape builders). */
  shapes?: () => unknown[];
  /** Whether the contract pins this door's payouts (else the signer directs
   * them freely, and only a pay-the-signer shape is meaningful). */
  pinned: boolean;
  /** The signer's key index, for the free-payout shape. */
  signer?: number;
}

/** A rule set as the vectors see it: actor, artifact fields, UTXO value. */
interface Mode<S> {
  utxo(s: S): Utxo;
  pot(s: S): bigint;
  /** The two players' keys (p2 may be ZERO_PK in a lobby). */
  players(s: S): [string, string];
  /** A coarse label of the state's situation, so sampling keeps every kind. */
  phase(s: S): string;
}

class Collector {
  readonly states: Utxo[] = [];
  private readonly index = new Map<string, number>();
  /** Bucketed candidates; capped and sampled in `finish`. */
  private readonly buckets = new Map<string, Vector[]>();
  /** Per-actor rotation through mutable fields. */
  private readonly rotation = new Map<string, number>();

  constructor(private readonly r: Rng) {}

  private stateRef(u: Utxo): number {
    const key = JSON.stringify(u);
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.states.length;
      this.states.push(u);
      this.index.set(key, i);
    }
    return i;
  }

  private add(
    actor: string,
    role: string,
    v: Omit<Vector, "input" | "next"> & { input: Utxo; next: Utxo | null },
  ) {
    const key = [actor, v.entry, v.class, v.field ?? "", v.accept, role].join("|");
    const list = this.buckets.get(key) ?? [];
    // Refs are taken now; unused states are pruned in finish().
    list.push({ ...v, input: this.stateRef(v.input), next: v.next && this.stateRef(v.next) });
    this.buckets.set(key, list);
  }

  /** Judge `a` on `s` with the TS and record the resulting vectors. */
  attempt<S>(mode: Mode<S>, s: S, a: Attempt) {
    const input = mode.utxo(s);
    const base = {
      entry: a.entry,
      args: a.args,
      lockTime: a.lockTime ?? 0,
      sequence: a.sequence ?? 0,
      daaScore: a.daaScore ?? "0",
      funding: a.funding ?? null,
      input,
    };
    const t: Timing = {
      lockTime: base.lockTime,
      sequence: base.sequence,
      daa: Number(base.daaScore),
    };
    const { ok, result, reason } = judge(a, t);
    // An edge: one clock moved by one flips the verdict. Edges are the
    // vectors an off-by-one in either source shows up on, so sampling keeps
    // them in their own buckets.
    const edge = neighbours(t, base.daaScore !== UNACCEPTED).some((n) => judge(a, n).ok !== ok);
    const role = [
      a.signer === undefined ? "anyone" : a.signer,
      mode.phase(s),
      edge ? "edge" : "",
      reason,
    ].join("@");
    if (ok && Array.isArray(result)) {
      const payouts = payoutOutputs(result as Payout[], mode.pot(s));
      this.add(input.actor, role, { ...base, class: "door", accept: true, next: null, payouts });
      if (a.pinned) {
        // The same pot to the wrong player(s): a pinned door must refuse.
        const [k1, k2] = mode.players(s);
        const wrong =
          payouts.length === 2
            ? [payouts[1]!, payouts[0]!]
            : [{ key: payouts[0]!.key === k1 ? k2 : k1, value: payouts[0]!.value }];
        this.add(input.actor, role, {
          ...base,
          class: "mutant",
          field: "payout",
          accept: false,
          next: null,
          payouts: wrong,
        });
      }
    } else if (ok) {
      const next = mode.utxo(result as S);
      this.add(input.actor, role, { ...base, class: "door", accept: true, next, payouts: [] });
      const mutant = this.mutate(next);
      this.add(input.actor, role, {
        ...base,
        class: "mutant",
        field: mutant.field,
        accept: false,
        next: mutant.utxo,
        payouts: [],
      });
    } else if (a.shapes) {
      let shapes: unknown[] = [];
      try {
        shapes = a.shapes();
      } catch (e) {
        // No shape for this attempt (a column that does not exist); anything
        // else is a generator bug and must not thin the vectors silently.
        if ((e as Error).message !== NO_SHAPE) throw e;
      }
      for (const shape of shapes) {
        this.add(input.actor, role, {
          ...base,
          class: "shape",
          accept: false,
          next: mode.utxo(shape as S),
          payouts: [],
        });
      }
    } else {
      // A refused terminal door: offer the payout patterns it could take.
      const pot = mode.pot(s);
      const [k1, k2] = mode.players(s);
      const patterns: Payout[][] = a.pinned
        ? [
            [
              { to: k1, amount: pot / 2n },
              { to: k2, amount: pot / 2n },
            ],
            [{ to: k1, amount: pot }],
            [{ to: k2, amount: pot }],
          ]
        : [[{ to: KEYS[a.signer ?? 2]!, amount: pot }]];
      for (const p of patterns) {
        if (p.some((x) => x.to === ZERO_PK)) continue;
        this.add(input.actor, role, {
          ...base,
          class: "shape",
          accept: false,
          next: null,
          payouts: payoutOutputs(p, pot),
        });
      }
    }
  }

  /** Change one field of `u`, rotating through its fields; type-valid. */
  private mutate(u: Utxo): { field: string; utxo: Utxo } {
    const fields = Object.keys(u.state);
    const turn = this.rotation.get(u.actor) ?? 0;
    this.rotation.set(u.actor, turn + 1);
    const field = fields[turn % fields.length]!;
    const v = u.state[field]!;
    let changed: string | number;
    if (typeof v === "number") changed = v + 1;
    else if (field === "board") {
      const cells = v.match(/../g)!.map((x) => parseInt(x, 16));
      const at = this.r.int(CELLS);
      cells[at] = (cells[at]! + 1) % 3;
      changed = hex(Uint8Array.from(cells));
    } else if (field === "p1" || field === "p2") changed = v === STRANGER ? P1 : STRANGER;
    else if (/^0+$/.test(v)) changed = "ab".repeat(32);
    else changed = (v.slice(0, 2) === "00" ? "01" : "00") + v.slice(2);
    return { field, utxo: { ...u, state: { ...u.state, [field]: changed } } };
  }

  /** Cap each bucket (deterministic sample) and renumber the states. */
  finish(caps: Record<Vector["class"], number>): VectorFile {
    const kept: Vector[] = [];
    for (const key of [...this.buckets.keys()].sort()) {
      const list = this.buckets.get(key)!;
      const limit = caps[list[0]!.class];
      const chosen = list.length <= limit ? list : sample(list, limit, this.r);
      kept.push(...chosen);
    }
    const used = new Map<number, number>();
    const states: Utxo[] = [];
    const ref = (i: number) => {
      let j = used.get(i);
      if (j === undefined) {
        j = states.length;
        states.push(this.states[i]!);
        used.set(i, j);
      }
      return j;
    };
    const vectors = kept.map((v) => ({
      ...v,
      input: ref(v.input),
      next: v.next === null ? null : ref(v.next),
    }));
    return { keys: KEYS, fee: FEE.toString(), states, vectors };
  }
}

function judge(a: Attempt, t: Timing): { ok: boolean; result?: unknown; reason: string } {
  try {
    return { ok: true, result: a.run(t), reason: "" };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** `t` with one clock moved by one, each way (never below zero). */
function neighbours(t: Timing, withDaa: boolean): Timing[] {
  const out: Timing[] = [];
  for (const d of [-1, 1]) {
    if (t.lockTime + d >= 0) out.push({ ...t, lockTime: t.lockTime + d });
    if (t.sequence + d >= 0) out.push({ ...t, sequence: t.sequence + d });
    if (withDaa && t.daa + d >= 0) out.push({ ...t, daa: t.daa + d });
  }
  return out;
}

/** `n` items of `xs`, in their original order. */
function sample<T>(xs: T[], n: number, r: Rng): T[] {
  const idx = xs.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx
    .slice(0, n)
    .sort((a, b) => a - b)
    .map((i) => xs[i]!);
}

/** The TS payouts as on-chain outputs: one payee takes the pot minus the fee,
 * two split it equally (the contract pins equal halves). */
function payoutOutputs(payouts: Payout[], pot: bigint) {
  if (payouts.length === 1) return [{ key: payouts[0]!.to, value: (pot - FEE).toString() }];
  const each = ((pot - FEE) / 2n).toString();
  return payouts.map((p) => ({ key: p.to, value: each }));
}

// --- Shared helpers ------------------------------------------------------------------

const SIGNERS = [0, 1, 2] as const;

/** Every line on `board` for `disc`, as witnesses (each line once per start). */
function linesOf(board: Uint8Array, disc: number): LineWitness[] {
  const out: LineWitness[] = [];
  for (let col = 0; col < COLS; col++)
    for (let row = 0; row < ROWS; row++)
      for (let dir = 0; dir < 4; dir++)
        if (classic.verifyLine(board, disc, { col, row, dir })) out.push({ col, row, dir });
  return out;
}

/** A witness that names no line of `disc` (or an out-of-range one). */
function bogusLine(r: Rng): LineWitness {
  return r.pick([
    { col: 0, row: 0, dir: 0 },
    { col: 4, row: 0, dir: 0 },
    { col: 0, row: 3, dir: 1 },
    { col: 6, row: 5, dir: 2 },
    { col: 0, row: 0, dir: 4 },
  ]);
}

const witnessArgs = (w: LineWitness): Arg[] => [{ int: w.col }, { int: w.row }, { int: w.dir }];

// --- Classic ---------------------------------------------------------------------------

const classicMode: Mode<ClassicState> = {
  utxo(s) {
    if (isOpen(s))
      return {
        actor: "FourkLobby",
        state: { p1: s.p1, move_timeout: s.moveTimeout, deadline: s.deadline },
        value: s.stake.toString(),
      };
    return {
      actor: "FourkMatch",
      state: {
        p1: s.p1,
        p2: s.p2,
        board: hex(s.board),
        move_count: s.moveCount,
        move_timeout: s.moveTimeout,
        deadline: s.deadline,
      },
      value: (2n * s.stake).toString(),
    };
  },
  pot: (s) => (isOpen(s) ? s.stake : 2n * s.stake),
  players: (s) => [s.p1, s.p2],
  phase: (s) =>
    isOpen(s) ? "lobby" : s.moveCount === 0 ? "fresh" : s.moveCount === CELLS ? "full" : "mid",
};

/** A lobby built literally, so out-of-bounds genesis gates can be posed. */
function classicLobby(moveTimeout: number, deadline: number): ClassicState {
  return {
    board: new Uint8Array(CELLS),
    moveCount: 0,
    p1: P1,
    p2: ZERO_PK,
    stake: STAKE,
    moveTimeout,
    deadline,
  };
}

const cctx = (signer: number, utxoAge = 0, txTime = 0): classic.Ctx => ({
  signer: KEYS[signer]!,
  utxoAge,
  txTime,
});

/** The would-be move: the mover's disc on top of `col`, guards skipped. */
function classicMoveShape(s: ClassicState, col: number): ClassicState {
  const h = heightOf(s.board, col);
  if (col < 0 || col >= COLS || h >= ROWS) throw new Error(NO_SHAPE);
  const board = s.board.slice();
  board[cellIndex(col, h)] = playerToMove(s) + 1;
  return { ...s, board, moveCount: s.moveCount + 1 };
}

function classicLobbyAttempts(c: Collector, s: ClassicState) {
  for (const k of SIGNERS) {
    c.attempt(classicMode, s, {
      entry: "join",
      args: [{ sig: k }, { bytes: KEYS[k]! }],
      funding: k,
      run: () => classic.join(s, cctx(k)),
      shapes: () => [{ ...s, board: s.board.slice(), p2: KEYS[k]! }],
      pinned: false,
      signer: k,
    });
    c.attempt(classicMode, s, {
      entry: "cancel",
      args: [{ sig: k }],
      run: () => classic.cancel(s, cctx(k)),
      pinned: false,
      signer: k,
    });
  }
}

function classicMatchAttempts(c: Collector, s: ClassicState, r: Rng) {
  for (const k of SIGNERS) {
    for (const col of [-1, 0, 1, 2, 3, 4, 5, 6, 7]) {
      c.attempt(classicMode, s, {
        entry: "move",
        args: [{ sig: k }, { int: col }],
        funding: k,
        run: () => classic.move(s, cctx(k), col),
        shapes: () => [classicMoveShape(s, col)],
        pinned: false,
        signer: k,
      });
      // A winning drop's real witness when there is one, else a bogus one.
      let witnesses: LineWitness[] = [bogusLine(r)];
      try {
        const next = classicMoveShape(s, col);
        witnesses = [...linesOf(next.board, playerToMove(s) + 1).slice(0, 1), ...witnesses];
      } catch {
        // Column full or out of range: only the bogus witness.
      }
      for (const w of witnesses)
        c.attempt(classicMode, s, {
          entry: "winning_move",
          args: [{ sig: k }, { int: col }, ...witnessArgs(w)],
          run: () => classic.winningMove(s, cctx(k), col, w),
          pinned: false,
          signer: k,
        });
    }
    for (const age of [0, s.moveTimeout - 1, s.moveTimeout]) {
      c.attempt(classicMode, s, {
        entry: "claim_forfeit",
        args: [{ sig: k }],
        sequence: age,
        run: (t) => classic.claimForfeit(s, cctx(k, t.sequence)),
        pinned: false,
        signer: k,
      });
      c.attempt(classicMode, s, {
        entry: "dissolve",
        args: [{ sig: k }, { bytes: KEYS[k]! }],
        sequence: age,
        run: (t) => classic.dissolve(s, cctx(k, t.sequence)),
        pinned: true,
        signer: k,
      });
    }
  }
  c.attempt(classicMode, s, {
    entry: "claim_draw",
    args: [],
    run: () => classic.claimDraw(s, cctx(2)),
    pinned: true,
  });
  // Both gates on both sides: the deadline (lock time) and the mover's
  // clock (sequence), which the cap never shortens.
  for (const lock of [s.deadline - 1, s.deadline])
    for (const age of [s.moveTimeout - 1, s.moveTimeout])
      c.attempt(classicMode, s, {
        entry: "sudden_death",
        args: [],
        lockTime: lock,
        sequence: age,
        run: (t) => classic.suddenDeath(s, cctx(2, t.sequence, t.lockTime)),
        pinned: true,
      });
}

function classicVectors(c: Collector, r: Rng) {
  // Genesis gates on both sides of every bound.
  for (const [mt, dl] of [
    [T, DEADLINE],
    [599, DEADLINE],
    [600, DEADLINE],
    [MAX_MOVE_TIMEOUT_DAA, DEADLINE],
    [MAX_MOVE_TIMEOUT_DAA + 1, DEADLINE],
    [T, 0],
    [T, 1],
    [T, DEADLINE_LIMIT - 1],
    [T, DEADLINE_LIMIT],
  ] as const)
    classicLobbyAttempts(c, classicLobby(mt, dl));

  const joined = classic.join(classicLobby(T, DEADLINE), cctx(1));
  // Random games of every length, plus the full board (wins left unclaimed:
  // a plain move never checks for lines).
  for (let game = 0; game < 10; game++) {
    let s = joined;
    const stop = game === 0 ? 0 : game === 9 ? CELLS : 1 + r.int(CELLS);
    while (s.moveCount < stop) {
      const open = [...Array(COLS).keys()].filter((col) => heightOf(s.board, col) < ROWS);
      s = classic.move(s, cctx(playerToMove(s)), r.pick(open));
    }
    classicMatchAttempts(c, s, r);
  }
  let full = joined;
  for (let col = 0; col < COLS; col++)
    for (let row = 0; row < ROWS; row++) full = classic.move(full, cctx(playerToMove(full)), col);
  classicMatchAttempts(c, full, r);
}

// --- Fourk (legacy simul and V2) ------------------------------------------------------------

/** The simul state as artifact fields; V2 adds its three. */
function simulFields(s: SimulState): Fields {
  return {
    p1: s.p1,
    p2: s.p2,
    board: hex(s.board),
    round: s.round,
    commit1: s.commit1,
    commit2: s.commit2,
    reveal1: s.reveal1,
    reveal2: s.reveal2,
    pending_win: s.pendingWin,
    move_timeout: s.moveTimeout,
    deadline: s.deadline,
  };
}

function simulPhase(s: SimulState): string {
  if (isSimulOpen(s)) return "lobby";
  if (s.pendingWin) return "pending";
  if (isBoardFull(s.board)) return "full";
  return `${s.round === 0 ? "first" : "later"}-${roundPhase(s)}-${Number(s.commit1 !== ZERO_HASH) + Number(s.commit2 !== ZERO_HASH)}`;
}

const v2Mode: Mode<v2.State> = {
  utxo(s) {
    if (isSimulOpen(s))
      return {
        actor: "FourkSimulV2Lobby",
        state: {
          p1: s.p1,
          move_timeout: s.moveTimeout,
          deadline: s.deadline,
          reveal_timeout: s.revealTimeout,
          quick: s.quick,
        },
        value: s.stake.toString(),
      };
    return {
      actor: "FourkSimulV2",
      state: {
        ...simulFields(s),
        pick_deadline: s.pickDeadline,
        first_committer: s.firstCommitter,
        reveal_timeout: s.revealTimeout,
        quick: s.quick,
      },
      value: (2n * s.stake).toString(),
    };
  },
  pot: (s) => (isSimulOpen(s) ? s.stake : 2n * s.stake),
  players: (s) => [s.p1, s.p2],
  phase: simulPhase,
};

/** A walk node: the state, its UTXO's acceptance score, and the secret picks
 * the walk knows (col, salt) per player. */
interface Node<S> {
  s: S;
  score: number;
  picks: Array<{ col: number; salt: Uint8Array } | null>;
}

const sctx = (signer: number, utxoAge = 0, txTime = 0, inputDaa = 0): v2.Ctx => ({
  signer: KEYS[signer]!,
  utxoAge,
  txTime,
  inputDaa,
});

/** Which rulebook a simul walk runs: legacy or V2. Same door names. */
interface SimulRules<S extends SimulState> {
  mode: Mode<S>;
  v2: boolean;
  join(s: S, ctx: v2.Ctx): S;
  cancel(s: S, ctx: v2.Ctx): Payout[];
  dissolve(s: S, ctx: v2.Ctx): Payout[];
  commit(s: S, ctx: v2.Ctx, h: string): S;
  reveal(s: S, ctx: v2.Ctx, col: number, salt: Uint8Array): S;
  resolve(s: S, ctx: v2.Ctx, col: number, salt: Uint8Array): S;
  claimWin(s: S, ctx: v2.Ctx, w: LineWitness): S;
  sweepWin(s: S, ctx: v2.Ctx): Payout[];
  claimSplit(s: S, ctx: v2.Ctx, w1: LineWitness, w2: LineWitness): Payout[];
  claimDraw(s: S, ctx: v2.Ctx): Payout[];
  claimTimeout(s: S, ctx: v2.Ctx): Payout[];
  splitTimeout(s: S, ctx: v2.Ctx): Payout[];
  suddenDeath(s: S, ctx: v2.Ctx): Payout[];
  applyCommit(s: S, player: 0 | 1, h: string, inputDaa: number): S;
  applyReveal(s: S, player: 0 | 1, col: number): S;
  applyResolve(s: S, player: 0 | 1, col: number): S;
  applyClaimWin(s: S, disc: number): S;
  /** The clock the challenge window and the draw wait out. */
  grace(s: S): number;
}

const v2Rules: SimulRules<v2.State> = {
  mode: v2Mode,
  v2: true,
  ...v2,
  grace: (s) => s.revealTimeout,
};

const seat = (k: number): 0 | 1 => (k === 1 ? 1 : 0);

/** Every DAA quantity a door may compare against, both sides of each. */
function boundaries<S extends SimulState>(n: Node<S>): number[] {
  const s = n.s as SimulState & Partial<v2.State>;
  const points = [n.score + s.moveTimeout, n.score + v2.REBASE_GRACE_DAA, s.deadline];
  if (s.pickDeadline) points.push(s.pickDeadline);
  const out = new Set<number>([0]);
  for (const p of points) if (p > 0) for (const q of [p - 1, p]) out.add(q);
  return [...out].sort((a, b) => a - b);
}

function simulAttempts<S extends SimulState>(
  c: Collector,
  rules: SimulRules<S>,
  n: Node<S>,
  r: Rng,
) {
  const s = n.s;
  const mode = rules.mode;
  const scores = rules.v2
    ? [
        ...new Set([
          n.score,
          ...((s as unknown as v2.State).pickDeadline
            ? [
                (s as unknown as v2.State).pickDeadline - 1,
                (s as unknown as v2.State).pickDeadline,
                (s as unknown as v2.State).pickDeadline + 1,
              ]
            : []),
        ]),
      ].map(String)
    : ["0"];
  if (rules.v2) scores.push(UNACCEPTED);
  const ages = [
    ...new Set([0, rules.grace(s) - 1, rules.grace(s), s.moveTimeout - 1, s.moveTimeout]),
  ];
  // Lock-time edges for every input score tried, not just the walk's: a
  // lone pick's claim waits for max(D, S1 + G) with S1 the attempt's own.
  const locks = [
    ...new Set([
      ...boundaries(n),
      ...scores
        .filter((x) => x !== UNACCEPTED)
        .flatMap((x) =>
          [Number(x) + s.moveTimeout, Number(x) + v2.REBASE_GRACE_DAA].flatMap((p) => [p - 1, p]),
        ),
    ]),
  ].sort((a, b) => a - b);

  if (isSimulOpen(s)) {
    for (const k of SIGNERS) {
      c.attempt(mode, s, {
        entry: "join",
        args: [{ sig: k }, { bytes: KEYS[k]! }],
        funding: k,
        run: () => rules.join(s, sctx(k)),
        shapes: () => [{ ...s, board: s.board.slice(), p2: KEYS[k]! }],
        pinned: false,
        signer: k,
      });
      c.attempt(mode, s, {
        entry: "cancel",
        args: [{ sig: k }],
        run: () => rules.cancel(s, sctx(k)),
        pinned: false,
        signer: k,
      });
    }
    return;
  }

  for (const k of SIGNERS) {
    const player = seat(k);
    // Commit: a fresh pick, and (when the opponent has one) a copy of theirs.
    const pick = { col: r.int(COLS), salt: r.salt() };
    const hashes = [commitmentOf(player, pick.col, pick.salt)];
    const theirs = player === 0 ? s.commit2 : s.commit1;
    if (theirs !== ZERO_HASH) hashes.push(theirs);
    for (const h of hashes)
      for (const score of scores)
        c.attempt(mode, s, {
          entry: "commit",
          args: [{ sig: k }, { bytes: KEYS[k]! }, { bytes: h }],
          daaScore: score,
          funding: k,
          run: (t) => rules.commit(s, sctx(k, 0, 0, t.daa), h),
          // An unaccepted input has no score to anchor a cutoff on: pose the
          // successor a timely acceptance would have produced instead.
          shapes: () =>
            k === 2
              ? []
              : [rules.applyCommit(s, player, h, score === UNACCEPTED ? n.score : Number(score))],
          pinned: false,
          signer: k,
        });

    // Reveal / resolve: the true opening when the walk knows it, a wrong salt
    // and a wrong column otherwise.
    const known = n.picks[player];
    const openings = known
      ? [
          known,
          { col: known.col, salt: r.salt() },
          { col: (known.col + 1) % COLS, salt: known.salt },
        ]
      : [{ col: r.int(COLS), salt: r.salt() }];
    for (const o of openings)
      for (const score of scores) {
        const args: Arg[] = [
          { sig: k },
          { bytes: KEYS[k]! },
          { int: o.col },
          { bytes: hex(o.salt) },
        ];
        c.attempt(mode, s, {
          entry: "reveal",
          args,
          daaScore: score,
          funding: k,
          run: (t) => rules.reveal(s, sctx(k, 0, 0, t.daa), o.col, o.salt),
          shapes: () => (k === 2 ? [] : [rules.applyReveal(s, player, o.col)]),
          pinned: false,
          signer: k,
        });
        c.attempt(mode, s, {
          entry: "resolve",
          args,
          daaScore: score,
          funding: k,
          run: (t) => rules.resolve(s, sctx(k, 0, 0, t.daa), o.col, o.salt),
          shapes: () => {
            const other = player === 0 ? s.reveal2 : s.reveal1;
            return k === 2 || other === 0 ? [] : [rules.applyResolve(s, player, o.col)];
          },
          pinned: false,
          signer: k,
        });
      }

    // Win claims: every color's first real line, and a bogus one.
    for (const disc of [1, 2]) {
      for (const w of [...linesOf(s.board, disc).slice(0, 1), bogusLine(r)])
        c.attempt(mode, s, {
          entry: "claim_win",
          args: [{ sig: k }, ...witnessArgs(w)],
          funding: k,
          run: () => rules.claimWin(s, sctx(k), w),
          shapes: () => [rules.applyClaimWin(s, disc)],
          pinned: false,
          signer: k,
        });
    }

    for (const age of ages) {
      c.attempt(mode, s, {
        entry: "dissolve",
        args: [{ sig: k }, { bytes: KEYS[k]! }],
        sequence: age,
        run: (t) => rules.dissolve(s, sctx(k, t.sequence)),
        pinned: true,
        signer: k,
      });
    }

    // The timeout claim reads every clock: age, lock time, acceptance.
    for (const score of scores)
      for (const lock of locks)
        for (const age of rules.v2 ? [0, rules.grace(s)] : ages)
          c.attempt(mode, s, {
            entry: "claim_timeout",
            args: [{ sig: k }],
            lockTime: lock,
            sequence: age,
            daaScore: score,
            run: (t) => rules.claimTimeout(s, sctx(k, t.sequence, t.lockTime, t.daa)),
            pinned: false,
            signer: k,
          });
  }

  // Permissionless doors.
  const p1Lines = linesOf(s.board, 1);
  const p2Lines = linesOf(s.board, 2);
  for (const [w1, w2] of [
    [p1Lines[0] ?? bogusLine(r), p2Lines[0] ?? bogusLine(r)],
    [p1Lines[0] ?? bogusLine(r), bogusLine(r)],
    [p2Lines[0] ?? bogusLine(r), p1Lines[0] ?? bogusLine(r)],
  ] as const)
    c.attempt(mode, s, {
      entry: "claim_split",
      args: [...witnessArgs(w1), ...witnessArgs(w2)],
      run: () => rules.claimSplit(s, sctx(2), w1, w2),
      pinned: true,
    });
  for (const age of ages)
    c.attempt(mode, s, {
      entry: "sweep_win",
      args: [],
      sequence: age,
      run: (t) => rules.sweepWin(s, sctx(2, t.sequence)),
      pinned: true,
    });
  for (const age of ages)
    c.attempt(mode, s, {
      entry: "claim_draw",
      args: [],
      sequence: age,
      run: (t) => rules.claimDraw(s, sctx(2, t.sequence)),
      pinned: true,
    });
  for (const score of scores)
    for (const lock of locks)
      for (const age of ages) {
        c.attempt(mode, s, {
          entry: "split_timeout",
          args: [],
          lockTime: lock,
          sequence: age,
          daaScore: score,
          run: (t) => rules.splitTimeout(s, sctx(2, t.sequence, t.lockTime, t.daa)),
          pinned: true,
        });
        c.attempt(mode, s, {
          entry: "sudden_death",
          args: [],
          lockTime: lock,
          sequence: age,
          daaScore: score,
          run: (t) => rules.suddenDeath(s, sctx(2, t.sequence, t.lockTime, t.daa)),
          pinned: true,
        });
      }
}

/** One step of a simul walk: both players pick, reveal and resolve a round,
 * each transition accepted `gap` DAA after the last. Returns every node. */
function playRound<S extends SimulState>(
  rules: SimulRules<S>,
  n: Node<S>,
  r: Rng,
  cols: [number, number] | null,
  gap: () => number,
): Node<S>[] {
  const visited: Node<S>[] = [];
  const order: Array<0 | 1> = r.int(2) === 0 ? [0, 1] : [1, 0];
  let cur = n;
  const picks: Node<S>["picks"] = [null, null];
  for (const player of order) {
    const col = cols ? cols[player] : r.pick(simul.legalSimulColumns(cur.s));
    const salt = r.salt();
    picks[player] = { col, salt };
    const next = rules.commit(
      cur.s,
      sctx(player, 0, 0, cur.score),
      commitmentOf(player, col, salt),
    );
    cur = { s: next, score: cur.score + gap(), picks: [...picks] };
    visited.push(cur);
  }
  const [first, second] = order;
  const p1 = picks[first!]!;
  const shown = rules.reveal(cur.s, sctx(first!, 0, 0, cur.score), p1.col, p1.salt);
  cur = { s: shown, score: cur.score + gap(), picks: [...picks] };
  visited.push(cur);
  const p2 = picks[second!]!;
  const done = rules.resolve(cur.s, sctx(second!, 0, 0, cur.score), p2.col, p2.salt);
  cur = { s: done, score: cur.score + gap(), picks: [null, null] };
  visited.push(cur);
  return visited;
}

function simulVectors<S extends SimulState>(
  c: Collector,
  rules: SimulRules<S>,
  lobby: (mt: number, dl: number) => S,
  r: Rng,
) {
  for (const [mt, dl] of [
    [T, DEADLINE],
    [599, DEADLINE],
    [MAX_MOVE_TIMEOUT_DAA + 1, DEADLINE],
    [T, 0],
    [T, DEADLINE_LIMIT],
  ] as const)
    simulAttempts(c, rules, { s: lobby(mt, dl), score: 1000, picks: [null, null] }, r);

  const joined: Node<S> = {
    s: rules.join(lobby(T, DEADLINE), sctx(1)),
    score: 1000,
    picks: [null, null],
  };
  const nodes: Node<S>[] = [joined];

  // Random games, mostly timely, some with late transitions.
  for (let game = 0; game < 4; game++) {
    let cur = joined;
    const rounds = 1 + r.int(5);
    for (let round = 0; round < rounds && simul.legalSimulColumns(cur.s).length > 0; round++) {
      try {
        const steps = playRound(rules, cur, r, null, () => 1 + r.int(game === 3 ? 2 * T : T / 4));
        nodes.push(...steps);
        cur = steps[steps.length - 1]!;
      } catch {
        break; // a late pick ended normal play: the nodes so far are kept
      }
    }
  }

  // A double win: p1 stacks column 0, p2 column 1, four rounds.
  let dbl = joined;
  for (let round = 0; round < 4; round++) {
    const steps = playRound(rules, dbl, r, [0, 1], () => 10);
    dbl = steps[steps.length - 1]!;
  }
  nodes.push(dbl);
  // ...and the pending win p1 claims on it.
  const w = linesOf(dbl.s.board, 1)[0]!;
  nodes.push({ s: rules.claimWin(dbl.s, sctx(0), w), score: dbl.score + 10, picks: [null, null] });

  // A full board: both players stack the same column, three rounds a column.
  let full = joined;
  for (let round = 0; round < 21; round++) {
    const col = Math.floor(round / 3);
    const steps = playRound(rules, full, r, [col, col], () => 10);
    full = steps[steps.length - 1]!;
  }
  nodes.push(full);

  for (const n of nodes) simulAttempts(c, rules, n, r);
}

// --- Entry point ---------------------------------------------------------------------

export function generateVectors(): VectorFile {
  const r = rng(0x4f0e_2026);
  const c = new Collector(r);
  classicVectors(c, r);
  // Invite and Quick Match lobbies: the flag only moves the joiner's
  // dissolve, but every door must carry it unchanged.
  for (const quick of [0, 1])
    simulVectors(
      c,
      v2Rules,
      (mt, dl) => ({
        ...simulLobby(mt, dl),
        pickDeadline: 0,
        firstCommitter: 0,
        revealTimeout: R,
        quick,
      }),
      r,
    );
  return c.finish({ door: 8, shape: 4, mutant: 3 });
}

/** A simul lobby built literally (newSimulMatch throws on bad gates). */
function simulLobby(moveTimeout: number, deadline: number): SimulState {
  return {
    board: new Uint8Array(CELLS),
    round: 0,
    p1: P1,
    p2: ZERO_PK,
    commit1: ZERO_HASH,
    commit2: ZERO_HASH,
    reveal1: 0,
    reveal2: 0,
    pendingWin: 0,
    stake: STAKE,
    moveTimeout,
    deadline,
  };
}

/** One state or vector per line: diffable, still plain JSON. */
export function serialize(file: VectorFile): string {
  const lines = (xs: unknown[]) => xs.map((x) => "    " + JSON.stringify(x)).join(",\n");
  return (
    "{\n" +
    `  "keys": ${JSON.stringify(file.keys)},\n` +
    `  "fee": ${JSON.stringify(file.fee)},\n` +
    `  "states": [\n${lines(file.states)}\n  ],\n` +
    `  "vectors": [\n${lines(file.vectors)}\n  ]\n` +
    "}\n"
  );
}
