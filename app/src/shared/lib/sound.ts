/**
 * Tiny synthesized alert sounds via Web Audio — no assets, no dependencies.
 * Browsers refuse audio before the first user gesture; every failure here is
 * silent by design (a missed chime must never break a game action).
 */

let ctx: AudioContext | null = null;
const SOUND_KEY = "fourk.sound";
let enabled: boolean | undefined;
const listeners = new Set<() => void>();

export function isSoundEnabled(): boolean {
  if (enabled === undefined) {
    try {
      enabled = localStorage.getItem(SOUND_KEY) !== "off";
    } catch {
      enabled = true;
    }
  }
  return enabled;
}

export function setSoundEnabled(value: boolean): void {
  enabled = value;
  try {
    localStorage.setItem(SOUND_KEY, value ? "on" : "off");
  } catch {
    // Still mute this tab when browser storage is unavailable.
  }
  for (const listener of listeners) listener();
}

export function subscribeToSound(listener: () => void): () => void {
  listeners.add(listener);
  const changed = (event: StorageEvent) => {
    if (event.key !== SOUND_KEY && event.key !== null) return;
    enabled = undefined;
    listener();
  };
  window.addEventListener("storage", changed);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", changed);
  };
}

function audioCtx(): AudioContext | null {
  if (!isSoundEnabled()) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** One soft sine blip with a fast attack and gentle decay. */
function tone(ac: AudioContext, at: number, freq: number, dur = 0.18, peak = 0.06): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

/** Your clock is getting low — a gentle two-note nudge. */
export function playClockWarning(): void {
  const ac = audioCtx();
  if (!ac) return;
  tone(ac, ac.currentTime, 880);
  tone(ac, ac.currentTime + 0.22, 660);
}

/** Your time just ran out — three quick descending notes, more insistent. */
export function playClockExpired(): void {
  const ac = audioCtx();
  if (!ac) return;
  tone(ac, ac.currentTime, 740, 0.14, 0.09);
  tone(ac, ac.currentTime + 0.16, 587, 0.14, 0.09);
  tone(ac, ac.currentTime + 0.32, 494, 0.22, 0.09);
}

/** The opponent's time ran out — the claim button just appeared. */
export function playClaimReady(): void {
  const ac = audioCtx();
  if (!ac) return;
  tone(ac, ac.currentTime, 587);
  tone(ac, ac.currentTime + 0.18, 880, 0.25);
}

let noise: AudioBuffer | null = null;

/** One hard plastic tick: a millisecond-scale high-passed noise transient
 * plus two short resonant pings (the disc's own ring), no low end. */
function click(ac: AudioContext, at: number, peak: number, pitch: number): void {
  if (!noise) {
    noise = ac.createBuffer(1, Math.ceil(ac.sampleRate * 0.02), ac.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = ac.createBufferSource();
  src.buffer = noise;
  const high = ac.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 3000;
  const tick = ac.createGain();
  tick.gain.setValueAtTime(peak, at);
  tick.gain.exponentialRampToValueAtTime(0.0001, at + 0.006);
  src.connect(high).connect(tick).connect(ac.destination);
  src.start(at);
  src.stop(at + 0.02);

  for (const [freq, level, decay] of [
    [pitch, 0.35, 0.03],
    [pitch * 1.59, 0.2, 0.018],
  ] as const) {
    const osc = ac.createOscillator();
    osc.frequency.value = freq;
    const ring = ac.createGain();
    ring.gain.setValueAtTime(peak * level, at);
    ring.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(ring).connect(ac.destination);
    osc.start(at);
    osc.stop(at + decay + 0.01);
  }
}

/** A disc landing — a plastic clack with a faint rattle against the slot a
 * few milliseconds behind it, scheduled `delay` seconds out so it lines up
 * with the drop animation's impact. `strength` (0–1) scales it: the rebound
 * is a quieter echo. */
export function playDiscLand(delay = 0, strength = 1): void {
  const ac = audioCtx();
  if (!ac) return;
  const at = ac.currentTime + delay;
  const peak = 0.3 * strength;
  const pitch = 2400 + Math.random() * 500;
  click(ac, at, peak, pitch);
  click(ac, at + 0.008 + Math.random() * 0.01, peak * 0.3, pitch * 1.07);
}
