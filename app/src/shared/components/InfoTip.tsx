import { useEffect, useId, useRef, useState } from "react";

/** A label with an ⓘ that opens a short explanation: on hover and focus,
 * pinned by a tap (touch has no hover). `center` hangs the tooltip from the
 * middle of the label, for labels in the middle of the screen. */
export const InfoTip = ({
  label,
  help,
  align = "start",
  className = "",
}: {
  label: React.ReactNode;
  help: string;
  align?: "start" | "center";
  className?: string;
}) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const close = () => {
    pinned.current = false;
    setOpen(false);
  };
  const leaveHelp = (target: EventTarget | null) => {
    if (pinned.current || document.activeElement === button.current) return;
    if (
      target instanceof Node &&
      (button.current?.contains(target) || tooltip.current?.contains(target))
    )
      return;
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !tooltip.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className={`relative flex items-center text-dim ${className}`}>
      {label}
      <button
        ref={button}
        type="button"
        aria-label={`About ${typeof label === "string" ? label : "this"}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-describedby={open ? id : undefined}
        className="ml-0.5 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim hover:text-ink"
        onFocus={() => setOpen(true)}
        onBlur={close}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={(event) => leaveHelp(event.relatedTarget)}
        onClick={() => {
          pinned.current = !pinned.current;
          setOpen(pinned.current);
        }}
      >
        <span
          aria-hidden="true"
          className="inline-flex size-3.5 items-center justify-center rounded-full border border-current font-serif text-[10px] leading-3.5"
        >
          i
        </span>
      </button>
      {open && (
        <div
          ref={tooltip}
          id={id}
          role="tooltip"
          onMouseLeave={(event) => leaveHelp(event.relatedTarget)}
          className={`absolute bottom-full z-20 rounded-lg ${
            align === "center" ? "left-1/2 w-64 -translate-x-1/2" : "left-0 w-80 max-w-full"
          } border border-line bg-panel px-3 py-2 text-left text-xs leading-snug text-ink shadow-lg`}
        >
          {help}
        </div>
      )}
    </div>
  );
};
