import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  // Our workspace packages export TypeScript source, so they are compiled in, and so is everything else:
  // the runtime image then needs no package manager. Some bundled packages are CommonJS and call require().
  noExternal: [/.*/],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
