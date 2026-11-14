// Syntax color for the notebook's code: a small scanner, enough for the Python and shell the agents write. It works on
// half-typed text too (an open string is a string to the end of what is there), and returns one HTML string per line,
// so the notebook can still wrap and highlight whole lines.
//
// Token classes (notebook.css): tk-k keyword, tk-s string, tk-n number or constant, tk-f a name being called,
// tk-c comment, tk-o shell punctuation.

import { esc } from "../ui";

const PY_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "try", "while", "with", "yield",
]);
const PY_CONSTANTS = new Set(["True", "False", "None"]);

// One alternative per token kind, tried in order at each position.
const PY = /(#[^\n]*)|((?:[rbfuRBFU]{1,2})?(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?))|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_]\w*)/g;
const SH = /(#[^\n]*)|("(?:\\.|[^"\\\n])*"?|'[^'\n]*'?)|(&&|\|\||[|;<>]+)|((?:^|(?<=\s))-{1,2}[\w-]+)|([A-Za-z_][\w./-]*)/g;

type Emit = (cls: string | null, text: string) => void;

function scanPython(code: string, emit: Emit): void {
  let at = 0;
  PY.lastIndex = 0;
  for (let m = PY.exec(code); m; m = PY.exec(code)) {
    if (m.index > at) emit(null, code.slice(at, m.index));
    const [text, comment, string, number, name] = m;
    if (comment) emit("c", text);
    else if (string) emit("s", text);
    else if (number) emit("n", text);
    else if (name) {
      const called = code[m.index + text.length] === "(";
      emit(PY_KEYWORDS.has(name) ? "k" : PY_CONSTANTS.has(name) ? "n" : called ? "f" : null, text);
    }
    at = m.index + text.length;
    if (!text.length) PY.lastIndex++;
  }
  if (at < code.length) emit(null, code.slice(at));
}

function scanShell(code: string, emit: Emit): void {
  let at = 0;
  let head = true; // the next word is a command name
  if (code.startsWith("!")) { emit("o", "!"); at = 1; }
  SH.lastIndex = at;
  for (let m = SH.exec(code); m; m = SH.exec(code)) {
    if (m.index > at) emit(null, code.slice(at, m.index));
    const [text, comment, string, op, flag, word] = m;
    if (comment) emit("c", text);
    else if (string) { emit("s", text); head = false; }
    else if (op) { emit("o", text); head = /&&|\|\||[|;]/.test(text); }
    else if (flag) emit("k", text);
    else if (word) { emit(head ? "f" : null, text); head = false; }
    at = m.index + text.length;
    if (!text.length) SH.lastIndex++;
  }
  if (at < code.length) emit(null, code.slice(at));
}

export type CodeKind = "python" | "shell" | "plain";

/** How to color a cell's code: Python cells and .py files as Python, `!commands` as shell, the rest plain. */
export function codeKind(lang: string, title: string | null, code: string): CodeKind {
  if (lang === "python") return "python";
  if (lang === "file") return !title || /\.py$/i.test(title) ? (/^[-+] /m.test(code) && !/^(import|from|def|class)\b/m.test(code) ? "plain" : "python") : "plain";
  if (lang === "shell") return "shell";
  return "plain";
}

/** The code as HTML, one string per line, escaped, with token spans. */
export function highlightLines(code: string, kind: CodeKind): string[] {
  if (kind === "plain") return code.split("\n").map(esc);
  const lines: string[] = [""];
  const emit: Emit = (cls, text) => {
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push("");
      if (part) lines[lines.length - 1] += cls ? `<span class="tk-${cls}">${esc(part)}</span>` : esc(part);
    });
  };
  if (kind === "python") scanPython(code, emit);
  else scanShell(code, emit);
  return lines;
}
