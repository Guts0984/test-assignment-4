import { z } from "zod";

/** Machine-readable error codes. The server sends them, the web app can react to them. */
export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  EMAIL_TAKEN: "EMAIL_TAKEN",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  SOLD_OUT: "SOLD_OUT",
  SEAT_LIMIT_REACHED: "SEAT_LIMIT_REACHED",
  BOOKING_EXPIRED: "BOOKING_EXPIRED",
  BOOKING_CANCELLED: "BOOKING_CANCELLED",
  CAPACITY_TOO_LOW: "CAPACITY_TOO_LOW",
  REQUEST_IN_PROGRESS: "REQUEST_IN_PROGRESS",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  RATE_LIMITED: "RATE_LIMITED",
  NOT_READY: "NOT_READY",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * The one error shape every api response uses: `{ code, message, details }`.
 * `code` is a plain string here so an older web build does not break if the api adds a code.
 */
export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** `details` of a VALIDATION_ERROR: readable messages per field, ready to show next to inputs. */
export const validationDetailsSchema = z.object({
  fields: z.record(z.string(), z.array(z.string())),
});
export type ValidationDetails = z.infer<typeof validationDetailsSchema>;
