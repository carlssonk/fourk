import { useEffect, useMemo, useRef } from "react";
import { buildAppearance, codeToGenes, drawAvatar } from "@shared/lib/avatar";

interface Props {
  /** 16-hex gene code (see shared/lib/avatar). */
  code: string;
  size?: number;
  animate?: boolean;
  /** Fill the parent's width (staying 1:1) instead of a fixed pixel size;
   * `size` then only sets the bitmap resolution. */
  fluid?: boolean;
  className?: string;
}

/** A procedural avatar on a canvas: idle-bobbing and blinking when animated,
 * a single fixed frame otherwise (and always under prefers-reduced-motion). */
export const Avatar = ({
  code,
  size = 64,
  animate = true,
  fluid = false,
  className = "",
}: Props) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const appearance = useMemo(() => buildAppearance(codeToGenes(code)), [code]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      drawAvatar(cv, appearance, 1200);
      return;
    }
    let raf = requestAnimationFrame(function loop(t) {
      drawAvatar(cv, appearance, t);
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  }, [appearance, animate]);

  // The key remount matters: drawAvatar upscales the bitmap for hi-dpi once
  // per canvas element, so a size change needs a fresh element. The CSS size
  // is pinned here because that upscale grows the width/height attributes.
  return (
    <canvas
      key={size}
      ref={ref}
      width={size}
      height={size}
      style={fluid ? { width: "100%", height: "auto" } : { width: size, height: size }}
      className={className}
      aria-hidden
    />
  );
};
