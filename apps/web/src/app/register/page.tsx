import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthForm } from "@/features/auth";

export const metadata: Metadata = { title: "Register" };

export default function Page() {
  return (
    <Suspense>
      <AuthForm mode="register" />
    </Suspense>
  );
}
