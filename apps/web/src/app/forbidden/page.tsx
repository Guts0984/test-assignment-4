import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "No access" };

/** Shown (with the real status 403) when a logged-in user opens an administrator page. */
export default function ForbiddenPage() {
  return (
    <div className="space-y-3 py-16 text-center">
      <h1 className="text-3xl font-semibold">No access</h1>
      <p className="text-muted-foreground">This page is only for administrators.</p>
      <Link href="/" className="underline">
        Back to events
      </Link>
    </div>
  );
}
