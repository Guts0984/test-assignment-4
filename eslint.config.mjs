import js from "@eslint/js";
import nextVitals from "eslint-config-next/core-web-vitals";
import functional from "eslint-plugin-functional";
import tseslint from "typescript-eslint";

const noRelativePackageImports = {
  group: ["**/packages/**"],
  message: "Import shared code through the package name (@app/shared), not a relative path.",
};

// A feature has two doors: its index (safe to use anywhere) and its `server` file (server-only code).
const noDeepFeatureImports = {
  group: ["@/features/*/*", "!@/features/*/server"],
  message: "Import from the feature's public entry (@/features/<name> or @/features/<name>/server), not its internals.",
};

const noFeatureImports = {
  group: ["@/features", "@/features/*"],
  message: "shared/ must not depend on features/.",
};

const restrictImports = (...patterns) => ({
  "no-restricted-imports": ["error", { patterns: [noRelativePackageImports, ...patterns] }],
});

// The Next.js rules (React Hooks, Core Web Vitals, @next/next) apply to the web app only.
const nextRules = nextVitals.map((config) =>
  "ignores" in config && !("files" in config) && !("rules" in config) ? config : { ...config, files: ["apps/web/**/*.{js,jsx,mjs,ts,tsx}"] },
);

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/coverage/**", "**/next-env.d.ts", "packages/db/src/generated/**", "**/test-results/**", "**/playwright-report/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...nextRules,
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    settings: { next: { rootDir: "apps/web" } },
    // Only for the old Pages Router; this app uses the App Router.
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": "allow-with-description", minimumDescriptionLength: 10 },
      ],
      ...restrictImports(),
    },
  },
  {
    // The load-test script is plain Node.js (no TypeScript): tell the linter which globals Node provides.
    files: ["loadtest/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", fetch: "readonly", setTimeout: "readonly" } },
  },
  {
    // Functional style: plain functions and data, no classes.
    // (The api is NestJS, which is built on classes and decorators, so it is the one exception.)
    files: ["apps/web/**/*.{ts,tsx}", "apps/worker/**/*.ts", "packages/**/*.{ts,tsx}"],
    plugins: { functional },
    rules: {
      "functional/no-classes": "error",
      "functional/no-class-inheritance": "error",
      "functional/no-this-expressions": "error",
    },
  },
  {
    // Feature-based web app: routes and features talk to a feature only through its index.
    files: ["apps/web/src/app/**/*.{ts,tsx}", "apps/web/src/features/**/*.{ts,tsx}"],
    rules: restrictImports(noDeepFeatureImports),
  },
  {
    files: ["apps/web/src/shared/**/*.{ts,tsx}"],
    rules: restrictImports(noFeatureImports),
  },
);
