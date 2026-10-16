import type { Connecting } from "@shared/state";
import { DiscLoader } from "./DiscLoader";

interface Props {
  connecting: Connecting;
}

const markOf = (state: "done" | "active" | "todo") =>
  state === "done" ? (
    <span className="text-ok">✓</span>
  ) : state === "active" ? (
    <span className="text-accent motion-safe:animate-pulse">●</span>
  ) : (
    <span className="text-dim">○</span>
  );

/**
 * Full-page progress while a connect-to-game journey runs (creating a game,
 * taking a seat): the journey's steps tick off as the network work lands.
 */
export const ConnectingScreen = ({ connecting: { title, steps, step, cancel } }: Props) => (
  <div
    role="status"
    className="flex flex-1 flex-col items-center py-8 text-center before:flex-[2] after:flex-[3]"
  >
    {/* Unequal flexible space places the group just above center. On short
        screens it collapses, leaving the content in normal scrolling flow. */}
    <div className="w-full shrink-0">
      <DiscLoader className="mb-6" />
      <h2 className="mb-1.5 text-2xl font-bold">{title}</h2>
      <p className="mb-6 text-sm text-dim">This may take a few seconds.</p>
      <ol className="inline-flex max-w-full flex-col items-start gap-2 text-left text-sm">
        {steps.map((label, i) => (
          <li key={label} className={`flex items-center gap-2.5 ${i === step ? "" : "text-dim"}`}>
            <span className="w-4 shrink-0 text-center">
              {markOf(i < step ? "done" : i === step ? "active" : "todo")}
            </span>
            {label}
          </li>
        ))}
      </ol>
      {cancel && (
        <div className="mt-6">
          <button className="btn btn-muted" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  </div>
);
