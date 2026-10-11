import { buildReadinessResponse } from "@/lib/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Canonical readiness route. `/api/readiness` is the supported compatibility alias. */
export async function GET() {
  return buildReadinessResponse();
}
