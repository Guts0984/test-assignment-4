import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/password";

describe("password hashing", () => {
  it("accepts the right password and refuses any other", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", stored)).toBe(false);
    expect(await verifyPassword("Correct horse battery staple", stored)).toBe(false);
    expect(await verifyPassword("correct horse battery staple ", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("works for unusual passwords: unicode, NUL byte, very long", async () => {
    for (const password of ["пароль-密码-🔐", "with\0nul", "a".repeat(100_000), " "]) {
      const stored = await hashPassword(password);
      expect(await verifyPassword(password, stored)).toBe(true);
      expect(await verifyPassword(`${password}x`, stored)).toBe(false);
    }
  });

  it("the same password gives a different stored value each time (random salt), yet both verify", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("does not keep the password inside the stored value", async () => {
    expect(await hashPassword("super-secret-value")).not.toContain("super-secret-value");
  });

  it("a hash from the same function but with another password is not accepted (no cross-matching)", async () => {
    const a = await hashPassword("alpha");
    const b = await hashPassword("beta");
    expect(await verifyPassword("alpha", b)).toBe(false);
    expect(await verifyPassword("beta", a)).toBe(false);
  });
});

describe("a damaged or hostile stored value only ever means 'no'", () => {
  const damaged = [
    "",
    "x",
    "scrypt",
    "scrypt$",
    "scrypt$16384$8$1$$",
    "scrypt$16384$8$1$c2FsdA==$",
    "scrypt$a$b$c$d$e",
    "scrypt$16384$8$1$c2FsdA==",
    "bcrypt$16384$8$1$c2FsdA==$aGFzaA==",
    "scrypt$0$8$1$c2FsdA==$aGFzaA==",
    "scrypt$16385$8$1$c2FsdA==$aGFzaA==", // N must be a power of two
    "scrypt$-1$8$1$c2FsdA==$aGFzaA==",
    "scrypt$1.5$8$1$c2FsdA==$aGFzaA==",
    "scrypt$16384$8$1$c2FsdA==$aGFzaA==$extra",
    "\0\0\0",
  ];

  it.each(damaged)("stored value %j: false, never an exception", async (stored) => {
    await expect(verifyPassword("anything", stored)).resolves.toBe(false);
  });

  it("a stored value that asks for a huge amount of memory is refused quickly instead of hanging the server", async () => {
    const started = Date.now();
    await expect(verifyPassword("x", `scrypt$${2 ** 30}$8$1$c2FsdA==$aGFzaA==`)).resolves.toBe(false);
    await expect(verifyPassword("x", `scrypt$16384$${2 ** 20}$1$c2FsdA==$aGFzaA==`)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("the stored value of a correct password still verifies after the damaged ones (no leftover state)", async () => {
    const stored = await hashPassword("still fine");
    await verifyPassword("x", "garbage");
    expect(await verifyPassword("still fine", stored)).toBe(true);
  });
});
