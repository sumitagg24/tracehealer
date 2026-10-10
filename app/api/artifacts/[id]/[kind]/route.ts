import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getHealingRun } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; kind: string }> },
) {
  const { id, kind } = await context.params;
  if (!['patch', 'report'].includes(kind)) {
    return NextResponse.json({ ok: false, error: "Unknown artifact" }, { status: 404 });
  }
  const run = await getHealingRun(id);
  if (!run?.artifacts) return NextResponse.json({ ok: false, error: "Artifact not found" }, { status: 404 });

  const configuredRoot = process.env.TRACEHEALER_DATA_DIR;
  const dataRoot = configuredRoot
    ? path.resolve(/* turbopackIgnore: true */ configuredRoot)
    : path.join(process.cwd(), ".tracehealer-data");
  const file = path.join(dataRoot, "artifacts", id, kind === "patch" ? "change.patch" : "verification.json");

  try {
    const content = await readFile(file, "utf8");
    return new Response(content, {
      headers: {
        "Content-Type": kind === "patch" ? "text/x-diff; charset=utf-8" : "application/json; charset=utf-8",
        "Content-Disposition": `inline; filename="${id}.${kind === "patch" ? "patch" : "json"}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Artifact file is unavailable" }, { status: 404 });
  }
}
