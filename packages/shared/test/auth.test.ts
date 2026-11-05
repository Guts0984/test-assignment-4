import { describe, expect, it } from "vitest";
import {
  issuesToFieldErrors,
  loginBodySchema,
  publicUserSchema,
  registerBodySchema,
} from "../src";

const fieldErrors = (result: { success: boolean; error?: { issues: never[] } }) =>
  result.success ? {} : issuesToFieldErrors(result.error?.issues ?? []);

describe("registerBodySchema: email", () => {
  it("trims and lower-cases, so one person cannot register the same address twice by changing case", () => {
    const result = registerBodySchema.parse({ email: "  Alice@Example.COM ", password: "long-enough-1" });
    expect(result.email).toBe("alice@example.com");
  });

  it.each(["plain", "a@", "@b.com", "a b@c.com", "a@b", "", "   "])("rejects %j", (email) => {
    const result = registerBodySchema.safeParse({ email, password: "long-enough-1" });
    expect(result.success).toBe(false);
    if (!result.success) expect(Object.keys(issuesToFieldErrors(result.error.issues))).toEqual(["email"]);
  });

  it("rejects an address longer than 254 characters", () => {
    const email = `${"a".repeat(250)}@example.com`;
    expect(registerBodySchema.safeParse({ email, password: "long-enough-1" }).success).toBe(false);
  });

  it("says in plain words what is wrong", () => {
    const result = registerBodySchema.safeParse({ email: "nope", password: "long-enough-1" });
    if (result.success) throw new Error("should have failed");
    expect(issuesToFieldErrors(result.error.issues)).toEqual({ email: ["Email must be a valid email address"] });
  });
});

describe("registerBodySchema: password", () => {
  const withPassword = (password: string) => registerBodySchema.safeParse({ email: "a@example.com", password });

  it("accepts exactly 8 and exactly 128 characters, rejects 7 and 129", () => {
    expect(withPassword("a".repeat(8)).success).toBe(true);
    expect(withPassword("a".repeat(128)).success).toBe(true);
    expect(withPassword("a".repeat(7)).success).toBe(false);
    expect(withPassword("a".repeat(129)).success).toBe(false);
  });

  it("does not change the password: spaces at the ends are kept", () => {
    const result = registerBodySchema.parse({ email: "a@example.com", password: "  two spaces each side  " });
    expect(result.password).toBe("  two spaces each side  ");
  });

  it("rejects a password made only of spaces, with a readable message", () => {
    const result = withPassword("        ");
    if (result.success) throw new Error("should have failed");
    expect(issuesToFieldErrors(result.error.issues)).toEqual({ password: ["Password cannot be only spaces."] });
  });

  it("explains the length rule in plain words", () => {
    const result = withPassword("short");
    if (result.success) throw new Error("should have failed");
    expect(issuesToFieldErrors(result.error.issues)).toEqual({
      password: ["Password must be at least 8 characters"],
    });
  });

  it("does not accept a non-text password", () => {
    expect(registerBodySchema.safeParse({ email: "a@example.com", password: 12345678 }).success).toBe(false);
    expect(registerBodySchema.safeParse({ email: "a@example.com", password: ["a", "b"] }).success).toBe(false);
  });
});

describe("registerBodySchema: no privilege escalation", () => {
  it("rejects a request that tries to choose its own role", () => {
    const result = registerBodySchema.safeParse({
      email: "mallory@example.com",
      password: "long-enough-1",
      role: "admin",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldErrors(result as never)).toEqual({ _: ["Request body has unknown fields: role"] });
  });

  it("rejects other extra fields too (id, passwordHash)", () => {
    const base = { email: "mallory@example.com", password: "long-enough-1" };
    expect(registerBodySchema.safeParse({ ...base, id: "00000000-0000-4000-8000-000000000000" }).success).toBe(false);
    expect(registerBodySchema.safeParse({ ...base, passwordHash: "x" }).success).toBe(false);
  });
});

describe("loginBodySchema", () => {
  it("normalizes the email the same way as registration, so login finds the account", () => {
    const result = loginBodySchema.parse({ email: " ALICE@example.com", password: "x" });
    expect(result.email).toBe("alice@example.com");
  });

  it("needs a password, but does not enforce the registration length rule", () => {
    expect(loginBodySchema.safeParse({ email: "a@example.com", password: "" }).success).toBe(false);
    expect(loginBodySchema.safeParse({ email: "a@example.com", password: "abc" }).success).toBe(true);
  });

  it("rejects extra fields", () => {
    expect(loginBodySchema.safeParse({ email: "a@example.com", password: "x", role: "admin" }).success).toBe(false);
  });
});

describe("publicUserSchema", () => {
  const row = {
    id: "5a1f0d3e-6b0a-4c1e-9d3c-2f6f0a7b1c11",
    email: "alice@example.com",
    role: "user",
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$secret",
    createdAt: new Date(),
  };

  it("drops the password hash and everything else that is not public", () => {
    const result = publicUserSchema.parse(row);
    expect(result).toEqual({ id: row.id, email: row.email, role: "user" });
    expect(JSON.stringify(result)).not.toMatch(/argon2|passwordHash|createdAt/);
  });

  it("rejects an unknown role", () => {
    expect(publicUserSchema.safeParse({ ...row, role: "superuser" }).success).toBe(false);
  });
});
