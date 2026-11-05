import { apiErrorSchema, type ApiError } from "@app/shared";

/** An error answered by the api: the HTTP status plus the standard `{ code, message, details }`. */
export type ApiRequestError = Error & { status: number; code: string; details: Record<string, unknown> | undefined };

export function makeApiError(status: number, body: unknown): ApiRequestError {
  const parsed = apiErrorSchema.safeParse(body);
  const info: ApiError = parsed.success ? parsed.data : { code: "UNKNOWN", message: `The server answered ${status}.` };
  return Object.assign(new Error(info.message), { status, code: info.code, details: info.details });
}

export function isApiError(error: unknown): error is ApiRequestError {
  return error instanceof Error && typeof (error as { status?: unknown }).status === "number" && typeof (error as { code?: unknown }).code === "string";
}

/** A short sentence for a person, for any error. */
export function describeError(error: unknown): string {
  if (isApiError(error)) return error.message;
  return "Could not reach the server. Check your connection and try again.";
}
