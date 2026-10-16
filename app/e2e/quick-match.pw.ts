import { expect, test, type Page } from "@playwright/test";

// Needs the matchmaker: browser.sh runs the sweeper process beside the app
// and points VITE_SWEEPER_URL at it.

const quickMatch = async (player: Page, name: string, mode = "Fourk") => {
  await player.goto("/");
  await player.getByLabel("Username", { exact: true }).fill(name);
  await player.getByRole("button", { name: mode, exact: true }).click();
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

test("Classic Quick Match pairs Classic players, who leave rather than kick", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await quickMatch(page, "Ada", "Classic");
    await expect(page.getByText("Free Classic game, 2 min per move.")).toBeVisible();
    await quickMatch(other, "Bo", "Classic");
    // Ada hosts and moves first; Bo waits for her disc.
    await expect(
      page.getByRole("button", { name: "drop a disc in column 1", exact: true }),
    ).toBeEnabled({ timeout: 90_000 });
    await expect(other.getByRole("group", { name: /^Player: Ada,/ })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator("main header")).toContainText("Classic · 2 min per move");
    // No covenant flag in Classic: the record marks the game paired, so the
    // host leaves rather than kicks, and the joiner waits out one clock.
    await expect(page.getByRole("button", { name: "Leave game", exact: true })).toBeEnabled();
    await expect(other.getByRole("button", { name: /^Leave game in / })).toBeDisabled();
    for (const player of [page, other])
      await expect(player.getByRole("button", { name: /Kick opponent|Cancel game/ })).toHaveCount(
        0,
      );
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

test("when the host leaves, the joiner sees a cancelled game", async ({ page, browser }) => {
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
    // Ada queued first, so she hosts; she leaves.
    await page.getByRole("button", { name: "Leave game", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Leave game?", exact: true })
      .getByRole("button", { name: "Leave game", exact: true })
      .click();
    // What Bo's game recorded as its ending, not just what the dialog shows.
    await expect
      .poll(
        () =>
          other.evaluate(
            () =>
              JSON.parse(JSON.parse(localStorage.getItem("fourk.matches") ?? "[]")[0] ?? "{}")
                .result ?? null,
          ),
        { timeout: 60_000 },
      )
      .toMatch(/called the game off/);
    await expect(other.getByRole("dialog", { name: "Game cancelled" })).toContainText(
      "This game ended before the first move.",
    );
  } finally {
    await otherContext.close();
  }
});

test("a host whose opponent cancels right after pairing goes back to looking", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await quickMatch(page, "Ada");
    await expect(page.getByText("Looking for an opponent", { exact: true })).toBeVisible();
    await quickMatch(other, "Bo");
    // Paired: Ada hosts and starts opening; Bo changes his mind at once.
    await expect(page.getByText(/Found an opponent/)).toBeVisible({ timeout: 30_000 });
    await other.getByRole("button", { name: "Cancel", exact: true }).click();
    // The matchmaker drops Bo; Ada's panel says so, her lobby kept.
    await expect(page.getByText("Looking for an opponent", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    // Bo tries again and lands straight in Ada's lobby.
    await other.getByRole("button", { name: "Quick Match", exact: true }).click();
    for (const player of [page, other])
      await expect(
        player.getByRole("button", { name: "drop a disc in column 1", exact: true }),
      ).toBeEnabled({ timeout: 90_000 });
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
