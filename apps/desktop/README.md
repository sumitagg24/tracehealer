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

## Status

The desktop source is committed and tested at the unit level. Builds for
Windows, macOS, and Linux require a working Rust toolchain and the appropriate
signing credentials before the installers can be distributed as production
release assets.

Production distribution is blocked until signing/notarization credentials exist
and release artifacts are actually produced. An unsigned local build is not a
production release.

## Security highlights

- Tauri capabilities are least privilege.
- Deep links accept only known `tracehealer://` targets.
- Auto-update accepts only signed, trusted-channel update metadata.
- No credentials are bundled into the desktop binary.
