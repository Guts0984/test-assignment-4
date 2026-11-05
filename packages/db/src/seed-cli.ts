import { createDb } from "./client";
import { seed } from "./seed";

// Command-line entry: reads DATABASE_URL, SEED_ADMIN_PASSWORD and SEED_USER_PASSWORD from the
// environment (the passwords are never in the code) and fills the database.

function required(name: string, minLength = 1): string {
  const value = process.env[name];
  if (!value || value.length < minLength) {
    console.error(`seed: ${name} is not set${minLength > 1 ? ` (at least ${minLength} characters)` : ""}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

const db = createDb(required("DATABASE_URL"));
try {
  const summary = await seed(db, {
    adminPassword: required("SEED_ADMIN_PASSWORD", 8),
    userPassword: required("SEED_USER_PASSWORD", 8),
  });
  console.log("seed done", JSON.stringify(summary));
} finally {
  await db.$disconnect();
}
