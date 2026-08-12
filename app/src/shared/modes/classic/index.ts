import type { GameMode } from "../types";
import { sharedAutoActions } from "../common";
import { classicEngine } from "./engine";
import { classicView } from "./view";
import { classicActions } from "./actions";

export const classicMode: GameMode = {
  meta: {
    key: "classic",
    label: "Classic",
    blurb: "Traditional turns, players alternate dropping discs.",
    inviteBlurb: "Connect four discs in a row to win — you play ",
    moveNoun: "move",
  },
  ...classicEngine,
  ...classicView,
  actions: classicActions,
  autoActions: (m) => sharedAutoActions(classicMode, m),
};
