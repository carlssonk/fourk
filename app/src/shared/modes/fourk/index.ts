import type { GameMode } from "../types";
import { sharedAutoActions } from "../common";
import { fourkEngine } from "./engine";
import { fourkView } from "./view";
import { fourkActions, fourkAutoActions } from "./actions";

export const fourkMode: GameMode = {
  meta: {
    key: "fourk",
    label: "Fourk",
    blurb:
      "The signature mode: both players pick a column in secret, then the discs drop together — collisions stack.",
    inviteBlurb:
      "Fourk mode: each round you both pick a column in secret, then the discs drop together. Connect four to win — you play ",
    moveNoun: "pick",
  },
  ...fourkEngine,
  ...fourkView,
  actions: fourkActions,
  autoActions: (m, ctx) => [...fourkAutoActions(m, ctx), ...sharedAutoActions(fourkMode, m)],
};
