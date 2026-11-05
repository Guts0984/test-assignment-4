import { NextResponse, type NextRequest } from "next/server";

// Access rules for the pages that belong to a logged-in visitor. They run before the page is drawn:
//   no session cookie                    -> 307 to /login?next=<this page>
//   /admin and the session is not admin  -> 403 (the "no access" page, with the real status)
// The cookie only says "a session exists"; the api decides what it is worth. A forged cookie gets through this first door but
// finds no data behind it (the api answers 401).
const API_URL = process.env["API_URL"] ?? "http://api:4000";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const cookie = request.cookies.get("sid")?.value;
  if (!cookie) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login, 307);
  }
  if (pathname.startsWith("/admin")) {
    const role = await roleOf(request);
    if (role === "none") {
      const login = new URL("/login", request.url);
      login.searchParams.set("next", `${pathname}${search}`);
      return NextResponse.redirect(login, 307);
    }
    if (role !== "admin") return NextResponse.rewrite(new URL("/forbidden", request.url), { status: 403 });
  }
  const response = NextResponse.next();
  // Pages for one visitor must never be kept by a shared cache.
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

async function roleOf(request: NextRequest): Promise<"admin" | "user" | "none"> {
  try {
    const response = await fetch(`${API_URL}/me`, { headers: { cookie: request.headers.get("cookie") ?? "" }, cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (response.status === 401) return "none";
    if (!response.ok) return "user";
    const data = (await response.json()) as { user?: { role?: string } };
    return data.user?.role === "admin" ? "admin" : "user";
  } catch {
    return "user";
  }
}

export const config = { matcher: ["/me/:path*", "/checkout/:path*", "/admin/:path*"] };
