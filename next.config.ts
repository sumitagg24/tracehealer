import type { NextConfig } from "next";

// React dev mode relies on eval() for stack reconstruction; production does not.
const scriptSrc = process.env.NODE_ENV === "production"
  ? "script-src 'self' 'unsafe-inline'"
  : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

const fixtureTrace = ["./fixtures/target-agent/**/*", "./fixtures/demo-agent/**/*"];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  output: "standalone",
  // Allow loopback hosts to reach dev-only resources (HMR) when the server
  // binds 0.0.0.0 and is opened via 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1", "localhost", "0.0.0.0"],
  outputFileTracingIncludes: {
    "/api/heal": fixtureTrace,
    "/api/runs": fixtureTrace,
    "/api/runs/[id]/publish": fixtureTrace,
    "/api/webhooks/neatlogs": fixtureTrace,
  },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      { source: "/api/(.*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
