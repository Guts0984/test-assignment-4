import { hashPassword, Prisma, verifyPassword, type Role } from "@app/db";
import { ErrorCode, type LoginBody, type PublicUser, type RegisterBody, type UserRole } from "@app/shared";
import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
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
    await this.limiter.limit("register", ip, this.infra.env.REGISTER_MAX_PER_HOUR, 3600);
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
   * - nothing is ever blocked per ACCOUNT alone. Wrong passwords are counted per visitor ADDRESS and account together:
   *   a stranger typing wrong passwords for your email from his address changes nothing for you at your address.
   * - a second, much higher counter per address stops a scan over many accounts.
   * - a correct login clears the count for THAT address and account (knowing the password proves ownership). It never clears
   *   the count of another account, so logging into your own account cannot wash away guesses made at someone else's.
   * - a short burst limit stops parallel guessing before the counters notice.
   * (Someone behind the very same network address as the owner shares that address's count; the block ends by itself.)
   */
  async login(body: LoginBody, ip: string): Promise<{ user: PublicUser; sessionId: string }> {
    const { env } = this.infra;
    await this.limiter.limit("login-burst", ip, env.LOGIN_BURST_MAX, 10);
    const account = createHash("sha256").update(body.email).digest("hex").slice(0, 32);
    const perAddress = `rl:login-failures:ip:${ip}`;
    const perAccount = `rl:login-failures:acct:${ip}:${account}`;
    const [addressCount, accountCount] = await Promise.all([this.limiter.peek(perAddress), this.limiter.peek(perAccount)]);
    if (addressCount && addressCount.count >= env.LOGIN_FAILURES_PER_IP_MAX) throw tooMany(addressCount.retryAfterSeconds);
    if (accountCount && accountCount.count >= env.LOGIN_FAILURES_MAX) throw tooMany(accountCount.retryAfterSeconds);

    const user = await this.infra.db.user.findUnique({ where: { email: body.email } });
    const matches = await verifyPassword(body.password, user?.passwordHash ?? (await this.decoyHash));
    if (!user || !matches) {
      await Promise.all([this.limiter.hit(perAddress, env.LOGIN_FAILURES_WINDOW_SECONDS), this.limiter.hit(perAccount, env.LOGIN_FAILURES_WINDOW_SECONDS)]);
      throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, "Wrong email or password.");
    }
    await this.infra.redis.del(perAccount).catch(() => undefined);
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
