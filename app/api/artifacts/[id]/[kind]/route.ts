import { NextResponse } from "next/server";
import { jsonError, noStore } from "@/lib/http";
import { readArtifact, type ArtifactKind } from "@/lib/store";
import { readRunSummary } from "@/lib/run-read";
import { authorize } from "@/lib/auth";

export const runtime = "nodejs";

const KINDS: ArtifactKind[] = ["patch", "report"];

export async function GET(_request: Request, context: { params: Promise<{ id: string; kind: string }> }) {
  try {
    const session = authorize(_request, "run:read");
    const { id, kind } = await context.params;
    if (!KINDS.includes(kind as ArtifactKind)) {
      return NextResponse.json({ ok: false, code: "not-found", error: "Unknown artifact" }, { status: 404 });
    }
    // Tenant scoping happens on the run summary, not the artifact path, so a
    // foreign identifier cannot be probed for existence through artifacts either.
    const summary = await readRunSummary(session.tenantId, id);
    if (!summary) {
      return NextResponse.json({ ok: false, code: "not-found", error: "Artifact not found" }, { status: 404 });
    }

    const artifact = await readArtifact(id, kind as ArtifactKind);
    if (!artifact) {
      return NextResponse.json({ ok: false, code: "not-found", error: "Artifact file is unavailable" }, { status: 404 });
    }

    return new Response(artifact.content, {
      headers: noStore({
        "Content-Type": artifact.contentType,
        "Content-Disposition": `inline; filename="${artifact.filename}"`,
      }),
    });
  } catch (error) {
    return jsonError(error, noStore());
  }
}
