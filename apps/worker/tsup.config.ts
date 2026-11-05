import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  // Our workspace packages export TypeScript source, so they are compiled into the file.
  // Everything else (Prisma, BullMQ, Redis ...) stays a normal dependency and is installed next to it.
  noExternal: [/^@app\//],
});
