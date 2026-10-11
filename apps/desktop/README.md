# TraceHealer Desktop

A Tauri 2 desktop client for the authenticated TraceHealer service. It connects
to the server you configure and displays real run progress, incidents, and
healing evidence. All repository execution, model calls, and secrets stay on
the server.

## Architecture

- The renderer talks HTTP-only to the configured server origin.
- The Rust side provides tray, notifications, deep links, and the OS-keychain
  session vault. It does not expose a shell, filesystem, or process bridge.
- Session material is stored only in the OS keychain. It is not written to
  localStorage or plaintext files.

## Development

From the repository root:

```bash
cd apps/desktop
npm install
npm run typecheck
```

The desktop app depends on the Rust toolchain. `cargo` must be available before
`npm run dev` or `npm run build` will succeed.

## Toolchain

The supported Windows toolchain is **MSVC**: `stable-x86_64-pc-windows-msvc`
plus the Visual Studio C++ Build Tools and the Windows SDK (`cl.exe`, `link.exe`,
`rc.exe`). The packaging command is the one defined in `package.json`:

```bash
cd apps/desktop
npm run build          # == tauri build
```

Note that `link.exe` on `PATH` is often Git's coreutils linker; only the
Microsoft linker produces a valid bundle. Locate Visual Studio with `vswhere.exe`
and initialise `vcvars64.bat` before building on Windows.

Linux builds need the Tauri system libraries plus `pkg-config` and
`libdbus-1-dev` (the OS keychain backend); the `desktop` workflow installs them.
macOS uses the runner's own Apple toolchain.

### Known local (Windows) blocker

This development machine has **no Visual Studio, no Windows SDK, and no
`vswhere.exe`**, and the active default Rust toolchain is
`stable-x86_64-pc-windows-gnu`. Consequently `tauri build` (and therefore MSI/NSIS
packaging) **cannot be produced locally** here, and no installer should be
claimed from this machine. `cargo fmt`, `cargo check`, `cargo test`, and
`cargo clippy` are run locally against the GNU target only as a code check; the
real, reproducible packaging proof is the GitHub `desktop` workflow on
windows-latest / macos-latest / ubuntu-latest with official runner toolchains.

Historical note: an earlier local attempt used a machine-global `dlltool` shim
under `~/.cargo/bin` plus MSYS2 binutils and a `gcc -E` stand-in under
`~/.local/dlltool` to work around the GNU target's missing `dlltool`/`windres`.
Those tools live outside this repository, are **not** part of the build, and are
**not** evidence of cross-platform release readiness. Nothing in this repo
depends on them.

All CI-produced installers are **unsigned test builds** (artifact names end in
`-unsigned`). Production distribution is blocked until signing/notarization
credentials exist and signed release artifacts are actually produced. An
unsigned local build is not a production release.

## Branding (pre-release)

The application icon is original artwork owned by this repository:

- `branding/tracehealer-icon.svg` — design source of truth (editable, reviewable).
- `branding/tracehealer-icon.png` — 1024x1024 source image committed once.
- `src-tauri/icons/` — every size Tauri needs: Windows `.ico`, macOS `.icns`,
  Linux PNGs, tray PNG, and the Windows Store logos.

Regenerate the whole set from the SVG (never hand-edit the generated files):

```bash
cd apps/desktop
node scripts/generate-icons.mjs   # needs the repository-root npm install for sharp
```

The mark is a dark squircle carrying a single pulse trace that is muted while it
is broken and brand lime once it is mended, using the product's own accent
colour. This is **pre-release branding**, not a signed-off visual identity: the
mark is deliberate and third-party-free, but it has not been through a formal
design review. No third-party or licensed artwork is bundled.

## Security highlights

- Tauri capabilities are least privilege: no shell, no filesystem, no process
  bridge, no arbitrary HTTP plugin.
- Deep links accept only `tracehealer://incident/:id` and `tracehealer://run/:id`
  with a validated identifier; everything else is rejected.
- OAuth uses a per-attempt CSPRNG PKCE state/verifier; the callback state is
  consumed exactly once, so a captured callback URL cannot be replayed.
- The session token is stored only in the OS credential vault and is never
  written to web storage, to any plugin store file, or to a plaintext file.
- The system browser is only opened for https URLs (or http on loopback).
- There is no auto-updater in this build: unsigned update metadata cannot
  install because no update channel exists at all.
- No credentials are bundled into the desktop binary.
