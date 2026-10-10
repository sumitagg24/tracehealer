import { NextResponse } from "next/server";
import { DEMO_INCIDENT } from "@/lib/demo-data";

export function GET() {
  return NextResponse.json({ ok: true, incident: DEMO_INCIDENT });
}
