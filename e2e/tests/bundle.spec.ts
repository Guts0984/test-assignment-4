import { expect, test } from "@playwright/test";
import { env } from "./helpers";

// Acceptance check 20: the browser's files contain neither the api's address nor any secret.
const PAGES = ["/", "/events/1", "/events/1/seats", "/login", "/me/orders"];

test("no file sent to the browser mentions the api's address, the database, or a secret", async ({ request, browser }) => {
  const forbidden = ["api:4000", "http://api", "postgresql://", "DATABASE_URL", "REDIS_URL", "INTERNAL_SECRET", env("INTERNAL_SECRET"), env("POSTGRES_PASSWORD"), env("REDIS_PASSWORD"), env("SEED_ADMIN_PASSWORD"), env("SEED_USER_PASSWORD")].filter((value) => value.length > 6);
  expect(forbidden.length).toBeGreaterThan(5);

  // a session is needed to be allowed to see some of the pages
  const context = await browser.newContext();
  await context.request.post("/api/auth/register", { data: { email: `bundle-${Date.now()}@e2e.test`, password: "e2e-password-123" } });

  const scripts = new Set<string>();
  const documents: Array<[string, string]> = [];
  for (const path of PAGES) {
    const html = await (await context.request.get(path)).text();
    documents.push([path, html]);
    for (const match of html.matchAll(/(?:src|href)="(\/_next\/[^"]+\.(?:js|css))"/g)) scripts.add(match[1] as string);
  }
  expect(scripts.size).toBeGreaterThan(3);
  for (const [path, html] of documents) for (const word of forbidden) expect(html.includes(word), `${path} (html) mentions ${word.slice(0, 6)}…`).toBe(false);
  for (const script of scripts) {
    const body = await (await request.get(script)).text();
    for (const word of forbidden) expect(body.includes(word), `${script} mentions ${word.slice(0, 6)}…`).toBe(false);
  }
  await context.close();
});
