import { atom } from "jotai";

/** The account panel's views; null = closed. Its own slice so any screen
 * (e.g. an invite that needs funds) can deep-link straight to a view. */
export type AccountView =
  | "overview"
  | "add-funds"
  | "cash-out"
  | "backup"
  | "sign-in"
  /** The guest landing: what an account is for, and the two ways to get one. */
  | "get-started"
  /** The freshly generated phrase, and nothing else, until the player
   * confirms they've written it down — confirming is what creates the
   * account. */
  | "new-phrase"
  /** This device forgets the active account's phrase — the one act in the
   * panel that can cost money if the player holds no other copy. */
  | "remove";

export const accountPanelAtom = atom<AccountView | null>(null);
