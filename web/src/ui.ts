// Ported from Trov (~/Projects/trov/web/src/ui.ts) — the two escaping helpers only.

/** Escape text content for safe insertion into innerHTML. */
export function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Escape a value for use inside an HTML attribute (delegates to esc for full safety). */
export function attr(v: string): string {
  return esc(v);
}

/** "10 MB" from bytes (Trov's ask-composer.ts `fmtBytes`). */
export function fmtBytes(b: number): string {
  if (b >= 1048576) return `${(b / 1048576).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}
