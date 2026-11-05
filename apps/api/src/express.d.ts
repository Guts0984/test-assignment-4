import type { SessionData } from "./auth/session";

// Fields our own middleware and guard add to every Express request.
declare global {
  namespace Express {
    interface Request {
      requestId: string;
      /** The real visitor's address (see http/client-ip.ts). */
      clientIp: string;
      session?: SessionData;
      sessionId?: string;
    }
  }
}
