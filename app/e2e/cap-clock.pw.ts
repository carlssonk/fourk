import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page, seconds = 86400, failFirst = false) {
  const time = new Date("2026-09-18T12:00:00Z");
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await page.goto("/");
  await page.evaluate(
    async (options) => {
      const { mountCapHeader } = await import("/e2e/fixtures/cap-header.tsx");
      mountCapHeader(options.seconds, options.failFirst);
    },
    { seconds, failFirst },
  );
}

test("game limit counts seconds without resetting on a move and hides after the game", async ({
  page,
}) => {
  await mount(page);
  const timer = page.getByRole("timer", { name: "Game time remaining" });
  await expect(timer).toHaveText("24:00:00");
  await expect(timer).toHaveAttribute("aria-live", "off");
  await page.clock.runFor(2000);
  await expect(timer).toHaveText("23:59:58");
  await page.getByRole("button", { name: "Next move", exact: true }).click();
  await expect(timer).toHaveText("23:59:58");
  await page.clock.runFor(28000);
  await expect(timer).toHaveText("23:59:30");
  await expect(page.getByTestId("cap-reads")).toHaveText("2");
  await page.getByRole("button", { name: "End game", exact: true }).click();
  await expect(timer).toHaveCount(0);
});

test("game limit remains centered without crowding header controls", async ({ page }) => {
  await mount(page);
  const timer = page.getByRole("timer", { name: "Game time remaining" });
  for (const width of [320, 390, 640, 767, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 740 });
    await expect(timer).toBeVisible();
    const box = await timer.boundingBox();
    expect(Math.abs(box!.x + box!.width / 2 - width / 2)).toBeLessThan(1);
    const header = page.locator("header").filter({ has: timer });
    expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const home = await header.getByRole("button", { name: "Home", exact: true }).boundingBox();
    const help = await header
      .getByRole("button", { name: "How to play", exact: true })
      .boundingBox();
    const details = await header
      .locator("span:visible")
      .filter({ hasText: /^Fourk · / })
      .boundingBox();
    expect(details!.x + details!.width).toBeLessThanOrEqual(help!.x);
    if (width >= 768) {
      expect(help!.y).toBe(home!.y);
      expect((await header.boundingBox())!.height).toBeLessThanOrEqual(60);
      expect(box!.x + box!.width).toBeLessThan(help!.x);
    } else {
      expect(help!.y).toBeGreaterThanOrEqual(home!.y + home!.height);
    }
    expect(box!.x + box!.width).toBeLessThan(home!.x);
    await expect(header).not.toContainText(/pot|stake|payout/);
    await page.screenshot({ path: `test-results/game-limit-${width}.png` });
  }
});

test("game limit clamps at zero and uncapped games have no countdown", async ({ page }) => {
  await mount(page, 1);
  const timer = page.getByRole("timer", { name: "Game time remaining" });
  await expect(timer).toHaveText("00:00:01");
  await page.clock.runFor(3000);
  await expect(timer).toHaveText("00:00:00");
  await page.getByRole("button", { name: "Remove limit", exact: true }).click();
  await expect(timer).toHaveCount(0);
});

test("game limit retries a failed initial network query", async ({ page }) => {
  await mount(page, 86400, true);
  await expect(page.getByTestId("cap-reads")).toBeVisible();
  const timer = page.getByRole("timer", { name: "Game time remaining" });
  await expect(timer).toHaveCount(0);
  await page.clock.runFor(30000);
  await expect(timer).toHaveText("23:59:30");
});
