// Number formatting shared by every batch view. Null and undefined render as a plain dash "-" so a missing value
// never shows as "NaN" or "null".

const DASH = "-";

/** 0.7561 -> "75.6%". */
export const pct = (x: number | null | undefined, digits = 1): string =>
  x == null || Number.isNaN(x) ? DASH : `${(x * 100).toFixed(digits)}%`;

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
