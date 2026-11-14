// Syntax color for notebook code: tokens, half-typed text, escaping, line splitting.

import { describe, expect, it } from "vitest";
import { codeKind, highlightLines } from "../src/batch/highlight";

describe("highlightLines", () => {
  it("colors Python keywords, strings, numbers, calls and comments", () => {
    const [a, b] = highlightLines(`import pandas as pd  # load\ndf = pd.read_csv('data.csv', nrows=10) if True else None`, "python");
    expect(a).toBe(`<span class="tk-k">import</span> pandas <span class="tk-k">as</span> pd  <span class="tk-c"># load</span>`);
    expect(b).toContain(`<span class="tk-f">read_csv</span>(`);
    expect(b).toContain(`<span class="tk-s">&#39;data.csv&#39;</span>`);
    expect(b).toContain(`<span class="tk-n">10</span>`);
    expect(b).toContain(`<span class="tk-n">True</span>`);
    expect(b).toContain(`<span class="tk-k">else</span>`);
  });

  it("keeps one entry per line, also through a triple-quoted string", () => {
    const code = `x = """a\nb"""\nprint(x)`;
    const lines = highlightLines(code, "python");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`<span class="tk-s">&quot;&quot;&quot;a</span>`);
    expect(lines[1]).toBe(`<span class="tk-s">b&quot;&quot;&quot;</span>`);
  });

  it("treats a half-typed string as a string and escapes markup", () => {
    expect(highlightLines(`print("<b>hel`, "python")[0]).toBe(`<span class="tk-f">print</span>(<span class="tk-s">&quot;&lt;b&gt;hel</span>`);
    expect(highlightLines("a < b", "plain")).toEqual(["a &lt; b"]);
  });

  it("colors shell commands, flags and operators", () => {
    const [line] = highlightLines("!ls -la && wc -l data.csv", "shell");
    expect(line).toBe(`<span class="tk-o">!</span><span class="tk-f">ls</span> <span class="tk-k">-la</span> <span class="tk-o">&amp;&amp;</span> <span class="tk-f">wc</span> <span class="tk-k">-l</span> data.csv`);
  });

  it("strips to the same text it was given", () => {
    const code = `for i in range(3):\n    print(f"{i}: ok")  # done\n`;
    const text = highlightLines(code, "python").join("\n").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(text).toBe(code);
  });
});

describe("codeKind", () => {
  it("picks the language from the cell", () => {
    expect(codeKind("python", null, "x")).toBe("python");
    expect(codeKind("file", "model.py", "import x")).toBe("python");
    expect(codeKind("file", "notes.txt", "hello")).toBe("plain");
    expect(codeKind("file", "model.py", "- old\n+ new")).toBe("plain");
    expect(codeKind("shell", null, "!ls")).toBe("shell");
    expect(codeKind("tool", null, "read_file x")).toBe("plain");
  });
});
