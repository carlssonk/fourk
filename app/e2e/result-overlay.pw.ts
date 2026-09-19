import { expect, test } from "@playwright/test";

for (const tone of ["win", "loss"] as const) {
  for (const action of ["play", "home", "board"] as const) {
    test(`${tone} dialog supports ${action} without View board button`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 740 });
      await page.goto("/");
      await page.evaluate(async (outcome) => {
        const { mountResultOverlay } = await import("/e2e/fixtures/result-overlay.tsx");
        mountResultOverlay(outcome);
      }, tone);
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "View board", exact: true })).toHaveCount(0);
      for (const name of ["Play again", "Back to start"]) {
        const button = dialog.getByRole("button", { name, exact: true });
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
      if (action === "board") await page.keyboard.press("Escape");
      else
        await dialog
          .getByRole("button", {
            name: action === "play" ? "Play again" : "Back to start",
            exact: true,
          })
          .click();
      await expect(page.getByTestId("result-action")).toHaveText(action);
      await expect(dialog).toHaveCount(0);
    });
  }
}
