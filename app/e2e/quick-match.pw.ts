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

test("a Quick Match host leaves instead of kicking", async ({ page, browser }) => {
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
    // Both seats leave rather than kick or cancel; the host's exit is open
    // at once, the joiner's waits out the covenant's clock.
    const [host, guest] = (await page
      .getByRole("button", { name: "Leave game", exact: true })
      .count())
      ? [page, other]
      : [other, page];
    for (const player of [page, other])
      await expect(player.getByRole("button", { name: /Kick opponent|Cancel game/ })).toHaveCount(
        0,
      );
    await expect(guest.getByRole("button", { name: /^Leave game in \d+:\d\d$/ })).toBeDisabled();
    await host.getByRole("button", { name: "Leave game", exact: true }).click();
    await host
      .getByRole("dialog", { name: "Leave game?", exact: true })
      .getByRole("button", { name: "Leave game", exact: true })
      .click();
    // Home, not a fresh private lobby.
    await expect(host.getByRole("button", { name: "Quick Match", exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(host.getByLabel("Invite link", { exact: true })).toHaveCount(0);
    // The same endings the kick test accepts (lobby-exits.pw.ts).
    await expect(guest.getByRole("dialog")).toContainText(/called off|game has ended/i, {
      timeout: 60_000,
    });
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
