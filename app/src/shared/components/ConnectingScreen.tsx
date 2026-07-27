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
export const ConnectingScreen = ({ connecting: { title, steps, step } }: Props) => (
  <div role="status" className="pt-16 pb-8 text-center">
    <DiscLoader className="mb-6" />
    <h2 className="mb-1.5 text-2xl font-bold">{title}</h2>
    <p className="mb-6 text-sm text-dim">Everything happens on-chain — this can take a moment.</p>
    <ol className="inline-flex flex-col items-start gap-2 text-sm">
      {steps.map((label, i) => (
        <li
          key={label}
          className={`flex items-center gap-2.5 ${i === step ? "" : "text-dim"}`}
        >
          <span className="w-4 text-center">
            {markOf(i < step ? "done" : i === step ? "active" : "todo")}
          </span>
          {label}
        </li>
      ))}
    </ol>
  </div>
);
