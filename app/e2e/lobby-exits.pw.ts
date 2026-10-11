import { expect, test } from "@playwright/test";

for (const mode of ["Classic", "Fourk"] as const) {
  test(`${mode} host can kick immediately while guest cancellation stays gated`, async ({
    page,
    browser,
  }) => {
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await page.goto("/");
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.getByRole("button", { name: "1 min", exact: true }).click();
      await page.getByRole("button", { name: "Private Game", exact: true }).click();
      const oldLink = await page.getByLabel("Invite link", { exact: true }).inputValue();
      await guest.goto(oldLink);
      await guest.getByRole("button", { name: "Join", exact: true }).click();
      const kick = page.getByRole("button", { name: "Kick opponent", exact: true });
      const cancel = guest.getByRole("button", { name: /^Cancel game in 0:/ });
      await expect(kick).toBeEnabled();
      await expect(cancel).toBeDisabled();
      await kick.click();
      const confirmation = page.getByRole("dialog", { name: "Kick your opponent?", exact: true });
      await expect(confirmation).toContainText("new invite link");
      await page.keyboard.press("Escape");
      await expect(confirmation).toHaveCount(0);
      await expect(kick).toBeEnabled();
      await expect(cancel).toBeDisabled();
      await kick.click();
      await confirmation.getByRole("button", { name: "Kick them", exact: true }).click();
      const invite = page.getByLabel("Invite link", { exact: true });
      await expect(invite).toBeVisible();
      await expect(invite).not.toHaveValue(oldLink);
      await expect(page.getByRole("group", { name: "Open seat", exact: true })).toBeVisible();
      await expect(guest.getByRole("dialog")).toContainText(
        /cancelled|called off|removed|game has ended/i,
      );
    } finally {
      await guestContext.close();
    }
  });
}
