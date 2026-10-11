import { NextResponse } from "next/server";
import { authorize } from "@/lib/auth";
import { sessionIdentity } from "@/lib/desktop-auth";
import { jsonError, noStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Identity of the session the caller presented.
 *
 * The desktop calls this immediately after exchanging an authorization code, so
 * a credential the server does not accept is never stored in the OS vault. It
 * reports only what the desktop needs to label the session, and it is scoped by
 * the session itself — never by a client-supplied identifier.
 */
export async function GET(request: Request) {
  try {
    const session = authorize(request, "run:read");
    return NextResponse.json({ ok: true, ...sessionIdentity(session) }, { headers: noStore() });
  } catch (error) {
    return jsonError(error, noStore());
  }
}
