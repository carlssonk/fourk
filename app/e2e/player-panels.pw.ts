import { expect, test } from "@playwright/test";

for (const width of [320, 390, 640, 1440]) {
  test(`player cards stay aligned with naturally sized names at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await page.evaluate(async () => {
      const { mountPlayerPanels } = await import("/e2e/fixtures/player-panels.tsx");
      mountPlayerPanels();
    });
    const short = page.getByTestId("players-Al").locator(".card").first();
    const long = page.getByTestId("players-FriendlyPlayer").locator(".card").first();
    await expect(short).toBeVisible();
    // Measure the real font, not the fallback the page shows while the web
    // font loads (Linux's fallback is wide enough to wrap a name).
    await page.evaluate(async () => {
      await document.fonts.load('600 14px "Baloo 2 Variable"');
      await document.fonts.ready;
    });
    const shortBox = await short.boundingBox();
    const longBox = await long.boundingBox();
    expect(shortBox!.width).toBe(longBox!.width);
    expect(shortBox!.height).toBe(longBox!.height);
    expect(shortBox!.height).toBeLessThanOrEqual(68);
    expect(shortBox!.width).toBeLessThanOrEqual(160);
    const name = long.locator('[title="FriendlyPlayer"]');
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const row of await page.locator('[data-testid^="players-"]').all()) {
      const box = await row.boundingBox();
      const cards = row.locator(".card");
      const first = await cards.first().boundingBox();
      const second = await cards.last().boundingBox();
      expect(first!.width).toBe(second!.width);
      expect(first!.height).toBe(second!.height);
      await expect(cards.first()).toHaveAccessibleName(/^Your player:/);
      await expect(cards.first()).toHaveClass(/border-accent/);
      await expect(cards.last()).toHaveClass(/border-line/);
      await expect(cards.first().getByRole("timer")).toHaveCount(1);
      await expect(cards.last().getByRole("timer")).toHaveCount(0);
      await expect(cards.getByText("you", { exact: true })).toHaveCount(0);
      for (const card of await cards.all()) {
        const avatar = await card.locator("canvas, .border-dashed").boundingBox();
        const label = card.locator(".line-clamp-2");
        const labelBox = await label.boundingBox();
        expect(labelBox!.y).toBeGreaterThanOrEqual(avatar!.y + avatar!.height);
        const identity = await card.locator(".h-8").boundingBox();
        expect(
          Math.abs(identity!.x + identity!.width / 2 - labelBox!.x - labelBox!.width / 2),
        ).toBeLessThan(1);
        const cardBox = await card.boundingBox();
        expect(identity!.x).toBeGreaterThanOrEqual(cardBox!.x);
        expect(identity!.x + identity!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
        expect(
          Math.abs(avatar!.x + avatar!.width / 2 - cardBox!.x - cardBox!.width / 2),
        ).toBeLessThan(1);
        expect(labelBox!.height).toBe(
          (await label.getAttribute("title")) === "AReallyLongUnbrokenPlayerName" ? 32 : 16,
        );
        await expect(label).toHaveCSS("-webkit-line-clamp", "2");
      }
      const nameBox = await cards.first().locator(".line-clamp-2").boundingBox();
      const badge = await cards.first().getByText("lands 1st", { exact: false }).boundingBox();
      expect(badge!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height);
      const timerBox = await row.getByRole("timer").boundingBox();
      expect(timerBox!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
      expect(timerBox!.x + timerBox!.width).toBeLessThanOrEqual(badge!.x);
      const fill = await row.getByTestId("move-time-fill").boundingBox();
      expect(fill!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height);
      expect(fill!.y + fill!.height).toBeLessThan(first!.y + first!.height);
      expect(first!.x + first!.width).toBeLessThan(second!.x);
      expect(second!.x + second!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
      const status = await row.getByTestId("turn-status").boundingBox();
      if (width < 640) expect(timerBox!.y + timerBox!.height).toBeLessThanOrEqual(status!.y);
      expect(Math.abs(status!.x + status!.width / 2 - width / 2)).toBeLessThan(1);
      await expect(row.getByRole("timer")).toHaveText("0:59");
      await expect(row.getByRole("timer")).toHaveAttribute("aria-live", "off");
      await expect(row.getByRole("status").getByRole("timer")).toHaveCount(0);
    }
    const wrapped = page
      .getByTestId("players-AReallyLongUnbrokenPlayerName")
      .locator('[title="AReallyLongUnbrokenPlayerName"]');
    const lines = await wrapped.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set(Array.from(range.getClientRects(), (rect) => rect.top)).size;
    });
    expect(lines).toBeGreaterThan(1);
    await wrapped.hover();
    await expect(wrapped).toHaveAttribute("title", "AReallyLongUnbrokenPlayerName");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: `test-results/player-cards-${width}.png` });
  });
}

for (const seconds of [null, 0, 5, 6]) {
  test(`player timer handles ${seconds === null ? "inactive" : `${seconds} seconds`} correctly`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(async (remaining) => {
      const { mountPlayerPanels } = await import("/e2e/fixtures/player-panels.tsx");
      mountPlayerPanels(remaining);
    }, seconds);
    await expect(page.getByTestId("players-Al")).toBeVisible();
    if (seconds === null) {
      await expect(page.getByRole("timer")).toHaveCount(0);
      await expect(page.getByTestId("move-time-fill")).toHaveCount(0);
    } else {
      const timer = page.getByRole("timer").first();
      await expect(timer).toHaveText(`0:${String(seconds).padStart(2, "0")}`);
      if (seconds <= 5) await expect(timer).toHaveClass(/text-red/);
      else await expect(timer).not.toHaveClass(/text-red/);
      const fill = page.getByTestId("move-time-fill").first();
      if (seconds <= 5) await expect(fill).toHaveClass(/bg-red/);
      else await expect(fill).toHaveClass(/bg-accent/);
    }
  });
}

for (const [remaining, duration, fraction] of [
  [60, 60, 1],
  [30, 60, 0.5],
  [30, 120, 0.25],
  [0, 60, 0],
  [61, 60, 1],
]) {
  test(`countdown fill is ${fraction} with ${remaining}/${duration} seconds`, async ({ page }) => {
    await page.goto("/");
    await page.evaluate(
      async ([left, total]) => {
        const { mountPlayerPanels } = await import("/e2e/fixtures/player-panels.tsx");
        mountPlayerPanels(left, "first", total);
      },
      [remaining, duration],
    );
    const fill = page.getByTestId("move-time-fill").first();
    await expect(fill).toBeAttached();
    const scale = await fill.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
    expect(scale).toBeCloseTo(fraction!);
  });
}

for (const timedSeats of ["second", "both"] as const) {
  test(`countdown belongs to ${timedSeats} seats`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto("/");
    await page.evaluate(async (seats) => {
      const { mountPlayerPanels } = await import("/e2e/fixtures/player-panels.tsx");
      mountPlayerPanels(48, seats);
    }, timedSeats);
    const row = page.getByTestId("players-Al");
    await expect(row.getByRole("group", { name: /^Your player:/ }).getByRole("timer")).toHaveCount(
      timedSeats === "both" ? 1 : 0,
    );
    await expect(row.getByRole("group", { name: /^Player:/ }).getByRole("timer")).toHaveText(
      "0:48",
    );
    await expect(row.getByTestId("turn-status").getByRole("timer")).toHaveCount(0);
  });
}
