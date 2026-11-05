import { verifyInternalRequest } from "@app/shared/internal";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import { internalSecret } from "@/shared/lib/server-env";

const body = z.object({ tags: z.array(z.string().min(1).max(100)).min(1).max(20) });

/**
 * The worker calls this after an event changed: "forget your cached pages with these tags". The call must carry a signature
 * made with the shared secret (nginx also hides /internal/ from the outside). Without a valid signature: 401.
 */
export async function POST(request: Request): Promise<Response> {
  const headers = Object.fromEntries(request.headers);
  if (!verifyInternalRequest(internalSecret(), headers).trusted) {
    return Response.json({ code: "UNAUTHENTICATED", message: "Not allowed." }, { status: 401 });
  }
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "VALIDATION_ERROR", message: "Send { tags: [...] }." }, { status: 400 });
  for (const tag of parsed.data.tags) revalidateTag(tag, { expire: 0 });
  return Response.json({ revalidated: parsed.data.tags });
}
