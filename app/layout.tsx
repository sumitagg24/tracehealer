import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TraceHealer — Autonomous agent incident response",
  description: "Turn failed AI agent traces into verified, review-ready code patches.",
  applicationName: "TraceHealer",
  openGraph: {
    title: "TraceHealer",
    description: "Your AI agents now fix themselves.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#080b0d",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
