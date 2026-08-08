import { KASPA_K_PATH, KASPA_RING_PATH } from "@shared/lib/kaspaMark";

/**
 * The Kaspa mark stamped into a coin face: the uneven roundel as an inner
 * border ring hugging the rim, the K in its logo position inside it. The
 * viewBox squares up around the roundel's centre (~98.3, 98.3), sized so
 * the ring spans ~92% of the face. Fills its parent — put it inside any
 * round, coloured element to make that element a Kaspa coin.
 */
export const KaspaStamp = () => (
  <svg viewBox="36.3 36.3 124 124" aria-hidden className="size-full">
    <path d={KASPA_RING_PATH} fill="none" stroke="rgba(0, 0, 0, 0.2)" strokeWidth="4" />
    <path d={KASPA_K_PATH} fill="rgba(0, 0, 0, 0.2)" />
  </svg>
);
