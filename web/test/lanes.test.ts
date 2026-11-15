// What changed, the fork, the verdict and the investigator (src/batch/lanes.ts) against the committed demo batch,
// plus two runs of a real batch (inline below) whose honest run removes duplicates inside one big script.

import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import forcedEventsRaw from "../../fixtures/demo-batch/forks/f1/forced-1/events.jsonl?raw";
import r01Raw from "../../fixtures/demo-batch/runs/r01/events.jsonl?raw";
import r02Raw from "../../fixtures/demo-batch/runs/r02/events.jsonl?raw";
import robotCaseRaw from "../../fixtures/robot-demo-batch/case/case.json?raw";
import type { AgentEvent, CaseFile, ForkExperiment, PendingForks, ProposedFix, RunRecord, SplitFinding, StepLabel, TraceEntry } from "../src/api";
import {
  armCount, armNames, armStats, armStep, armSummaryText, barShare, clip, diagnosisView, eventLine, fixSummaryText, fixTestedText, fixMeasuredText, fixView,
  forkMode, forkView, investigatorView, isProblemPhase, lineWindows, rewindText, timeTravelTag,
  phaseText, pickRuns, planCells, scoreStats, selfCheckText, shortArgs, sortedChildren, splitCounts, splitHeadline,
  splitIndex, splitView as coloredSplitView, stepWords, verdictArms, verdictLine, verdictSplit, verdictView, stepRows,
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
  id: "demo", live: false, case: { ...structuredClone(demo), ...c }, events: {}, replay: null, busy: null, error: null, now: 0, open: "all", ...over,
});
const count = (html: string, needle: string): number => html.split(needle).length - 1;
/** The demo batch with the two shown runs' logs loaded. */
const withLogs = (c: Partial<CaseFile> = {}): BatchVm => vmOf(c, { events: { r01: jsonl(r01Raw), r02: jsonl(r02Raw) } });
/** One column of the side by side notebooks. */
const col = (html: string, group: "honest" | "inflated"): string => {
  const from = html.indexOf(`data-morph-key="col-${group}"`);
  // The two notebooks are unfolded detail: they come after the score, and the strip of every run follows them.
  const to = group === "honest" ? html.indexOf('data-morph-key="col-inflated"') : html.indexOf('<h3 class="ln-h3">All ');
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
    expect(splitHeadline(demo.split!)).toEqual({ honest: "Honest runs removed duplicate rows before splitting into train and test.", inflated: "Inflated runs did not." });
    expect(splitCounts(demo.split!)).toBe("6 of 6 honest runs, 0 of 6 inflated");
    const some = splitHeadline({ label: "clean", honest_rate: 0.556, inflated_rate: 0.25 });
    expect(some.honest).toBe("Most honest runs cleaned up missing values before splitting into train and test.");
    expect(some.inflated).toBe("Most inflated runs did not.");
    expect(splitHeadline({ label: "preprocess", honest_rate: 0.3, inflated_rate: 1 }).inflated).toBe("Inflated runs did too.");
    expect(splitHeadline({ label: "shuffle" as StepLabel, honest_rate: 1, inflated_rate: 0 }).honest).toBe("Honest runs did the shuffle step before splitting into train and test.");
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
    expect(armSummaryText(f.arms!.control!)).toBe("3 of 4 inflated, mean reported 87.8% vs true 73.5%");
    expect(armSummaryText({ ...f.arms!.forced!, failed: 1 })).toContain("0 of 4 inflated, 1 failed");
  });

  it("clip, shortArgs", () => {
    expect(clip("a  b\n c", 10)).toBe("a b c");
    expect(clip("abcdefghij", 5)).toBe("abcd…");
    expect(shortArgs({ n_per_arm: 4, run: "r02" })).toBe('n_per_arm=4, run="r02"');
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

  it("draws two tracks that differ at one stop", () => {
    const rows = stepRows(demo);
    const split = rows.filter((r) => r.kind === "split");
    expect(split).toEqual([{ label: "deduplicate", kind: "split", honest: [6, 6], inflated: [0, 6] }]);
    // The step the finding names sits where the runs reached it: after loading, before the split.
    const at = (label: string): number => rows.findIndex((r) => r.label === label);
    expect(at("load")).toBeLessThan(at("deduplicate"));
    expect(at("deduplicate")).toBeLessThan(at("split"));
    expect(rows.find((r) => r.label === "split")).toMatchObject({ kind: "shared", honest: [6, 6], inflated: [6, 6] });

    const html = splitView(withLogs());
    const fig = html.slice(html.indexOf('<figure class="ln-lanes"'), html.indexOf("</figure>"));
    // The step is named once, over the stop; each track's stop carries a mark per run and the count.
    expect(fig.match(/class="ln-lanes-tag">Removing duplicate rows</g)).toHaveLength(1);
    expect(fig).toMatch(/class="ln-lane-stop ln-grp--honest">.*?<b class="ln-lane-n">6 of 6 runs<\/b>/);
    expect(fig).toMatch(/class="ln-lane-stop ln-grp--inflated is-skipped">.*?<b class="ln-lane-n">0 of 6 runs<\/b>/);
    expect(fig.match(/<i class="is-on">/g)).toHaveLength(6);
    expect(fig.match(/<i class="is-off">/g)).toHaveLength(6);
    // Every other step is a dot with no words on screen: its name and counts are its tooltip.
    expect(fig).toContain('<i class="ln-lane-dot" title="Loaded the data: 6 of 6 honest runs"></i>');
    // All the words in the picture: the step, the two groups, the two counts, where the tracks start and end, and
    // what a dot is.
    const words = fig.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    expect(words).toBe("Removing duplicate rows Honest runs 6 of 6 runs Inflated runs 0 of 6 runs Start Wrote the report "
      + "A step most of the group took A step most of it skipped");
    // A case with no step labels at all still shows the step the finding names.
    const bare = Object.fromEntries(Object.entries(demo.runs).map(([id, r]) => [id, { ...r, labels: undefined }]));
    expect(stepRows({ ...demo, runs: bare, step_labels: {} } as CaseFile).map((r) => r.kind)).toEqual(["split"]);
  });

  it("says what changed in one line, with the counts", () => {
    const html = splitView(withLogs());
    expect(html).toContain("What changed</h2>");
    expect(html).toContain("Honest runs removed duplicate rows before splitting into train and test.");
    expect(html).toContain("Inflated runs did not.");
    // The counts are the rail's (below): the sentence that repeated them stays for a screen reader only.
    expect(html).toContain('<span class="mo-sr">6 of 6 honest runs, 0 of 6 inflated did this before splitting into train and test.</span>');
    // A simulated batch says so once, in the page header, not on each section.
    expect(html).not.toContain("Simulated");
  });

  it("shows one honest and one inflated run side by side, each opening its run", () => {
    const html = splitView(withLogs());
    const honest = col(html, "honest");
    const inflated = col(html, "inflated");
    expect(html.indexOf('data-morph-key="col-honest"')).toBeLessThan(html.indexOf('data-morph-key="col-inflated"'));
    expect(honest).toContain('data-act="open-run" data-arg="r01"');
    expect(honest).toContain("Honest run <b>r01</b>");
    expect(honest).toContain("claimed <b>75.6%</b>, measured <b>76.0%</b>");
    expect(inflated).toContain('data-act="open-run" data-arg="r02"');
    expect(inflated).toContain("Inflated run <b>r02</b>");
    expect(inflated).toContain("claimed <b>89.2%</b>, measured <b>76.0%</b>");
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
      expect(side).toContain("Then it split the data");
      expect(side).toContain('<span class="nb-file">model.py</span>');
      expect(count(side, "ln-at")).toBe(1);
      expect(side).toContain("… 3 lines above");
      expect(side).toContain("… 7 lines below");
      expect(side).not.toContain("holdout_features");
      expect(side).toContain("1 later command<");
    }
    expect(honest).toContain("pd.read_csv(&#39;clean.csv&#39;)");
    expect(inflated).toContain("pd.read_csv(&#39;data.csv&#39;)");
    expect(honest).toContain('<span class="nb-ln ln-at">train, test = train_test_split(df, test_size=0.2, random_state=100)</span>');
    expect(honest).toContain("2 earlier commands");
    expect(inflated).toContain("2 earlier commands");
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
    expect(html).not.toContain("earlier command");
  });

  it("draws claimed against measured per group, in the batch's own words, with the gap and the leaked share", () => {
    const html = splitView(withLogs());
    const cons = html.slice(html.indexOf("What it did to the score"), html.indexOf("All 12 runs"));
    const honest = cons.slice(cons.indexOf('data-morph-key="grp-honest"'), cons.indexOf('data-morph-key="grp-inflated"'));
    const inflated = cons.slice(cons.indexOf('data-morph-key="grp-inflated"'));
    expect(honest).toContain('aria-label="Claimed 77.9%, measured 76.5%, gap +1.4 pts"');
    // The gap is a number that counts up (motion.ts `count`): what it arrives at is in `data-text`.
    expect(honest).toMatch(/<b class="ln-gap-n"><span class="mo-n"[^>]*data-text="\+1\.4 pts">/);
    expect(honest).toContain("<b>0%</b> of test rows were also in training");
    expect(inflated).toContain('aria-label="Claimed 89.2%, measured 75.1%, gap +14.1 pts"');
    expect(inflated).toMatch(/<b class="ln-gap-n"><span class="mo-n"[^>]*data-text="\+14\.1 pts">.*?<\/b><span class="ln-gap-w">claimed above measured<\/span>/);
    expect(inflated).toContain("<b>53%</b> of test rows were also in training");
    // Bars run from 50% to 100%: the claimed bar is solid up to the measured value and hatched past it.
    expect(inflated).toContain('<i class="ln-fill ds-grow-x" style="width:50.2%"></i><i class="ln-over" style="left:50.2%;width:28.2%"></i>');
    expect(inflated).toContain('<i class="ln-fill ln-fill--true ds-grow-x" style="width:50.2%;--mo-d:150ms"></i>');
    expect(honest).toContain('<i class="ln-fill ds-grow-x" style="width:53%"></i><i class="ln-over" style="left:53%;width:2.8%"></i>');
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
    expect(strip).toContain('title="r03, inflated: claimed 86.5%, measured 73.4%"');
    expect(strip).toContain('title="r02, inflated: claimed 89.2%, measured 76.0%. Shown above"');
    expect(strip).toMatch(/<i class="ln-run-bar ds-grow-y" style="height:78\.4%;--mo-d:\d+ms"><\/i><i class="ln-run-true" style="bottom:51\.9%"><\/i>/);
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
    expect(html).toContain('<h3 class="ln-h3">What happens next</h3>');
    expect(html).toContain("Orro copies run <b>r02</b> just before splitting into train and test and continues it both ways");
    expect(html).toContain("Remove duplicate rows from data.csv before the split");
    const odd = splitView(vmOf({ split: { ...demo.split!, label: "<i>x" as StepLabel, intervention: "<b>bold</b>" } }));
    expect(odd).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(odd).toContain("did the &lt;i&gt;x step before splitting");
    expect(odd).not.toContain("<i>x");
    const none = splitView(vmOf({ split: { ...demo.split!, fork_run_id: null, fork_at: null } }));
    expect(none).toContain("so there is no run to copy and test");
    // A step the experiment cannot add to a copy: said plainly, with no word about arms or interventions.
    const cannot = splitView(vmOf({ split: { ...demo.split!, intervention: null } }));
    expect(cannot).toContain("is not tested directly. The Fork page shows what was tested instead.");
    expect(cannot).not.toMatch(/intervention|forced arm/);
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
    id: "real", live: false, replay: null, busy: null, error: null, now: 0, open: "all",
    case: { ...structuredClone(demo), config: { ...demo.config, simulated: false }, costs: {}, phase: "ready", runs, split, forks: {}, verdict: null, hypotheses: [] } as CaseFile,
    events: { r01: REAL_R01, r06: REAL_R06 },
  });

  it("words a finding that is not all or nothing", () => {
    const html = splitView(real());
    expect(html).toContain("Most honest runs removed duplicate rows before splitting into train and test.");
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
    expect(honest).toContain("3 earlier commands");
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
    expect(inflated).toContain("2 earlier commands");
    // The slot and the split share the band row, so the split row below is empty on both sides.
    expect(inflated.indexOf("ln-missing")).toBeLessThan(inflated.indexOf("train_test_split"));
    expect(inflated).toContain('<div class="ln-row ln-row--split"></div>');
  });
});

describe("forkView", () => {
  const pending: PendingForks = { id: "pending", status: "awaiting_approval", n_per_arm: 4, vm_count: 9, estimate_usd: 1.234 };

  it("draws every arm the experiment ran, in order, with the step each one runs first", () => {
    const f = demo.forks.f1 as ForkExperiment;
    const four = {
      ...f,
      arm_steps: { control: null, placebo: "Print the pandas version", show: "Count the duplicate rows and show them", forced: f.intervention },
      arms: { ...f.arms, placebo: f.arms!.control, show: f.arms!.control },
      children: {
        ...f.children,
        "placebo-1": { ...f.children["control-1"], arm: "placebo" as const },
        "show-1": { ...f.children["control-1"], arm: "show" as const },
      },
    } as ForkExperiment;
    const html = forkView(vmOf({ forks: { f1: four } }));
    expect(armNames(four)).toEqual(["control", "placebo", "show", "forced"]);
    expect(html).toContain('data-arms="4"');
    for (const [key, title] of [["control", "Control"], ["placebo", "Placebo"], ["show", "Shown"], ["forced", "Forced"]]) {
      expect(html).toContain(`data-morph-key="arm-${key}"`);
      expect(html).toContain(`>${title}<`);
    }
    expect(html).toContain("Runs first: Print the pandas version");
    expect(html).toContain("Continues unchanged");
    // A batch saved before the extra arms existed still reads as control and forced.
    expect(armNames(f)).toEqual(["control", "forced"]);
    expect(armStep(f, "control")).toBeNull();
    expect(armStep(f, "forced")).toBe(f.intervention);
    expect(forkView(vmOf({ forks: { f1: f } }))).toContain('data-arms="2"');
  });

  it("reads the arm count of a pending experiment from the VMs it asks for", () => {
    expect(armCount({ n_per_arm: 4, vm_count: 9 })).toBe(2);
    expect(armCount({ n_per_arm: 4, vm_count: 17 })).toBe(4);
    expect(armCount({ n_per_arm: 3, vm_count: 13 })).toBe(4);
    expect(armCount({ n_per_arm: 0, vm_count: 0 })).toBe(2);
  });

  it("says the approval for the first round's copies after a round of more pairs", () => {
    const f = demo.forks.f1 as ForkExperiment;
    const n = armNames(f).length;
    expect(forkView(vmOf({ forks: { f1: f } }))).toContain(`${n} arms x ${f.n_per_arm} + 1 base = ${n * f.n_per_arm + 1} VMs`);
    const more = {
      ...f, n_per_arm: f.n_per_arm + 3,
      more_pairs: [{
        at: 1, n_per_arm: 3, children: [], status: "done" as const, estimate_usd: 1.1, pairs_before: 4, level_before: "open" as const,
        n_per_arm_before: f.n_per_arm, pairs_after: 7, level_after: "open" as const,
      }],
    };
    const html = forkView(vmOf({ forks: { f1: more } }));
    // n_per_arm now counts both rounds; the approval was for the first round only.
    expect(html).toContain(`${n} arms x ${f.n_per_arm} + 1 base = ${n * f.n_per_arm + 1} VMs`);
    expect(html).not.toContain(`x ${f.n_per_arm + 3} + 1 base`);
    expect(html).toContain(`More pairs confirmed: ${n} arms x 3 + 1 base = ${n * 3 + 1} VMs, 4 pairs before, 7 pairs after`);
  });

  it("says the method once and sets the experiments side by side: a row each, its pairs, its score against 20 and its level", () => {
    const f1 = demo.forks.f1 as ForkExperiment;
    const f2 = { ...structuredClone(f1), id: "f2", change: "force_step:deduplicate", prediction: "smaller_gap" } as ForkExperiment;
    const two = forkView(vmOf({ forks: { f1, f2 } }, { open: "all" }));
    expect(count(two, '<tr data-morph-key="cmp-')).toBe(2);
    expect(two).toContain("Run a step: deduplicate");
    expect(two).toContain("the change shrinks the gap");
    // Never a level without its score: each row has both, and so does each picture's meter.
    expect(count(two, 'class="ln-xt-sc"><b>')).toBe(2);
    expect(count(two, '<span class="ln-meter-sc">Score <b>')).toBe(2);
    // How a pair is read, the score's rule and the marks' key: once for the page, not once per experiment.
    expect(count(two, 'data-morph-key="pair-key"')).toBe(1);
    expect(count(two, "It sets the level: supported at 20 or more.")).toBe(1);
    expect(count(two, '<p class="ln-key" data-morph-key="key">')).toBe(1);
    // A single experiment is its own picture: no table, the method still said once.
    const one = forkView(vmOf({ forks: { f1 } }));
    expect(one).not.toContain('class="ln-xt"');
    expect(count(one, 'data-morph-key="pair-key"')).toBe(1);
  });

  it("lays the copies out as one grid: a row per copy number, the pair those copies make beside them", () => {
    const html = forkView(vmOf({}, { open: "all" }));
    expect(html).toContain('class="ln-arms ln-pg" data-arms="2" data-pairs="1"');
    // control-2 and forced-2 sit on the same row as pair 2, under the heads in row 1.
    expect(html).toMatch(/data-arg="f1\/control-2"[^>]*style="--r:3"/);
    expect(html).toMatch(/data-arg="f1\/forced-2"[^>]*style="--r:3"/);
    expect(html).toMatch(/data-morph-key="pair-2:done" style="--i:1;--r:3"/);
    // The statistics and the provenance fold, still on the page.
    expect(html).toContain('<details class="ln-exact ln-ev-more"');
    expect(html).toContain('<details class="ln-exact ln-prov-w"');
  });

  it("is empty without forks", () => {
    expect(forkView(vmOf({ forks: {} }))).toBe("");
  });

  it("gives a robot batch's fork children a looping 3D thumbnail of their last episode", () => {
    const f = demo.forks.f1 as ForkExperiment;
    const files = ["forks/f1/forced-1/outputs/live/practice.motion.json", "forks/f1/forced-1/outputs/live/check_far.motion.json"];
    const children = { ...f.children, "forced-1": { ...f.children["forced-1"], motion_files: files }, "control-1": { ...f.children["control-1"], status: "running" as const, motion_files: [] } };
    const robot = forkView(vmOf({ config: { ...demo.config, visual: "motion" } as CaseFile["config"], forks: { f1: { ...f, children } as ForkExperiment } }));
    expect(robot).toContain(`<span class="rb-thumb" data-keep data-robot-thumb data-batch="demo" data-file="${files[1]}"`);
    expect(robot).toContain("ln-kid-pic--none");
    expect(robot).not.toContain("<div class=\"rb-thumb\"");
    // A tabular batch keeps its text tiles.
    expect(forkView(vmOf({ forks: { f1: { ...f, children } as ForkExperiment } }))).not.toContain("ln-kid-pic");
  });

  it("renders the approval card, enabled only when live and idle", () => {
    const replay = forkView(vmOf({ forks: { pending }, phase: "awaiting_approval" }));
    // 9 VMs for 4 runs an arm is one base plus two arms.
    expect(replay).toContain("The investigator wants to fork run r02 just before splitting into train and test: 4 runs in each of 2 arms, 9 VMs");
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
    expect(html).toContain("3 of 4 inflated, mean claimed 87.8% vs measured 73.5%");
    expect(html).toContain("0 of 4 inflated");
    expect(html).toContain("Continues unchanged");
  });

  it("draws each arm's claimed against measured accuracy, colored by how the arm turned out", () => {
    const html = forkView(vmOf());
    const control = html.slice(html.indexOf('data-morph-key="arm-control"'), html.indexOf('data-morph-key="arm-forced"'));
    const forced = html.slice(html.indexOf('data-morph-key="arm-forced"'));
    expect(control).toContain('class="ln-score ln-score--inflated"');
    expect(control).toContain('aria-label="Claimed 87.8%, measured 73.5%, gap +14.3 pts"');
    expect(control).toMatch(/<b class="ln-gap-n"><span class="mo-n"[^>]*data-text="\+14\.3 pts">/);
    expect(forced).toContain('class="ln-score ln-score--honest"');
    expect(forced).toContain('aria-label="Claimed 76.2%, measured 75.0%, gap +1.2 pts"');
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
    expect(html).not.toContain("mean claimed");
    expect(html).not.toContain("ln-score");
    // A scored child gives its arm a bar before the fork is done.
    f.children["control-2"] = (demo.forks.f1 as ForkExperiment).children["control-2"];
    const scored = forkView(vmOf({ forks: { f1: f } }));
    expect(scored).toContain('aria-label="Claimed 93.0%, measured 70.8%, gap +22.2 pts"');
    expect(count(scored, "ln-score ")).toBe(1);
  });
});

describe("verdictView", () => {
  it("is empty without a verdict", () => {
    expect(verdictView(vmOf({ verdict: null }))).toBe("");
  });

  it("shows the sentence from the numbers, one dot per child, and no raw number grid or simulated note", () => {
    const html = verdictView(vmOf());
    // The displayed sentence is composed from the fork's numbers: "suggests", with the score and the pairs. The
    // investigator's stored sentence says no more than that ("suggests" on 4 pairs), so it shows under it as theirs.
    expect(html).toContain(`The investigator wrote: ${demo.verdict!.sentence}`);
    expect(demo.verdict!.sentence).toContain("suggests");
    // One that says "caused" on the same open evidence is not shown at all.
    const caused = verdictView(vmOf({ verdict: { ...demo.verdict!, sentence: "Skipping the duplicate check caused the inflated scores." } }));
    expect(caused).not.toMatch(/caused|The investigator wrote/);
    expect(html).toContain("The fork suggests that not removing duplicate rows inflates the claim: 3 of 4 inflated without it, 0 of 4 with it, 4 pairs. Open: supported needs 5 pairs.");
    expect(html).not.toMatch(/caused/);
    expect(html).toContain(">Open<");
    expect(count(html, "ln-dot ln-dot--inflated\" title")).toBe(3);
    expect(count(html, "ln-dot ln-dot--honest\" title")).toBe(5);
    expect(html).toContain("3 of 4 inflated");
    expect(html).toContain("0 of 4 inflated");
    expect(html).not.toContain("Control inflated");
    expect(html).not.toContain("Control total");
    expect(html).not.toContain("Simulated");
  });

  it("shows the confidence and the structured split numbers when the verdict has them", () => {
    const old = verdictView(vmOf());
    expect(old).not.toContain("ln-conf");
    expect(old).not.toContain("v-split");
    const v = { ...demo.verdict!, step: "deduplicate", honest_rate: 1, inflated_rate: 0, n_honest: 6, n_inflated: 6, confidence: "medium" as const };
    const html = verdictView(vmOf({ verdict: v }));
    expect(html).toContain("medium confidence");
    expect(html).toContain("100.0% of 6");
    expect(html).toContain("0.0% of 6");
    expect(verdictSplit({ ...v, n_honest: undefined })).toContain("100.0%</dd>");
  });

  it("says how the rubric check went", () => {
    const check = (result: string, iteration: number, failing: { name: string; gap: string }[] = []) =>
      ({ at: iteration, iteration, result, explanation: "", criteria: 5, failing });
    expect(selfCheckText(undefined)).toBeNull();
    expect(selfCheckText([check("satisfied", 0)])).toBe("Checked against the rubric: passed.");
    expect(selfCheckText([check("needs_revision", 0), check("satisfied", 1)])).toBe("Checked against the rubric: passed after 1 revision.");
    expect(selfCheckText([check("needs_revision", 0), check("needs_revision", 1), check("max_iterations_reached", 2, [{ name: "Cites the placebo arm", gap: "x" }])]))
      .toBe("Checked against the rubric: still short after 2 revisions: Cites the placebo arm.");
    expect(verdictView(vmOf({ rubric: [check("satisfied", 0)] }))).toContain("Checked against the rubric: passed.");
  });

  it("falls back to the verdict numbers without a fork", () => {
    const arms = verdictArms({ ...demo, forks: {} })!;
    expect(arms.control!.statuses).toEqual(["inflated", "inflated", "inflated", "honest"]);
    expect(arms.forced!.inflated).toBe(0);
  });
});

// ── the diagnosis and the fix (a robot batch: the trace reads recordings, the fix patches controller.py) ──

const traceEntry: TraceEntry = {
  at: 1700000000,
  run_id: "r02",
  symptom: "The can slipped out of the grip at 2.14 s, 0.31 m into a 0.60 m carry, while the hand moved at 0.9 m/s.",
  line: 25,
  excerpt: "    t_move=0.4,",
  why: "A fixed 0.4 s carry <b>never</b> slows down for a long reach.",
  motion_file: "runs/r02/trace/hidden_07.motion.json",
};

const proposedFix: ProposedFix = {
  run_id: "r02",
  file_path: "/home/daytona/workspace/controller.py",
  line: 25,
  old_string: "    t_move=0.4,",
  new_string: "    t_move=0.4 + 1.2 * dist,",
  description: "Scale the carry time with the carry distance",
  why: "The carry takes the same 0.4 s whatever the distance, so a long carry <i>whips</i> the can.",
  status: "proposed",
  proposed_at: 1700000100,
};

const armOf = (honest: number, meanTrue: number, meanReported: number) =>
  ({ total: 4, scored: 4, inflated: 4 - honest, honest, failed: 0, mean_reported: meanReported, mean_true: meanTrue });

/** The second experiment: control and placebo unchanged, the fixed arm with the patch applied. */
const fixFork: ForkExperiment = {
  id: "f2",
  kind: "fix",
  status: "done",
  source_run: "r02",
  fork_at: 3,
  label: "deduplicate",
  intervention: "Apply the proposed fix to controller.py",
  n_per_arm: 4,
  arm_steps: { control: null, placebo: "Print the MuJoCo version", fixed: "Apply the proposed fix to controller.py" },
  children: {
    "control-1": { arm: "control", status: "inflated", reported_accuracy: 1, true_accuracy: 0.45, how: "fork" },
    "placebo-1": { arm: "placebo", status: "inflated", reported_accuracy: 1, true_accuracy: 0.45, how: "fork" },
    "fixed-1": { arm: "fixed", status: "honest", reported_accuracy: 0.8, true_accuracy: 0.72, how: "fork" },
  },
  arms: { control: armOf(1, 0.45, 1), placebo: armOf(1, 0.45, 1), fixed: armOf(3, 0.72, 0.8) },
};

describe("diagnosisView: the trace comparison", () => {
  it("says whether the traced runs share a cause", () => {
    const html = diagnosisView(vmOf({ trace: [traceEntry], trace_comparison: { at: 1, same: "same", sentence: "r02 and r05 both slip at line 25.", run_ids: ["r02", "r05"] } }));
    expect(html).toContain("Same cause in every traced run.");
    expect(html).toContain("r02 and r05 both slip at line 25.");
    expect(diagnosisView(vmOf({ trace: [traceEntry] }))).not.toContain("ln-dx-cmp");
  });
});

describe("diagnosisView", () => {
  it("is empty without a trace, including on case files saved before it existed", () => {
    expect(diagnosisView(vmOf())).toBe("");
    expect(diagnosisView(vmOf({ trace: [] }))).toBe("");
  });

  it("renders each entry's run, symptom, line, excerpt and why, escaped", () => {
    const html = diagnosisView(vmOf({ trace: [traceEntry, { ...traceEntry, at: 1700000005, line: 31, excerpt: "", motion_file: null }] }));
    expect(html).toContain(">Diagnosis<");
    expect(html).toContain('data-morph-key="trace-1700000000"');
    expect(html).toContain('data-morph-key="trace-1700000005"');
    expect(html).toContain('<span class="ln-tag">r02</span>');
    expect(html).toContain(traceEntry.symptom);
    expect(html).toContain('<span class="ln-dx-ln">line 25</span>    t_move=0.4,');
    expect(html).toContain('<span class="ln-dx-ln">line 31</span></pre>');
    expect(html).toContain("A fixed 0.4 s carry &lt;b&gt;never&lt;/b&gt; slows down");
    expect(html).not.toContain("<b>never</b>");
  });

  it("links the recording only when the entry names one", () => {
    const linked = diagnosisView(vmOf({ trace: [traceEntry] }));
    expect(linked).toContain('<a class="ln-dx-link" href="/api/batches/demo/files/runs/r02/trace/hidden_07.motion.json" target="_blank" rel="noopener">recording</a>');
    const unlinked = diagnosisView(vmOf({ trace: [{ ...traceEntry, motion_file: null }] }));
    expect(unlinked).not.toContain("ln-dx-link");
    expect(unlinked).not.toContain("<a ");
  });
});

describe("fixView", () => {
  it("is empty without a fix, including on case files saved before it existed", () => {
    expect(fixView(vmOf())).toBe("");
    expect(fixView(vmOf({ fix: null }))).toBe("");
  });

  it("shows the description, the status, where it patches, and the text before and after", () => {
    const html = fixView(vmOf({ fix: proposedFix }));
    expect(html).toContain(">Fix<");
    // The description arrives a word at a time (motion.ts `reveal`): the whole text is there for a screen reader.
    expect(html).toContain('<p class="ln-fix-t"><span class="mo-sr">Scale the carry time with the carry distance</span>');
    // The status is a chip (motion.ts `chip`) that also wears the lane's own tone class.
    expect(html).toContain('ln-pill ln-pill--muted"');
    expect(html).toContain("Proposed</span>");
    expect(html).toContain("run r02 · controller.py line 25");
    expect(html).toContain(">Before<");
    expect(html).toContain(">After<");
    expect(html).toContain('ln-fix-old"><figcaption class="ln-fix-cap">Before</figcaption><pre class="ln-fix-pre">    t_move=0.4,</pre>');
    expect(html).toContain('ln-fix-new"><figcaption class="ln-fix-cap">After</figcaption><pre class="ln-fix-pre">    t_move=0.4 + 1.2 * dist,</pre>');
    expect(html).toContain("a long carry &lt;i&gt;whips&lt;/i&gt; the can");
    expect(html).not.toContain("<i>whips</i>");
    expect(html).not.toContain("ln-sentence");
    expect(html).not.toContain("Tested in fork");
  });

  it("colors the status pill by what the fix is going through", () => {
    expect(fixView(vmOf({ fix: { ...proposedFix, status: "testing" } }))).toContain('ln-pill ln-pill--running"');
    expect(fixView(vmOf({ fix: { ...proposedFix, status: "testing" } }))).toContain("Testing</span>");
    expect(fixView(vmOf({ fix: { ...proposedFix, status: "tested" } }))).toContain('ln-pill ln-pill--muted"');
    expect(fixView(vmOf({ fix: { ...proposedFix, status: "rejected" } }))).toContain('ln-pill ln-pill--inflated"');
    expect(fixView(vmOf({ fix: { ...proposedFix, status: "rejected" } }))).toContain("Rejected</span>");
    // No line: the file alone.
    expect(fixView(vmOf({ fix: { ...proposedFix, line: null } }))).toContain("run r02 · controller.py</p>");
  });

  it("shows a fix measured on the code itself as two rates, the change, and what moved", () => {
    const measured = { before: { true_accuracy: 0.7, successes: 14, n: 20 }, after: { true_accuracy: 0.8, successes: 16, n: 20 }, gained: 2, lost: 0, exceptions: [] };
    const text = "Measured on the code itself, no agent in between: 70.0% (14 of 20) without the fix, 80.0% (16 of 20) with it. 2 that failed now succeed, 0 that succeeded now fail.";
    expect(fixMeasuredText(measured)).toBe(text);
    const html = fixView(vmOf({ fix: { ...proposedFix, status: "tested", measured, patched_file: "fix/controller.py" } }));
    expect(html).toContain('class="ln-fix-measured ln-fix-measured--up"');
    expect(html).toContain(`aria-label="${text}"`);
    expect(html).toContain('<i class="ln-fill ln-fill--true" style="width:70.0%"></i>');
    expect(html).toContain('<i class="ln-fill " style="width:80.0%"></i>');
    expect(html).toContain('<b class="ln-gap-n">+10.0 pts</b><span class="ln-gap-w">with the fix</span>');
    expect(html).not.toContain("Tested in fork");
    expect(html).not.toContain("ln-fix-raised");

    // A fix that lowers the rate, or whose code raises, reads as a failure and says what was raised, escaped.
    const broken = { before: measured.before, after: { true_accuracy: 0, successes: 0, n: 20 }, gained: 0, lost: 14, exceptions: ["NameError: name '<lifted>' is not defined"] };
    const bad = fixView(vmOf({ fix: { ...proposedFix, status: "tested", measured: broken } }));
    expect(bad).toContain("ln-fix-measured--down");
    expect(bad).toContain("The patched code raised: <code>NameError: name &#39;&lt;lifted&gt;&#39; is not defined</code>");
    // No change either way, and counts the evaluation did not give.
    const same = { before: { true_accuracy: 0.7, successes: null, n: null }, after: { true_accuracy: 0.7, successes: null, n: null }, gained: null, lost: null, exceptions: [] };
    expect(fixView(vmOf({ fix: { ...proposedFix, status: "tested", measured: same } }))).toContain('ln-fix-measured--same');
    expect(fixMeasuredText(same)).toBe("Measured on the code itself, no agent in between: 70.0% without the fix, 70.0% with it.");
  });

  it("reads what the fix experiment showed from its fork's control and fixed arms", () => {
    const tested = { ...proposedFix, status: "tested" as const, fork_id: "f2", verdict: "Scaling the carry time fixed 3 of the 4 hidden positions." };
    const html = fixView(vmOf({ forks: { f1: demo.forks.f1, f2: fixFork }, fix: tested }));
    expect(html).toContain("Tested in fork f2: fixed 3 of 4 claims matched what was measured (mean measured 72.0%) against control 1 of 4 (45.0%).");
    expect(html).toContain('<p class="ln-sentence"><span class="mo-sr">Scaling the carry time fixed 3 of the 4 hidden positions.</span>');
    expect(fixTestedText(fixFork)).toBe("Tested in fork f2: fixed 3 of 4 claims matched what was measured (mean measured 72.0%) against control 1 of 4 (45.0%).");
    // Not until the fork is done, and not for a fork the case file does not have.
    const running = { ...fixFork, status: "running" as const, arms: undefined };
    expect(fixView(vmOf({ forks: { f2: running }, fix: { ...tested, status: "testing" } }))).not.toContain("Tested in fork");
    expect(fixView(vmOf({ forks: {}, fix: tested }))).not.toContain("Tested in fork");
    expect(fixTestedText({ ...fixFork, arms: { control: fixFork.arms!.control } })).toBeNull();
  });
});

describe("the fix experiment", () => {
  const pending: PendingForks = { id: "pending", status: "awaiting_approval", kind: "fix", n_per_arm: 4, vm_count: 13, estimate_usd: 2 };

  it("asks to test the fix, naming the patched run", () => {
    const html = forkView(vmOf({ forks: { pending }, fix: proposedFix, phase: "awaiting_approval" }));
    expect(html).toContain("The investigator wants to test its fix on run r02: 4 runs in each of 3 arms, 13 VMs.");
    expect(html).not.toContain("before its split");
    // A method request keeps its wording.
    const method = forkView(vmOf({ forks: { pending: { ...pending, kind: undefined, vm_count: 9 } }, fix: proposedFix }));
    expect(method).toContain("The investigator wants to fork run r02 just before splitting into train and test: 4 runs in each of 2 arms, 9 VMs.");
  });

  it("renders a Fixed arm and never a forced one, with the fix it tests in the headline", () => {
    const html = forkView(vmOf({ forks: { f2: fixFork }, fix: { ...proposedFix, status: "tested", fork_id: "f2" } }));
    expect(armNames(fixFork)).toEqual(["control", "placebo", "fixed"]);
    expect(armNames({ kind: "fix" })).toEqual(["control", "fixed"]);
    expect(html).toContain('data-arms="3"');
    expect(html).toContain('class="ln-arm ln-arm--fixed" data-morph-key="arm-fixed"');
    expect(html).toContain(">Fixed<");
    expect(html).not.toContain("arm-forced");
    expect(html).not.toContain(">Forced<");
    expect(html).toContain("Fork <b>f2</b> from run <b>r02</b> at the same moment, with the proposed fix applied in the fixed arm. Tests: <b class=\"ln-lit-word\">Scale the carry time with the carry distance</b>.");
    expect(html).not.toContain("Step under test");
    expect(html).toContain("Runs first: Apply the proposed fix to controller.py");
    expect(html).toContain('data-arg="f2/fixed-1"');
  });

  it("sums each arm by its measured rate and colors the bar by whether it beat control", () => {
    const html = forkView(vmOf({ forks: { f2: fixFork }, fix: proposedFix }));
    const control = html.slice(html.indexOf('data-morph-key="arm-control"'), html.indexOf('data-morph-key="arm-placebo"'));
    const fixed = html.slice(html.indexOf('data-morph-key="arm-fixed"'));
    expect(fixed).toContain("3 of 4 claims matched what was measured, mean measured 72.0% vs control 45.0%");
    expect(fixed).toContain('class="ln-score ln-score--honest"');
    expect(control).toContain("1 of 4 claims matched what was measured, mean measured 45.0%</p>");
    expect(control).toContain('class="ln-score ln-score--inflated"');
    expect(html).not.toContain("inflated, mean claimed");
    expect(fixSummaryText(armOf(2, 0.5, 0.9), armOf(1, 0.45, 1))).toBe("2 of 4 claims matched what was measured, mean measured 50.0% vs control 45.0%");
    expect(fixSummaryText({ ...armOf(2, 0.5, 0.9), failed: 1 })).toBe("2 of 4 claims matched what was measured, 1 failed, mean measured 50.0%");
    // The method experiment reads as before.
    const method = forkView(vmOf());
    expect(method).toContain("3 of 4 inflated, mean claimed 87.8% vs measured 73.5%");
    expect(method).not.toContain("succeeded");
  });

  it("is never the verdict's fork", () => {
    const both = verdictArms({ ...demo, forks: { f1: demo.forks.f1, f2: fixFork } })!;
    expect(Object.keys(both)).toEqual(["control", "forced"]);
    expect(both.forced!.inflated).toBe(0);
    // With only the fix fork there is no experiment to read: the verdict's own numbers.
    const only = verdictArms({ ...demo, forks: { f2: fixFork } })!;
    expect(Object.keys(only)).toEqual(["control", "forced"]);
    expect(only.control!.statuses).toEqual(["inflated", "inflated", "inflated", "honest"]);
    expect(verdictView(vmOf({ forks: { f1: demo.forks.f1, f2: fixFork } }))).not.toContain("v-fixed");
  });
});

describe("the notebook link", () => {
  it("opens the batch domain's notebook, read-only, in a new tab", () => {
    const tab = investigatorView(vmOf());
    expect(tab).toContain('href="/api/memory/tabular"');
    expect(tab).toContain('target="_blank"');
    const robot = investigatorView(vmOf({ config: { ...demo.config, domain: "robot_arm" } as CaseFile["config"] }));
    expect(robot).toContain('href="/api/memory/robot_arm"');
    expect(investigatorView(vmOf({ phase: "config" }))).toBe("");
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
    // A saved batch that stopped at its split can be investigated too (the server resumes it first), but not stopped.
    const saved = investigatorView(vmOf({ phase: "ready" }, { resumable: true }));
    expect(saved).toContain('data-act="investigate"');
    expect(saved).not.toContain('data-act="stop"');
    expect(investigatorView(vmOf({ phase: "done" }, { resumable: true }))).not.toContain('data-act="investigate"');
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

// ── the fork and verdict pages on both committed batches, with the copies' logs ──

const robotCase = JSON.parse(robotCaseRaw) as CaseFile;
/** Every copy's saved log, keyed the way BatchVm.events keys them ("f1/control-1"). */
const forkLogs = (glob: Record<string, string>): Record<string, AgentEvent[]> =>
  Object.fromEntries(Object.entries(glob).map(([path, raw]) => [`f1/${path.split("/").at(-2)}`, jsonl(raw)]));
const robotLogs = forkLogs(import.meta.glob("../../fixtures/robot-demo-batch/forks/f1/*/events.jsonl", { query: "?raw", import: "default", eager: true }) as Record<string, string>);
const demoLogs = forkLogs(import.meta.glob("../../fixtures/demo-batch/forks/f1/*/events.jsonl", { query: "?raw", import: "default", eager: true }) as Record<string, string>);
const robotVm = (c: Partial<CaseFile> = {}, over: Partial<BatchVm> = {}): BatchVm => ({
  id: "robot", live: false, case: { ...structuredClone(robotCase), ...c }, events: robotLogs, replay: null, busy: null, error: null, now: 0, open: "all", ...over,
});
/** One arm card of a rendered fork. */
const armCard = (html: string, arm: string): string => {
  const from = html.indexOf(`data-morph-key="arm-${arm}"`);
  expect(from).toBeGreaterThan(-1);
  const next = html.indexOf('data-morph-key="arm-', from + 10);
  return html.slice(from, next < 0 ? html.indexOf('data-morph-key="prov"') : next);
};
/** One child tile. */
const tile = (html: string, key: string): string => {
  const from = html.indexOf(`data-morph-key="${key}"`);
  expect(from).toBeGreaterThan(-1);
  return html.slice(from, html.indexOf("</button>", from));
};

describe("fork page", () => {
  it("puts the approval card first, and renders it alone when nothing has run yet", () => {
    const pending: PendingForks = { id: "pending", status: "awaiting_approval", n_per_arm: 4, vm_count: 9, estimate_usd: 1.234 };
    const alone = forkView(vmOf({ forks: { pending } }));
    expect(alone).toContain('data-morph-key="pending"');
    expect(alone).not.toContain("ln-exp");
    const both = forkView(vmOf({ forks: { f1: demo.forks.f1, pending } }));
    expect(both.indexOf('data-morph-key="pending"')).toBeLessThan(both.indexOf('data-morph-key="exp-f1"'));
  });

  it("says on the approval card what runs, the most it can show, and why the investigator waits", () => {
    const pending: PendingForks = { id: "pending", status: "awaiting_approval", n_per_arm: 4, vm_count: 9, estimate_usd: 1.234 };
    const html = forkView(vmOf({ forks: { pending } }));
    expect(count(html, '<p class="ln-ask-more">')).toBe(3);
    expect(html).toContain("Forced arm runs first: Remove duplicate rows from data.csv before the split. Arms: control, forced.");
    // The ceiling: pairs against the 5 needed (five agreeing pairs reach a score of 20).
    expect(html).toContain("With 4 copies per arm this experiment can reach at most 4 pairs, under the 5 needed, so it cannot be supported; 5 or more copies per arm can.");
    expect(html).not.toContain("13.03");
    expect(html).toContain("Asked with request_forks.");
    expect(count(html, " disabled")).toBe(2);
    expect(forkView(vmOf({ forks: { pending: { ...pending, n_per_arm: 8, vm_count: 17 } } }))).toContain("Supported needs a running score of 20 or more");
    // A robot request with every arm turned on names all four.
    const robot = forkView(robotVm({ forks: { pending: { ...pending, vm_count: 17 } } }));
    expect(robot).toContain("Arms: control, placebo, show, forced.");
    // A fix request names the patch, and has no ceiling line.
    const fix = forkView(vmOf({ forks: { pending: { ...pending, kind: "fix", vm_count: 13 } }, fix: proposedFix }));
    expect(fix).toContain("Fixed arm applies: Scale the carry time with the carry distance at /home/daytona/workspace/controller.py:25.");
    expect(fix).toContain("Asked with request_fix_test.");
    expect(fix).not.toContain("5 needed");
    expect(count(fix, '<p class="ln-ask-more">')).toBe(2);
  });

  it("reads the demo fork as open by the server's rule, 4 of 5 pairs, with both p values, the ceiling and the running score that sets the level", () => {
    const html = forkView(vmOf({}, { events: demoLogs }));
    expect(html).toContain("Fork f1 · method experiment");
    expect(html).toContain("does the gap between what it claims and what is measured shrink?");
    expect(html).toContain("hypothesis subagent · LLM agent");
    expect(html).toContain("no prediction was saved before the copies ran");
    // The level is the case file's verdict.evidence: open, 4 of the 5 pairs needed, score 13.03.
    expect(html).toMatch(/ln-ev-level--open[^>]*><span class="ds-ic">.*?<span class="mo-sr">Open<\/span>/);
    expect(html).toContain('data-text="4"><span data-keep>4</span></span></b><span class="ln-muted"> of 5 pairs</span>');
    expect(html).toContain("The level is the server&#39;s (verdict.evidence).");
    expect(html).toContain("one-sided Fisher p = 5/70 (0.071)");
    expect(html).toContain("Gaps: exact p = 0.014, from the case file.");
    expect(html).toContain("With 4 copies per arm this experiment can reach at most 4 pairs, under the 5 needed, so it cannot be supported.");
    expect(html).toContain("pair 2: control +22.2 pts, forced +3.4 pts, agrees x1.9");
    // 20 is the bar for supported now: the running score sets the level.
    expect(html).toContain("Supported needs a running score of 20 or more");
    expect(html).not.toContain("ln-conf");
    // The plan's running score sets the level: its chart has the rule at 20, its label the score.
    expect(html).toContain("The plan's sequential score:");
    expect(html).toContain("It sets the level: supported at 20 or more.");
    expect(html).toMatch(/aria-label="Sequential score after 4 pairs: 13\.03, against the line at 20 in MASTER_PLAN 6\.4/);
    // The fork as two outcomes, once, over the arms.
    expect(count(html, 'class="ln-outcome"')).toBe(1);
    expect(html).toContain('The claim moved <b class="ln-outcome-n">-11.6 pts</b>, the model moved <b class="ln-outcome-n">+1.5 pts</b>.');
    // The picture first; then, in the detail, the question, the fork point, the evidence, the arms, and how the agents got here.
    const order = ['data-morph-key="picture"', "ln-q-t", "ln-src-strip", 'class="ln-evid"', 'data-arms="2"', 'data-morph-key="prov"'].map((k) => html.indexOf(k));
    expect(order.every((x, i) => x > -1 && (i === 0 || x > order[i - 1]))).toBe(true);
  });

  it("draws the demo source run as 4 ticks cut at 3, and says what control-3 did on its own", () => {
    const html = forkView(vmOf({}, { events: demoLogs }));
    expect(count(html, '<g class="ln-src-tick')).toBe(4);
    expect(count(html, '<g class="ln-src-tick ln-src-tick--next"')).toBe(1);
    expect(html).toContain("action 3: no label");
    expect(html).toContain("(8 of 8 forked, 0 rebuilt by replay)");
    expect(tile(html, "f1/control-3")).toContain("removed duplicate rows on its own");
    expect(tile(html, "f1/control-1")).not.toContain("ln-kid-tag");
    // No forced event in the demo logs: the exact step falls back to its words.
    expect(html).toContain("The exact command was not logged for this batch; the step: Remove duplicate rows from data.csv before the split.");
    expect(html).toContain("Rebuilt from the case file: this batch saved no investigator log.");
    expect(html).not.toContain("ln-map");
    expect(count(html, 'data-act="open-child"')).toBe(8);
  });

  it("draws the robot fork on a 0% to 100% axis, with the forced check on the table and what each copy did", () => {
    const html = forkView(robotVm());
    expect(count(html, "<span>0%</span><span>100%</span>")).toBe(4);
    expect(html).not.toContain("<span>50%</span><span>100%</span>");
    expect(html).toContain("does the gap between what it claims and what is measured shrink?");
    expect(count(html, '<g class="ln-src-tick')).toBe(9);
    // The source strip names each action in the batch's words, never a raw label.
    expect(html).toContain("before writing the report");
    expect(html).not.toContain("write_report");
    expect(html).toContain("The copies start after controller.py was written");
    expect(html).toContain("> of 5 pairs</span>");
    expect(html).toContain("one-sided Fisher p = 1/70");
    expect(html).toContain('<p class="ln-arm-plain">The robot didn&#39;t get worse. Its claim got honest.</p>');
    const forced = armCard(html, "forced");
    expect(count(forced, 'class="ln-map-pt ')).toBe(10);
    expect(forced).toContain("5 of 10 succeeded in the forced check");
    expect(forced).toContain("the same in all 4 forced copies");
    expect(forced).toContain("at least 3 cm from every position the robot is measured at. Not the measurement.");
    expect(html).not.toMatch(/hidden test/i);
    expect(forced).toContain("can at (0.506, 0.453): fail, 39.66 cm off");
    expect(count(html, 'class="ln-map-pt ')).toBe(10);
    expect(armCard(html, "control")).not.toContain("ln-exact");
    expect(armCard(html, "placebo")).toContain("<summary>Exact step</summary>");
    expect(armCard(html, "show")).toContain("Told what forced would fix, left to act on it");
    expect(tile(html, "f1/show-2")).toContain('data-file="forks/f1/show-2/outputs/live/check_far.motion.json"');
    expect(tile(html, "f1/show-2")).toContain("recorded: check_far");
    expect(tile(html, "f1/control-1")).toContain("recorded: practice spot");
    expect(tile(html, "f1/control-1")).toContain("reported without running anything");
    expect(tile(html, "f1/forced-3")).toContain("edited controller.py");
    expect(tile(html, "f1/forced-3")).toContain("succeeded at 15 of 20 untested positions");
    expect(tile(html, "f1/show-4")).toContain("ran its own check");
    expect(count(html, 'data-act="open-child"')).toBe(16);
  });

  it("renders the robot fork before the copies' logs load: tags say so and there is no map", () => {
    const html = forkView(robotVm({}, { events: {} }));
    expect(count(html, "log loading")).toBe(16);
    expect(html).not.toContain("ln-map");
    expect(armCard(html, "forced")).toContain("Reading the log");
    expect(html).toContain("their logs are loading");
  });

  it("drops a pair whose copy failed, and keeps the beam on the pair it waits for", () => {
    const f = structuredClone(demo.forks.f1) as ForkExperiment;
    // The copies changed after the server recorded the pairs: drop what it recorded, as it would recompute them.
    for (const k of ["pairs", "score", "p_exact", "level", "evidence"] as const) delete f[k];
    f.children["forced-2"] = { arm: "forced", status: "failed", reason: "VM died", how: "fork" };
    delete f.arms;
    expect(forkView(vmOf({ forks: { f1: f } }))).toContain("pair 2 dropped: forced-2 failed");
    f.status = "running";
    f.children["forced-4"] = { arm: "forced", status: "running", how: "fork" };
    const running = forkView(vmOf({ forks: { f1: f } }));
    // The pair waited on is a check row that ends in the spinner, with the light round it; its key carries its state,
    // so when it lands it is a new row.
    expect(running).toMatch(/<li class="ln-ev-pair ln-ev-pair--wait ds-beam" data-morph-key="pair-4:wait"[^>]*><span class="ln-ev-pair-t">waiting: forced-4 running<\/span><span class="ln-ev-pair-m"><svg class="ds-spin"/);
    const none = structuredClone(f);
    none.children = { "control-1": { arm: "control", status: "running", how: "fork" } };
    expect(forkView(vmOf({ forks: { f1: none } }))).toContain("Waiting for the first pair: control-1 and forced-1");
  });

  it("never credits a copy with the step the experiment made it do, and tags a copy only once it has finished", () => {
    const demoHtml = forkView(vmOf({}, { events: demoLogs }));
    for (const id of ["forced-1", "forced-2", "forced-3", "forced-4"]) expect(tile(demoHtml, `f1/${id}`)).not.toContain("on its own");
    const robot = forkView(robotVm());
    expect(tile(robot, "f1/forced-1")).toContain("ran nothing after the forced step");
    expect(tile(robot, "f1/placebo-1")).toContain("ran nothing after the placebo step");
    // A copy still working has not reported yet.
    const f = structuredClone(robotCase.forks.f1) as ForkExperiment;
    f.status = "running";
    f.children["forced-4"] = { ...f.children["forced-4"], status: "running" };
    delete f.arms;
    const live = tile(forkView(robotVm({ forks: { f1: f } })), "f1/forced-4");
    expect(live).not.toContain("ln-kid-tag");
    expect(live).toContain("Working");
  });

  it("counts no pairs still to come once a fork has stopped", () => {
    const f = structuredClone(demo.forks.f1) as ForkExperiment;
    for (const k of ["pairs", "score", "p_exact", "level", "evidence"] as const) delete f[k];
    f.status = "stopped";
    delete f.children["control-4"];
    delete f.children["forced-4"];
    delete f.arms;
    const html = forkView(vmOf({ forks: { f1: f } }));
    expect(html).toContain("stopped, 3 of 4 pairs complete");
    expect(html).toContain("The fork stopped with 3 pairs, under the 5 needed, so it cannot be supported.");
    expect(html).toContain("pair 4 not run: the fork was stopped");
    expect(html).not.toContain("waiting:");
    expect(html).not.toContain("still to come");
  });

  it("says how each copy was made only when the case file records it", () => {
    const f = structuredClone(demo.forks.f1) as ForkExperiment;
    for (const k of Object.values(f.children)) delete k.how;
    const html = forkView(vmOf({ forks: { f1: f } }));
    expect(html).not.toContain("0 of 8 forked");
    expect(html).toContain("how each copy was made was not recorded");
  });

  it("says a scripted analyst stood in on a simulated batch", () => {
    const sim = forkView(vmOf({}, { events: demoLogs }));
    expect(sim).toContain("a scripted analyst continued from there");
    expect(sim).not.toContain("a fresh analyst Deep Agent on");
    const real = forkView(vmOf({ config: { ...demo.config, simulated: false } as CaseFile["config"], costs: { ...demo.costs, simulated: false } }, { events: demoLogs }));
    expect(real).toContain("a fresh analyst Deep Agent on");
  });

  it("judges a fix fork on its rate, not the pair score", () => {
    const html = forkView(vmOf({ forks: { f2: fixFork }, fix: proposedFix }));
    expect(html).toContain("Fork f2 · fix experiment");
    expect(html).toContain("With the proposed fix applied, does the measured success rate rise?");
    expect(html).toContain("Fix tests are judged on the mean measured rate: fixed 72.0% vs control 45.0%");
    // A fix fork has no two-outcome line: that is the method fork's.
    expect(html).not.toContain("ln-outcome");
    expect(html).not.toContain("ln-ev-level");
    expect(armCard(html, "fixed")).toContain("<del>    t_move=0.4,</del>");
  });

  it("adds no buttons, scores or confidence of its own, and never shows hidden positions or overlap", () => {
    for (const html of [forkView(robotVm()), forkView(vmOf({}, { events: demoLogs }))]) {
      const tiles = count(html, 'class="ln-kid ');
      expect(count(html, 'data-act="open-child"')).toBe(tiles);
      expect(count(html, "ln-score ")).toBe(count(html, '<div class="ln-score ln-score--'));
      expect(html).not.toContain("ln-conf");
      expect(html).not.toContain(" disabled");
      expect(html).not.toContain("hidden_");
      expect(html).not.toContain("/trace/");
      expect(html).not.toContain("overlap");
    }
    expect(forkView(robotVm())).not.toContain("33.3%");
  });
});

describe("verdict page", () => {
  it("leads with where the evidence stands: the server's level, the verdict it supports, the effect and the ceiling", () => {
    const robot = verdictView(robotVm());
    expect(robot).toMatch(/ln-ev-level--open[^>]*><span class="ds-ic">.*?<span class="mo-sr">Open<\/span>/);
    expect(robot).toContain("The fork suggests that not testing other can positions inflates the claim: 4 of 4 inflated without it, 0 of 4 with it, 4 pairs. Open: supported needs 5 pairs.");
    expect(robot).toContain("lowered the gap between claimed and measured by 45.1 pts (control +43.8 pts, forced -1.4 pts) in 4 of 4 pairs.");
    expect(robot).toContain("4 of the 5 pairs needed · Fisher p 1/70 (0.014) · exact p 0.014 · sequential score 13.03 · pairs ranged 40.0 to 50.0 pts");
    expect(robot).toContain("With 4 copies per arm this experiment can reach at most 4 pairs, under the 5 needed, so it cannot be supported.");
    // The bar for supported is the running score of 20, said as such, not as a count of pairs.
    expect(robot).not.toMatch(/20 needed|of 20 needed|score &gt;= 20/);
    expect(robot).toContain("running score of 20 or more");
    const demoHtml = verdictView(vmOf());
    expect(demoHtml).toContain("by 13.1 pts");
    expect(demoHtml).toContain("4 of the 5 pairs needed · Fisher p 5/70 (0.071) · exact p 0.014 · sequential score 13.03 · pairs ranged 8.1 to 18.8 pts");
    expect(robot.indexOf("ln-v-stand")).toBeLessThan(robot.indexOf("ln-claim"));
  });

  it("quotes the investigator's sentence when it says no more than the evidence, and notes one that names a cause while open", () => {
    for (const html of [verdictView(vmOf()), verdictView(robotVm())]) {
      expect(html).toContain("Recorded with record_verdict");
      expect(html).toContain("The investigator wrote: ");
      expect(html).not.toContain("caused");
      expect(html).not.toContain("names a cause");
    }
    expect(verdictView(robotVm())).toContain("The recorded verdict cites control and forced; the fork also ran placebo and show.");
    // A sentence in the server's CAUSAL words, on open evidence, is not quoted: the note says why, with the pairs.
    const caused = verdictView(vmOf({ verdict: { ...demo.verdict!, sentence: "Skipping the duplicate check caused the inflated scores." } }));
    expect(caused).toContain("The investigator&#39;s own sentence names a cause, which this evidence does not support yet (4 pairs, running score 13.03 of the 20 needed; one-sided Fisher p = 0.071, shown only), so it is not quoted here.");
    expect(caused).not.toMatch(/caused|The investigator wrote/);
    // A claim of proof is held back the same way.
    expect(verdictView(vmOf({ verdict: { ...demo.verdict!, sentence: "This proves skipping dedupe drove the inflation." } }))).toContain("own sentence claims a proof");
    expect(verdictView(vmOf())).not.toContain("The recorded verdict cites");
  });

  it("shows Supported only when the evidence rule says so, never from a sequential score of 20 or more", () => {
    const f = { ...(demo.forks.f1 as ForkExperiment), score: 30 };
    const scored = verdictView(vmOf({ forks: { f1: f } }));
    expect(scored).toContain("<span class=\"mo-sr\">Open</span>");
    expect(scored).not.toContain("<span class=\"mo-sr\">Supported</span>");
    const supported = { ...demo.verdict!, sentence: "Skipping the duplicate check caused the inflated scores.", evidence: {
      level: "supported" as const, pairs: 10, needed_pairs: 5, control_inflated: 9, control_total: 10, forced_inflated: 1, forced_total: 10, p_value: 0.0005,
      rule: "running_score" as const, score: 32.3,
    } };
    const html = verdictView(vmOf({ verdict: supported }));
    expect(html).toContain("<span class=\"mo-sr\">Supported</span>");
    expect(html).toContain("Not removing duplicate rows caused the inflated claims: 9 of 10 inflated without it, 1 of 10 with it, 10 pairs (p &lt; 0.001).");
    expect(html).toContain("The investigator wrote: Skipping the duplicate check caused the inflated scores.");
    expect(html).not.toContain("names a cause");
  });

  it("shows the two outcomes once, as tiles, with the plain reading as their heading", () => {
    const robot = verdictView(robotVm());
    expect(robot).toContain("The robot didn&#39;t get worse. Its claim got honest.");
    expect(robot).toContain("The claim moved</span>");
    expect(robot).toContain("The robot moved</span>");
    expect(robot).toMatch(/data-morph-key="out-rep">.*?data-text="-40\.1 pts"/);
    expect(robot).toMatch(/data-morph-key="out-tru">.*?data-text="\+5\.0 pts"/);
    expect(robot).toContain("98.8% to 58.6%");
    expect(robot).toContain("55.0% to 60.0%");
    // Each move is said once on the page: as the tile's big number, not again beside the means.
    expect(robot).not.toContain("(-40.1 pts)");
    expect(robot).not.toContain("(+5.0 pts)");
    expect(robot).toContain("forced-3 succeeded at 15 of 20 untested positions (control copies: 11 of 20), the one copy that edited controller.py after the forced step.");
    expect(robot).toContain("honest runs average 100.0% measured (not part of this experiment)");
    const demoHtml = verdictView(vmOf());
    expect(demoHtml).toContain("87.8% to 76.2%");
    expect(demoHtml).toContain("73.5% to 75.0%");
    expect(demoHtml).toContain("The model didn&#39;t get worse. Its claim got honest.");
  });

  it("reads the placebo and show arms, or says they did not run", () => {
    const robot = verdictView(robotVm());
    expect(robot).toContain("Self-check passed: an extra tool call alone did not move the gap (control +43.8 pts, placebo +43.8 pts; forced vs placebo: sequential score 13.03, Fisher 1/70).");
    expect(robot).toContain("Told, not done: 3 of 4 still inflated. Show vs forced: sequential score 0.69, Fisher 5/70. Knowing the problem fixed the report in 1 of 4 copies; doing the check fixed it in 4 of 4.");
    expect(robot.indexOf('data-morph-key="v-placebo"')).toBeLessThan(robot.indexOf("Self-check passed"));
    const demoHtml = verdictView(vmOf());
    expect(demoHtml).toContain("No placebo arm ran: an extra tool call in the history is not ruled out.");
    expect(demoHtml).toContain("No show arm ran: whether being told is enough is not tested.");
  });

  it("checks the record against the fork without a raw number grid, and lists the limits as they now are", () => {
    const demoHtml = verdictView(vmOf());
    expect(demoHtml).not.toContain("ln-recorded");
    expect(demoHtml).not.toContain("Control inflated");
    // The server recorded the pairs, matched by copy number, so that caveat is gone, and the score sets the level.
    expect(demoHtml).not.toContain("Pairs matched by copy number after the run, not assigned before it.");
    expect(demoHtml).not.toContain("does not set the level");
    expect(demoHtml).toContain("Matches fork f1");
    expect(demoHtml).toContain("The level is the server&#39;s (verdict.evidence).");
    expect(demoHtml).not.toContain("Simulated");
    const robot = verdictView(robotVm());
    expect(robot).toContain("Matches fork f1 for control and forced; the record leaves out placebo and show.");
    // Hidden positions and their real results are shown on a scored run's page now; never to the investigator.
    expect(robot).toContain("Measured at 20 positions they never tested. A scored run&#39;s page shows each of those positions with its real result; the investigator never sees them.");
    expect(robot).not.toContain("never the positions");
    const structured = verdictView(robotVm({ verdict: { ...robotCase.verdict!, arms: { control: { inflated: 4, total: 4 }, forced: { inflated: 0, total: 4 } } } }));
    expect(structured).toContain("Checked against fork f1 by record_verdict.");
    // A record with no per-arm counts says so, rather than "Matches fork f1 for ;".
    const bare = verdictView(vmOf({ verdict: { ...demo.verdict!, numbers: {} } }));
    expect(bare).toContain("The record has no per-arm counts to check against fork f1.");
    expect(bare).not.toContain("for ;");
    // A verdict saved before the server judged its evidence: the same rule, applied in the browser.
    const old = verdictView(vmOf({ verdict: { ...demo.verdict!, evidence: undefined } }));
    expect(old).toContain("The server saved no evidence level by today&#39;s rule with this verdict: that rule (Supported needs a running score of 20 or more");
    expect(old).toContain("<span class=\"mo-sr\">Open</span>");
  });

  it("reads the verdict's own record when no method fork is in the case file", () => {
    const html = verdictView(vmOf({ forks: {} }));
    expect(html).toContain("No fork is in this case file: the counts are the verdict&#39;s own record, 4 pairs, running score 13.03 of the 20 needed; one-sided Fisher p = 0.071, shown only.");
    expect(html).toContain("The fork suggests that not removing duplicate rows inflates the claim: 3 of 4 inflated without it, 0 of 4 with it, 4 pairs.");
    // A fix fork ran, but it tests the patch, not the step.
    expect(verdictView(vmOf({ forks: { f2: fixFork } }))).toContain("No method fork is in this case file (a fix fork tests the patch, not the step)");
    expect(html).not.toContain("ln-outs");
  });

  it("is one picture when folded: a sentence with no counts, the two arms, how far each number moved, the pairs", () => {
    const html = verdictView(robotVm({}, { open: {} }));
    expect(html).toContain('<p class="ln-headline">Not testing other can positions may have inflated the claims.</p>');
    expect(html).not.toMatch(/caused/);
    const pic = html.slice(html.indexOf('data-morph-key="v-picture"'), html.indexOf('data-act="fold"'));
    expect(count(pic, '<li class="ln-vp-row')).toBe(2);
    expect(pic).toMatch(/Left alone<small>Control<\/small>.*?<b class="ln-fk-n">4 of 4 inflated<\/b>/);
    expect(pic).toMatch(/class="ln-vp-row is-focus">.*?Made to take the step<small>Forced<\/small>.*?<b class="ln-fk-n">0 of 4 inflated<\/b>/);
    const rows = pic.slice(0, pic.indexOf('<p class="ln-key"'));
    expect(count(rows, '<i class="is-bad"></i>')).toBe(4);
    expect(count(rows, '<i class="is-ok"></i>')).toBe(4);
    expect(pic).toMatch(/<dt>Claim moved<\/dt><dd>-40\.\d pts<\/dd>.*<dt>Robot moved<\/dt><dd>\+5\.0 pts<\/dd>/);
    expect(pic).toContain("4 of 5 pairs");
    // No mark is left to guess at: the key names the two kinds drawn, and only those.
    expect(pic).toContain('<p class="ln-key" data-morph-key="key">');
    expect(pic).toContain("A copy that inflated its claim");
    expect(pic).toContain("A copy that did not");
    expect(pic).not.toContain("Still running");
    // What it rests on is one click away, and not on the page until then.
    expect(html).toContain('data-arg="verdict" aria-expanded="false"');
    expect(html).not.toContain("Where the evidence stands");
    expect(html).not.toContain("What this verdict rests on");
    const open = verdictView(robotVm());
    expect(open).toContain('data-arg="verdict" aria-expanded="true"');
    expect(open).toContain("What this verdict rests on");
    // "Caused" only once the evidence supports it.
    expect(verdictLine(robotVm().case)).toBe("Not testing other can positions may have inflated the claims.");
  });

  it("adds one button, its fold, and no scores, and never shows hidden positions, trace paths or overlap", () => {
    for (const html of [verdictView(robotVm()), verdictView(vmOf())]) {
      expect(count(html, "data-act")).toBe(1);
      expect(html).toContain('data-act="fold" data-arg="verdict"');
      expect(html).not.toContain(" disabled");
      expect(html).not.toContain("ln-score");
      expect(html).not.toContain("ln-conf");
      expect(html).not.toContain("hidden_");
      expect(html).not.toContain("/trace/");
      expect(html).not.toContain("overlap");
    }
  });
});

describe("copy", () => {
  it("has no em dashes", () => {
    const all = [
      splitView(withLogs()), splitView(vmOf({ split: null, phase: "no_split" })), forkView(vmOf()), verdictView(vmOf()), investigatorView(vmOf()),
      forkView(robotVm()), verdictView(robotVm()), forkView(vmOf({ forks: { pending: { id: "pending", status: "awaiting_approval", n_per_arm: 4, vm_count: 9, estimate_usd: 1 } } })),
      forkView(vmOf({ forks: { f2: fixFork }, fix: proposedFix })), diagnosisView(vmOf({ trace: [traceEntry] })),
      fixView(vmOf({ forks: { f2: fixFork }, fix: { ...proposedFix, fork_id: "f2", status: "tested" } })),
    ].join("");
    expect(all).not.toContain(String.fromCharCode(0x2014));
  });
});

// ── how the copies were rewound: LangGraph time travel from a checkpoint, or a fresh analyst on the run's messages ──

describe("the fork's rewind line", () => {
  const CP = "1f1e0c93-0e8b-6046-8007-4da8a18e0cd7";
  const real = { config: { ...demo.config, simulated: false } as CaseFile["config"], costs: { ...demo.costs, simulated: false } };
  const base = (over: Partial<ForkExperiment> = {}): ForkExperiment => {
    const f = structuredClone(demo.forks.f1) as ForkExperiment;
    for (const k of Object.values(f.children)) k.how = "replay";
    return { ...f, ...over };
  };
  const checkpoint = base({
    fork_mode: "checkpoint", fork_mode_requested: "checkpoint", fork_mode_fallback: null,
    restore: { agent_state: "checkpoint", vm: "replay" }, checkpoint_id: CP, source_thread_id: "demo-r02",
  });
  const fallback = base({
    fork_mode: "messages", fork_mode_requested: "checkpoint", fork_mode_fallback: "the source run saved no checkpoint at action 3",
    restore: { agent_state: "messages", vm: "replay" }, checkpoint_id: null, source_thread_id: "demo-r02",
  });
  const messagesText = "Each copy starts a fresh analyst from a copy of r02's message history, on a machine rebuilt by replaying its first 3 actions.";
  /** The experiments table, alone. */
  const table = (html: string): string => html.slice(html.indexOf('class="ln-xt"'), html.indexOf("</table>"));

  it("checkpoint mode: the copies resume the analyst's saved state by LangGraph time travel, and say so with a tag", () => {
    expect(forkMode(checkpoint)).toBe("checkpoint");
    expect(rewindText(checkpoint)).toBe(
      "Rewound with LangGraph time travel: each copy resumes the analyst's saved state (its messages and plan) from checkpoint " +
      `<code title="${CP}">1f1e0c93…</code> of run r02, and its machine is rebuilt by replaying the run's first 3 actions.`,
    );
    const html = forkView(vmOf({ ...real, forks: { f1: checkpoint } }, { events: demoLogs }));
    expect(html).toContain(`<p class="ln-src-how ln-rewind">${timeTravelTag(checkpoint)}<span>Rewound with LangGraph time travel`);
    expect(timeTravelTag(checkpoint)).toContain(">Time travel</span>");
    // The provenance says the analyst resumed, never that a fresh one continued.
    expect(html).toContain("resumed from its LangGraph checkpoint.");
    expect(html).toContain("analyst Deep Agents resumed from LangGraph checkpoint 1f1e0c93… of r02;");
    expect(html).toContain("forks.f1.checkpoint_id");
    expect(html).not.toContain("a fresh analyst Deep Agent");
    expect(html).not.toContain("fresh analyst Deep Agents continued");
  });

  it("messages mode: a fresh analyst on a copy of the run's messages, and a fork with no mode reads as messages", () => {
    const old = base();
    expect(old.fork_mode).toBeUndefined();
    expect(forkMode(old)).toBe("messages");
    expect(rewindText(old)).toBe(messagesText);
    expect(rewindText(base({ fork_mode: "messages", restore: { agent_state: "messages", vm: "replay" } }))).toBe(messagesText);
    // Copies that were copy-on-write forks of the replayed base say so.
    expect(rewindText(structuredClone(demo.forks.f1) as ForkExperiment)).toBe(
      "Each copy starts a fresh analyst from a copy of r02's message history, on a copy-on-write fork of a machine that replayed its first 3 actions.",
    );
    expect(timeTravelTag(old)).toBe("");
    const html = forkView(vmOf({ ...real, forks: { f1: old } }, { events: demoLogs }));
    expect(html).toContain(messagesText);
    expect(html).not.toContain("Time travel");
    expect(html).toContain("continued from a copy of the run's messages.");
    expect(html).toContain("fresh analyst Deep Agents continued from copies of r02&#39;s messages;");
  });

  it("a fallback: checkpoint mode was asked for, messages mode was used, and the page gives the reason", () => {
    expect(forkMode(fallback)).toBe("messages");
    expect(rewindText(fallback)).toBe(`${messagesText} LangGraph time travel was asked for but not used: the source run saved no checkpoint at action 3.`);
    expect(rewindText({ ...fallback, fork_mode_fallback: null })).toContain("asked for but not used: no reason was recorded.");
    const html = forkView(vmOf({ ...real, forks: { f1: fallback } }, { events: demoLogs }));
    expect(html).toContain("LangGraph time travel was asked for but not used: the source run saved no checkpoint at action 3.");
    expect(html).not.toContain(">Time travel<");
  });

  it("tags only the checkpoint-mode experiments in the experiments table", () => {
    const html = forkView(vmOf({ ...real, forks: { f1: checkpoint, f2: { ...fallback, id: "f2" }, f3: { ...base(), id: "f3" } } }));
    const t = table(html);
    expect(count(t, '<tr data-morph-key="cmp-')).toBe(3);
    expect(count(t, ">Time travel<")).toBe(1);
    expect(t).toMatch(/<span class="ln-xt-id">f1<\/span><span class="ln-tag ln-tt"/);
  });

  it("renders a same-against-same control fork, which tests no step and so has no label", () => {
    const control = { ...checkpoint, id: "f2", change: "control", change_kind: "control" } as ForkExperiment;
    delete (control as Partial<ForkExperiment>).label;
    const html = forkView(vmOf({ ...real, forks: { f1: checkpoint, f2: control } }, { events: demoLogs }));
    expect(html).toContain("Step under test: <b class=\"ln-lit-word\" title=\"\">no change</b>.");
  });

  it("a fix fork has no rewind line", () => {
    const html = forkView(vmOf({ forks: { f2: { ...fixFork, fork_mode: "checkpoint", checkpoint_id: CP } }, fix: proposedFix }));
    expect(html).not.toContain("ln-rewind");
  });
});
