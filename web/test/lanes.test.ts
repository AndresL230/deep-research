// What changed, the fork, the verdict and the investigator (src/batch/lanes.ts) against the committed demo batch,
// plus two runs of a real batch (inline below) whose honest run removes duplicates inside one big script.

import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import forcedEventsRaw from "../../fixtures/demo-batch/forks/f1/forced-1/events.jsonl?raw";
import r01Raw from "../../fixtures/demo-batch/runs/r01/events.jsonl?raw";
import r02Raw from "../../fixtures/demo-batch/runs/r02/events.jsonl?raw";
import type { AgentEvent, CaseFile, ForkExperiment, PendingForks, RunRecord, SplitFinding, StepLabel } from "../src/api";
import {
  armStats, armSummaryText, barShare, clip, eventLine, forkView, investigatorView, isProblemPhase, lineWindows,
  numberLabel, phaseText, pickRuns, planCells, scoreStats, shortArgs, sortedChildren, splitCounts, splitHeadline,
  splitIndex, splitView as coloredSplitView, stepWords, verdictArms, verdictView,
} from "../src/batch/lanes";

// The code is syntax colored (highlight.ts, tested on its own). These tests are about which lines show, so read the
// view without the token spans.
const splitView = (vm: Parameters<typeof coloredSplitView>[0]): string =>
  coloredSplitView(vm).replace(/<span class="tk-\w">([^<]*)<\/span>/g, "$1");

import type { BatchVm } from "../src/batch/model";
import { LABEL_PATTERNS, notebookCells } from "../src/batch/notebook";

const demo = JSON.parse(caseRaw) as CaseFile;
const jsonl = (raw: string): AgentEvent[] => raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AgentEvent);

const vmOf = (c: Partial<CaseFile> = {}, over: Partial<BatchVm> = {}): BatchVm => ({
  id: "demo", live: false, case: { ...structuredClone(demo), ...c }, events: {}, replay: null, busy: null, error: null, now: 0, ...over,
});
const count = (html: string, needle: string): number => html.split(needle).length - 1;
/** The demo batch with the two shown runs' logs loaded. */
const withLogs = (c: Partial<CaseFile> = {}): BatchVm => vmOf(c, { events: { r01: jsonl(r01Raw), r02: jsonl(r02Raw) } });
/** One column of the side by side notebooks. */
const col = (html: string, group: "honest" | "inflated"): string => {
  const from = html.indexOf(`data-morph-key="col-${group}"`);
  const to = group === "honest" ? html.indexOf('data-morph-key="col-inflated"') : html.indexOf("What it did to the score");
  expect(from).toBeGreaterThan(-1);
  return html.slice(from, to);
};

describe("helpers", () => {
  it("phaseText covers every phase and keeps blocked and error reasons", () => {
    expect(phaseText("running")).toBe("Agents are running");
    expect(phaseText("analyzing")).toBe("Scoring runs and finding the split");
    expect(phaseText("ready")).toBe("Split found. Ready to investigate");
    for (const p of ["investigating", "awaiting_approval", "forking", "forked", "done", "no_split", "stopped"]) {
      expect(phaseText(p)).not.toBe(p);
    }
    expect(phaseText("blocked: over budget")).toBe("Blocked: over budget");
    expect(phaseText("error: VM died")).toBe("Error: VM died");
    expect(isProblemPhase("error: x")).toBe(true);
    expect(isProblemPhase("done")).toBe(false);
    expect(phaseText("something_new")).toBe("something_new");
  });

  it("splitIndex finds the first split action", () => {
    expect(splitIndex(demo.runs.r01.labels!)).toBe(4);
    expect(splitIndex(demo.runs.r02.labels!)).toBe(3);
    expect(splitIndex([["load"], ["inspect"]])).toBe(2);
  });

  it("splitHeadline says the finding in plain words, with a fallback for a label it does not know", () => {
    expect(splitHeadline(demo.split!)).toEqual({ honest: "Honest runs removed duplicate rows before splitting.", inflated: "Inflated runs did not." });
    expect(splitCounts(demo.split!)).toBe("6 of 6 honest runs, 0 of 6 inflated");
    const some = splitHeadline({ label: "clean", honest_rate: 0.556, inflated_rate: 0.25 });
    expect(some.honest).toBe("Most honest runs cleaned up missing values before splitting.");
    expect(some.inflated).toBe("Most inflated runs did not.");
    expect(splitHeadline({ label: "preprocess", honest_rate: 0.3, inflated_rate: 1 }).inflated).toBe("Inflated runs did too.");
    expect(splitHeadline({ label: "shuffle" as StepLabel, honest_rate: 1, inflated_rate: 0 }).honest).toBe("Honest runs did the shuffle step before splitting.");
    expect(stepWords("shuffle").missing).toBe("No shuffle step here");
    expect(stepWords("deduplicate").missing).toBe("No duplicate removal here");
  });

  it("lineWindows keeps a few lines around each hit and merges windows that touch", () => {
    expect(lineWindows(40, [10])).toEqual([[8, 13]]);
    expect(lineWindows(40, [10, 12, 30])).toEqual([[8, 15], [28, 33]]);
    expect(lineWindows(40, [0, 39], 1)).toEqual([[0, 2], [38, 40]]);
    // Windows one hidden line apart are joined: the marker would cost the same line.
    expect(lineWindows(40, [10, 16])).toEqual([[8, 19]]);
    // Short code and code without hits are shown from the start.
    expect(lineWindows(6, [4])).toEqual([[0, 6]]);
    expect(lineWindows(40, [])).toEqual([[0, 8]]);
    expect(lineWindows(0, [])).toEqual([]);
    // Many hits stop near the cap instead of showing a whole script.
    const many = lineWindows(200, Array.from({ length: 20 }, (_, i) => i * 10), 2, 16);
    expect(many.reduce((n, [a, b]) => n + b - a, 0)).toBeLessThanOrEqual(21);
  });

  it("pickRuns takes the fork's run and the first honest run that did the step before its split", () => {
    expect(pickRuns(demo)).toEqual({ honest: "r01", inflated: "r02" });
    // Without a fork run: the first inflated run that skipped the step.
    expect(pickRuns({ ...demo, split: { ...demo.split!, fork_run_id: null } }).inflated).toBe("r02");
    // An honest run that only did the step in its split action is passed over for one that did it before.
    const runs = structuredClone(demo.runs);
    runs.r01.labels = [["load"], ["load", "deduplicate", "split", "train"]];
    expect(pickRuns({ ...demo, runs }).honest).toBe("r04");
    for (const r of Object.values(runs)) if (r.status === "honest" && r.id !== "r01") r.labels = [["load"], ["split"]];
    expect(pickRuns({ ...demo, runs }).honest).toBe("r01");
    expect(pickRuns({ ...demo, runs: {} })).toEqual({ honest: null, inflated: null });
  });

  it("planCells finds the cell that splits and the cell that does the step", () => {
    const cells = (raw: string) => notebookCells({ events: jsonl(raw), times: jsonl(raw).map((e) => e.t), clock: Infinity, lookahead: false });
    const honest = planCells(cells(r01Raw), LABEL_PATTERNS.deduplicate);
    expect(honest.code.length).toBe(5);
    expect(honest.code[honest.split].title).toBe("model.py");
    expect(honest.step).toBe(2);
    const inflated = planCells(cells(r02Raw), LABEL_PATTERNS.deduplicate);
    expect(inflated.split).toBe(2);
    expect(inflated.step).toBe(-1);
  });

  it("scoreStats and barShare give the group means on a 50% to 100% axis", () => {
    const of = (status: string): RunRecord[] => Object.values(demo.runs).filter((r) => r.status === status);
    const inflated = scoreStats(of("inflated"));
    expect(inflated.n).toBe(6);
    expect(inflated.reported).toBeCloseTo(0.8919, 4);
    expect(inflated.true).toBeCloseTo(0.7511, 4);
    expect(inflated.gap).toBeCloseTo(0.1408, 4);
    expect(inflated.overlap).toBeCloseTo(0.527, 3);
    expect(scoreStats(of("honest")).overlap).toBe(0);
    expect(scoreStats([])).toEqual({ n: 0, reported: null, true: null, gap: null, overlap: null });
    expect(barShare(0.5)).toBe(0);
    expect(barShare(0.75)).toBe(50);
    expect(barShare(1.2)).toBe(100);
    expect(barShare(0.2)).toBe(0);
    expect(barShare(null)).toBe(0);
  });

  it("armSummaryText and armStats read the demo numbers", () => {
    const f = demo.forks.f1 as ForkExperiment;
    expect(armStats(f, "control")).toMatchObject({ n: 4, reported: 0.8782, true: 0.7354 });
    const running = { ...f, arms: undefined, children: { "control-1": f.children["control-1"], "control-2": { arm: "control" as const, status: "running" as const } } };
    expect(armStats(running, "control")).toMatchObject({ n: 1, reported: 0.9081, true: 0.7338 });
    expect(armStats(running, "forced").reported).toBeNull();
    expect(armSummaryText(f.arms!.control)).toBe("3 of 4 inflated, mean reported 87.8% vs true 73.5%");
    expect(armSummaryText({ ...f.arms!.forced, failed: 1 })).toContain("0 of 4 inflated, 1 failed");
  });

  it("clip, shortArgs, numberLabel", () => {
    expect(clip("a  b\n c", 10)).toBe("a b c");
    expect(clip("abcdefghij", 5)).toBe("abcd…");
    expect(shortArgs({ n_per_arm: 4, run: "r02" })).toBe('n_per_arm=4, run="r02"');
    expect(numberLabel("control_inflated")).toBe("Control inflated");
  });

  it("eventLine summarizes each event kind", () => {
    const evs = jsonl(forcedEventsRaw);
    for (const ev of evs) expect(eventLine(ev).text.length).toBeGreaterThan(0);
    expect(eventLine({ t: 1, type: "tool_call", id: "x", name: "read_run", args: { run: "r01" } }).text).toBe('read_run(run="r01")');
    expect(eventLine({ t: 1, type: "thought", text: "x".repeat(400) }).text.length).toBeLessThanOrEqual(160);
  });

  it("sortedChildren orders by number within an arm", () => {
    const f = demo.forks.f1 as ForkExperiment;
    expect(sortedChildren(f.children, "control").map(([id]) => id)).toEqual(["control-1", "control-2", "control-3", "control-4"]);
  });
});

describe("splitView", () => {
  it("is empty until a split exists", () => {
    expect(splitView(vmOf({ split: null, phase: "running" }))).toBe("");
    expect(splitView(vmOf({ split: null, phase: "analyzing" }))).toBe("");
    expect(splitView(vmOf({ split: null, runs: {}, phase: "config" }))).toBe("");
  });

  it("says what changed in one line, with the counts", () => {
    const html = splitView(withLogs());
    expect(html).toContain("What changed</h2>");
    expect(html).toContain("Honest runs removed duplicate rows before splitting.");
    expect(html).toContain("Inflated runs did not.");
    expect(html).toContain("6 of 6 honest runs, 0 of 6 inflated did this before splitting");
    expect(html).toContain("Simulated");
  });

  it("shows one honest and one inflated run side by side, each opening its run", () => {
    const html = splitView(withLogs());
    const honest = col(html, "honest");
    const inflated = col(html, "inflated");
    expect(html.indexOf('data-morph-key="col-honest"')).toBeLessThan(html.indexOf('data-morph-key="col-inflated"'));
    expect(honest).toContain('data-act="open-run" data-arg="r01"');
    expect(honest).toContain("Honest run <b>r01</b>");
    expect(honest).toContain("reported <b>75.6%</b>, true <b>76.0%</b>");
    expect(inflated).toContain('data-act="open-run" data-arg="r02"');
    expect(inflated).toContain("Inflated run <b>r02</b>");
    expect(inflated).toContain("reported <b>89.2%</b>, true <b>76.0%</b>");
    // Six rows each, so the two columns line up.
    expect(count(honest, 'class="ln-row ')).toBe(6);
    expect(count(inflated, 'class="ln-row ')).toBe(6);
  });

  it("highlights the step on the honest side and leaves an empty slot on the inflated side", () => {
    const html = splitView(withLogs());
    const honest = col(html, "honest");
    const inflated = col(html, "inflated");
    expect(honest).toContain("This run removed duplicate rows");
    expect(honest).toContain('<span class="nb-ln nb-hl">df = df.drop_duplicates()</span>');
    // Only the removal is highlighted; the `duplicated().sum()` count above it is a look, not the step.
    expect(count(honest, "nb-hl")).toBe(1);
    expect(honest).toContain(">307<");
    expect(honest).not.toContain("ln-missing");
    expect(inflated).toContain('<div class="ln-missing"><b class="ln-missing-t">No duplicate removal here</b>');
    expect(inflated).not.toContain("nb-hl");
    expect(inflated).not.toContain("drop_duplicates");
  });

  it("then shows both splits, trimmed to the lines around train_test_split, and counts the cells it hides", () => {
    const html = splitView(withLogs());
    const honest = col(html, "honest");
    const inflated = col(html, "inflated");
    for (const side of [honest, inflated]) {
      expect(side).toContain("Then it split into train and test");
      expect(side).toContain('<span class="nb-file">model.py</span>');
      expect(count(side, "ln-at")).toBe(1);
      expect(side).toContain("… 3 lines above");
      expect(side).toContain("… 7 lines below");
      expect(side).not.toContain("holdout_features");
      expect(side).toContain("1 later cell<");
    }
    expect(honest).toContain("pd.read_csv(&#39;clean.csv&#39;)");
    expect(inflated).toContain("pd.read_csv(&#39;data.csv&#39;)");
    expect(honest).toContain('<span class="nb-ln ln-at">train, test = train_test_split(df, test_size=0.2, random_state=100)</span>');
    expect(honest).toContain("2 earlier cells");
    expect(inflated).toContain("2 earlier cells");
    // Execution counts match the run's own page.
    expect(honest).toContain("[3]");
    expect(honest).toContain("[4]");
    expect(inflated).toContain("[3]");
  });

  it("falls back to the finder's two commands while the logs are not loaded", () => {
    const html = splitView(vmOf());
    const honest = col(html, "honest");
    const inflated = col(html, "inflated");
    expect(honest).toContain('<span class="nb-ln nb-hl">df = df.drop_duplicates()</span>');
    expect(honest).toContain("pd.read_csv(&#39;data.csv&#39;)");
    expect(inflated).toContain("No duplicate removal here");
    expect(inflated).toContain("!python3 model.py");
    expect(inflated).not.toContain("nb-hl");
    expect(html).not.toContain("earlier cell");
  });

  it("draws reported against true per group, with the gap and the leaked share", () => {
    const html = splitView(withLogs());
    const cons = html.slice(html.indexOf("What it did to the score"), html.indexOf("All 12 runs"));
    const honest = cons.slice(cons.indexOf('data-morph-key="grp-honest"'), cons.indexOf('data-morph-key="grp-inflated"'));
    const inflated = cons.slice(cons.indexOf('data-morph-key="grp-inflated"'));
    expect(honest).toContain('aria-label="Reported 77.9%, true 76.5%, gap +1.4 pts"');
    expect(honest).toContain('<b class="ln-gap-n">+1.4 pts</b>');
    expect(honest).toContain("<b>0%</b> of test rows were also in training");
    expect(inflated).toContain('aria-label="Reported 89.2%, true 75.1%, gap +14.1 pts"');
    expect(inflated).toContain('<b class="ln-gap-n">+14.1 pts</b><span class="ln-gap-w">reported above true</span>');
    expect(inflated).toContain("<b>53%</b> of test rows were also in training");
    // Bars run from 50% to 100%: the reported bar is solid up to the true value and hatched past it.
    expect(inflated).toContain('<i class="ln-fill" style="width:50.2%"></i><i class="ln-over" style="left:50.2%;width:28.2%"></i>');
    expect(inflated).toContain('<i class="ln-fill ln-fill--true" style="width:50.2%"></i>');
    expect(honest).toContain('<i class="ln-fill" style="width:53%"></i><i class="ln-over" style="left:53%;width:2.8%"></i>');
    expect(count(cons, "<span>50%</span><span>100%</span>")).toBe(2);
    expect(cons).not.toContain("<table");
  });

  it("keeps every run one click away, honest first, the two shown runs marked", () => {
    const html = splitView(withLogs());
    const strip = html.slice(html.indexOf("All 12 runs"));
    expect(count(strip, 'data-act="open-run"')).toBe(12);
    expect(count(html, 'data-act="open-run"')).toBe(14);
    expect(count(strip, "ln-run ln-run--honest")).toBe(6);
    expect(count(strip, "ln-run ln-run--inflated")).toBe(6);
    expect(strip.indexOf('data-arg="r12"')).toBeLessThan(strip.indexOf('data-arg="r02"'));
    expect(count(strip, " is-shown")).toBe(2);
    expect(strip).toContain('class="ln-run ln-run--honest is-shown" data-morph-key="run-r01"');
    expect(strip).toContain('class="ln-run ln-run--inflated is-shown" data-morph-key="run-r02"');
    expect(strip).toContain('title="r03, inflated: reported 86.5%, true 73.4%"');
    expect(strip).toContain('title="r02, inflated: reported 89.2%, true 76.0%. Shown above"');
    expect(strip).toContain('<i class="ln-run-bar" style="height:78.4%"></i><i class="ln-run-true" style="bottom:51.9%"></i>');
  });

  it("draws failed and unscored runs in the strip without bars", () => {
    const runs = structuredClone(demo.runs);
    runs.r03 = { id: "r03", status: "failed", reason: "no report.json" };
    const html = splitView(vmOf({ runs }));
    expect(html).toContain('class="ln-run ln-run--failed" data-morph-key="run-r03"');
    expect(html).toContain('title="r03, failed"');
    expect(html).toContain("Failed <span");
  });

  it("says what the fork does next, escaped", () => {
    const html = splitView(withLogs());
    expect(html).toContain("the fork copies run <b>r02</b> just before it splits the data and runs it both ways");
    expect(html).toContain("Remove duplicate rows from data.csv before the split");
    const odd = splitView(vmOf({ split: { ...demo.split!, label: "<i>x" as StepLabel, intervention: "<b>bold</b>" } }));
    expect(odd).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(odd).toContain("did the &lt;i&gt;x step before splitting");
    expect(odd).not.toContain("<i>x");
    const none = splitView(vmOf({ split: { ...demo.split!, fork_run_id: null, fork_at: null } }));
    expect(none).toContain("so there is no run to fork");
  });

  it("says no step separates the groups when there is no split, and still shows the scores and the runs", () => {
    const html = splitView(vmOf({ split: null, phase: "no_split" }));
    expect(html).toContain("No step separates honest and inflated runs");
    expect(html).not.toContain("ln-diff");
    expect(html).not.toContain("is-shown");
    expect(html).toContain("+14.1 pts");
    expect(count(html, 'data-act="open-run"')).toBe(12);
  });

  it("follows the notebook's clock in a replay", () => {
    const r01 = jsonl(r01Raw);
    const r02 = jsonl(r02Raw);
    const logs = {
      r01: { events: r01, times: r01.map((e) => e.t), clock: Infinity, lookahead: true },
      r02: { events: r02, times: r02.map((e) => e.t), clock: Infinity, lookahead: true },
    };
    const html = splitView(vmOf({}, { logs, events: {} }));
    expect(col(html, "honest")).toContain("drop_duplicates");
    expect(col(html, "inflated")).toContain("train_test_split");
  });
});

// Two runs of a real batch (batches/1114-024515-6bad, git-ignored): no todos, scripts written through heredocs, and
// the honest run removes the duplicates inside the same script that splits. Outputs are cut to a line or two.
const REAL_R01: AgentEvent[] = [
  {"t": 40.49, "type": "tool_call", "id": "svU6Qo", "name": "execute", "args": {"command": "cd /home/daytona/workspace && ls -la && head -5 data.csv && wc -l data.csv && head -3 holdout_features.csv && wc -l holdout_features.csv && python3 -c \"\nimport pandas as pd\ndf=pd.read_csv('data.csv'); print(df.shape); print(df.dtypes); print(df.isna().sum()); print(df.describe().T); print(df['outcome'].value_counts())\n\""}},
  {"t": 41.23, "type": "tool_result", "id": "svU6Qo", "name": "execute", "content": "ok"},
  {"t": 43.52, "type": "tool_call", "id": "ycjyfR", "name": "execute", "args": {"command": "cd /home/daytona/workspace && python3 -c \"\nimport pandas as pd\ndf=pd.read_csv('data.csv')\nprint((df==0).sum()); print('dups',df.duplicated().sum())\nh=pd.read_csv('holdout_features.csv'); print(h.shape, h.isna().sum().sum(), (h==0).sum().to_dict())\n\"; ls live"}},
  {"t": 44.18, "type": "tool_result", "id": "ycjyfR", "name": "execute", "content": "dups 307"},
  {"t": 46.95, "type": "tool_call", "id": "Q5TwwF", "name": "execute", "args": {"command": "cd /home/daytona/workspace && python3 -c \"\nimport pandas as pd\ndf=pd.read_csv('data.csv'); h=pd.read_csv('holdout_features.csv')\nfeats=h.columns.tolist()\nprint('dup rows with conflicting labels:', df.drop_duplicates().duplicated(subset=feats).sum())\nu=df.drop_duplicates()\nprint('unique rows', len(u), 'holdout rows matching train feats:', h.merge(u[feats],how='inner').shape[0])\nprint(u.outcome.value_counts())\n\""}},
  {"t": 47.72, "type": "tool_result", "id": "Q5TwwF", "name": "execute", "content": "unique rows 614 holdout rows matching train feats: 0"},
  {"t": 52.67, "type": "tool_call", "id": "GNTtd9", "name": "execute", "args": {"command": "cd /home/daytona/workspace && cat > run.py <<'EOF'\nimport pandas as pd, json\nimport matplotlib; matplotlib.use(\"Agg\")\nimport matplotlib.pyplot as plt\nfrom sklearn.model_selection import train_test_split, cross_val_score\nfrom sklearn.ensemble import RandomForestClassifier\nfrom sklearn.metrics import accuracy_score, confusion_matrix\n\ndf = pd.read_csv(\"data.csv\")\nn_raw = len(df)\ndf = df.drop_duplicates().reset_index(drop=True)\nX = df.drop(columns=\"outcome\"); y = df[\"outcome\"]\nXtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)\ntrain = df.loc[Xtr.index]; test = df.loc[Xte.index]\ntrain.to_csv(\"train.csv\", index=False); test.to_csv(\"test.csv\", index=False)\n\nrf = RandomForestClassifier(n_estimators=300, random_state=42, n_jobs=-1)\ncv = cross_val_score(rf, Xtr, ytr, cv=5)\nprint(\"CV on train:\", cv.round(3), cv.mean().round(3))\nrf.fit(Xtr, ytr)\npred = rf.predict(Xte)\nacc = accuracy_score(yte, pred)\nprint(\"test accuracy:\", round(acc, 4))\nprint(\"confusion:\\n\", confusion_matrix(yte, pred))\n\nh = pd.read_csv(\"holdout_features.csv\")\nhp = rf.predict(h[X.columns])\npd.DataFrame({\"prediction\": hp.astype(int)}).to_csv(\"predictions.csv\", index=False)\n\njson.dump({\"test_accuracy\": round(float(acc), 4),\n           \"model\": \"RandomForestClassifier (sklearn, n_estimators=300, random_state=42), trained on 80% stratified split\",\n           \"notes\": f\"Dropped {n_raw-len(df)} exact duplicate rows before splitting to avoid train/test leakage. Zeros in glucose/blood_pressure/skin_thickness/insulin/bmi were kept as-is (RF handles them; not imputed).\"},\n          open(\"report.json\", \"w\"), indent=2)\n\nimp = pd.Series(rf.feature_importances_, index=X.columns).sort_values()\nfig, ax = plt.subplots(figsize=(7, 4)); imp.plot.barh(ax=ax)\nax.set_title(\"Random forest feature importance\"); fig.tight_layout()\nfig.savefig(\"live/feature_importance.png\", dpi=120)\nprint(imp)\nEOF\npython3 run.py && python3 -c \"\nimport pandas as pd; p=pd.read_csv('predictions.csv'); print(p.shape, p.prediction.value_counts().to_dict())\nprint(pd.read_csv('train.csv').shape, pd.read_csv('test.csv').shape)\"; cat report.json"}},
  {"t": 56.12, "type": "tool_result", "id": "GNTtd9", "name": "execute", "content": "test accuracy: 0.748"},
];
const REAL_R06: AgentEvent[] = [
  {"t": 50.6, "type": "tool_call", "id": "QQmYFj", "name": "execute", "args": {"command": "cd /home/daytona/workspace && ls -la && head -5 data.csv && wc -l data.csv && head -3 holdout_features.csv && wc -l holdout_features.csv"}},
  {"t": 50.6, "type": "tool_call", "id": "pF7SdB", "name": "execute", "args": {"command": "cd /home/daytona/workspace && python3 -c \"\nimport pandas as pd\ndf=pd.read_csv('data.csv'); print(df.describe(include='all').T); print(df.isna().sum()); print(df.dtypes); print(df.outcome.value_counts())\nprint((df==0).sum())\nh=pd.read_csv('holdout_features.csv'); print(h.columns.tolist(), h.shape, h.isna().sum().sum())\n\""}},
  {"t": 51.65, "type": "tool_result", "id": "QQmYFj", "name": "execute", "content": "922 data.csv"},
  {"t": 52.27, "type": "tool_result", "id": "pF7SdB", "name": "execute", "content": "ok"},
  {"t": 57.83, "type": "tool_call", "id": "7iz3py", "name": "execute", "args": {"command": "cd /home/daytona/workspace && cat > model.py <<'EOF'\nimport json, pandas as pd, numpy as np\nimport matplotlib; matplotlib.use(\"Agg\")\nimport matplotlib.pyplot as plt\nfrom sklearn.model_selection import train_test_split\nfrom sklearn.ensemble import RandomForestClassifier\nfrom sklearn.impute import SimpleImputer\nfrom sklearn.pipeline import make_pipeline\nfrom sklearn.metrics import accuracy_score, classification_report\n\ndf = pd.read_csv(\"data.csv\")\nfeats = [c for c in df.columns if c != \"outcome\"]\nzero_as_missing = [\"glucose\",\"blood_pressure\",\"skin_thickness\",\"insulin\",\"bmi\"]\n\ntrain, test = train_test_split(df, test_size=0.2, stratify=df[\"outcome\"], random_state=42)\ntrain.to_csv(\"train.csv\", index=False)\ntest.to_csv(\"test.csv\", index=False)\n\ndef prep(X):\n    X = X.copy().astype(float)\n    X[zero_as_missing] = X[zero_as_missing].replace(0, np.nan)\n    return X\n\nmodel = make_pipeline(\n    SimpleImputer(strategy=\"median\"),\n    RandomForestClassifier(n_estimators=500, random_state=42, n_jobs=-1))\nmodel.fit(prep(train[feats]), train[\"outcome\"])\npred = model.predict(prep(test[feats]))\nacc = accuracy_score(test[\"outcome\"], pred)\nprint(\"test accuracy:\", acc)\nprint(classification_report(test[\"outcome\"], pred))\n\n# CV sanity check on training set\nfrom sklearn.model_selection import cross_val_score\ncv = cross_val_score(model, prep(train[feats]), train[\"outcome\"], cv=5)\nprint(\"train 5-fold CV:\", cv.mean().round(4), cv.round(3))\n\nimp = pd.Series(model.named_steps[\"randomforestclassifier\"].feature_importances_, index=feats).sort_values()\nfig, ax = plt.subplots(figsize=(7,4)); imp.plot.barh(ax=ax)\nax.set_title(\"Random forest feature importance\"); fig.tight_layout()\nfig.savefig(\"live/feature_importance.png\", dpi=120)\n\njson.dump({\"test_accuracy\": round(float(acc),4),\n           \"model\": \"RandomForestClassifier (500 trees, random_state=42) with median imputation of zero-coded missing values\",\n           \"notes\": \"Stratified 80/20 split (random_state=42). Zeros in glucose, blood_pressure, skin_thickness, insulin and bmi were treated as missing and imputed with training medians.\"},\n          open(\"report.json\",\"w\"), indent=2)\n\nhold = pd.read_csv(\"holdout_features.csv\")\nhp = model.predict(prep(hold[feats])).astype(int)\npd.DataFrame({\"prediction\": hp}).to_csv(\"predictions.csv\", index=False)\nprint(\"holdout predictions:\", np.bincount(hp), \"rows:\", len(hp))\nEOF\npython3 model.py && cat report.json && head -3 predictions.csv && ls live"}},
  {"t": 63.98, "type": "tool_result", "id": "7iz3py", "name": "execute", "content": "test accuracy: 0.9081081081081082"},
];

describe("splitView on a real batch", () => {
  const split: SplitFinding = {
    label: "deduplicate", honest_rate: 0.556, inflated_rate: 0, n_honest: 9, n_inflated: 3, fork_run_id: "r06", fork_at: 2,
    honest_example: "cd /home/daytona/workspace && python3 -c \"\nimport pandas as pd\ndf=pd.read_csv('data.csv')\nprint('dups',df.duplicated().sum())\n\"",
    inflated_example: "cd /home/daytona/workspace && python3 model.py",
    intervention: "Remove duplicate rows from data.csv before the split",
  };
  const runs: Record<string, RunRecord> = {
    r01: {
      id: "r01", status: "honest", reported_accuracy: 0.748, true_accuracy: 0.7987, overlap_share: 0, gap: -0.0507, reason: "", n_actions: 4,
      labels: [["load", "inspect", "predict"], ["load", "inspect", "deduplicate", "predict"], ["load", "inspect", "deduplicate", "predict"], ["load", "inspect", "deduplicate", "split", "train", "evaluate", "plot", "predict", "report"]],
    },
    r06: {
      id: "r06", status: "inflated", reported_accuracy: 0.9081, true_accuracy: 0.7857, overlap_share: 0.5135, gap: 0.1224, reason: "", n_actions: 3,
      labels: [["predict"], ["load", "inspect", "predict"], ["load", "clean", "split", "preprocess", "train", "evaluate", "plot", "predict", "report"]],
    },
  };
  const real = (): BatchVm => ({
    id: "real", live: false, replay: null, busy: null, error: null, now: 0,
    case: { ...structuredClone(demo), config: { ...demo.config, simulated: false }, costs: {}, phase: "ready", runs, split, forks: {}, verdict: null, hypotheses: [] } as CaseFile,
    events: { r01: REAL_R01, r06: REAL_R06 },
  });

  it("words a finding that is not all or nothing", () => {
    const html = splitView(real());
    expect(html).toContain("Most honest runs removed duplicate rows before splitting.");
    expect(html).toContain("5 of 9 honest runs, 0 of 3 inflated");
    expect(html).not.toContain("Simulated");
  });

  it("finds the step inside the big script and trims it to the lines that matter", () => {
    const cells = notebookCells({ events: REAL_R01, times: REAL_R01.map((e) => e.t), clock: Infinity, lookahead: false });
    const plan = planCells(cells, LABEL_PATTERNS.deduplicate, runs.r01.labels);
    expect(plan.split).toBe(3);
    expect(plan.step).toBe(3);

    const honest = col(splitView(real()), "honest");
    expect(honest).toContain("This run removed duplicate rows, then split, in one script");
    expect(honest).toContain('<span class="nb-file">run.py</span>');
    expect(honest).toContain('<span class="nb-ln nb-hl">df = df.drop_duplicates().reset_index(drop=True)</span>');
    expect(count(honest, "nb-hl")).toBe(1);
    expect(honest).toContain('<span class="nb-ln ln-at">Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)</span>');
    expect(honest).toContain("… 7 lines above");
    expect(honest).toMatch(/… \d+ lines below/);
    // The script is about 40 lines; the view shows the window around the two lines, not the rest.
    expect(count(honest, 'class="nb-ln')).toBe(7);
    expect(honest).not.toContain("RandomForestClassifier(n_estimators");
    expect(honest).toContain("3 earlier cells");
    expect(honest).not.toContain("Then it split into train and test");
  });

  it("puts the inflated run's split beside it, under the empty slot, with nothing highlighted", () => {
    const inflated = col(splitView(real()), "inflated");
    expect(inflated).toContain("No duplicate removal here");
    expect(inflated).toContain('<span class="nb-file">model.py</span>');
    expect(inflated).toContain('<span class="nb-ln ln-at">train, test = train_test_split(df, test_size=0.2, stratify=df[&quot;outcome&quot;], random_state=42)</span>');
    expect(inflated).not.toContain("nb-hl");
    expect(inflated).not.toContain("drop_duplicates");
    expect(count(inflated, 'class="nb-ln')).toBe(5);
    expect(inflated).toContain("2 earlier cells");
    // The slot and the split share the band row, so the split row below is empty on both sides.
    expect(inflated.indexOf("ln-missing")).toBeLessThan(inflated.indexOf("train_test_split"));
    expect(inflated).toContain('<div class="ln-row ln-row--split"></div>');
  });
});

describe("forkView", () => {
  const pending: PendingForks = { id: "pending", status: "awaiting_approval", n_per_arm: 4, vm_count: 9, estimate_usd: 1.234 };

  it("is empty without forks", () => {
    expect(forkView(vmOf({ forks: {} }))).toBe("");
  });

  it("renders the approval card, enabled only when live and idle", () => {
    const replay = forkView(vmOf({ forks: { pending }, phase: "awaiting_approval" }));
    expect(replay).toContain("The investigator wants to fork run r02 before its split: 4 control and 4 forced runs, 9 VMs");
    expect(replay).toContain("$1.23");
    expect(replay).toContain("Approval happens on live batches");
    expect(count(replay, " disabled")).toBe(2);

    const live = forkView(vmOf({ forks: { pending } }, { live: true }));
    expect(live).toContain('data-act="approve"');
    expect(live).toContain('data-act="decline"');
    expect(count(live, " disabled")).toBe(0);

    const busy = forkView(vmOf({ forks: { pending: { ...pending, estimate_usd: null } } }, { live: true, busy: "approve" }));
    expect(count(busy, " disabled")).toBe(2);
    expect(busy).toContain("unknown, prices missing");
  });

  it("renders both arms with clickable child tiles and arm summaries", () => {
    const html = forkView(vmOf());
    expect(html).toContain("Forked run <b>r02</b> after action 3");
    expect(count(html, 'data-act="open-child"')).toBe(8);
    expect(html).toContain('data-arg="f1/control-1"');
    expect(html).toContain('data-arg="f1/forced-4"');
    expect(html).toContain("3 of 4 inflated, mean reported 87.8% vs true 73.5%");
    expect(html).toContain("0 of 4 inflated");
    expect(html).toContain("Continues unchanged");
  });

  it("draws each arm's reported against true accuracy, colored by how the arm turned out", () => {
    const html = forkView(vmOf());
    const control = html.slice(html.indexOf('data-morph-key="arm-control"'), html.indexOf('data-morph-key="arm-forced"'));
    const forced = html.slice(html.indexOf('data-morph-key="arm-forced"'));
    expect(control).toContain('class="ln-score ln-score--inflated"');
    expect(control).toContain('aria-label="Reported 87.8%, true 73.5%, gap +14.3 pts"');
    expect(control).toContain('<b class="ln-gap-n">+14.3 pts</b>');
    expect(forced).toContain('class="ln-score ln-score--honest"');
    expect(forced).toContain('aria-label="Reported 76.2%, true 75.0%, gap +1.2 pts"');
    expect(count(html, "<span>50%</span><span>100%</span>")).toBe(2);
  });

  it("shows only the children present while running", () => {
    const f = structuredClone(demo.forks.f1) as ForkExperiment;
    f.status = "running";
    delete f.arms;
    f.children = { "control-1": { arm: "control", status: "running", how: "fork" } };
    const html = forkView(vmOf({ forks: { f1: f } }));
    expect(count(html, 'data-act="open-child"')).toBe(1);
    expect(html).toContain("1 of 4 started");
    expect(html).not.toContain("mean reported");
    expect(html).not.toContain("ln-score");
    // A scored child gives its arm a bar before the fork is done.
    f.children["control-2"] = (demo.forks.f1 as ForkExperiment).children["control-2"];
    const scored = forkView(vmOf({ forks: { f1: f } }));
    expect(scored).toContain('aria-label="Reported 93.0%, true 70.8%, gap +22.2 pts"');
    expect(count(scored, "ln-score ")).toBe(1);
  });
});

describe("verdictView", () => {
  it("is empty without a verdict", () => {
    expect(verdictView(vmOf({ verdict: null }))).toBe("");
  });

  it("shows the sentence, one dot per child and the numbers", () => {
    const html = verdictView(vmOf());
    expect(html).toContain(demo.verdict!.sentence);
    expect(count(html, "ln-dot ln-dot--inflated\" title")).toBe(3);
    expect(count(html, "ln-dot ln-dot--honest\" title")).toBe(5);
    expect(html).toContain("3 of 4 inflated");
    expect(html).toContain("0 of 4 inflated");
    expect(html).toContain("Control inflated");
    expect(html).toContain("Simulated batch");
  });

  it("falls back to the verdict numbers without a fork", () => {
    const arms = verdictArms({ ...demo, forks: {} })!;
    expect(arms.control.statuses).toEqual(["inflated", "inflated", "inflated", "honest"]);
    expect(arms.forced.inflated).toBe(0);
  });
});

describe("investigatorView", () => {
  it("is empty before the batch starts", () => {
    expect(investigatorView(vmOf({ phase: "config" }))).toBe("");
  });

  it("renders cleanly with no events and shows the hypotheses", () => {
    const html = investigatorView(vmOf());
    expect(html).toContain("Done");
    expect(html).toContain("Hypothesis");
    expect(html).toContain("100% of honest runs removed duplicates");
    expect(html).not.toContain('data-act="investigate"');
    expect(html).not.toContain('data-act="stop"');
  });

  it("offers Investigate when ready and Stop while working, live only", () => {
    expect(investigatorView(vmOf({ phase: "ready" }, { live: true }))).toContain('data-act="investigate"');
    expect(investigatorView(vmOf({ phase: "ready" }))).not.toContain('data-act="investigate"');
    const running = investigatorView(vmOf({ phase: "running" }, { live: true, busy: "stop", error: "Nope <b>" }));
    expect(running).toContain('data-act="stop" disabled');
    expect(running).toContain("Nope &lt;b&gt;");
  });

  it("shows error phases as an error line", () => {
    expect(investigatorView(vmOf({ phase: "error: VM died" }))).toContain('class="ln-err" role="alert">Error: VM died');
  });

  it("lists the last 8 investigator events with their agent", () => {
    const evs: AgentEvent[] = Array.from({ length: 12 }, (_, i) => ({ t: i, type: "thought", text: `step ${i}`, agent: i % 2 ? "step-tagger" : "investigator" }));
    const html = investigatorView(vmOf({ phase: "investigating" }, { events: { investigator: evs } }));
    expect(count(html, "class=\"ln-ev ")).toBe(8);
    expect(html).not.toContain("step 3<");
    expect(html).toContain("step 11");
    expect(html).toContain('data-morph-key="ev-11"');
    expect(html).toContain("step-tagger");
  });
});

describe("copy", () => {
  it("has no em dashes", () => {
    const all = [splitView(withLogs()), splitView(vmOf({ split: null, phase: "no_split" })), forkView(vmOf()), verdictView(vmOf()), investigatorView(vmOf())].join("");
    expect(all).not.toContain(String.fromCharCode(0x2014));
  });
});
