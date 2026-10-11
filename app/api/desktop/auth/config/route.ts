import { NextResponse } from "next/server";
import { desktopAuthConfig } from "@/lib/desktop-auth";
import { noStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What this deployment supports for desktop sign-in.
 *
 * Public and secret-free on purpose: it carries no provider URL, no client
 * secret, and no tenant data — only whether a provider is configured and the
 * same-origin endpoints the desktop should use. When nothing is configured the
 * desktop is told `configured: false` and refuses to start a sign-in rather
 * than showing a broken button.
 */
export async function GET(request: Request) {
  return NextResponse.json(desktopAuthConfig(request), { headers: noStore() });
}
