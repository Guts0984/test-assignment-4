import Link from "next/link";

export default function NotFound() {
  return (
    <div className="space-y-3 py-16 text-center">
      <h1 className="text-3xl font-semibold">Not found</h1>
      <p className="text-muted-foreground">There is nothing at this address.</p>
      <Link href="/" className="underline">
        Back to events
      </Link>
    </div>
  );
}
