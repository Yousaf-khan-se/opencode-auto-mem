// Plugin logger: OpenCode server log (client.app.log) primary, console
// fallback only when no app sink exists. Fire-and-forget by design — plog
// never awaits and never throws.
//
// WHY the console sink is NOT unconditional: inside the OpenCode TUI the
// server process shares the terminal's stdout, so every console.log line is
// injected as raw text into the middle of the TUI's rendered frame (garbled
// positioning). The app sink delivers everything to opencode.log instead.
// Escape hatch for live debugging: OPENCODE_AUTO_MEM_CONSOLE_LOG=1 forces
// the console sink on even when the app sink is armed.

type AppDomain = { log: (args: unknown) => Promise<unknown> };

let appDomain: AppDomain | undefined;

/**
 * Capture the OpenCode client's app domain for server-log dispatch.
 * Null-safe: a missing client (or one without `app`) leaves the logger
 * console-only. Must be callable before any config loading that logs.
 */
export function initPluginLogger(client: unknown): void {
  appDomain = (client as { app?: AppDomain } | undefined)?.app;
}

function consoleSinkEnabled(): boolean {
  if (process.env.OPENCODE_AUTO_MEM_CONSOLE_LOG === "1") return true;
  return !appDomain;
}

/**
 * Log to the server log (primary) and — only when no app sink is armed
 * (tests, standalone scripts) or the escape-hatch env var is set — to the
 * console. Server-log dispatch is best-effort (rejections swallowed).
 * Message strings keep their [keeper]/[git]/[memory] prefixes so both sinks
 * stay findstr-able.
 */
export function plog(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
): void {
  if (consoleSinkEnabled()) {
    if (level === "error" || level === "warn") {
      console[level](message);
    } else {
      console.log(message);
    }
  }
  if (appDomain) {
    appDomain.log({
      body: {
        service: "opencode-auto-mem",
        level,
        message,
        ...(extra ? { extra } : {}),
      },
    }).catch(() => {});
  }
}
