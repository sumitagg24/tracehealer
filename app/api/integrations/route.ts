import { NextResponse } from "next/server";
import { integrationStatus } from "@/lib/integrations";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({ ok: true, integrations: integrationStatus() });
}
