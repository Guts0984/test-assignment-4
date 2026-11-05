import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // The files share one Redis, so they run one after another.
    fileParallelism: false,
    // Starting the containers (and pulling the images the first time) can be slow.
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
