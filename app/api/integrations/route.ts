import { NextResponse } from "next/server";
import { integrationStatus } from "@/lib/integrations";
import { jsonError, noStore } from "@/lib/http";
import { authorize } from "@/lib/auth";

export const runtime = "nodejs";

export function GET(request: Request) {
  try {
    authorize(request, "run:read");
    return NextResponse.json({ ok: true, integrations: integrationStatus() }, { headers: noStore() });
  } catch (error) {
    return jsonError(error, noStore());
  }
}
