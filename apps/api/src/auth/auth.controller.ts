import { loginBodySchema, registerBodySchema, type LoginBody, type PublicUser, type RegisterBody } from "@app/shared";
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { Infra } from "../infra/infra";
import { openApiSchema } from "../http/openapi";
import { ZodPipe } from "../http/zod-pipe";
import { Auth } from "./auth.guard";
import { AuthService } from "./auth.service";
import { readCookie, SESSION_COOKIE } from "./session";

@ApiTags("auth")
@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Infra) private readonly infra: Infra,
  ) {}

  @Post("auth/register")
  @ApiOperation({ summary: "Create an account and log in" })
  @ApiBody({ schema: openApiSchema(registerBodySchema) })
  async register(@Body(new ZodPipe(registerBodySchema)) body: RegisterBody, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ user: PublicUser }> {
    const { user, sessionId } = await this.auth.register(body, req.clientIp);
    this.setCookie(res, sessionId);
    res.status(201);
    return { user };
  }

  @Post("auth/login")
  @HttpCode(200)
  @ApiOperation({ summary: "Log in (session cookie)" })
  @ApiBody({ schema: openApiSchema(loginBodySchema) })
  async login(@Body(new ZodPipe(loginBodySchema)) body: LoginBody, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ user: PublicUser }> {
    const { user, sessionId } = await this.auth.login(body, req.clientIp);
    this.setCookie(res, sessionId);
    return { user };
  }

  /** Always succeeds: logging out when you are not logged in is not an error. */
  @Post("auth/logout")
  @HttpCode(204)
  @ApiOperation({ summary: "Log out and forget the session" })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const id = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (id) await this.auth.logout(id);
    res.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "lax", secure: this.infra.env.COOKIE_SECURE });
  }

  @Get("me")
  @Auth()
  @ApiOperation({ summary: "The logged-in user" })
  me(@Req() req: Request): { user: PublicUser } {
    const session = req.session;
    // The guard guarantees a session; this keeps the type honest without a cast.
    if (!session) throw new Error("session missing after AuthGuard");
    return { user: { id: session.userId, email: session.email, role: session.role } };
  }

  private setCookie(res: Response, sessionId: string): void {
    const { env } = this.infra;
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.COOKIE_SECURE,
      path: "/",
      maxAge: env.SESSION_TTL_SECONDS * 1000,
    });
  }
}
