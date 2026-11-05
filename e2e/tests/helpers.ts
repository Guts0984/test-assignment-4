import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

/** Values from the project's .env (the same file Docker Compose uses), so the tests know the demo passwords and secret. */
function readDotEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const path of ["../../.env", "../../.env.example"]) {
    try {
      const text = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
      for (const line of text.split("\n")) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (match && !(match[1] as string in values)) values[match[1] as string] = match[2] as string;
      }
    } catch {
      // that file does not exist; try the next one
    }
  }
  return values;
}
const dotenv = readDotEnv();
export const env = (name: string): string => process.env[name] ?? dotenv[name] ?? "";

export const ADMIN = { email: "admin@example.com", password: env("SEED_ADMIN_PASSWORD") };
export const ALICE = { email: "alice@example.com", password: env("SEED_USER_PASSWORD") };

export type Person = { email: string; password: string };

/** A new, never used account (a fresh email each time, so repeated runs on one stack never collide). */
export function newPerson(label: string): Person {
  return { email: `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@e2e.test`, password: "e2e-password-123" };
}

/** Registers through the api (fast) and leaves the session cookie in the browser context. */
export async function registerInContext(context: BrowserContext, person: Person): Promise<void> {
  const reply = await context.request.post("/api/auth/register", { data: person });
  expect(reply.status(), await reply.text()).toBe(201);
}

export async function loginInContext(context: BrowserContext, person: Person): Promise<void> {
  const reply = await context.request.post("/api/auth/login", { data: person });
  expect(reply.status(), await reply.text()).toBe(200);
}

export async function logoutInPage(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
}

type ApiEvent = { id: number; title: string; version: number; startsAt: string };

/** An upcoming event picked at random, so tests that buy seats (and repeated runs) rarely meet the same seats. */
export async function randomEvent(request: APIRequestContext, from = 0, to = 60): Promise<ApiEvent> {
  const reply = await request.get("/api/events?limit=50");
  const events = ((await reply.json()) as { items: ApiEvent[] }).items.slice(from, to);
  return events[Math.floor(Math.random() * events.length)] as ApiEvent;
}

/** Waits until the seat map is drawn, and returns a locator for free seats. */
export async function openSeats(page: Page, eventId: number): Promise<void> {
  await page.goto(`/events/${eventId}/seats`);
  await expect(page.getByTestId("seat-grid")).toBeVisible();
  await expect(page.getByText(/Live: other people/)).toBeVisible(); // the live connection is up
}

export const freeSeats = (page: Page) => page.locator('[data-testid="seat-grid"] button[data-status="free"]');
