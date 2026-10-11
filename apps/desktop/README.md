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

## Build verification

- Desktop frontend typecheck and unit tests pass locally.
- `cargo fmt --check` passes locally.
- Compiling/linking the Rust shell requires a Windows SDK + Visual Studio C++
  Build Tools (MSVC) on Windows; this dev machine does not have them, so
  `cargo check`, `cargo test`, `cargo clippy`, and `tauri build` are proven by
  the GitHub `desktop` workflow on windows-latest, macos-latest, and
  ubuntu-latest instead.
- Linux builds need `pkg-config` and `libdbus-1-dev` (the OS keychain backend);
  the workflow installs them.

All CI-produced installers are **unsigned test builds** (artifact names end in
`-unsigned`). Production distribution is blocked until signing/notarization
credentials exist and release artifacts are actually produced. An unsigned
local build is not a production release.

## Security highlights

- Tauri capabilities are least privilege: no shell, no filesystem, no process
  bridge, no arbitrary HTTP plugin.
- Deep links accept only `tracehealer://incident/:id` and `tracehealer://run/:id`
  with a validated identifier; everything else is rejected.
- OAuth uses a per-attempt CSPRNG PKCE state/verifier; the callback state is
  consumed exactly once, so a captured callback URL cannot be replayed.
- The session token is stored only in the OS credential vault and is never
  written to web storage, the Tauri store file, or a plaintext file.
- The system browser is only opened for https URLs (or http on loopback).
- There is no auto-updater in this build: unsigned update metadata cannot
  install because no update channel exists at all.
- No credentials are bundled into the desktop binary.
