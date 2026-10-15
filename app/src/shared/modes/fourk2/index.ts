import type { GameMode } from "../types";
import { sharedAutoActions } from "../common";
import { fourk2Engine } from "./engine";
import { fourk2View } from "./view";
import { fourk2Actions, fourk2AutoActions, fourk2CapAction } from "./actions";

export const fourk2Mode: GameMode = {
  meta: {
    key: "fourk2",
    label: "Fourk",
    blurb: "Both players pick a column in secret, then the discs drop together.",
    moveNoun: "pick",
  },
  ...fourk2Engine,
  ...fourk2View,
  actions: fourk2Actions,
  // The cap crank is the mode's own (its gate depends on the round state);
  // the shared draw crank applies as is.
  autoActions: (m, ctx) => [
    ...fourk2AutoActions(m, ctx),
    ...sharedAutoActions(fourk2Mode, m, ctx.myPk).filter((a) => a.key !== "sudden-death"),
    ...fourk2CapAction(m, ctx.myPk),
  ],
};
