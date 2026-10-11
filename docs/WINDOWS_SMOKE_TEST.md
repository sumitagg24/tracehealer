# Windows installed-runtime smoke test

**Status: partially verified.** A sanitized summary of a hands-on check of the unsigned Windows installer from the `v0.1.0-rc.1` preview release. Raw verbose installer logs and UI Automation trees were captured locally and are deliberately **not** published.

Host: Windows 11, Node v22.23.2. Nothing below bypasses an operating-system control, and no signing or notarization is claimed.

## Artifact identity

```
TraceHealer_0.1.0_x64_en-US.msi
sha256: b74786ea7166d5f463d3080e84febb58305c59e23a8b766d176ca5c0c27181df
```

This matches both the checksum published in the release's `SHA256SUMS.txt` and GitHub's own recorded digest for the asset. `Get-AuthenticodeSignature` reports **NotSigned**.

## Launch from the MSI payload (no install)

The MSI was administratively extracted (`msiexec /a`, no product registration, no elevation) and the payload binary was launched directly.

The window's accessibility tree reported the expected structure: a window titled `TraceHealer` that was on-screen and responsive, with a web-content pane present.

## Connection to a separately running service

The app was pointed at a TraceHealer server running locally on the same machine, through the app's own non-secret settings file. The connection state reported **Connected** with live server state:

```
connection state        Connected
incidents               Order support agent is failing — healed
healing runs            two demo runs, both state: healed
run detail (invoked)    state · trace id · started/completed timestamps
                        · result: patch to the order-support source file
live progress           server-side events rendered as they were emitted:
                        reproducing, diagnosing, patching, verifying, committing
server readiness        status: ready · persistence: filesystem · data root writable
                        model patches: disabled · allowlisted repositories: 1 · paths: 1
                        integrations — github/neatlogs/slack/sandbox: not configured
notification control    notification preference toggle present
auth controls           Sign in · Sign out · Save address · Refresh
```

The run ids and incident text above exist only in the local server's data store, which is what makes this evidence that the packaged client really fetched incidents, runs, run detail, live progress, and readiness from a server over HTTP.

## Install, launch the installed copy, uninstall

Elevation was granted explicitly for the install and uninstall, each run with a verbose log kept privately.

```
msiexec /i <msi> /qn /norestart /l*v <install.log>
  -> "Windows Installer installed the product. Product Name: TraceHealer.
      Product Version: 0.1.0. Product Language: 1033. Manufacturer: neathack.
      Installation success or error status: 0."

installed files     the default install directory, containing the app
                    executable (11,494,400 bytes) and an uninstaller shortcut
registry            DisplayName=TraceHealer  DisplayVersion=0.1.0  Publisher=neathack
file version info   FileVersion=0.1.0  ProductName=TraceHealer  ProductVersion=0.1.0

launched the installed copy:
  responding=True  title='TraceHealer'
  connection-state   Connected
  incidents, run ids, run detail, readiness, notification preference, sign-in
  control            all visible

msiexec /x <msi> /qn /norestart /l*v <uninstall.log>
  -> "Windows Installer removed the product. Product Name: TraceHealer.
      Product Version: 0.1.0. Product Language: 1033. Manufacturer: neathack.
      Removal success or error status: 0."

after uninstall     the install directory no longer exists
                    registry entries matching TraceHealer: 0
```

## Verified end to end on Windows

- the published MSI hashes to its published checksum;
- the MSI installs and uninstalls cleanly (both status 0, both logged);
- the installed application window renders and responds;
- the client connects to a separately running TraceHealer server;
- incidents load from the server;
- healing runs load from the server with real run ids and states;
- run detail loads (state, trace id, timestamps, patch result);
- live progress events from the server render in the client;
- server readiness and integration status render in the client;
- the notification preference and the sign-in/sign-out controls are present;
- uninstall left no matching process, installation directory, or registry entry.

## Still NOT verified (do not claim otherwise)

- **Tray icon** — not observed programmatically; an area of the shell we did not instrument.
- **Native notification firing** — the preference is on, but no notification was observed being delivered or clicked.
- **OS-level deep links** — the hints render (`tracehealer://run/<id>`, `tracehealer://incident/<id>`) but no deep link was exercised end to end.
- **Logout / credential removal** — the control exists; sign-out and the resulting vault cleanup were not exercised (no identity provider configured).
- **Quit through the tray** — the process was stopped programmatically, which is not the same as quitting from the tray menu.
- **Server-unavailable state** — the client was only ever run against a reachable server, so the "no server configured / unreachable" surface is unverified in the packaged app.
- **SmartScreen** — the install and uninstall ran silently (`/qn`) under an already-approved elevation prompt, so SmartScreen's interactive behaviour for a double-clicked, Mark-of-the-Web-tagged MSI was not exercised. The binaries are unsigned (`NotSigned`), so a SmartScreen warning should be expected.
- **macOS and Linux packages** — never installed or launched. Only structural checks were performed (DMG trailer/GPT/HFS layout, AppImage type-2 magic and squashfs, deb `ar` metadata).

## Reproducing this test

```powershell
Get-FileHash .\TraceHealer_0.1.0_x64_en-US.msi -Algorithm SHA256  # compare with SHA256SUMS.txt
msiexec /i .\TraceHealer_0.1.0_x64_en-US.msi /qb /l*v install.log   # interactive: shows the SmartScreen/wizard path
# launch the installed app from the Start menu, point it at a locally running server
msiexec /x .\TraceHealer_0.1.0_x64_en-US.msi /qb /l*v uninstall.log
```

Use `/qb` rather than `/qn` to see the interactive path, including any SmartScreen prompt.

Note: the app writes only non-secret preferences to its settings file (server address, notification preference, appearance). The session token lives in the OS credential vault and is never written there; no credential was created during this test because no sign-in provider is configured.
