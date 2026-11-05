import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // Starting the PostgreSQL container (and pulling the image the first time) can be slow.
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
