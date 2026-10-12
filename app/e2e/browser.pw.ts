import { expect, test, type Page } from "@playwright/test";
import { fundAccount } from "./fund.mjs";

const column = (page: Page, n: number) =>
  page.getByRole("button", { name: `drop a disc in column ${n}`, exact: true });

test("a broken invitation explains what happened", async ({ page }) => {
  await page.goto("/#g=not-a-valid-invite");
  await expect(page.getByRole("alert")).toContainText("invite link");
  await expect(page.getByRole("button", { name: "Private Game", exact: true })).toBeVisible();
});

async function current(page: Page) {
  return page.evaluate(() => {
    const list = JSON.parse(localStorage.getItem("fourk.matches") ?? "[]");
    return list.length ? JSON.parse(list[0]) : null;
  });
}

test("account management stays on the start screen, including after refresh and navigation", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Private Game", exact: true }).click();
  await expect(page.getByLabel("Invite link", { exact: true })).toBeVisible();
  const gameUrl = page.url();
  await expect(page.getByRole("button", { name: /^(Your account|Account)$/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Invite link", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Your account|Account)$/ })).toHaveCount(0);
  // Navigating to a saved game also closes an already-open account dialog.
  await page.goto("/");
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate((url) => {
    window.location.hash = new URL(url).hash;
  }, gameUrl);
  await expect(page.getByLabel("Invite link", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel game", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel game", exact: true }).click();
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("account validation, clipboard denial, and small-screen dialogs", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto("/");
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "I already have one" }).click();
  await page.getByLabel("Recovery phrase").fill("not a recovery phrase");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Check for typos");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create an account" }).click();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toBeDisabled();
  await page.getByRole("button", { name: "Reveal", exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Clipboard denied", "NotAllowedError")),
    });
  });
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Couldn't copy");
  await expect(page.getByRole("button", { name: "Copied!", exact: true })).toHaveCount(0);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  await page.getByRole("button", { name: "Cash out", exact: true }).click();
  await page.getByLabel("Destination Kaspa address").fill("invalid");
  await expect(page.getByRole("button", { name: "Max", exact: true })).toBeDisabled();
  await page.getByLabel("Amount (KAS)").fill("1");
  await expect(page.getByRole("button", { name: "Cash out", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("two browsers finish Classic and preserve a game across refresh", async ({
  page,
  browser,
}) => {
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await guestContext.newPage();
  const spectatorContext = await browser.newContext();
  const spectator = await spectatorContext.newPage();
  try {
    await page.goto("/");
    await page.getByLabel("Username").fill("Browser host");
    await page.getByRole("button", { name: "Classic", exact: true }).click();
    await page.getByRole("button", { name: "1 min", exact: true }).click();
    await page.getByRole("button", { name: "Private Game", exact: true }).click();
    const link = await page.getByLabel("Invite link", { exact: true }).inputValue();
    await guest.goto(link);
    await guest.getByLabel("Username").fill("Browser guest");
    await guest.getByRole("button", { name: "Join", exact: true }).click();
    await expect(page.getByRole("timer", { name: "Move time remaining" })).toHaveCount(0);
    await expect(page.getByRole("timer", { name: "Game time remaining" })).toHaveText(
      /^\d{2,}:\d{2}:\d{2}$/,
    );
    await expect(page.locator("main")).not.toContainText("if unfinished");
    const gameUrl = page.url();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await expect(page.getByRole("button", { name: "Private Game", exact: true })).toBeVisible();
    await page.goto(gameUrl);
    for (let move = 0; move < 7; move++) {
      const actor = move % 2 === 0 ? page : guest;
      await column(actor, move % 2 === 0 ? 1 : 2).click();
      if (move < 6) {
        await expect.poll(async () => (await current(page))?.moveCount).toBe(move + 1);
        await expect.poll(async () => (await current(guest))?.moveCount).toBe(move + 1);
        await expect(page.getByRole("button", { name: "Kick opponent", exact: true })).toHaveCount(
          0,
        );
        await expect(guest.getByRole("button", { name: /^Cancel game/ })).toHaveCount(0);
        for (const player of [page, guest]) {
          await expect(player.getByRole("group", { name: /^Your player:/ })).toHaveClass(
            /border-accent/,
          );
          await expect(player.getByRole("group", { name: /^Player:/ })).toHaveClass(/border-line/);
          await expect(player.getByRole("timer", { name: "Move time remaining" })).toBeVisible();
          await expect(player.getByRole("group").getByRole("timer")).toHaveCount(1);
          const myTurn = player === (move % 2 === 0 ? guest : page);
          await expect(
            player
              .getByRole("group", { name: myTurn ? /^Your player:/ : /^Player:/ })
              .getByRole("timer"),
          ).toBeVisible();
        }
      }
      if (move === 2) {
        await guest.reload();
        await spectator.goto(page.url());
        await expect(spectator.getByText("Both seats are taken.", { exact: false })).toBeVisible();
        await spectator.getByRole("button", { name: "Watch game", exact: true }).click();
        await expect(spectator.getByRole("group", { name: /^Your player:/ })).toHaveCount(0);
        for (const panel of await spectator.getByRole("group", { name: /^Player:/ }).all()) {
          await expect(panel).toHaveClass(/border-line/);
        }
        await expect(
          spectator.getByRole("button", { name: "column 1", exact: true }),
        ).toBeDisabled();
      }
    }
    await expect(page.getByRole("dialog")).toContainText("win");
    await expect(guest.getByRole("dialog")).toContainText("opponent");
    await expect(page.getByRole("button", { name: "View board", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(await page.locator(".disc-win").count()).toBe(4);
  } finally {
    await guestContext.close();
    await spectatorContext.close();
  }
});

test("Fourk keeps both simultaneous picks and reveals after refresh", async ({ page, browser }) => {
  const guestContext = await browser.newContext({ viewport: { width: 320, height: 640 } });
  const guest = await guestContext.newPage();
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Private Game", exact: true }).click();
    await guest.goto(await page.getByLabel("Invite link", { exact: true }).inputValue());
    await guest.getByRole("button", { name: "Join", exact: true }).click();
    // The joined lobby is where the first picks happen; its exits close
    // the moment the first pick lands (asserted below).
    await expect(page.getByRole("button", { name: "Kick opponent", exact: true })).toBeVisible();
    await expect(column(page, 4)).toBeEnabled();
    await expect(column(guest, 4)).toBeEnabled();
    for (let round = 0; round < 2; round++) {
      await Promise.all([column(page, 4).click(), column(guest, 4).click()]);
      await expect.poll(async () => (await current(page))?.round).toBe(round + 1);
      await expect.poll(async () => (await current(guest))?.round).toBe(round + 1);
      await expect(page.getByRole("button", { name: "Kick opponent", exact: true })).toHaveCount(0);
      await expect(guest.getByRole("button", { name: /^Cancel game/ })).toHaveCount(0);
    }
    await column(page, 1).click();
    await expect(page.getByText("Pick saved. Waiting for your opponent…")).toBeVisible();
    for (const player of [page, guest]) {
      await expect(player.getByRole("group", { name: /^Your player:/ })).toHaveClass(
        /border-accent/,
      );
      await expect(player.getByRole("timer", { name: "Move time remaining" })).toBeVisible();
    }
    await page.reload();
    await column(guest, 2).click();
    await expect.poll(async () => (await current(page))?.round).toBe(3);
    await expect.poll(async () => (await current(guest))?.round).toBe(3);
    expect((await current(page)).board).toBe((await current(guest)).board);
    const board = await guest.locator(".board-frame").boundingBox();
    expect(board!.x).toBeGreaterThanOrEqual(16);
    expect(board!.x + board!.width).toBeLessThanOrEqual(304);
  } finally {
    await guestContext.close();
  }
});

test("staked hosting, cancellation, cash-out validation and Max reset", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create an account" }).click();
  await page.getByRole("button", { name: "Reveal", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Add funds", exact: true }).click();
  const address = await page.getByLabel("Deposit address", { exact: true }).inputValue();
  await fundAccount(address);
  await expect(page.getByRole("button", { name: "Your account", exact: true })).toContainText(
    "50 KAS",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: "Free", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "1 KAS", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "1 KAS", exact: true }).click();
  await page.getByRole("button", { name: "About Move timer", exact: true }).click();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Time allowed for each move. If you run out, your opponent can claim the win.",
  );
  await page.getByRole("button", { name: "About Move timer", exact: true }).press("Escape");
  await page.getByRole("button", { name: "Classic", exact: true }).click();
  await page.getByRole("button", { name: "About Move timer", exact: true }).click();
  await expect(page.getByRole("tooltip")).not.toContainText("winnings");
  await page.getByRole("button", { name: "About Move timer", exact: true }).press("Escape");
  await page.getByRole("button", { name: "Fourk", exact: true }).click();
  await page.getByRole("button", { name: "Free", exact: true }).click();
  await page.getByRole("button", { name: "About Move timer", exact: true }).click();
  await expect(page.getByRole("tooltip")).not.toContainText("winnings");
  await page.getByRole("button", { name: "About Move timer", exact: true }).press("Escape");
  await page.getByRole("button", { name: "1 KAS", exact: true }).click();
  await page.getByRole("button", { name: "Private Game", exact: true }).click();
  await expect(page.getByText("2 KAS pot once your opponent joins")).toBeVisible();
  await expect(page.getByRole("button", { name: "Your account", exact: true })).toHaveCount(0);
  // Account management remains available at home while the match is saved.
  await page.goto("/");
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  await page.getByRole("button", { name: "Cash out", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("keeping 1 KAS aside");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button").filter({ hasText: "Waiting for an opponent" }).click();
  await expect(page.getByRole("button", { name: "Your account", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel game", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel game", exact: true }).click();
  await expect(page.getByRole("button", { name: "Private Game", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  await page.getByRole("button", { name: "Cash out", exact: true }).click();
  await page.getByLabel("Destination Kaspa address").fill("invalid");
  await page.getByLabel("Amount (KAS)").fill("1");
  await page.getByRole("button", { name: "Cash out", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("valid Kaspa address");
  // A fresh test-only destination, with no recovery phrase in artifacts.
  const destination = await page.evaluate(async () => {
    const { kaspa } = await import("/src/shared/lib/sdk.ts");
    return new kaspa.PrivateKey("cc".repeat(32)).toAddress("simnet").toString();
  });
  await page.getByLabel("Destination Kaspa address").fill(destination);
  await page.getByRole("button", { name: "Max", exact: true }).click();
  await page.getByRole("button", { name: "Cash out", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Sent:");
  await expect(page.getByLabel("Amount (KAS)")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Cash out", exact: true })).toBeDisabled();
});
