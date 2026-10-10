import { expect, test } from "@playwright/test";

test("home promotes optional stakes without adding money copy to free gameplay", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await expect(page.getByText("Want to play for stakes?", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("play for stakes");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "about", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("You can also play for stakes.");
  await expect(page.getByRole("dialog")).toContainText("any stakes are test money");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Private Game", exact: true }).click();
  await expect(page.getByLabel("Invite link", { exact: true })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/\b(stakes?|pot|payout|winnings)\b/i);
  await page.getByRole("button", { name: "Cancel game", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toContainText(/\b(stakes?|pot|payout|refund)\b/i);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel game", exact: true }).click();
  await expect(page.getByText("Want to play for stakes?", { exact: false })).toBeVisible();
});

test("move timer help appears above the button", async ({ page }) => {
  await page.goto("/");
  const help = page.getByRole("button", { name: "About Move timer", exact: true });
  await help.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  const box = await tooltip.boundingBox();
  const button = await help.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(button!.y);
});

test("move timer help uses the full button hover area", async ({ page }) => {
  await page.goto("/");
  const help = page.getByRole("button", { name: "About Move timer", exact: true });
  const tooltip = page.getByRole("tooltip");
  const box = await help.boundingBox();
  for (const position of [
    { x: 2, y: 2 },
    { x: box!.width - 2, y: 2 },
    { x: 2, y: box!.height - 2 },
    { x: box!.width - 2, y: box!.height - 2 },
  ]) {
    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCount(0);
    await help.hover({ position });
    await expect(tooltip).toBeVisible({ timeout: 2000 });
  }
});

test("move timer help supports hover, keyboard, dismissal, and mode changes", async ({ page }) => {
  await page.goto("/");
  const help = page.getByRole("button", { name: "About Move timer", exact: true });
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveCount(0);
  const row = help.locator("..");
  const bounds = await row.boundingBox();
  await row.hover({ position: { x: 2, y: bounds!.height / 2 } });
  await expect(tooltip).toHaveCount(0);
  await row.hover({ position: { x: bounds!.width - 2, y: bounds!.height / 2 } });
  await expect(tooltip).toHaveCount(0);
  await help.hover();
  await expect(tooltip).toHaveText(
    "Time allowed for each move. If you run out, your opponent can claim the win.",
  );
  await expect(tooltip).not.toContainText(/winnings|pot|stake|payout/i);
  await tooltip.hover();
  await expect(tooltip).toBeVisible();
  await row.hover({ position: { x: bounds!.width - 2, y: bounds!.height / 2 } });
  await expect(tooltip).toHaveCount(0);
  await help.focus();
  await expect(tooltip).toBeVisible();
  await expect(help).toHaveAccessibleDescription(/your opponent can claim the win/);
  await help.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await expect(help).toBeFocused();
  await help.press("Enter");
  await expect(tooltip).toBeVisible();
  await help.press("Tab");
  await expect(tooltip).toHaveCount(0);
  await page.getByRole("button", { name: "Classic", exact: true }).click();
  await help.click();
  await expect(tooltip).toHaveText(
    "Time allowed for each move. If you run out, your opponent can claim the win.",
  );
  await page.locator("h2").first().click();
  await expect(tooltip).toHaveCount(0);
  await page.getByRole("button", { name: "1 min", exact: true }).click();
  await expect(page.getByRole("button", { name: "1 min", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("move timer help opens and closes by touch without mobile overflow", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await page.goto(process.env.PLAYTEST_URL ?? "http://localhost:5173");
    const help = page.getByRole("button", { name: "About Move timer", exact: true });
    await help.tap();
    await expect(page.getByRole("tooltip")).toBeVisible();
    const box = await page.getByRole("tooltip").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(740);
    const button = await help.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(button!.y);
    await page.screenshot({ path: "test-results/move-timer-help-mobile.png" });
    await help.tap();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await help.tap();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.locator("h2").first().tap();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
