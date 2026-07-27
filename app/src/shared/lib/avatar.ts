/**
 * Seeded procedural .io-style avatars. Four u16 "genes" (shape, colour,
 * eyes, extras) each seed their own xorshift stream, so a gene can be locked
 * and rerolled independently. The 16-hex concatenation of the genes is the
 * player's avatar code — it travels in profiles (share codes, join payloads)
 * and is all that's needed to redraw the character anywhere.
 */

export interface Genes {
  shape: number;
  color: number;
  eyes: number;
  extra: number;
}

export const GENE_KEYS = ["shape", "color", "eyes", "extra"] as const;
export const GENE_LABELS: Record<keyof Genes, string> = {
  shape: "Shape",
  color: "Colour",
  eyes: "Eyes",
  extra: "Extras",
};

const rnd16 = () => (Math.random() * 0x10000) | 0;

export function randomGenes(): Genes {
  return { shape: rnd16(), color: rnd16(), eyes: rnd16(), extra: rnd16() };
}

/** 16 lowercase hex chars: shape|color|eyes|extra, 4 hex each. */
export function genesToCode(g: Genes): string {
  return GENE_KEYS.map((k) => (g[k] & 0xffff).toString(16).padStart(4, "0")).join("");
}

export function codeToGenes(code: string): Genes {
  const hex = /^[0-9a-f]{16}$/.test(code) ? code : code.padEnd(16, "0").slice(0, 16);
  const [shape, color, eyes, extra] = [0, 4, 8, 12].map((i) =>
    parseInt(hex.slice(i, i + 4), 16) || 0,
  );
  return { shape: shape!, color: color!, eyes: eyes!, extra: extra! };
}

/** Deterministic avatar for a player who never sent a profile: their pubkey
 * hex doubles as a gene code, so every wallet has a face. */
export function codeFromPubkey(pk: string): string {
  return pk.slice(0, 16).padEnd(16, "0");
}

// --- Genes -> appearance ------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return function () {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export interface Appearance {
  k1: number;
  k2: number;
  w1: number;
  w2: number;
  ph1: number;
  ph2: number;
  hue: number;
  sat: number;
  lit: number;
  accent: number;
  pattern: number;
  eyeN: number;
  eyeGap: number;
  eyeR: number;
  pupil: number;
  eyeY: number;
  spikes: boolean;
  spikeN: number;
  spikeLen: number;
  antenna: boolean;
  ring: boolean;
  rare: boolean;
  bob: number;
  blink: number;
}

export function buildAppearance(g: Genes): Appearance {
  const rs = rng(g.shape),
    rc = rng(g.color),
    re = rng(g.eyes),
    rx = rng(g.extra);
  const hue = Math.floor(rc() * 360);
  return {
    k1: 3 + Math.floor(rs() * 6),
    k2: 2 + Math.floor(rs() * 4),
    w1: rs() * 0.16,
    w2: rs() * 0.09,
    ph1: rs() * 6.28,
    ph2: rs() * 6.28,
    hue,
    sat: 58 + rc() * 26,
    lit: 46 + rc() * 13,
    accent: (hue + (rc() < 0.5 ? 180 : 35 + rc() * 20)) % 360,
    pattern: Math.floor(rc() * 5),
    eyeN: 1 + Math.floor(re() * 3),
    eyeGap: 0.22 + re() * 0.3,
    eyeR: 0.13 + re() * 0.09,
    pupil: 0.4 + re() * 0.3,
    eyeY: -0.12 + re() * 0.24,
    spikes: rx() < 0.45,
    spikeN: 5 + Math.floor(rx() * 8),
    spikeLen: 0.12 + rx() * 0.16,
    antenna: rx() < 0.3,
    ring: rx() < 0.22,
    rare: rx() < 0.06,
    bob: rx() * 6.28,
    blink: 2200 + rx() * 3000,
  };
}

// --- Canvas rendering ---------------------------------------------------------

function radius(a: Appearance, th: number, R: number): number {
  return R * (1 + a.w1 * Math.sin(a.k1 * th + a.ph1) + a.w2 * Math.sin(a.k2 * th + a.ph2));
}

function bodyPath(ctx: CanvasRenderingContext2D, a: Appearance, cx: number, cy: number, R: number) {
  ctx.beginPath();
  for (let i = 0; i <= 120; i++) {
    const th = (i / 120) * Math.PI * 2,
      r = radius(a, th, R);
    const x = cx + Math.cos(th) * r,
      y = cy + Math.sin(th) * r;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

interface HiDpiCanvas extends HTMLCanvasElement {
  _w?: number;
  _h?: number;
}

/** Draw one animation frame at time `t` (ms). Pass a fixed `t` for a static
 * thumbnail. The canvas is upscaled for hi-dpi once, on first draw. */
export function drawAvatar(canvas: HTMLCanvasElement, a: Appearance, t: number): void {
  const cv = canvas as HiDpiCanvas;
  const dpr = window.devicePixelRatio || 1;
  if (cv.dataset.hi !== "1") {
    const w = cv.width,
      h = cv.height;
    cv.width = w * dpr;
    cv.height = h * dpr;
    cv.getContext("2d")!.scale(dpr, dpr);
    cv.dataset.hi = "1";
    cv._w = w;
    cv._h = h;
  }
  const ctx = cv.getContext("2d")!,
    w = cv._w!,
    h = cv._h!;
  ctx.clearRect(0, 0, w, h);
  const R = Math.min(w, h) * 0.33,
    cx = w / 2,
    cy = h / 2 + Math.sin(t / 700 + a.bob) * h * 0.012;
  const base = `hsl(${a.hue} ${a.sat.toFixed(0)}% ${a.lit.toFixed(0)}%)`;
  const acc = `hsl(${a.accent} ${a.sat.toFixed(0)}% ${(a.lit + 14).toFixed(0)}%)`;
  const line = `hsl(${a.hue} 45% 16%)`;
  const sw = Math.max(1.5, R * 0.075);

  if (a.ring) {
    ctx.strokeStyle = a.rare ? `hsl(${(t / 12) % 360} 80% 55%)` : acc;
    ctx.lineWidth = sw * 0.6;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.26, 0, 6.284);
    ctx.stroke();
  }

  if (a.antenna) {
    ctx.strokeStyle = line;
    ctx.lineWidth = sw * 0.7;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx, cy - R * 0.9);
    ctx.quadraticCurveTo(cx + R * 0.1, cy - R * 1.4, cx + R * 0.22, cy - R * 1.45);
    ctx.stroke();
    ctx.fillStyle = acc;
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.arc(cx + R * 0.22, cy - R * 1.45, R * 0.11, 0, 6.284);
    ctx.fill();
    ctx.stroke();
  }

  if (a.spikes) {
    ctx.fillStyle = acc;
    ctx.strokeStyle = line;
    ctx.lineWidth = sw * 0.8;
    ctx.lineJoin = "round";
    for (let i = 0; i < a.spikeN; i++) {
      const th = (i / a.spikeN) * Math.PI * 2 + a.ph1,
        r = radius(a, th, R),
        L = R * a.spikeLen,
        sp = 0.14;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(th - sp) * r * 0.96, cy + Math.sin(th - sp) * r * 0.96);
      ctx.lineTo(cx + Math.cos(th) * (r + L), cy + Math.sin(th) * (r + L));
      ctx.lineTo(cx + Math.cos(th + sp) * r * 0.96, cy + Math.sin(th + sp) * r * 0.96);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  bodyPath(ctx, a, cx, cy, R);
  ctx.fillStyle = base;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = acc;
  ctx.globalAlpha = 0.55;
  if (a.pattern === 0) {
    for (let i = -6; i < 10; i++) {
      ctx.fillRect(cx - R * 1.4 + i * R * 0.34, cy - R * 1.5, R * 0.17, R * 3);
    }
  } else if (a.pattern === 1) {
    for (let i = 0; i < 9; i++) {
      const th = i * 2.4 + a.ph2,
        rr = R * (0.25 + ((i * 37) % 50) / 100);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(th) * rr, cy + Math.sin(th) * rr, R * 0.14, 0, 6.284);
      ctx.fill();
    }
  } else if (a.pattern === 2) {
    ctx.strokeStyle = acc;
    ctx.lineWidth = R * 0.13;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * i * 0.3, 0, 6.284);
      ctx.stroke();
    }
  } else if (a.pattern === 3) {
    ctx.fillRect(cx - R * 1.5, cy, R * 3, R * 1.5);
  }
  ctx.restore();
  bodyPath(ctx, a, cx, cy, R);
  ctx.strokeStyle = line;
  ctx.lineWidth = sw;
  ctx.stroke();

  const open = t % a.blink > 140 ? 1 : 0.12;
  const ey = cy + R * a.eyeY,
    er = R * a.eyeR;
  for (let i = 0; i < a.eyeN; i++) {
    const off = (i - (a.eyeN - 1) / 2) * R * a.eyeGap * 2,
      ex = cx + off;
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = line;
    ctx.lineWidth = sw * 0.55;
    ctx.beginPath();
    ctx.ellipse(ex, ey, er, er * open, 0, 0, 6.284);
    ctx.fill();
    ctx.stroke();
    if (open > 0.5) {
      ctx.fillStyle = line;
      ctx.beginPath();
      ctx.arc(
        ex + Math.cos(t / 900 + i) * er * 0.22,
        ey + Math.sin(t / 1100) * er * 0.18,
        er * a.pupil * 0.55,
        0,
        6.284,
      );
      ctx.fill();
    }
  }
}
