import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    status: "healthy",
    service: "tracehealer",
    version: "0.1.0",
    mode:
      process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO
        ? "connected"
        : "demo",
    timestamp: new Date().toISOString(),
  });
}
