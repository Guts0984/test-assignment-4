import { Inject, Injectable, UseGuards, applyDecorators, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { readCookie, SESSION_COOKIE, SessionStore } from "./session";

/**
 * For pages anybody may open, but that show a bit more to a logged-in visitor (for example which seats are theirs).
 * A missing or wrong cookie is simply "anonymous". If the session store is unreachable the visitor is also treated as
 * anonymous, so a Redis hiccup does not turn public pages into errors.
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(@Inject(SessionStore) private readonly sessions: SessionStore) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const id = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (id) {
      const session = await this.sessions.get(id).catch(() => null);
      if (session) {
        req.session = session;
        req.sessionId = id;
      }
    }
    return true;
  }
}

export const OptionalAuth = () => applyDecorators(UseGuards(OptionalAuthGuard));
