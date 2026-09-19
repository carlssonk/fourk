import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // Hold the real loading screen without starting a blockchain transaction.
  await page.evaluate(async () => {
    const { startConnecting } = await import("/src/shared/state/actions.ts");
    startConnecting("Creating your game", [
      "Connecting to the game",
      "Preparing your seat",
      "Creating your invite link",
    ]);
  });
  await expect(page.getByRole("heading", { name: "Creating your game" })).toBeVisible();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 740, height: 360 },
]) {
  test(`loading content is centered at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const group = page.getByRole("status").locator(":scope > div");
    const box = await group.boundingBox();
    expect(box!.y).toBeGreaterThan(0);
    expect(box!.y + box!.height).toBeLessThan(viewport.height);
    const center = box!.y + box!.height / 2;
    expect(center).toBeGreaterThan(viewport.height * 0.4);
    expect(center).toBeLessThan(viewport.height * 0.56);
    expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(viewport.height);
    await expect(page.getByRole("list")).toHaveCSS("text-align", "left");
    if (viewport.width === 390 || viewport.width === 1440) {
      await page.screenshot({ path: `test-results/creating-game-${viewport.width}.png` });
    }
  });
}

test("loading content stays scrollable on very short screens with an error banner", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 200 });
  await page.evaluate(async () => {
    const { reportError } = await import("/src/shared/state/actions.ts");
    reportError(new Error("Connection interrupted. Please try again."));
  });
  const banner = page.getByRole("alert");
  await expect(banner).toBeVisible();
  const status = page.getByRole("status");
  const bannerBox = await banner.boundingBox();
  const statusBox = await status.boundingBox();
  expect(statusBox!.y).toBeGreaterThanOrEqual(bannerBox!.y + bannerBox!.height);
  const lastStep = page.getByRole("listitem").last();
  await lastStep.scrollIntoViewIfNeeded();
  await expect(lastStep).toBeInViewport();
  const title = page.getByRole("heading", { name: "Creating your game" });
  await title.scrollIntoViewIfNeeded();
  await expect(title).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});
