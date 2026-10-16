import { expect, test, type Page } from "@playwright/test";

// Needs the matchmaker: browser.sh runs the sweeper process beside the app
// and points VITE_SWEEPER_URL at it.

const quickMatch = async (player: Page, name: string) => {
  await player.goto("/");
  await player.getByLabel("Username", { exact: true }).fill(name);
  await player.getByRole("button", { name: "Quick Match", exact: true }).click();
};

test("two players who press Quick Match end up in the same game", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await quickMatch(page, "Ada");
    await expect(page.getByText("Looking for an opponent", { exact: true })).toBeVisible();
    await quickMatch(other, "Bo");
    for (const player of [page, other])
      await expect(
        player.getByRole("button", { name: "drop a disc in column 1", exact: true }),
      ).toBeEnabled({ timeout: 90_000 });
    // Each sees the other's name, and neither was shown an invite link.
    await expect(page.getByRole("group", { name: /^Player: Bo,/ })).toBeVisible();
    await expect(other.getByRole("group", { name: /^Player: Ada,/ })).toBeVisible();
    for (const player of [page, other])
      await expect(player.getByLabel("Invite link", { exact: true })).toHaveCount(0);
  } finally {
    await otherContext.close();
  }
});

test("either Quick Match player can leave at once", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await quickMatch(page, "Ada");
    await expect(page.getByText("Looking for an opponent", { exact: true })).toBeVisible();
    await quickMatch(other, "Bo");
    for (const player of [page, other])
      await expect(
        player.getByRole("button", { name: "drop a disc in column 1", exact: true }),
      ).toBeEnabled({ timeout: 90_000 });
    // Both seats leave rather than kick or cancel, and neither waits: the
    // covenant waives the joiner's lobby clock in Quick Match.
    for (const player of [page, other]) {
      await expect(player.getByRole("button", { name: "Leave game", exact: true })).toBeEnabled();
      await expect(player.getByRole("button", { name: /Kick opponent|Cancel game/ })).toHaveCount(
        0,
      );
    }
    // Ada queued first, so she hosts: Bo, the joiner, leaves, the exit an
    // invite would make wait.
    await other.getByRole("button", { name: "Leave game", exact: true }).click();
    await other
      .getByRole("dialog", { name: "Leave game?", exact: true })
      .getByRole("button", { name: "Leave game", exact: true })
      .click();
    await expect(other.getByRole("button", { name: "Quick Match", exact: true })).toBeVisible({
      timeout: 60_000,
    });
    // The same endings the kick test accepts (lobby-exits.pw.ts).
    await expect(page.getByRole("dialog")).toContainText(
      /cancelled|called off|removed|game has ended/i,
      {
        timeout: 60_000,
      },
    );
  } finally {
    await otherContext.close();
  }
});

test("cancelling a search goes back to the setup card", async ({ page }) => {
  await quickMatch(page, "Ada");
  await expect(page.getByText("Looking for an opponent", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Quick Match", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "drop a disc in column 1" })).toHaveCount(0);
});
