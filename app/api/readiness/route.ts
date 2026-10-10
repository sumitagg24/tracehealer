import { buildReadinessResponse } from "@/lib/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Compatibility alias for the canonical `/api/ready` route. It returns the same
 * status code, payload, and headers because both call `buildReadinessResponse`.
 */
export async function GET() {
  return buildReadinessResponse();
}
