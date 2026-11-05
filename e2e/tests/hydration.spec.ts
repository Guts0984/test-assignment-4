import { expect, test } from "@playwright/test";
import { newPerson, registerInContext } from "./helpers";

// Acceptance check 19: no hydration errors, in every browser the tests run in.
const PAGES = ["/", "/events/1", "/events/1/seats", "/events/57", "/login", "/register"];

for (const path of PAGES) {
  test(`${path}: the browser reports no hydration problem and no error`, async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || /hydrat|did not match|server rendered/i.test(message.text())) problems.push(`console ${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    expect(problems.filter((p) => !/Failed to load resource.*(401|404)/.test(p)), problems.join("\n")).toEqual([]);
  });
}

test("pages that belong to a user are also free of hydration problems", async ({ browser }) => {
  const context = await browser.newContext();
  await registerInContext(context, newPerson("hydrate"));
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || /hydrat|did not match/i.test(message.text())) problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  for (const path of ["/me/orders", "/events/3/seats"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  expect(problems).toEqual([]);
  await context.close();
});
