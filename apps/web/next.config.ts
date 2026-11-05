import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const monorepoRoot = fileURLToPath(new URL("../../", import.meta.url));

const nextConfig: NextConfig = {
  // A self-contained server for the Docker image.
  output: "standalone",
  outputFileTracingRoot: monorepoRoot,
  // @app/shared exports TypeScript source, so Next has to compile it.
  transpilePackages: ["@app/shared"],
  poweredByHeader: false,
};

export default nextConfig;
