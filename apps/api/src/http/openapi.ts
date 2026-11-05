import { z } from "zod";

/** A JSON schema for Swagger, made from the very Zod schema that validates the request (so the docs cannot drift). */
export function openApiSchema(schema: z.ZodType, io: "input" | "output" = "input"): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { io, unrepresentable: "any", target: "draft-7" }) as Record<string, unknown>;
  // The "$schema" line is for standalone files; inside the OpenAPI document it is noise.
  return Object.fromEntries(Object.entries(jsonSchema).filter(([name]) => name !== "$schema"));
}
