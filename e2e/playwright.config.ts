import { defineConfig, devices } from "@playwright/test";

// The tests drive a real browser against the whole running stack (`docker compose up`).
// BASE_URL defaults to the address from .env.example.
export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env["BASE_URL"] ?? "http://localhost:8080",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    // Use the browser Playwright installed, or the system Chrome when CHROME_PATH is set.
    ...(process.env["CHROME_PATH"] ? { launchOptions: { executablePath: process.env["CHROME_PATH"] } } : {}),
  },
});
