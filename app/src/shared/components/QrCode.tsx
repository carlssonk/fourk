import { useMemo } from "react";
import { encode } from "uqr";

interface Props {
  /** What the camera should read. For a deposit that's the address itself —
   * a bare Kaspa address already carries its `kaspa:` prefix, so wallets
   * take it as-is. */
  value: string;
  /** Rendered edge length in px; the tile is square. An address fills a
   * 45-module grid, so the default leaves each module a shade over 4px —
   * about the floor for a phone camera pointed at a laptop screen. */
  size?: number;
  /** Accessible name. To anyone not holding a phone the code is decoration,
   * so it says what it encodes rather than describing the pattern. */
  label: string;
  className?: string;
}

/**
 * A QR code as one flat SVG.
 *
 * Scanners want dark on light with a quiet zone, and they get it regardless
 * of what the code is dropped onto: the light field is a rect inside the
 * viewBox rather than the parent's padding, so the margin can't be squeezed
 * away by a layout change. It's the warm paper of the palette, not white —
 * the same ink the page writes in, inverted — so a bright square in a dark
 * dialog still reads as part of the room. Binarisers only care that the two
 * tones are far apart, and #ece4d6 against #15100a is about as far as this
 * palette goes.
 */
export const QrCode = ({ value, size = 200, label, className = "" }: Props) => {
  // Encoding is a Reed–Solomon pass plus a search over eight mask patterns —
  // cheap once, wasteful on every keystroke elsewhere in the dialog.
  const { d, span } = useMemo(() => {
    // Border 4 is the quiet zone the spec asks for, counted in modules so it
    // scales with the code rather than with the CSS.
    const qr = encode(value, { border: 4, ecc: "M" });
    // One path beats a few hundred rects: same pixels, one node.
    let path = "";
    for (let y = 0; y < qr.size; y++)
      for (let x = 0; x < qr.size; x++) if (qr.data[y][x]) path += `M${x} ${y}h1v1h-1z`;
    return { d: path, span: qr.size };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      // Modules land on whole viewBox units; let the browser snap them to
      // whole pixels too rather than antialiasing every edge into mush.
      shapeRendering="crispEdges"
      className={`rounded-xl ${className}`}
    >
      <rect width={span} height={span} className="fill-ink" />
      <path d={d} className="fill-bg" />
    </svg>
  );
};
