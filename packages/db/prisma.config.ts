import { defineConfig } from "prisma/config";

// The connection string comes from the environment, never from the code.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DATABASE_URL"] ?? "" },
});
