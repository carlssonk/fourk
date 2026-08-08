import { useAtomValue } from "jotai";
import { confirmAtom } from "@shared/state";
import { Dialog } from "./Dialog";

/**
 * The app's answer to `window.confirm`: same question, same two outcomes,
 * but staged like the rest of the game. Mounted once at the root — every
 * caller goes through `askConfirm`.
 */
export const ConfirmDialog = () => {
  const req = useAtomValue(confirmAtom);
  if (!req) return null;
  return (
    <Dialog
      title={req.title}
      tone={req.danger ? "loss" : "accent"}
      width="max-w-105"
      onDismiss={() => req.answer(false)}
    >
      <p className="mb-5 text-sm text-dim">{req.body}</p>
      {/* Backing out sits first and quiet; the deliberate choice is on the
       * right, where the eye lands last. */}
      <div className="flex flex-wrap justify-end gap-2">
        <button className="btn btn-muted" onClick={() => req.answer(false)}>
          Never mind
        </button>
        <button
          className={`btn ${req.danger ? "btn-danger" : ""}`}
          onClick={() => req.answer(true)}
        >
          {req.confirm}
        </button>
      </div>
    </Dialog>
  );
};
