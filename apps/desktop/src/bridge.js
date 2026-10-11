// The one native entry point the renderer uses.
//
// The window ships without a bundler, so `@tauri-apps/api` is not available as
// an import; this calls the same IPC entry point that package wraps
// (`window.__TAURI_INTERNALS__.invoke`). Everything the shell exposes is a
// command, and everything the shell reports is drained through `take_events`,
// so there is exactly one inbound and one outbound mechanism.

function internals() {
  return typeof window === "undefined" ? undefined : window.__TAURI_INTERNALS__;
}

/** Whether the page is running inside the desktop shell. */
export function bridgeAvailable() {
  const entry = internals();
  return Boolean(entry && typeof entry.invoke === "function");
}

/**
 * Invoke a shell command.
 *
 * Rejects with a plain `Error` when the page is not inside the shell, so the UI
 * can explain that instead of failing silently.
 */
export async function invoke(command, args = {}) {
  const entry = internals();
  if (!entry || typeof entry.invoke !== "function") {
    throw new Error(
      "The desktop bridge is unavailable. Open this window with the TraceHealer desktop application.",
    );
  }
  return entry.invoke(command, args);
}

/** Drain queued shell events; safe to call from a polling loop. */
export async function takeEvents() {
  const events = await invoke("take_events");
  return Array.isArray(events) ? events : [];
}
