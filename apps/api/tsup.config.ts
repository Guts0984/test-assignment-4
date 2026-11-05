import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["cjs"],
  target: "node22",
  clean: true,
  // Our workspace packages export TypeScript source, so they are compiled into the file.
  // Everything else stays a normal dependency (NestJS is CommonJS and loads parts of itself on demand).
  noExternal: [/^@app\//],
  // The generated database client uses `import.meta.url`, which a CommonJS file does not have: tsup supplies it.
  shims: true,
});
