// The home screen and the header cost bar (src/batch/home.ts), against the demo batch's real config and costs.

import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import type { BatchConfig, CaseFile, Costs, Estimate } from "../src/api";
import { costBar, costGroups, homeView, startBlocked } from "../src/batch/home";
import type { HomeVm } from "../src/batch/model";

const demo = JSON.parse(caseRaw) as CaseFile;
const cfg = { ...(demo.config as BatchConfig), mode: "live" } as BatchConfig;
const est: Estimate = { avg_run_usd: 0.12, runs_usd: 1.44, forks_usd: 0.96, total_usd: 2.4, over_budget: false, basis: "average of earlier runs" };

const vm = (over: Partial<HomeVm> = {}): HomeVm => ({
  batches: { state: "ready", value: [{ id: "demo-batch", kind: "replay" }, { id: "b-20261114", kind: "live" }] },
  health: { ok: true, keys: { anthropic: true, daytona: true } },
  defaults: { config: cfg, prices_missing: false },
  draft: cfg,
  estimate: { state: "ready", value: est },
  starting: false,
  error: null,
  ...over,
});

const startTag = (html: string) => html.match(/<button[^>]*data-act="start"[^>]*>/)![0];

describe("homeView", () => {
  it("lists batches with their kind and open actions", () => {
    const html = homeView(vm());
    expect(html).toContain('data-act="open-batch" data-arg="demo-batch"');
    expect(html).toContain('data-morph-key="b-20261114"');
    expect(html).toContain(">Replay<");
    expect(html).toContain(">Live<");
    expect(html).toContain("data-morph-list");
  });

  it("shows loading, empty and error states for the list", () => {
    expect(homeView(vm({ batches: { state: "loading" } }))).toContain("Loading batches");
    expect(homeView(vm({ batches: { state: "ready", value: [] } }))).toContain("No batches yet");
    const err = homeView(vm({ batches: { state: "error", message: "Couldn't reach the server <x>" } }));
    expect(err).toContain('data-act="home"');
    expect(err).toContain("&lt;x&gt;");
  });

  it("renders a data-cfg input for every editable config field, with the draft's values", () => {
    const html = homeView(vm());
    for (const f of ["trap_strength", "trap_noise", "hint_level", "model_hint", "n_runs", "forks_per_choice", "analyst_model",
      "investigator_model", "budget_usd", "inflation_threshold", "holdout_fraction", "seed"]) {
      expect(html).toContain(`data-cfg="${f}"`);
    }
    expect(html).not.toContain('data-cfg="dataset"');
    expect(html).toContain("50% of rows duplicated");
    expect(html).toContain("8 pts");
    expect(html).toContain(`value="${cfg.analyst_model}"`);
    expect(html).toMatch(/<option value="random_forest" selected>/);
    expect(html).toContain("A run counts as inflated when reported accuracy beats true accuracy by more than this");
  });

  it("shows a skeleton while the defaults load", () => {
    const html = homeView(vm({ draft: null, defaults: null, estimate: null }));
    expect(html).toContain("Loading the defaults");
    expect(html).not.toContain("data-cfg=");
    expect(startTag(html)).toContain("disabled");
  });

  it("shows the estimate, and no estimate without earlier runs", () => {
    const html = homeView(vm());
    expect(html).toContain("$1.44");
    expect(html).toContain("$2.40");
    expect(html).toContain("average of earlier runs");
    const none = homeView(vm({ estimate: { state: "ready", value: { ...est, avg_run_usd: null, runs_usd: null, forks_usd: null, total_usd: null, basis: "no earlier runs yet" } } }));
    expect(none).toContain("no earlier runs to estimate from");
  });

  it("warns that the cap cannot be enforced when prices are missing", () => {
    expect(homeView(vm({ defaults: { config: cfg, prices_missing: true } }))).toContain("budget cap cannot be enforced");
    expect(homeView(vm())).not.toContain("cannot be enforced");
  });

  it("enables Start only when keys are set, the estimate fits and nothing is in flight", () => {
    expect(startBlocked(vm())).toBeNull();
    expect(startTag(homeView(vm()))).not.toContain("disabled");

    const over = vm({ estimate: { state: "ready", value: { ...est, total_usd: 12, over_budget: true } } });
    expect(startBlocked(over)).not.toBeNull();
    expect(homeView(over)).toContain("Over the $10.0 budget");

    const noKey = vm({ health: { ok: true, keys: { anthropic: true, daytona: false } } });
    expect(startTag(homeView(noKey))).toContain("disabled");
    expect(homeView(noKey)).toContain("Daytona key missing");
    expect(homeView(noKey)).toContain("Live batches cannot start");

    const starting = homeView(vm({ starting: true, error: "HTTP 500 & more" }));
    expect(startTag(starting)).toContain("disabled");
    expect(starting).toContain("HTTP 500 &amp; more");
    expect(starting).toContain('data-act="reset-config"');
  });

  it("never uses an em dash", () => {
    expect(homeView(vm())).not.toContain("\u2014");
    expect(homeView(vm({ draft: null }))).not.toContain("\u2014");
  });
});

describe("costBar", () => {
  it("shows the demo batch as simulated with token counts only", () => {
    const html = costBar(demo.costs, { simulated: true });
    expect(html).toContain("Simulated");
    expect(html).toContain("573k tokens");   // 516707 + 55935
    expect(html).not.toContain("$");
    expect(html).toContain('title="');
    expect(html).toContain("Runs: 573k tokens");
  });

  it("shows tokens and a prices hint when spend is unknown", () => {
    const html = costBar({ ...demo.costs, simulated: false }, { simulated: false });
    expect(html).toContain("prices missing");
    expect(html).toContain("573k tokens");
    expect(html).not.toContain("hm-cb-meter");
  });

  it("shows spend against the budget with a colored meter", () => {
    const base: Costs = { budget_usd: 10, spent_usd: 2, prices_missing: false, scopes: {
      "run:r01": { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 2000, total_usd: 1.5 },
      "fork:f1:control-1": { input_tokens: 1000, output_tokens: 0, total_usd: 0.3 },
      investigator: { input_tokens: 500, output_tokens: 0, total_usd: 0.2 },
    } };
    const ok = costBar(base, { simulated: false });
    expect(ok).toContain("$2.00");
    expect(ok).toContain("of $10.0");
    expect(ok).toContain('data-level="ok"');
    expect(ok).toContain("width:20.0%");
    expect(ok).toContain("5k tokens");
    expect(ok).toContain("Forks: 1k tokens, $0.30");
    expect(costBar({ ...base, spent_usd: 8 }, { simulated: false })).toContain('data-level="warn"');
    const over = costBar({ ...base, spent_usd: 12 }, { simulated: false });
    expect(over).toContain('data-level="over"');
    expect(over).toContain("width:100.0%");
  });

  it("groups scopes into runs, forks and investigator", () => {
    const g = costGroups({ scopes: {
      "run:r01": { input_tokens: 10, output_tokens: 5 }, "run:r02": { input_tokens: 1, output_tokens: 1 },
      "fork:f1:base": { input_tokens: 3, output_tokens: 0, cache_write_tokens: 2 }, investigator: { input_tokens: 4, output_tokens: 0 },
    } });
    expect(g.map((x) => [x.name, x.tokens])).toEqual([["Runs", 17], ["Forks", 5], ["Investigator", 4]]);
  });

  it("handles empty costs", () => {
    const html = costBar({}, { simulated: false });
    expect(html).toContain("No cost yet");
    expect(html).not.toContain("NaN");
  });
});
