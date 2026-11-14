// The trap as the views use it (src/batch/trap.ts): the picker on the home screen, and a batch's words, highlight
// pattern and evidence sentence taken from `config.trap_info`. traps.json is the server's own description of its
// traps (`GET /api/defaults`, `traps`); tests/test_traps.py checks it against the registry. The demo batch has no
// `trap_info`, so it shows what a batch saved before traps were pluggable looks like.

import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import trapsRaw from "./traps.json?raw";
import type { AgentEvent, BatchConfig, CaseFile, RunRecord, SplitFinding, TrapInfo } from "../src/api";
import { homeView } from "../src/batch/home";
import { splitHeadline, splitView as coloredSplitView, stepMark, stepWords } from "../src/batch/lanes";
import type { BatchVm, HomeVm } from "../src/batch/model";
import { LABEL_PATTERNS } from "../src/batch/notebook";
import { runSummaryView } from "../src/batch/run";
import { DEFAULT_PLANTED, chosenTrap, evidenceParts, trapMark, trapOf, trapWords } from "../src/batch/trap";
import { wallView } from "../src/batch/wall";
import { inputsLabel, initialDatasetUi } from "../src/dataset-input";

const demo = JSON.parse(caseRaw) as CaseFile;
const traps = JSON.parse(trapsRaw) as TrapInfo[];
const trap = (name: string): TrapInfo => traps.find((t) => t.name === name)!;
const duplicates = trap("duplicates");
const leaky = trap("leaky_column");
const repeat = trap("repeat_rows");

const splitView = (vm: BatchVm): string => coloredSplitView(vm).replace(/<span class="tk-\w">([^<]*)<\/span>/g, "$1");
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const W = "/home/daytona/workspace";

/** A run's log: look at the data, write model.py, run it. */
function log(script: string): AgentEvent[] {
  const call = (t: number, id: string, name: string, args: Record<string, unknown>): AgentEvent[] => [
    { t, type: "tool_call", id, name, args }, { t: t + 1, type: "tool_result", id, name, content: "ok" },
  ];
  return [
    ...call(1, "c0", "execute", { command: `cd ${W} && python3 -c "import pandas as pd; df = pd.read_csv('data.csv'); print(df.head())"` }),
    ...call(5, "c1", "write_file", { file_path: `${W}/model.py`, content: script }),
    ...call(9, "c2", "execute", { command: `cd ${W} && python3 model.py` }),
  ];
}

const HEAD = "import pandas as pd\nfrom sklearn.ensemble import RandomForestClassifier\n";
const FIT = "m = RandomForestClassifier().fit(train.drop(columns='outcome'), train.outcome)\nprint(m.score(test.drop(columns='outcome'), test.outcome))\n";
const RANDOM = `${HEAD}from sklearn.model_selection import train_test_split\ndf = pd.read_csv('data.csv')\ntrain, test = train_test_split(df, test_size=0.2, random_state=0)\n${FIT}`;
const GROUPED = `${HEAD}from sklearn.model_selection import GroupShuffleSplit\ndf = pd.read_csv('data.csv')\n`
  + "gss = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=0)\n"
  + "tr, te = next(gss.split(df, groups=df['subject_id']))\ntrain, test = df.iloc[tr], df.iloc[te]\n" + FIT;
const DROPPED = `${HEAD}from sklearn.model_selection import train_test_split\ndf = pd.read_csv('data.csv')\n`
  + "df = df.drop(columns=['followup_score'])\ntrain, test = train_test_split(df, test_size=0.2, random_state=0)\n" + FIT;

/** A two run batch that planted `info`: r01 is honest (it ran `honest`), r02 inflated (a random split). */
function batch(info: TrapInfo, honest: string, shares: [number | null, number | null]): BatchVm {
  const run = (id: string, status: "honest" | "inflated", reported: number, share: number | null, own: boolean): RunRecord => ({
    id, status, reported_accuracy: reported, true_accuracy: 0.75, gap: reported - 0.75, overlap_share: share, reason: "", n_actions: 3,
    labels: [["load", "inspect"], [], ["load", ...(own ? [info.label] : []), "split", "train", "evaluate"]],
  });
  const split: SplitFinding = {
    label: info.label, honest_rate: 1, inflated_rate: 0, n_honest: 1, n_inflated: 1, fork_run_id: "r02", fork_at: 2,
    honest_example: `cd ${W} && python3 model.py`, inflated_example: `cd ${W} && python3 model.py`,
    intervention: info.intervention.description,
  };
  const c: CaseFile = {
    ...structuredClone(demo),
    config: { ...(demo.config as BatchConfig), simulated: false, trap: info.name, trap_info: info },
    phase: "ready", split, forks: {}, verdict: null, hypotheses: [], step_labels: {},
    runs: { r01: run("r01", "honest", 0.76, shares[0], true), r02: run("r02", "inflated", 0.93, shares[1], false) },
  };
  return { id: "b1", live: false, case: c, events: { r01: log(honest), r02: log(RANDOM) }, replay: null, busy: null, error: null, now: 0 };
}

const col = (html: string, group: "honest" | "inflated"): string => {
  const from = html.indexOf(`data-morph-key="col-${group}"`);
  const to = group === "honest" ? html.indexOf('data-morph-key="col-inflated"') : html.indexOf("What it did to the score");
  expect(from).toBeGreaterThan(-1);
  return html.slice(from, to);
};

describe("the server's trap list", () => {
  it("has the three traps, each with everything the views read", () => {
    expect(traps.map((t) => t.name)).toEqual(["duplicates", "leaky_column", "repeat_rows"]);
    for (const t of traps) {
      for (const k of ["title", "description", "planted", "strength_label", "label", "pattern", "did", "missing"] as const) {
        expect(typeof t[k]).toBe("string");
        expect(t[k]).not.toBe("");
      }
      expect(typeof t.intervention.description).toBe("string");
      expect(() => new RegExp(t.pattern)).not.toThrow();
      expect(JSON.stringify(t)).not.toMatch(/\u2014/);
    }
    expect(duplicates.evidence_text).toBe("of test rows were also in training");
    expect(leaky.evidence_text).toBeNull();
    expect(repeat.at_split).toBe(true);
  });

  it("describes the duplicates trap with the words and the pattern the views had built in", () => {
    expect(new RegExp(duplicates.pattern).source).toBe(LABEL_PATTERNS.deduplicate.source);
    expect(stepWords("deduplicate", duplicates)).toEqual(stepWords("deduplicate"));
    expect(`planted ${duplicates.planted}`).toBe(DEFAULT_PLANTED);
  });
});

describe("trap helpers", () => {
  it("reads the trap from a case file, and null from one that does not say", () => {
    expect(trapOf(demo)).toBeNull();
    expect(trapOf(null)).toBeNull();
    expect(trapOf({ config: {} })).toBeNull();
    expect(trapOf({ config: { ...(demo.config as BatchConfig), trap_info: repeat } })).toBe(repeat);
    // Something that is not a trap description is ignored, not trusted.
    expect(trapOf({ config: { ...(demo.config as BatchConfig), trap_info: { name: "x" } as unknown as TrapInfo } })).toBeNull();
  });

  it("finds the chosen trap in the defaults", () => {
    const defaults = { config: demo.config as BatchConfig, prices_missing: false, traps };
    expect(chosenTrap(defaults, "repeat_rows")).toBe(repeat);
    expect(chosenTrap(defaults, "nope")).toBeNull();
    expect(chosenTrap({ ...defaults, traps: undefined }, "duplicates")).toBeNull();
    expect(chosenTrap(null, "duplicates")).toBeNull();
  });

  it("gives the trap's pattern and words for its own step only", () => {
    expect(trapMark(repeat, "group_split")!.test("gss = GroupShuffleSplit(n_splits=1)")).toBe(true);
    expect(trapMark(repeat, "group_split")!.test("train_test_split(df)")).toBe(false);
    // Importing the splitter is not using it, as the backend's labels have it.
    expect(trapMark(repeat, "group_split")!.test("from sklearn.model_selection import GroupShuffleSplit, train_test_split")).toBe(false);
    expect(trapMark(repeat, "group_split")!.test("from sklearn.model_selection import (\n    GroupKFold,\n)\ncv = 5")).toBe(false);
    expect(trapMark(repeat, "group_split")!.test("from sklearn.model_selection import GroupKFold; cv = GroupKFold(5)")).toBe(true);
    expect(trapMark(repeat, "deduplicate")).toBeNull();
    expect(trapMark(null, "group_split")).toBeNull();
    expect(trapMark(repeat, undefined)).toBeNull();
    expect(trapMark(leaky, "drop_leak")!.test("X = df.drop(columns=['outcome', \"followup_score\"])")).toBe(true);
    expect(trapMark(leaky, "drop_leak")!.test("X = df.drop(columns=['outcome'])")).toBe(false);
    // A pattern the browser cannot read gives no highlight, not a crash.
    expect(trapMark({ ...repeat, pattern: "(?P<x>a" }, "group_split")).toBeNull();
    expect(trapWords(repeat, "group_split")).toEqual({ did: "grouped the rows by subject", missing: "No grouping by subject here" });
    expect(trapWords(repeat, "clean")).toBeNull();
  });

  it("stepWords and stepMark fall back to the built in table, then to generic words", () => {
    expect(stepWords("group_split", repeat).did).toBe("grouped the rows by subject");
    expect(stepWords("group_split").did).toBe("did the group_split step");
    expect(stepWords("clean", repeat)).toEqual(stepWords("clean"));
    expect(stepMark("group_split", repeat)).toBe(trapMark(repeat, "group_split"));
    expect(stepMark("group_split")).toBeNull();
    expect(stepMark("split", repeat)).toBe(LABEL_PATTERNS.split);
    expect(LABEL_PATTERNS.split.test("gss = GroupShuffleSplit(n_splits=1)")).toBe(true);
  });

  it("writes the evidence sentence, or nothing when there is no number", () => {
    expect(evidenceParts(0.5234, repeat, "x")).toEqual({ share: "52%", text: "of test rows came from subjects also in training" });
    expect(evidenceParts(0.5234, repeat, "x", 1)?.share).toBe("52.3%");
    expect(evidenceParts(0, duplicates, "x")).toEqual({ share: "0%", text: "of test rows were also in training" });
    expect(evidenceParts(null, repeat, "x")).toBeNull();
    expect(evidenceParts(undefined, null, "x")).toBeNull();
    expect(evidenceParts(0.5, leaky, "x")).toBeNull();
    expect(evidenceParts(0.5, null, "of test rows were in training")).toEqual({ share: "50%", text: "of test rows were in training" });
  });
});

describe("the trap picker on the home screen", () => {
  const cfg = { ...(demo.config as BatchConfig), mode: "live" } as BatchConfig;
  const vm = (over: Partial<HomeVm> = {}): HomeVm => ({
    batches: { state: "ready", value: [] }, health: { ok: true, keys: { anthropic: true, daytona: true } },
    defaults: { config: cfg, prices_missing: false, traps }, draft: cfg, estimate: null, starting: false, error: null, ...over,
  });
  const select = (html: string): string => html.match(/<select[^>]*data-cfg="trap"[^>]*>.*?<\/select>/s)![0];

  it("lists the traps by title with the chosen one selected and described", () => {
    const html = homeView(vm());
    expect(select(html)).toContain('<option value="duplicates" selected>Duplicate rows</option>');
    expect(select(html)).toContain('<option value="leaky_column">Leaky column</option>');
    expect(select(html)).toContain('<option value="repeat_rows">Repeat subjects</option>');
    expect(select(html).match(/ selected/g)).toHaveLength(1);
    expect(html).toContain(`<label class="hm-lbl" for="hm-f-trap">Trap</label>`);
    expect(html).toContain(`<span class="hm-trap-d" id="hm-trap-d">${duplicates.description}</span>`);
    // Among the main settings: after the dataset rows' place, before the Runs field, and not under Advanced.
    expect(html.indexOf('data-cfg="trap"')).toBeLessThan(html.indexOf('data-cfg="n_runs"'));
    expect(html.indexOf('data-cfg="trap"')).toBeLessThan(html.indexOf('data-act="toggle-advanced"'));
  });

  it("follows the draft: the selected option, the description, the slider's label and the summary", () => {
    const html = homeView(vm({ draft: { ...cfg, trap: "repeat_rows" } }), { html: "", label: inputsLabel(initialDatasetUi()) });
    expect(select(html)).toContain('<option value="repeat_rows" selected>Repeat subjects</option>');
    expect(select(html)).toContain('<option value="duplicates">Duplicate rows</option>');
    expect(html).toContain(repeat.description);
    expect(html).not.toContain(duplicates.description);
    expect(text(html)).toContain("Runs Subjects with repeat visits 50% Hint None Light Budget $");
    expect(text(html)).toContain("New batch Pima diabetes · planted repeat visits of the same subjects Trap");
    expect(text(html)).not.toContain("Duplicated rows");
    const leak = text(homeView(vm({ draft: { ...cfg, trap: "leaky_column", trap_strength: 0.25 } })));
    expect(leak).toContain("Pima diabetes · planted a column that leaks the target");
    expect(leak).toContain("Leak strength 25%");
  });

  it("keeps the summary's other parts when the trap changes", () => {
    const label = `mine.csv, predicting label · ${DEFAULT_PLANTED} · starting from your script`;
    const html = homeView(vm({ draft: { ...cfg, trap: "leaky_column" } }), { html: "", label });
    expect(text(html)).toContain("mine.csv, predicting label · planted a column that leaks the target · starting from your script");
    expect(text(homeView(vm(), { html: "", label }))).toContain(label);
  });

  it("shows no picker and today's words when the server sends no list", () => {
    for (const defaults of [{ config: cfg, prices_missing: false }, { config: cfg, prices_missing: false, traps: [] }]) {
      const html = homeView(vm({ defaults }));
      expect(html).not.toContain('data-cfg="trap"');
      expect(html).not.toContain("hm-trap");
      expect(text(html)).toContain("Pima diabetes · planted duplicate rows Runs Duplicated rows 50%");
    }
    expect(homeView(vm({ draft: null, defaults: null }))).not.toContain('data-cfg="trap"');
  });

  it("shows a draft's trap that the list does not have, and escapes what the server sends", () => {
    const odd = homeView(vm({ draft: { ...cfg, trap: "old<trap>" } }));
    expect(select(odd)).toContain('<option value="old&lt;trap&gt;" selected>old&lt;trap&gt;</option>');
    expect(odd).not.toContain("hm-trap-d");
    expect(text(odd)).toContain("Duplicated rows 50%");
    const evil: TrapInfo = { ...duplicates, title: "<b>T</b>", description: "<img src=x>", strength_label: "<i>S</i>", planted: "<u>p</u>" };
    const html = homeView(vm({ defaults: { config: cfg, prices_missing: false, traps: [evil] } }));
    expect(html).toContain("&lt;b&gt;T&lt;/b&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).toContain("&lt;i&gt;S&lt;/i&gt;");
    expect(html).toContain("planted &lt;u&gt;p&lt;/u&gt;");
    expect(html).not.toMatch(/<(b|img|i|u)\b/);
  });
});

describe("What changed, for a batch that planted repeat subjects", () => {
  const vm = batch(repeat, GROUPED, [0, 0.71]);
  const html = splitView(vm);

  it("says what the honest runs did in the trap's words", () => {
    expect(splitHeadline(vm.case.split!, repeat)).toEqual({ honest: "Honest runs grouped the rows by subject before splitting.", inflated: "Inflated runs did not." });
    expect(html).toContain("Honest runs grouped the rows by subject before splitting.");
    expect(html).not.toContain("group_split step");
  });

  it("highlights the grouped split, which is the split, and leaves the slot empty on the other side", () => {
    const honest = col(html, "honest");
    const inflated = col(html, "inflated");
    expect(honest).toContain("This run grouped the rows by subject, then split, in one script");
    expect(honest).toContain('<span class="nb-ln nb-hl">gss = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=0)</span>');
    expect(honest).toContain('<span class="nb-ln nb-hl">tr, te = next(gss.split(df, groups=df[&#39;subject_id&#39;]))</span>');
    expect(honest).not.toContain("ln-missing");
    expect(inflated).toContain('<div class="ln-missing"><b class="ln-missing-t">No grouping by subject here</b>');
    expect(inflated).not.toContain("nb-hl");
    expect(inflated).toContain('<span class="nb-ln ln-at">train, test = train_test_split(df, test_size=0.2, random_state=0)</span>');
  });

  it("does not take an import of a grouped splitter for the step", () => {
    const unused = RANDOM.replace("import train_test_split", "import GroupShuffleSplit, train_test_split");
    const inflated = col(splitView({ ...vm, events: { ...vm.events, r02: log(unused) } }), "inflated");
    expect(inflated).toContain("No grouping by subject here");
    expect(inflated).not.toContain("This run grouped the rows by subject");
    expect(inflated).not.toContain("nb-hl");
  });

  it("finishes the evidence sentence the trap's way", () => {
    expect(html).toContain('<p class="ln-leak"><b>0%</b> of test rows came from subjects also in training</p>');
    expect(html).toContain('<p class="ln-leak"><b>71%</b> of test rows came from subjects also in training</p>');
    expect(html).not.toContain("were also in training");
  });

  it("escapes the trap's words", () => {
    const evil: TrapInfo = { ...repeat, did: "<b>did</b>", missing: "<i>none</i>", evidence_text: "<u>ev</u>" };
    const out = splitView({ ...vm, case: { ...vm.case, config: { ...(vm.case.config as BatchConfig), trap_info: evil } } });
    expect(out).toContain("Honest runs &lt;b&gt;did&lt;/b&gt; before splitting.");
    expect(out).toContain("&lt;i&gt;none&lt;/i&gt;");
    expect(out).toContain("&lt;u&gt;ev&lt;/u&gt;");
    expect(out).not.toMatch(/<(i|u)>/);
  });
});

describe("What changed, for a batch that planted a leaky column", () => {
  const html = splitView(batch(leaky, DROPPED, [null, null]));

  it("uses the trap's words and highlights the dropped column", () => {
    expect(html).toContain("Honest runs left out the leaky column before splitting.");
    expect(col(html, "honest")).toContain('<span class="nb-ln nb-hl">df = df.drop(columns=[&#39;followup_score&#39;])</span>');
    expect(col(html, "inflated")).toContain("The leaky column was kept here");
  });

  it("has no evidence line, because the trap has no evidence number", () => {
    expect(html).toContain("What it did to the score");
    expect(html).not.toContain("ln-leak");
    expect(html).not.toContain("in training");
  });
});

describe("the wall's tiles", () => {
  const tile = (html: string, id: string): string => {
    const at = html.indexOf(`data-morph-key="tile:${id}"`);
    const next = html.indexOf('data-morph-key="tile:', at + 1);
    return html.slice(at, next < 0 ? undefined : next);
  };

  it("finish the evidence sentence the trap's way", () => {
    const html = wallView(batch(repeat, GROUPED, [0, 0.71]));
    expect(tile(html, "r02")).toContain('<span class="bw-ovl-t">71% of test rows came from subjects also in training</span>');
    expect(tile(html, "r01")).toContain("0% of test rows came from subjects also in training");
  });

  it("leave the evidence out when there is no number", () => {
    const html = wallView(batch(leaky, DROPPED, [null, null]));
    expect(html).not.toContain("bw-ovl-t");
    expect(html).not.toContain("Overlap unknown");
    // The gap alone on the device's panel, with no evidence sentence after it.
    expect(tile(html, "r02")).toMatch(/<div class="bw-res"><span class="bw-gap"><span class="mo-n"[^>]*><span data-keep>\+18\.0 pts<\/span><\/span><\/span><\/div>/);
    // A run of an evidence trap that did not keep what the number is read from.
    const partial = wallView(batch(repeat, GROUPED, [null, 0.71]));
    expect(tile(partial, "r01")).not.toContain("bw-ovl-t");
    expect(tile(partial, "r02")).toContain("bw-ovl-t");
  });

  it("keep today's sentence on a batch that does not describe its trap", () => {
    const html = wallView({ ...batch(repeat, GROUPED, [0, 0.71]), case: demo });
    expect(tile(html, "r02")).toContain("52% of test rows were in training");
    const noShare = structuredClone(demo);
    noShare.runs.r02.overlap_share = null;
    const out = wallView({ ...batch(repeat, GROUPED, [0, 0.71]), case: noShare });
    expect(tile(out, "r02")).not.toContain("bw-ovl-t");
    expect(out).not.toContain("Overlap unknown");
  });
});

describe("the run page's summary", () => {
  it("shows the evidence number with the trap's sentence", () => {
    const html = runSummaryView(batch(repeat, GROUPED, [0, 0.713]), "r02");
    expect(html).toContain('title="71.3% of test rows came from subjects also in training"');
    expect(text(html)).toContain("Gap +18.0 pts Overlap 71.3% Time");
  });

  it("leaves the number out when the trap has none, or a scored run has none", () => {
    expect(text(runSummaryView(batch(leaky, DROPPED, [null, null]), "r02"))).toContain("Gap +18.0 pts Time");
    expect(runSummaryView(batch(leaky, DROPPED, [0.4, 0.4]), "r02")).not.toContain("Overlap");
    expect(runSummaryView(batch(repeat, GROUPED, [null, 0.7]), "r01")).not.toContain("Overlap");
    // Not scored yet: the number is still to come.
    const vm = batch(repeat, GROUPED, [null, null]);
    vm.case.runs.r01 = { id: "r01", status: "running" };
    expect(text(runSummaryView(vm, "r01"))).toContain("Gap - Overlap - Time");
  });

  it("keeps today's number and tooltip on a batch that does not describe its trap", () => {
    const vm: BatchVm = { ...batch(repeat, GROUPED, [0, 0.7]), id: "demo-batch", case: demo };
    const html = runSummaryView(vm, "r02");
    expect(html).toContain('title="Share of its test rows that also appear in its training rows"');
    expect(text(html)).toContain("Overlap 52.4%");
  });
});
