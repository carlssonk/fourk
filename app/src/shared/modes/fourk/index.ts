import type { GameMode } from "../types";
import { sharedAutoActions } from "../common";
import { fourkEngine } from "./engine";
import { fourkView } from "./view";
import { fourkActions, fourkAutoActions } from "./actions";

export const fourkMode: GameMode = {
  meta: {
    key: "fourk",
    label: "Fourk",
    blurb: "Both players pick a column in secret, the discs drop together.",
    inviteBlurb:
      "Fourk mode: each round you both pick a column in secret, the discs drop together. Connect four to win. You play ",
    moveNoun: "pick",
  },
  ...fourkEngine,
  ...fourkView,
  actions: fourkActions,
  autoActions: (m, ctx) => [...fourkAutoActions(m, ctx), ...sharedAutoActions(fourkMode, m)],
};
