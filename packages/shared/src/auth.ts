import { z } from "zod";

export const userRoleSchema = z.enum(["user", "admin"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email());

export const newPasswordSchema = z
  .string()
  .min(8)
  .max(128)
  .refine(
    (value) => value.trim().length > 0,
    "Password cannot be only spaces.",
  );

export const registerBodySchema = z.strictObject({
  email: emailSchema,
  password: newPasswordSchema,
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

export const loginBodySchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const publicUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: userRoleSchema,
});
export type PublicUser = z.infer<typeof publicUserSchema>;
