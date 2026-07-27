/**
 * Tiny synthesized alert sounds via Web Audio — no assets, no dependencies.
 * Browsers refuse audio before the first user gesture; every failure here is
 * silent by design (a missed chime must never break a game action).
 */

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
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
