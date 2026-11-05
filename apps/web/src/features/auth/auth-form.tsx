"use client";

import { loginBodySchema, registerBodySchema, type PublicUser } from "@app/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { isApiError } from "@/shared/lib/api-error";
import { apiRequest } from "@/shared/lib/client-api";
import { queryKeys } from "@/shared/lib/query-keys";
import { safeNextPath } from "@/shared/lib/safe-next";
import { Alert } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { TextField } from "@/shared/ui/text-field";

type Mode = "login" | "register";
type Values = { email: string; password: string };

const COPY = {
  login: { title: "Log in", button: "Log in", path: "/auth/login", switchText: "No account yet?", switchLink: "/register", switchLabel: "Register" },
  register: { title: "Create an account", button: "Register", path: "/auth/register", switchText: "Already registered?", switchLink: "/login", switchLabel: "Log in" },
} as const;

/** The login and registration forms. React Hook Form, validated with the very same Zod schemas the api uses. */
export function AuthForm({ mode }: { mode: Mode }) {
  const copy = COPY[mode];
  const router = useRouter();
  const next = safeNextPath(useSearchParams().get("next"));
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(mode === "login" ? loginBodySchema : registerBodySchema), mode: "onTouched" });

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const { user } = await apiRequest<{ user: PublicUser }>(copy.path, { body: values });
      queryClient.setQueryData(queryKeys.me, user);
      // Everything private from before (another user's orders ...) is forgotten.
      queryClient.removeQueries({ queryKey: queryKeys.orders });
      router.replace(next);
      router.refresh();
    } catch (error) {
      if (!isApiError(error)) return setFormError("Could not reach the server. Try again.");
      if (error.status === 429) return setFormError("Too many attempts. Wait a minute and try again.");
      if (error.code === "INVALID_CREDENTIALS") return setFormError("Wrong email or password.");
      if (error.code === "EMAIL_TAKEN") return setError("email", { message: "An account with this email already exists." });
      const fields = (error.details as { fields?: Record<string, string[]> } | undefined)?.fields;
      if (!fields) return setFormError(error.message);
      for (const [name, messages] of Object.entries(fields)) {
        if (name === "email" || name === "password") setError(name, { message: messages.join(" ") });
      }
    }
  });

  return (
    <form onSubmit={submit} noValidate className="mx-auto w-full max-w-sm space-y-4" aria-labelledby="auth-title">
      <h1 id="auth-title" className="text-2xl font-semibold">
        {copy.title}
      </h1>
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <TextField id="email" label="Email" type="email" autoComplete="email" errors={errors.email?.message ? [errors.email.message] : undefined} {...register("email")} />
      <TextField
        id="password"
        label="Password"
        type="password"
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        hint={mode === "register" ? "At least 8 characters." : undefined}
        errors={errors.password?.message ? [errors.password.message] : undefined}
        {...register("password")}
      />
      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? "Please wait…" : copy.button}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {copy.switchText}{" "}
        <Link href={copy.switchLink} className="underline">
          {copy.switchLabel}
        </Link>
      </p>
    </form>
  );
}
