import { useEffect, useRef } from "react";
import { useChainPulse } from "../hooks";

/** Grid pitch in px — the zoom knob. Smaller = more, smaller cells on
 * screen (zoomed out); disc size and spacing scale with it. */
const CELL = 15;
const DISC = Math.round(CELL * 0.78);
const PAD = (CELL - DISC) / 2;
/** testnet-10 mines ~10 blocks/s — one disc per block, with the real
 * chain's jitter setting the rhythm. (Deliberately unexplained in the UI:
 * that the board is the live chain is a hidden fun fact, see IDEAS.md.) */
const BLOCKS_PER_DISC = 1;

/** px/s², tuned so a full-viewport drop takes ~0.7s. */
const GRAVITY = 4000;

/** Restitution variants, deadest to liveliest. */
const BOUNCE_E = [0.12, 0.18, 0.24, 0.3] as const;

interface Disc {
  col: number;
  /** Row from the bottom of the screen. */
  row: number;
  blue: boolean;
  /** Restitution of the landing bounce. */
  e: number;
  /** Fall distance in px, from above the viewport to rest. */
  drop: number;
  /** performance.now() when the drop started. */
  start: number;
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The board itself, painted over the discs: opaque page-color between the
 * holes (so falling discs only show through them, like a real board) with a
 * faint ink tint inside each hole. Pre-rendered once per resize — thousands
 * of circles are too many to stroke every frame. Anchored bottom-left to
 * line up with the disc grid.
 */
function renderBoard(w: number, h: number, dpr: number, ink: string, bg: string) {
  const layer = document.createElement("canvas");
  layer.width = Math.round(w * dpr);
  layer.height = Math.round(h * dpr);
  const ctx = layer.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const holes = new Path2D();
  for (let col = 0; col < Math.ceil(w / CELL); col++) {
    for (let row = 0; row < Math.ceil(h / CELL); row++) {
      const x = col * CELL + CELL / 2;
      const y = h - (row * CELL + CELL / 2);
      holes.moveTo(x + DISC / 2, y);
      holes.arc(x, y, DISC / 2, 0, 2 * Math.PI);
    }
  }
  const sheet = new Path2D();
  sheet.rect(0, 0, w, h);
  sheet.addPath(holes);
  ctx.fillStyle = bg;
  ctx.fill(sheet, "evenodd");
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = ink;
  ctx.fill(holes);
  return layer;
}

/**
 * Decorative connect-four board behind the home screen: faint holes cover the
 * viewport and low-opacity discs drop into random columns to the beat of the
 * chain, stacking from the bottom until the board is full. One canvas, no DOM
 * per disc; the rAF loop runs only while a disc is in flight. Purely cosmetic
 * — hidden from the a11y tree, no pointer events, and static under
 * prefers-reduced-motion.
 */
export const BoardBackdrop = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spawn = useRef<(blocks: number) => void>(() => {});

  // The chain is the only driver: every BLOCKS_PER_DISC freshly mined blocks
  // drop one disc, so the board stays empty until the subscription flows.
  useChainPulse((blocks) => spawn.current(blocks));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const styles = getComputedStyle(canvas);
    const color = (name: string) => styles.getPropertyValue(name).trim();
    const red = color("--color-red");
    const blue = color("--color-blue");

    let w = 0;
    let h = 0;
    let cols = 0;
    let rows = 0;
    let board: HTMLCanvasElement;
    const discs: Disc[] = [];

    /** Paint one frame; true while any disc is still in flight. Falling is
     * plain kinematics — t₁ = √(2h/g) to impact, then one rebound at e·v
     * lasting 2e·t₁ — so a frame is a pure function of the clock and discs
     * snap to rest after a background-tab gap instead of replaying. */
    const draw = (now: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = 0.15;
      let flying = false;
      for (const d of discs) {
        const t = (now - d.start) / 1000;
        const t1 = Math.sqrt((2 * d.drop) / GRAVITY);
        let off = 0;
        if (t < t1) {
          off = 0.5 * GRAVITY * t * t - d.drop;
          flying = true;
        } else if (t < t1 * (1 + 2 * d.e)) {
          const tb = t - t1;
          off = -(d.e * GRAVITY * t1 * tb - 0.5 * GRAVITY * tb * tb);
          flying = true;
        }
        ctx.fillStyle = d.blue ? blue : red;
        ctx.beginPath();
        ctx.arc(d.col * CELL + CELL / 2, h - (d.row * CELL + CELL / 2) + off, DISC / 2, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.drawImage(board, 0, 0, w, h);
      return flying;
    };

    let raf = 0;
    const tick = () => {
      raf = draw(performance.now()) ? requestAnimationFrame(tick) : 0;
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };

    /** Drop one disc into a random open column; colors alternate like real
     * turns. Landing on a stack absorbs energy: a disc hitting the board
     * floor gets the liveliest bounce, one notch deader per disc already
     * beneath it, with a little scatter so same-height landings don't look
     * cloned. */
    const addDisc = () => {
      const heights = new Map<number, number>();
      for (const d of discs) heights.set(d.col, (heights.get(d.col) ?? 0) + 1);
      const open = [...Array(cols).keys()].filter((c) => (heights.get(c) ?? 0) < rows);
      if (!open.length) return false;
      const col = open[Math.floor(Math.random() * open.length)]!;
      const row = heights.get(col) ?? 0;
      const cap = Math.max(0, BOUNCE_E.length - 1 - row);
      const variant = Math.max(0, cap - (Math.random() < 0.3 ? 1 : 0));
      const drop = h - row * CELL - PAD;
      // The rebound peaks at e²·drop, so untempered restitution sends a
      // full-viewport faller several cells back up. Cap the rebound height
      // at ~3 cells; short falls keep their liveliness untouched.
      const e = Math.min(BOUNCE_E[variant]!, Math.sqrt((3 * CELL) / drop));
      discs.push({
        col,
        row,
        blue: discs.length % 2 === 1,
        e,
        drop,
        start: performance.now(),
      });
      return true;
    };

    let pending = 0;
    spawn.current = (blocks) => {
      if (reducedMotion()) return;
      pending += blocks;
      let added = false;
      while (pending >= BLOCKS_PER_DISC) {
        pending -= BLOCKS_PER_DISC;
        if (addDisc()) added = true;
      }
      if (added) kick();
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = window.innerWidth;
      h = window.innerHeight;
      cols = Math.ceil(w / CELL);
      rows = Math.ceil(h / CELL);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      board = renderBoard(w, h, dpr, color("--color-ink"), color("--color-bg"));
      if (draw(performance.now())) kick();
    };
    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(raf);
      spawn.current = () => {};
    };
  }, []);

  const mask = "linear-gradient(to top, black 55%, transparent 100%)";

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    />
  );
};
