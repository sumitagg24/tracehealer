import { NextResponse } from "next/server";
import { buildAuthorizeUrl } from "@/lib/desktop-auth";
import { jsonError, noStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same-origin authorize entry point.
 *
 * The desktop opens this URL in the system browser; the deployment then
 * redirects to the operator-configured provider. The destination comes from the
 * environment, never from the query string, so this cannot be used as an open
 * redirect, and PKCE parameters are validated before they are forwarded.
 */
export async function GET(request: Request) {
  try {
    const location = buildAuthorizeUrl(request);
    return NextResponse.redirect(location, { status: 302, headers: noStore() });
  } catch (error) {
    return jsonError(error, noStore());
  }
}
