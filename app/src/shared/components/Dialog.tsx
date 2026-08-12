import { useEffect, useRef, type ReactNode } from "react";

/** The colour a dialog's headline is spoken in. */
export type DialogTone = "accent" | "win" | "loss" | "neutral";

interface Props {
  /** The header's text — and the dialog's accessible name. */
  title: string;
  tone?: DialogTone;
  /** Give the title the whole header, big and in the tone's colour: for a
   * dialog whose title IS the news (the verdict), not a label on a form. */
  headline?: boolean;
  /** Escape and a click beside the card. Leave it off for a dialog that has
   * to be answered rather than waved away. */
  onDismiss?: () => void;
  /** A ‹ in the header: step back inside the dialog without closing it.
   * Navigation lives up here so it never sits in the body dressed like one
   * of the screen's own actions. Standard header only — headline dialogs
   * are verdicts, they have nowhere to go back to. */
  onBack?: () => void;
  /** A near-opaque backdrop for dialogs with a secret on screen (recovery
   * phrase); the default backdrop stays light enough to keep the page in
   * view. */
  shroud?: boolean;
  /** Tailwind max-width for the card. */
  width?: string;
  /** Extra classes for the body panel (alignment, padding overrides). */
  className?: string;
  /** Rendered inside the top layer but behind the card — decoration that
   * wants the whole screen, like the winner's coins. */
  behind?: ReactNode;
  children: ReactNode;
}

const TONE_TEXT: Record<DialogTone, string> = {
  accent: "text-accent",
  win: "text-ok",
  loss: "text-red",
  neutral: "text-ink",
};

/**
 * The shell every dialog in the app wears: a flat, near-black plane with a
 * hairline edge, a header separated by another hairline, and the page
 * blurred out behind it.
 *
 * It's a real <dialog> opened with showModal, so the top layer, the focus
 * trap, the inert page behind it and Escape are the platform's job rather
 * than ours — the element itself is the full-viewport centring frame, and
 * the card is its only child.
 */
export const Dialog = ({
  title,
  tone = "accent",
  headline = false,
  onDismiss,
  onBack,
  shroud = false,
  width = "max-w-110",
  className = "",
  behind,
  children,
}: Props) => {
  const ref = useRef<HTMLDialogElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // Through a ref so the handlers below don't need re-binding when a caller
  // passes a fresh closure on every render.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    const el = ref.current;
    if (!el || el.open) return;
    el.showModal();
    // showModal parks focus on the first focusable thing it finds, which is
    // the ✕ — so every dialog would open with "leave" pre-selected, and a
    // destructive one with its dangerous button one Enter away. Park it on
    // the card instead; Tab from there still walks the controls in order.
    card.current?.focus();
    return () => el.close();
  }, []);

  // When the content swaps inside an open dialog (the account panel walking
  // between views), glide the card between its two natural heights instead
  // of snapping. CSS can't transition height:auto, so: watch the content
  // wrapper (which is never animated, so it reports only real changes) and
  // run a WAAPI animation on the card — which lands back on auto height
  // when it finishes, keeping layout content-driven the rest of the time.
  useEffect(() => {
    const cardEl = card.current;
    const innerEl = inner.current;
    if (!cardEl || !innerEl) return;
    let anim: Animation | undefined;
    let prev = cardEl.offsetHeight;
    const ro = new ResizeObserver(() => {
      // A still-running glide holds the card at a mid-flight height —
      // cancel it before measuring or `next` reads that frame, not the
      // content's real height.
      anim?.cancel();
      const next = cardEl.offsetHeight;
      if (next === prev || matchMedia("(prefers-reduced-motion: reduce)").matches) {
        prev = next;
        return;
      }
      anim = cardEl.animate([{ height: `${prev}px` }, { height: `${next}px` }], {
        duration: 220,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      });
      prev = next;
    });
    ro.observe(innerEl);
    return () => {
      anim?.cancel();
      ro.disconnect();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={shroud ? "dlg dlg-shroud" : "dlg"}
      // Escape: always take the browser's close away and route it through
      // the caller, so React's state stays the one thing that decides
      // whether this dialog exists — and a dialog with no onDismiss simply
      // can't be escaped.
      onCancel={(e) => {
        e.preventDefault();
        dismiss.current?.();
      }}
      // Only clicks on the frame itself — anything on the card bubbles from
      // a descendant and is left alone.
      onClick={(e) => {
        if (e.target === ref.current) dismiss.current?.();
      }}
    >
      {behind}
      <div ref={card} tabIndex={-1} className={`overlay-pop dlg-card w-full outline-none ${width}`}>
        {/* The height-glide's measuring stick: never animated itself, so a
         * resize here is always a real content change. */}
        <div ref={inner}>
          <div
            className={`dlg-head ${
              headline ? "px-5 py-5 text-center" : "flex items-center gap-2 px-5 py-3.5"
            }`}
          >
            {!headline && onBack && (
              <button
                type="button"
                aria-label="Back"
                onClick={onBack}
                className="-ml-1.5 cursor-pointer rounded-md px-1 py-0.5 text-dim transition-colors hover:bg-white/8 hover:text-ink"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                </svg>
              </button>
            )}
            <h2
              className={
                headline
                  ? `text-3xl font-bold ${TONE_TEXT[tone]}`
                  : "flex-1 font-semibold text-ink"
              }
            >
              {title}
            </h2>
            {onDismiss && (
              <button
                type="button"
                aria-label="Close"
                className={`cursor-pointer rounded-md px-1.5 text-lg leading-none text-dim transition-colors hover:bg-white/8 hover:text-ink ${
                  headline ? "absolute top-3 right-3" : "-mr-1.5"
                }`}
                onClick={onDismiss}
              >
                ✕
              </button>
            )}
          </div>
          <div className={`px-5 py-4 ${className}`}>{children}</div>
        </div>
      </div>
    </dialog>
  );
};
