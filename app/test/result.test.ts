import { expect, test } from "vitest";
import { resultTone } from "../src/shared/lib/result";
import { DRAW_MESSAGE, SUDDEN_DEATH_MESSAGE } from "../src/shared/modes/common";

test("a draw with no winner is neutral, never a loss", () => {
  expect(resultTone(DRAW_MESSAGE)).toBe("neutral");
  expect(resultTone(SUDDEN_DEATH_MESSAGE)).toBe("neutral");
});

test("both timeout loss wordings show a loss", () => {
  expect(resultTone("You connected four. You win!")).toBe("win");
  expect(resultTone("The round timer ran out and your opponent claimed the pot.")).toBe("loss");
  expect(resultTone("The move timer ran out and your opponent claimed the win.")).toBe("loss");
  expect(resultTone("Your opponent ran out of time — you win by timeout. 🎉")).toBe("win");
});
