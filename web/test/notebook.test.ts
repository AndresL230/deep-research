// The notebook: tool calls as cells, typed out against a clock. Against the demo batch's real logs.

import { describe, expect, it } from "vitest";
import r01Raw from "../../fixtures/demo-batch/runs/r01/events.jsonl?raw";
import r02Raw from "../../fixtures/demo-batch/runs/r02/events.jsonl?raw";
import type { AgentEvent } from "../src/api";
import type { LogView } from "../src/batch/model";
import { LABEL_PATTERNS, cellView, cleanOutput, notebookCells, notebookTail, notebookView, parseCommand, savedCharts, splitStatements } from "../src/batch/notebook";

const jsonl = (raw: string): AgentEvent[] => raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AgentEvent);
const r01 = jsonl(r01Raw);
const r02 = jsonl(r02Raw);
const log = (events: AgentEvent[], clock: number, lookahead = true): LogView => ({ events, times: events.map((e) => e.t), clock, lookahead });

describe("parseCommand", () => {
  it("turns inline Python into lines of code", () => {
    const p = parseCommand(`cd /home/daytona/workspace && python3 -c "import pandas as pd; df = pd.read_csv('data.csv'); print(df.shape)"`);
    expect(p.lang).toBe("python");
    expect(p.code).toBe("import pandas as pd\ndf = pd.read_csv('data.csv')\nprint(df.shape)");
  });

  it("keeps multi-line inline Python and unescapes quotes", () => {
    const p = parseCommand(`cd /w && python3 -c "\nimport json\nprint(json.dumps({\\"a\\": 1}))\n"`);
    expect(p.code).toBe(`import json\nprint(json.dumps({"a": 1}))`);
  });

  it("reads a heredoc that writes a file and then runs it", () => {
    const p = parseCommand("cd /w && cat > model.py <<'EOF'\nimport pandas as pd\nprint(1)\nEOF\npython3 model.py");
    expect(p).toEqual({ lang: "file", title: "model.py", code: "import pandas as pd\nprint(1)", then: "python3 model.py" });
  });

  it("reads Python piped through a heredoc, and leaves other commands as shell", () => {
    expect(parseCommand("python3 - <<'PY'\nprint(2)\nPY").code).toBe("print(2)");
    expect(parseCommand("cd /w && ls -la && wc -l data.csv")).toMatchObject({ lang: "shell", code: "!ls -la && wc -l data.csv" });
  });

  it("does not split semicolons inside strings or brackets", () => {
    expect(splitStatements(`print("a; b"); x = [1; 2]`)).toBe(`print("a; b")\nx = [1; 2]`);
  });
});

describe("helpers", () => {
  it("finds saved charts and strips the exit line", () => {
    expect(savedCharts("plt.savefig('live/01_outcome_counts.png'); plt.savefig(\"/x/02.png\")")).toEqual(["01_outcome_counts.png", "02.png"]);
    expect(cleanOutput("307\n[Command succeeded with exit code 0]")).toBe("307");
  });
});

describe("notebookCells on the demo runs", () => {
  it("shows the whole run when the log is over", () => {
    const cells = notebookCells(log(r01, Infinity));
    const code = cells.filter((c) => c.kind === "code");
    expect(code.length).toBe(r01.filter((e) => e.type === "tool_call").length);
    expect(code.every((c) => c.state === "done" && c.typed === c.code.length)).toBe(true);
    // The honest run has a cell that removes duplicates; the inflated one does not.
    const dedupe = LABEL_PATTERNS.deduplicate;
    expect(code.some((c) => dedupe.test(c.code))).toBe(true);
    expect(notebookCells(log(r02, Infinity)).some((c) => dedupe.test(c.code))).toBe(false);
    // The script it wrote is a file cell, and running it shows the charts the script saved.
    expect(code.some((c) => c.lang === "file" && c.title === "model.py")).toBe(true);
    expect(code.at(-1)!.images).toContain("02_confusion.png");
  });

  it("types the next cell before its call lands in a replay", () => {
    const first = r01.find((e) => e.type === "tool_call")!;
    const before = notebookCells(log(r01, first.t - 0.4));
    const typing = before.at(-1)!;
    expect(typing.state).toBe("typing");
    expect(typing.typed).toBeGreaterThan(0);
    expect(typing.typed).toBeLessThan(typing.code.length);
    expect(typing.output).toBeNull();
    // The call landed: fully typed and running until its result.
    const at = notebookCells(log(r01, first.t + 0.01)).at(-1)!;
    expect(at.state).toBe("running");
    expect(at.typed).toBe(at.code.length);
  });

  it("grows monotonically", () => {
    let prev = 0;
    for (let t = 0; t <= 70; t += 0.5) {
      const cells = notebookCells(log(r01, t));
      const typed = cells.reduce((n, c) => n + c.typed, 0);
      expect(typed).toBeGreaterThanOrEqual(prev);
      prev = typed;
    }
  });

  it("types after the call when live", () => {
    const first = r01.findIndex((e) => e.type === "tool_call");
    const sofar = r01.slice(0, first + 1);
    const live = notebookCells(log(sofar, r01[first].t + 0.1, false)).at(-1)!;
    expect(live.state).toBe("typing");
    const later = notebookCells(log(sofar, r01[first].t + 5, false)).at(-1)!;
    expect(later.state).toBe("running");
  });

  it("marks a fork child's copied history and its forced step", () => {
    const events: AgentEvent[] = [
      { t: 7, type: "tool_call", id: "a", name: "execute", args: { command: "python3 -c \"print(1)\"" } },
      { t: 8, type: "tool_result", id: "a", name: "execute", content: "1" },
      { t: 0.2, type: "forced", command: "python3 -c \"df = df.drop_duplicates()\"", output: "Removed 307 rows" },
    ];
    const cells = notebookCells({ events, times: [0, 0, 0.2], clock: Infinity, lookahead: true });
    expect(cells[0].inherited).toBe(true);
    expect(cells[1]).toMatchObject({ kind: "forced", inherited: false, output: "Removed 307 rows" });
  });
});

describe("drawing", () => {
  const cells = notebookCells(log(r01, Infinity));

  it("draws cells with counts, output and charts, escaping the code", () => {
    const html = notebookView(cells, { image: (n) => `/files/${n}`, mark: LABEL_PATTERNS.deduplicate });
    expect(html).toContain("[1]");
    expect(html).toContain("nb-hl");
    expect(html).toContain(`src="/files/02_confusion.png"`);
    expect(html).not.toMatch(/<pre class="nb-code[^>]*>[^<]*<script/);
    expect(cellView({ ...cells[0], code: "<b>", typed: 3 }, 1)).toContain("&lt;b&gt;");
  });

  it("draws no chart without a URL, and a caret while typing", () => {
    expect(notebookView(cells)).not.toContain("<img");
    const first = r01.find((e) => e.type === "tool_call")!;
    const html = notebookTail(notebookCells(log(r01, first.t - 0.4)));
    expect(html).toContain("nb-caret");
    expect(html).toContain("[ ]");
  });

  it("keeps only the end of the notebook on a tile", () => {
    const html = notebookTail(cells, {}, 2);
    expect(html.match(/class="nb-cell /g)?.length).toBe(2);
  });
});

describe("real run shapes", () => {
  it("reads inline Python followed by more shell", () => {
    const p = parseCommand(`cd /w && python3 -c "\nimport pandas as pd\nprint('dups', df.duplicated().sum())\n"; ls live`);
    expect(p).toEqual({ lang: "python", title: null, code: "import pandas as pd\nprint('dups', df.duplicated().sum())", then: "ls live" });
  });

  it("names what a run is doing and how far it got without todos", async () => {
    const { activityOf, stagesOf } = await import("../src/batch/notebook");
    const events: AgentEvent[] = [
      { t: 1, type: "tool_call", id: "a", name: "execute", args: { command: "python3 -c \"import pandas as pd; df = pd.read_csv('data.csv'); print(df.head())\"" } },
      { t: 2, type: "tool_result", id: "a", name: "execute", content: "ok" },
      { t: 5, type: "tool_call", id: "b", name: "execute", args: { command: "cat > model.py <<'EOF'\nfrom sklearn.model_selection import train_test_split\nm.fit(X, y)\nEOF\npython3 model.py" } },
    ];
    const cells = notebookCells(log(events, 5.5));
    expect(activityOf(cells)).toBe("Training the model");
    expect(stagesOf(cells)).toEqual(["completed", "in_progress", "in_progress", "pending", "pending"]);
    expect(activityOf(notebookCells(log(events, 1.5)))).toBe("Inspecting the data");
    expect(activityOf([])).toBeNull();
  });
});

describe("setup before a heredoc", () => {
  it("drops mkdir and cd, and reads an appending heredoc", () => {
    const p = parseCommand("mkdir -p /w/live && cd /w && cat > run.py <<'EOF'\nprint(1)\nEOF\npython3 run.py && wc -l predictions.csv");
    expect(p).toEqual({ lang: "file", title: "run.py", code: "print(1)", then: "python3 run.py && wc -l predictions.csv" });
    expect(parseCommand("cat >> run.py <<'EOF'\nprint(2)\nEOF").title).toBe("run.py");
  });
});
