import { defineConfig, devices } from "@playwright/test";

// The tests drive real browsers against the whole running stack (`docker compose up`).
// BASE_URL defaults to the address from .env.example. Choose browsers with `--project chromium|firefox|webkit`.
const executable = process.env["CHROME_PATH"] ? { launchOptions: { executablePath: process.env["CHROME_PATH"] } } : {};

export default defineConfig({
  testDir: "tests",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env["BASE_URL"] ?? "http://localhost:8080",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], ...executable } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
