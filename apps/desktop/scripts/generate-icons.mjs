#!/usr/bin/env node
// Regenerate the TraceHealer application icon set from the repository-owned
// brand mark.
//
//   node scripts/generate-icons.mjs
//
// Pipeline:
//   1. rasterize branding/tracehealer-icon.svg -> branding/tracehealer-icon.png
//      (1024x1024, the single committed source image), then
//   2. hand that PNG to the Tauri CLI, which writes src-tauri/icons/* for
//      Windows (.ico), macOS (.icns), Linux (PNG), and the tray.
//
// The committed artifacts are the SVG (design source of truth), the 1024 PNG,
// and the generated icons/ set — so a normal build never needs to run this, and
// never needs a rasterizer. Requires a root `npm install` for `sharp`.
//
// The product ships desktop only, so the mobile icon directories the Tauri CLI
// also emits are pruned: committing them would imply mobile targets that do
// not exist.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = join(desktop, "branding", "tracehealer-icon.svg");
const pngPath = join(desktop, "branding", "tracehealer-icon.png");
const iconsDir = join(desktop, "src-tauri", "icons");

// Run the CLI's own entry point through the current Node process. Spawning
// `npx`/`.cmd` shims directly does not work without a shell on Windows.
const tauriCli = join(desktop, "node_modules", "@tauri-apps", "cli", "tauri.js");

let sharp;
try {
  ({ default: sharp } = await import("sharp"));
} catch {
  console.error("generate-icons: `sharp` is required. Run `npm install` at the repository root first.");
  process.exit(1);
}

mkdirSync(dirname(pngPath), { recursive: true });
await sharp(svgPath, { density: 384 }).resize(1024, 1024).png().toFile(pngPath);
console.log(`wrote ${pngPath}`);

if (!existsSync(tauriCli)) {
  console.error("generate-icons: @tauri-apps/cli is missing. Run `npm install` in apps/desktop first.");
  process.exit(1);
}

execFileSync(process.execPath, [tauriCli, "icon", pngPath], {
  cwd: desktop,
  stdio: "inherit",
});

for (const mobile of ["android", "ios"]) {
  const target = join(iconsDir, mobile);
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`pruned ${target} (the product is desktop only)`);
  }
}

console.log("icon set regenerated");
