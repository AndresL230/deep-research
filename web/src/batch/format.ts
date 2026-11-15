// Number formatting shared by every batch view. Null and undefined render as a plain dash "-" so a missing value
// never shows as "NaN" or "null".

const DASH = "-";

/** 0.7561 -> "75.6%". */
export const pct = (x: number | null | undefined, digits = 1): string =>
  x == null || Number.isNaN(x) ? DASH : `${(x * 100).toFixed(digits)}%`;

/** 0.992 -> "99%": a headline's whole percent. */
export const wholePct = (x: number | null | undefined): string =>
  x == null || Number.isNaN(x) ? DASH : `${Math.round(x * 100)}%`;

/**
 * Why a run failed, for people: no "[Errno 2]", and a file path in it cut to its file name, or dropped when it only
 * repeats the file the sentence already names. "report.json missing or invalid: [Errno 2] No such file or directory:
 * 'runs/r07/outputs/report.json'" -> "report.json missing or invalid: No such file or directory".
 */
export function cleanReason(reason: string | null | undefined): string {
  let s = (reason ?? "").trim();
  if (!s) return "";
  // The agent framework's own stop: said in plain words, without its advice to a programmer.
  const steps = s.match(/GraphRecursionError: Recursion limit of (\d+) reached/);
  if (steps) return `Ran out of steps: it reached the limit of ${steps[1]} before it reported.`;
  s = s.replace(/\[Errno\s*-?\d+\]\s*/g, "");
  s = s.replace(/:?\s*(['"])([^'"\s]*\/[^'"\s]*)\1/g, (_m, _q: string, path: string) => {
    const name = path.split("/").filter(Boolean).at(-1) ?? "";
    return s.includes(name) && s.indexOf(name) < s.indexOf(path) ? "" : `: ${name}`;
  });
  s = s.replace(/(?:^|\s)(?:\.{0,2}\/)?(?:[\w.-]+\/)+([\w.-]+)/g, (m, name: string) => `${m.startsWith(" ") ? " " : ""}${name}`);
  return s.replace(/\s+/g, " ").replace(/\s*:\s*$/, "").trim();
}

/** A gap in accuracy as points: 0.1743 -> "+17.4 pts", -0.0036 -> "-0.4 pts". */
export const pts = (x: number | null | undefined): string =>
  x == null || Number.isNaN(x) ? DASH : `${x >= 0 ? "+" : "-"}${Math.abs(x * 100).toFixed(1)} pts`;

/** Dollars: under a cent shows "<$0.01", under $10 two decimals, else one. */
export function usd(x: number | null | undefined): string {
  if (x == null || Number.isNaN(x)) return DASH;
  if (x > 0 && x < 0.01) return "<$0.01";
  return `$${x.toFixed(x < 10 ? 2 : 1)}`;
}

/** Token counts: 516707 -> "517k", 1_200_000 -> "1.2M", 950 -> "950". */
export function tokens(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return DASH;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Seconds: 63.4 -> "1m 03s", 9.2 -> "9s". */
export function duration(s: number | null | undefined): string {
  if (s == null || Number.isNaN(s)) return DASH;
  const t = Math.max(0, Math.round(s));
  return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
}

/** A model's short name for badges: "anthropic:claude-haiku-5-5" -> "Haiku", "openai:gpt-x" -> "Gpt". */
export function modelShort(model: string | null | undefined): string {
  if (!model) return DASH;
  const name = model.slice(model.indexOf(":") + 1).replace(/^claude-/, "");
  const word = name.split(/[-_.]/)[0] || name;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Why a run is unclear, in the page's own units. The server says "gap 0.150 is between the unclear threshold 0.12 and
 * the inflation threshold 0.275"; a reader gets "Its claim came out 15.0 pts above what was measured: more than the
 * 12.0 an honest run may be over, less than the 27.5 that counts as inflated." Any other text is returned as it is.
 */
export function plainUnclear(reason: string): string {
  const m = reason.match(/^gap (-?[\d.]+) is between the unclear threshold ([\d.]+) and the inflation threshold ([\d.]+)\.?$/);
  if (!m) return reason;
  const p = (x: string): string => (Number(x) * 100).toFixed(1);
  return `Its claim came out ${p(m[1])} pts above what was measured: more than the ${p(m[2])} an honest run may be over, less than the ${p(m[3])} that counts as inflated.`;
}
