import { hashPassword, Prisma, verifyPassword, type Role } from "@app/db";
import { ErrorCode, type LoginBody, type PublicUser, type RegisterBody, type UserRole } from "@app/shared";
import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { AppError } from "../http/errors";
import { RateLimiter, tooMany } from "../http/rate-limiter";
import { Infra } from "../infra/infra";
import { SessionStore } from "./session";

const toRole = (role: Role): UserRole => (role === "ADMIN" ? "admin" : "user");

@Injectable()
export class AuthService {
  /**
   * Checked against when the email is unknown, so "no such account" costs the same time as "wrong password" and
   * the answer cannot be used to find out which emails are registered.
   */
  private readonly decoyHash: Promise<string> = hashPassword(randomBytes(24).toString("hex"));

  constructor(
    @Inject(Infra) private readonly infra: Infra,
    @Inject(SessionStore) private readonly sessions: SessionStore,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  async register(body: RegisterBody, ip: string): Promise<{ user: PublicUser; sessionId: string }> {
    await this.limiter.limit("register", ip, 30, 3600);
    const passwordHash = await hashPassword(body.password);
    try {
      const created = await this.infra.db.user.create({ data: { email: body.email, passwordHash } });
      return { user: this.publicUser(created), sessionId: await this.openSession(created) };
    } catch (error) {
      // The unique index on the email is what decides, so two registrations at the same moment cannot both win.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, ErrorCode.EMAIL_TAKEN, "An account with this email already exists.");
      }
      throw error;
    }
  }

  /**
   * Protection against guessing passwords that cannot be used to lock someone else out:
   * - nothing is ever blocked per ACCOUNT. A stranger who types wrong passwords for your email changes nothing for you.
   * - what is limited is the guessing ADDRESS: after too many wrong passwords from one address, that address waits
   *   (a short burst limit protects against parallel guessing too). Correct logins from other addresses are untouched.
   * - successes are not counted and do not reset the counter, so logging in to your own account cannot "wash" the count.
   */
  async login(body: LoginBody, ip: string): Promise<{ user: PublicUser; sessionId: string }> {
    const { env } = this.infra;
    await this.limiter.limit("login-burst", ip, 30, 10);
    const failuresKey = `rl:login-failures:${ip}`;
    const failures = await this.limiter.peek(failuresKey);
    if (failures && failures.count >= env.LOGIN_FAILURES_MAX) throw tooMany(failures.retryAfterSeconds);

    const user = await this.infra.db.user.findUnique({ where: { email: body.email } });
    const matches = await verifyPassword(body.password, user?.passwordHash ?? (await this.decoyHash));
    if (!user || !matches) {
      await this.limiter.hit(failuresKey, env.LOGIN_FAILURES_WINDOW_SECONDS);
      throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, "Wrong email or password.");
    }
    return { user: this.publicUser(user), sessionId: await this.openSession(user) };
  }

  logout(sessionId: string): Promise<void> {
    return this.sessions.destroy(sessionId);
  }

  private openSession(user: { id: string; email: string; role: Role }): Promise<string> {
    return this.sessions.create({ userId: user.id, email: user.email, role: toRole(user.role) });
  }

  private publicUser(user: { id: string; email: string; role: Role }): PublicUser {
    return { id: user.id, email: user.email, role: toRole(user.role) };
  }
}
