import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthForm } from "@/features/auth";

export const metadata: Metadata = { title: "Log in" };

export default function Page() {
  return (
    <Suspense>
      <AuthForm mode="login" />
    </Suspense>
  );
}
