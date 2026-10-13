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
    moveNoun: "move",
  },
  ...classicEngine,
  ...classicView,
  actions: classicActions,
  autoActions: (m, ctx) => sharedAutoActions(classicMode, m, ctx.myPk),
};
