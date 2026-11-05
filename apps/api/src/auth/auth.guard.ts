import { ErrorCode, type UserRole } from "@app/shared";
import { applyDecorators, Inject, Injectable, SetMetadata, UseGuards, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiCookieAuth } from "@nestjs/swagger";
import type { Request } from "express";
import { AppError } from "../http/errors";
import { readCookie, SESSION_COOKIE, SessionStore } from "./session";

const ROLE_KEY = "required-role";

/** Looks the session up from the cookie and attaches it to the request; refuses the request if there is none. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(SessionStore) private readonly sessions: SessionStore,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const id = readCookie(req.headers.cookie, SESSION_COOKIE);
    const session = id ? await this.sessions.get(id) : null;
    if (!id || !session) throw new AppError(401, ErrorCode.UNAUTHENTICATED, "Log in to continue.");
    req.session = session;
    req.sessionId = id;
    const required = this.reflector.get<UserRole | undefined>(ROLE_KEY, context.getHandler());
    if (required && session.role !== required) throw new AppError(403, ErrorCode.FORBIDDEN, "You do not have access to this.");
    return true;
  }
}

/** Marks a route as "logged in only" (and, with a role, "this role only"). */
export const Auth = (role?: UserRole) =>
  applyDecorators(SetMetadata(ROLE_KEY, role), UseGuards(AuthGuard), ApiCookieAuth());
