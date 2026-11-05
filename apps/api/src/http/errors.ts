import { ErrorCode, issuesToFieldErrors, type ApiError } from "@app/shared";
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import type { Logger } from "../infra/logger";

/** An error the api raises on purpose. The filter turns it into the standard response. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const notFound = (what = "Not found"): AppError => new AppError(404, ErrorCode.NOT_FOUND, what);
export const validationError = (fields: Record<string, string[]>, message = "The request is not valid."): AppError =>
  new AppError(400, ErrorCode.VALIDATION_ERROR, message, { fields });

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: ErrorCode.VALIDATION_ERROR,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  413: ErrorCode.PAYLOAD_TOO_LARGE,
  429: ErrorCode.RATE_LIMITED,
};

/** Is this a failure of PostgreSQL or Redis (down, restarting, too slow) and not a bug or bad input? */
export function isDependencyFailure(error: unknown): boolean {
  // Errors from the drivers are not always instances of our Error class (they can come from another copy of it): read them as plain objects.
  if (typeof error !== "object" || error === null) return false;
  const { code, name, message, cause } = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  if (typeof code === "string" && /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|57P0[1-3]|08\d{3}|53300|P100[1-8]|P1017|P2024|P2028|ECONNABORTED|NR_CLOSED)$/.test(code)) {
    return true;
  }
  const text = `${String(name)} ${String(message)} ${cause instanceof Error ? cause.message : String(cause ?? "")}`;
  // Prisma wraps PostgreSQL errors: "Database error. Code: `57P03`. Message: `the database system is starting up`".
  if (/Code: `(57P0[1-3]|08[0-9A-Z]{3}|53300|40001)`/.test(text)) return true;
  return /(the database system is (starting up|shutting down|in recovery|not yet accepting)|Stream isn't writeable|Connection is closed|Command timed out|connect ETIMEDOUT|connect ECONNREFUSED|Connection terminated|terminating connection|timeout exceeded when trying to connect|Can't reach database|DatabaseNotReachable|ConnectionError|Query read timeout|query_timeout|statement timeout|timed out after \d+ ms|Max client connections|Client has encountered a connection error|ECONNRESET|Server has closed the connection|Connection ended unexpectedly|socket hang up|Unable to start a transaction|Transaction API error|Client was closed|pool is draining|Cannot use a pool after calling end)/i.test(
    text,
  );
}

export type RenderedError = { status: number; body: ApiError; headers?: Record<string, string> };

/**
 * The one place that turns every failure into a response: `{ code, message, details }`.
 * Rule: bad input is always 4xx. Only a real fault is 5xx, and then the client never sees internals.
 */
export function renderError(error: unknown): RenderedError {
  if (error instanceof AppError) {
    return { status: error.status, body: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, ...(error.headers ? { headers: error.headers } : {}) };
  }
  if (error instanceof ZodError) {
    return { status: 400, body: { code: ErrorCode.VALIDATION_ERROR, message: "The request is not valid.", details: { fields: issuesToFieldErrors(error.issues) } } };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = CODE_BY_STATUS[status] ?? (status < 500 ? ErrorCode.VALIDATION_ERROR : ErrorCode.INTERNAL_ERROR);
    const message = status === 404 ? "Not found" : status < 500 ? shortMessage(error) : "Something went wrong on our side.";
    return { status, body: { code, message } };
  }
  if (isDependencyFailure(error)) {
    return {
      status: 503,
      body: { code: ErrorCode.NOT_READY, message: "The service is temporarily unavailable. Try again in a moment." },
      headers: { "Retry-After": "2" },
    };
  }
  // Errors thrown by Express' body reader (malformed JSON, body too large, unsupported charset ...) carry a 4xx status.
  const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status ?? (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const code = CODE_BY_STATUS[status] ?? ErrorCode.VALIDATION_ERROR;
    const message = status === 413 ? "The request is too large." : status === 400 ? "The request body is not valid JSON." : "The request cannot be processed.";
    return { status, body: { code, message } };
  }
  return { status: 500, body: { code: ErrorCode.INTERNAL_ERROR, message: "Something went wrong on our side." } };
}

/** Sends the standard error response; a real fault (5xx) is logged with its details, which the client never sees. */
export function sendError(res: Response, error: unknown, logger: Logger, url?: string): void {
  const { status, body, headers } = renderError(error);
  if (status >= 500) {
    logger.error({ err: error instanceof Error ? { message: error.message, stack: error.stack } : error, url }, "request failed");
  }
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).set(headers ?? {}).json(body);
}

/** Catches whatever a route handler, guard or pipe throws. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    sendError(http.getResponse<Response>(), error, this.logger, http.getRequest<Request>().originalUrl?.split("?")[0]);
  }
}

function shortMessage(error: HttpException): string {
  const response = error.getResponse();
  if (typeof response === "string") return response;
  const message = (response as { message?: unknown }).message;
  return typeof message === "string" ? message : "The request cannot be processed.";
}
