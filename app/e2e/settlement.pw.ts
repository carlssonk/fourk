import { expect, test } from "@playwright/test";

for (const failure of ["sequence", "connection", "schedule", "age"] as const) {
  test(`automatic payout recovers after a ${failure} failure`, async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Private Game", exact: true }).click();
    await expect(page.getByLabel("Invite link", { exact: true })).toBeVisible();
    await page.evaluate(async (kind) => {
      const { mountPayoutRetry } = await import("/e2e/fixtures/autopilot.tsx");
      mountPayoutRetry(kind);
    }, failure);
    await expect(page.getByTestId("payout-retry")).toHaveText("settled", { timeout: 8000 });
  });
}

test("a Fourk winner and opponent both reach the settled result", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await page.setViewportSize({ width: 320, height: 740 });
    await other.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "change", exact: true }).click();
    await page.getByRole("button", { name: "1 min", exact: true }).click();
    await page.getByRole("button", { name: "Private Game", exact: true }).click();
    await expect(page.getByLabel("Invite link", { exact: true })).toBeVisible();
    await other.goto(await page.getByLabel("Invite link", { exact: true }).inputValue());
    await other.getByRole("button", { name: "Join", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "drop a disc in column 1", exact: true }),
    ).toBeEnabled();
    for (let round = 0; round < 4; round++) {
      await Promise.all([
        page.getByRole("button", { name: "drop a disc in column 1", exact: true }).click(),
        other
          .getByRole("button", { name: `drop a disc in column ${round < 2 ? 2 : 3}`, exact: true })
          .click(),
      ]);
      for (const player of [page, other]) {
        await expect
          .poll(() =>
            player.evaluate(
              () => JSON.parse(JSON.parse(localStorage.getItem("fourk.matches")!)[0]).round,
            ),
          )
          .toBe(round + 1);
      }
    }
    await expect
      .poll(() =>
        page.evaluate(
          () => JSON.parse(JSON.parse(localStorage.getItem("fourk.matches")!)[0]).pendingWin,
        ),
      )
      .toBe(1);
    // The game result appears before settlement; free players never see money copy.
    await expect(page.getByRole("dialog", { name: "You win!", exact: true })).toBeVisible();
    await expect(other.getByRole("dialog", { name: "You lose", exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/free-win-mobile.png" });
    for (const player of [page, other]) {
      await expect(player.locator("main")).not.toContainText(
        /\b(payout|pot|stake|refund|winnings|challenge window)\b/i,
      );
      expect(await player.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        await player.evaluate(
          () => JSON.parse(JSON.parse(localStorage.getItem("fourk.matches")!)[0]).result,
        ),
      ).toBeUndefined();
    }
    // Leaving the result early preserves the unfinished settlement record.
    await other
      .getByRole("dialog")
      .getByRole("button", { name: "Back to start", exact: true })
      .click();
    // Reopened from the list, a finished game skips the result card (the
    // list already said how it ended) and opens on the final board.
    await other.getByRole("button").filter({ hasText: "You lose" }).click();
    await expect(other.getByRole("button", { name: "Play again", exact: true })).toBeVisible();
    await expect(other.getByRole("dialog")).toHaveCount(0);
    // An already-pending win must also resume after a refresh — quietly.
    await page.reload();
    await expect(page.getByRole("button", { name: "Play again", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The visual result must not disable the real settlement automation.
    for (const player of [page, other]) {
      await expect
        .poll(
          () =>
            player.evaluate(
              () => JSON.parse(JSON.parse(localStorage.getItem("fourk.matches")!)[0]).result,
            ),
          { timeout: 95_000 },
        )
        .toBeTruthy();
      await expect(player.locator("main")).not.toContainText(
        /\b(payout|pot|stake|refund|winnings|challenge window)\b/i,
      );
    }
    // Settlement must not reopen a dismissed result dialog.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Play again", exact: true }).click();
    await expect(page.getByLabel("Invite link", { exact: true })).toBeVisible();
  } finally {
    await otherContext.close().catch(() => {});
  }
});
