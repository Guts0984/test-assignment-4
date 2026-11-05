import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "../infra/logger";
import { clientIp } from "./client-ip";
import { sendError, validationError } from "./errors";
import type { RateLimiter } from "./rate-limiter";
import { tooMany } from "./rate-limiter";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Gives every request an id (the one nginx assigned, or a new one), returns it in a header, and logs one line when done. */
export function requestContext(logger: Logger, internalSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const given = req.headers["x-request-id"];
    req.requestId = typeof given === "string" && SAFE_REQUEST_ID.test(given) ? given : randomUUID();
    req.clientIp = clientIp(req, internalSecret);
    res.setHeader("X-Request-Id", req.requestId);
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      // Docker asks /health every few seconds: that is noise at the normal level.
      const log = req.path === "/health" || req.path === "/ready" ? logger.debug.bind(logger) : logger.info.bind(logger);
      log(
        {
          requestId: req.requestId,
          method: req.method,
          path: req.originalUrl.split("?")[0],
          status: res.statusCode,
          durationMs: Number(process.hrtime.bigint() - started) / 1e6,
          ip: req.clientIp,
        },
        "request",
      );
    });
    next();
  };
}

/** A NUL character (%00) in the address can never be valid and PostgreSQL would choke on it: answer 400 right away. */
export function rejectNulInUrl(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (/%00/i.test(req.originalUrl) || req.originalUrl.includes("\u0000")) {
      sendError(res, validationError({ _: ["The address must not contain NUL characters."] }), logger);
      return;
    }
    next();
  };
}

const UNLIMITED_PATHS = new Set(["/health", "/ready"]);

/**
 * One limit for every request to the api, counted per visitor address in Redis and so shared by all instances.
 * It covers every path, also unknown ones: guessing URLs is not free either. (Calls the web server makes for page
 * rendering carry the visitor's signed address, so they are counted against that visitor.)
 */
export function rateLimit(limiter: RateLimiter, logger: Logger, max: number, windowSeconds: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (UNLIMITED_PATHS.has(req.path)) {
      next();
      return;
    }
    void limiter.hit(`rl:all:${req.clientIp}`, windowSeconds).then(
      (hit) => {
        if (hit) {
          res.setHeader("X-RateLimit-Limit", String(max));
          res.setHeader("X-RateLimit-Remaining", String(Math.max(max - hit.count, 0)));
        }
        if (hit && hit.count > max) {
          res.setHeader("Retry-After", String(hit.retryAfterSeconds));
          sendError(res, tooMany(hit.retryAfterSeconds), logger);
          return;
        }
        next();
      },
      (error: unknown) => sendError(res, error, logger),
    );
  };
}
