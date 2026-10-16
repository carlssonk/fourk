import { expect, test } from "@playwright/test";

for (const mode of ["Fourk", "Classic"] as const) {
  test(`${mode} game has responsive controls, rules, and an invite below the board`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await page.getByLabel("Username").fill("FriendlyPlayer");
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.getByRole("button", { name: "change", exact: true }).click();
    await page.getByRole("button", { name: "1 min", exact: true }).click();
    await page.getByRole("button", { name: "Private Game", exact: true }).click();
    await expect(page.getByLabel("Invite link", { exact: true })).toBeVisible();
    const header = page.locator("main header");
    await expect(header).toContainText(`${mode} · 1 min per ${mode === "Fourk" ? "pick" : "move"}`);
    await expect(header.getByRole("button", { name: "Home", exact: true })).toBeVisible();
    const gameUrl = page.url();
    const inviteLink = await page.getByLabel("Invite link", { exact: true }).inputValue();
    await header.getByRole("button", { name: "Home", exact: true }).click();
    await expect(page.getByRole("button", { name: "Private Game", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto(gameUrl);
    await expect(page.getByLabel("Invite link", { exact: true })).toHaveValue(inviteLink);
    await expect(page.getByRole("button", { name: /^(Account|Your account)$/ })).toHaveCount(0);
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
      { width: 320, height: 740 },
      { width: 740, height: 360 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => window.scrollTo(0, 0));
      const board = await page.locator(".board-frame").boundingBox();
      const invite = await page.getByRole("region", { name: "Invite an opponent" }).boundingBox();
      const controls = await header.boundingBox();
      expect(board!.y).toBeGreaterThan(controls!.y + controls!.height);
      expect(invite!.y).toBeGreaterThanOrEqual(board!.y + board!.height);
      expect(board!.x).toBeGreaterThanOrEqual(15);
      expect(board!.x + board!.width).toBeLessThanOrEqual(viewport.width - 15);
      const name = page.locator('[title="FriendlyPlayer"]');
      await expect(name).toBeVisible();
      expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (viewport.width < 500) expect(board!.width).toBeGreaterThan(viewport.width - 40);
      if (viewport.height >= 720)
        expect(invite!.y + invite!.height).toBeLessThanOrEqual(viewport.height - 15);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      await page.screenshot({
        path: `test-results/game-${mode.toLowerCase()}-${viewport.width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 320, height: 740 });
    await page.getByRole("button", { name: "How to play", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `How to play ${mode}` });
    await expect(dialog).toContainText("does not pause the game");
    await expect(dialog).toContainText(
      mode === "Fourk" ? "choose a column in secret" : "Take turns",
    );
    await expect(dialog).not.toContainText(/\b(stake|pot|payout|winnings)\b/i);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "How to play", exact: true })).toBeFocused();
    const sound = page.getByRole("button", { name: "Sound", exact: true });
    await expect(sound).toHaveAttribute("aria-pressed", "true");
    await sound.click();
    await expect(sound).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await expect(sound).toHaveAttribute("aria-pressed", "false");
    await sound.click();
    await expect(sound).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("main")).not.toContainText(/\b(stake|pot|payout|winnings)\b/i);
    await page.getByRole("button", { name: "Cancel game", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("The invite link will no longer work.");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel game", exact: true })
      .click();
    await expect(page.getByRole("button", { name: "Private Game", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
