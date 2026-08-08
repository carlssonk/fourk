import { atom, getDefaultStore } from "jotai";

const store = getDefaultStore();

export interface ConfirmRequest {
  title: string;
  body: string;
  /** Label on the button that goes ahead; backing out is always "Never mind". */
  confirm: string;
  /** Colours the dialog and its go-ahead button as a warning. */
  danger?: boolean;
}

export interface PendingConfirm extends ConfirmRequest {
  answer: (ok: boolean) => void;
}

export const confirmAtom = atom<PendingConfirm | null>(null);

/**
 * Ask the player to confirm, in the app's own dialog — the replacement for
 * `window.confirm`, which drags OS chrome over the game and can't say
 * anything in the app's voice. Resolves false if they back out.
 */
export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  // Nothing should be able to stack two of these — but if it ever does, the
  // one being shoved aside resolves rather than hanging its caller forever.
  store.get(confirmAtom)?.answer(false);
  return new Promise((resolve) => {
    store.set(confirmAtom, {
      ...request,
      answer: (ok) => {
        store.set(confirmAtom, null);
        resolve(ok);
      },
    });
  });
}
