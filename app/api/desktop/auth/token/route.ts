import { NextResponse } from "next/server";
import { exchangeAuthorizationCode } from "@/lib/desktop-auth";
import { jsonError, noStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-side authorization-code exchange for the desktop client.
 *
 * The desktop posts the code and its PKCE verifier here; this deployment talks
 * to the provider, so no client secret is ever embedded in the desktop binary.
 * A deployment without a configured provider answers 503 and the desktop tells
 * the user sign-in is unavailable instead of failing mysteriously.
 */
export async function POST(request: Request) {
  try {
    const result = await exchangeAuthorizationCode(request);
    return new NextResponse(result.body, {
      status: result.status,
      headers: { ...noStore(), "Content-Type": result.contentType || "application/json" },
    });
  } catch (error) {
    return jsonError(error, noStore());
  }
}
