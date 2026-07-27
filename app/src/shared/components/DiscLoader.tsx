/** Three game discs hopping in turn — the app's loading pulse. Decorative;
 * pair it with visible text. Still under prefers-reduced-motion. */
export const DiscLoader = ({ className = "" }: { className?: string }) => (
  <span aria-hidden className={`inline-flex items-center gap-1.5 ${className}`}>
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        className={`size-2.5 rounded-full ${i === 1 ? "bg-blue" : "bg-red"} motion-safe:animate-[disc-hop_0.9s_ease-in-out_infinite]`}
        style={{ animationDelay: `${i * 0.12}s` }}
      />
    ))}
  </span>
);
