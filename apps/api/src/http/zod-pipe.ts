import { issuesToFieldErrors } from "@app/shared";
import type { PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { validationError } from "./errors";

/** Does any text inside the value contain a NUL character? PostgreSQL cannot store it, so it must never reach a query. */
export function containsNul(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (depth > 20 || value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, inner]) => key.includes("\u0000") || containsNul(inner, depth + 1));
}

/**
 * Checks a request part (body, query, params) against a schema from `@app/shared`.
 * Anything that does not fit is a 400 with readable messages per field, never a 500.
 */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    if (containsNul(value)) throw validationError({ _: ["Text must not contain NUL characters."] });
    const result = this.schema.safeParse(value);
    if (!result.success) throw validationError(issuesToFieldErrors(result.error.issues, "_"));
    return result.data;
  }
}
