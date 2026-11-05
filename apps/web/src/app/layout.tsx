import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import Link from "next/link";
import { UserMenu } from "@/features/auth";
import { Providers } from "@/shared/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Event Tickets", template: "%s · Event Tickets" },
  description: "Find an event, choose your seats, pay.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers>
          <header className="border-b">
            <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
              <Link href="/" className="text-lg font-semibold tracking-tight">
                Event Tickets
              </Link>
              <UserMenu />
            </div>
          </header>
          <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
