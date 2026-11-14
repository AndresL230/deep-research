// The home screen, the New batch form and the header cost bar (src/batch/home.ts), against the demo batch's real config and costs.

import { afterEach, describe, expect, it, vi } from "vitest";
import caseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import type { BatchConfig, CaseFile, ControllerInfo, Costs, Defaults, Estimate } from "../src/api";
import {
  HM_ACT, MODEL_CHOICES, NEW_BATCH_TITLE, costBar, costGroups, domainDraft, draftModels, homeView, initialDraft, newBatchView, pickDomain, recallDomain, rememberDomain,
  resetDraft, startBlocked, startPayload, toggleModel,
} from "../src/batch/home";
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
/** The markup's visible text: tags dropped, whitespace collapsed. */
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const MAIN = ["n_runs", "trap_strength", "hint_level", "budget_usd"];
const ADVANCED = ["trap_noise", "model_hint", "holdout_fraction", "seed", "forks_per_choice", "inflation_threshold", "analyst_model", "investigator_model"];

describe("homeView", () => {
  it("shows batches as table rows with their kind and open actions", () => {
    const html = homeView(vm());
    expect(html).toContain('data-act="open-batch" data-arg="demo-batch"');
    expect(html).toContain('data-morph-key="b-20261114"');
    expect(html).toContain(">Replay<");
    expect(html).toContain(">Live<");
    expect(html).toContain("data-morph-list");
  });

  it("marks a saved batch that can be picked up again", () => {
    const html = homeView(vm({ batches: { state: "ready", value: [{ id: "b-saved", kind: "replay", resumable: true }] } }));
    expect(html).toContain('data-kind="ready">Ready to investigate<');
    expect(html).not.toContain(">Replay<");
  });

  it("shows loading, empty and error states for the batches", () => {
    expect(homeView(vm({ batches: { state: "loading" } }))).toContain("Loading batches");
    expect(homeView(vm({ batches: { state: "ready", value: [] } }))).toContain("No batches yet");
    const err = homeView(vm({ batches: { state: "error", message: "Couldn't reach the server <x>" } }));
    expect(err).toContain('data-act="home"');
    expect(err).toContain(">Retry<");
    expect(err).toContain("&lt;x&gt;");
  });

  it("is Needs you, then the batches, and no longer holds the New batch form", () => {
    for (const html of [homeView(vm()), homeView(vm({ advanced: true, error: "HTTP 500" })), homeView(vm({ draft: null, defaults: null }))]) {
      expect(html).not.toContain("data-cfg=");
      expect(html).not.toContain('data-act="start"');
      expect(html).not.toContain('data-act="toggle-advanced"');
      expect(html).not.toContain("New batch");
      expect(html).not.toContain("hm-panel");
      expect(html).not.toContain("hm-foot");
      expect(html).not.toContain("HTTP 500");
    }
    expect(text(homeView(vm({ advanced: true })))).toBe(
      "Nothing needs you. Batches 2 batches, newest first, simulated last "
      + "Batch Domain Started Runs Claimed vs measured Step found Verdict Models Spend "
      + "b-20261114 Live demo-batch Replay");
  });
});

describe("newBatchView, the New batch dialog's form", () => {
  it("has no lead, no help paragraphs and no prose: labels and readouts only", () => {
    for (const html of [newBatchView(vm()), newBatchView(vm({ advanced: true }))]) {
      expect(html).not.toContain("hm-lead");
      expect(html).not.toContain("hm-help");
      // The only paragraphs are the one-line estimate and status lines in the footer.
      for (const p of html.match(/<p\b[^>]*>/g) ?? []) expect(p).toMatch(/class="hm-(est|warn|errtext)"/);
      expect(html).not.toMatch(/<(fieldset|legend|details)\b/);
    }
    expect(text(newBatchView(vm({ advanced: true })))).toBe(
      "New batch Pima diabetes · planted duplicate rows "
      + "Runs Duplicated rows 50% Hint None Light Budget $ "
      + "Advanced Reset Trap noise 0.00 Holdout fraction 20% Inflation threshold 8 pts Model hint Random forest Any "
      + "Forks per arm Seed Analyst model Investigator model "
      + "About $2.40 for 12 runs and 8 forks Start batch");
  });

  it("is titled for the dialog, closes from its X, and keeps Start in the footer after the form", () => {
    const html = newBatchView(vm({ advanced: true }));
    expect(html).toContain(`<h2 class="hm-h2" id="${NEW_BATCH_TITLE}">New batch</h2>`);
    expect(html).toMatch(/<button type="button" class="nbd-x" data-act="close-new-batch" aria-label="Close"/);
    // The title bar, the form that scrolls, then the footer: three parts, in that order.
    const head = html.indexOf('data-morph-key="nbd-head"');
    const body = html.indexOf('data-morph-key="nbd-body"');
    const foot = html.indexOf('class="hm-foot" data-morph-key="foot"');
    expect(head).toBeGreaterThanOrEqual(0);
    expect(body).toBeGreaterThan(head);
    expect(foot).toBeGreaterThan(body);
    expect(html.indexOf('data-cfg="investigator_model"')).toBeLessThan(foot);
    expect(html.indexOf('data-act="start"')).toBeGreaterThan(foot);
  });

  it("shows the four main settings with the draft's values, and the dataset and trap as one fixed line", () => {
    const html = newBatchView(vm());
    for (const f of MAIN) expect(html).toContain(`data-cfg="${f}"`);
    expect(html).toMatch(/type="number"[^>]*min="1" max="48"[^>]*value="12" data-cfg="n_runs"/);
    expect(html).toMatch(/type="range" min="0" max="1" step="0.05" value="0.5"[^>]*data-cfg="trap_strength"/);
    expect(html).toContain(">50%</output>");
    expect(html).toContain('<input type="radio" name="hint_level" data-cfg="hint_level" value="none" checked>');
    expect(html).toContain('<input type="radio" name="hint_level" data-cfg="hint_level" value="light">');
    expect(html).toMatch(/value="10" data-cfg="budget_usd"/);
    expect(html).toContain("Pima diabetes");
    expect(html).toContain("planted duplicate rows");
    expect(html).not.toContain('data-cfg="dataset"');
    expect(html).not.toContain('data-cfg="trap"');
    expect(newBatchView(vm({ draft: { ...cfg, hint_level: "light", trap_strength: 0.35 } })))
      .toContain('<input type="radio" name="hint_level" data-cfg="hint_level" value="light" checked>');
    expect(newBatchView(vm({ draft: { ...cfg, trap_strength: 0.35 } }))).toContain(">35%</output>");
  });

  it("hides the advanced settings until vm.advanced, behind a toggle", () => {
    const closed = newBatchView(vm());
    expect(closed).toMatch(/<button[^>]*data-act="toggle-advanced" aria-expanded="false"[^>]*>/);
    for (const f of ADVANCED) expect(closed).not.toContain(`data-cfg="${f}"`);
    expect(closed).not.toContain('data-act="reset-config"');
    expect(newBatchView(vm({ advanced: false }))).toBe(closed);

    const open = newBatchView(vm({ advanced: true }));
    expect(open).toMatch(/<button[^>]*data-act="toggle-advanced" aria-expanded="true"[^>]*>/);
    for (const f of [...MAIN, ...ADVANCED]) expect(open).toContain(`data-cfg="${f}"`);
    expect(open).toContain('data-act="reset-config"');
    expect(open).toContain("8 pts");
    expect(open).toContain(`value="${cfg.analyst_model}"`);
    expect(open).toContain(`value="${cfg.investigator_model}"`);
    expect(open).toContain('<input type="radio" name="model_hint" data-cfg="model_hint" value="random_forest" checked>');
    expect(open).toMatch(/min="1" max="8"[^>]*data-cfg="forks_per_choice"/);
  });

  it("shows a skeleton while the defaults load", () => {
    const html = newBatchView(vm({ batches: { state: "loading" }, draft: null, defaults: null, estimate: null, advanced: true }));
    expect(html).toContain("hm-skel");
    expect(html).toContain("Loading defaults");
    expect(html).not.toContain("data-cfg=");
    expect(html).toMatch(/<button[^>]*data-act="toggle-advanced" aria-expanded="false"[^>]* disabled>/);
    expect(startTag(html)).toContain("disabled");
    // The list has settled without defaults: they failed, so nothing keeps spinning.
    const failed = newBatchView(vm({ batches: { state: "error", message: "down" }, draft: null, defaults: null, estimate: null }));
    expect(failed).toContain("Defaults did not load");
    expect(failed).not.toContain("Loading defaults");
    expect(startTag(failed)).toContain("disabled");
  });

  it("shows the estimate as one line", () => {
    expect(text(newBatchView(vm()))).toContain("About $2.40 for 12 runs and 8 forks");
    expect(newBatchView(vm())).not.toContain('data-tone="bad"');
    expect(text(newBatchView(vm({ draft: { ...cfg, n_runs: 1, forks_per_choice: 2 } })))).toContain("for 1 run and 4 forks");
    const none = newBatchView(vm({ estimate: { state: "ready", value: { ...est, avg_run_usd: null, runs_usd: null, forks_usd: null, total_usd: null, basis: "no earlier runs yet" } } }));
    expect(none).toContain("No earlier runs to estimate from");
    expect(newBatchView(vm({ estimate: { state: "loading" } }))).toContain("Estimating");
    expect(newBatchView(vm({ estimate: null }))).toContain("Estimating");
    const failed = newBatchView(vm({ estimate: { state: "error", message: "HTTP 500 <oops>" } }));
    expect(failed).toContain("No estimate. HTTP 500 &lt;oops&gt;");
    expect(startTag(failed)).not.toContain("disabled");
    for (const html of [newBatchView(vm()), none, failed]) expect(html.match(/class="hm-est"/g)).toHaveLength(1);
  });

  it("shows one short line when prices are missing", () => {
    expect(newBatchView(vm({ defaults: { config: cfg, prices_missing: true } }))).toContain("Prices missing, budget not enforced");
    expect(newBatchView(vm())).not.toContain("Prices missing");
  });

  it("names a key only when it is missing", () => {
    const ok = newBatchView(vm());
    expect(ok).not.toContain("key missing");
    expect(ok).not.toContain("key set");
    expect(ok).not.toContain("hm-why");
    expect(newBatchView(vm({ health: null }))).not.toContain("key missing");

    const noDaytona = newBatchView(vm({ health: { ok: true, keys: { anthropic: true, daytona: false } } }));
    expect(noDaytona).toContain("Daytona key missing");
    expect(noDaytona).not.toContain("Anthropic key missing");
    const noAnthropic = newBatchView(vm({ health: { ok: true, keys: { anthropic: false, daytona: true } } }));
    expect(noAnthropic).toContain("Anthropic key missing");
    expect(noAnthropic).not.toContain("Daytona key missing");
    const neither = newBatchView(vm({ health: { ok: false, keys: { anthropic: false, daytona: false } } }));
    expect(neither).toContain("Anthropic key missing");
    expect(neither).toContain("Daytona key missing");
  });

  it("enables Start only when keys are set, the estimate fits and nothing is in flight", () => {
    expect(startBlocked(vm())).toBeNull();
    expect(startTag(newBatchView(vm()))).not.toContain("disabled");
    expect(startTag(newBatchView(vm({ health: null })))).not.toContain("disabled");

    const over = vm({ estimate: { state: "ready", value: { ...est, total_usd: 12, over_budget: true } } });
    expect(startBlocked(over)).toBe("Over budget");
    expect(startTag(newBatchView(over))).toContain("disabled");
    expect(newBatchView(over)).toContain('<span class="hm-why" data-morph-key="why">Over budget</span>');
    expect(newBatchView(over)).toMatch(/<p class="hm-est"[^>]*data-tone="bad"/);
    expect(text(newBatchView(over))).toContain("About $12.0 for 12 runs and 8 forks");

    const noKey = vm({ health: { ok: true, keys: { anthropic: true, daytona: false } } });
    expect(startBlocked(noKey)).toBe("Daytona key missing");
    expect(startTag(newBatchView(noKey))).toContain("disabled");
    expect(newBatchView(noKey)).toContain('<span class="hm-why" data-morph-key="why">Daytona key missing</span>');

    const starting = newBatchView(vm({ starting: true, advanced: true }));
    expect(startBlocked(vm({ starting: true }))).not.toBeNull();
    expect(startTag(starting)).toContain("disabled");
    expect(starting).toContain(">Starting<");
    expect(starting).not.toContain("hm-why");
    expect(starting).toMatch(/<button[^>]*data-act="reset-config" disabled>/);
    expect(newBatchView(vm({ advanced: true }))).toMatch(/<button[^>]*data-act="reset-config">/);

    expect(startBlocked(vm({ draft: null }))).not.toBeNull();
  });

  it("shows the start error near Start", () => {
    const html = newBatchView(vm({ error: "HTTP 500 & more" }));
    expect(html).toContain('role="alert">HTTP 500 &amp; more</p>');
    expect(html.indexOf("HTTP 500")).toBeGreaterThan(html.indexOf('data-act="start"'));
    expect(newBatchView(vm())).not.toContain('role="alert"');
  });

  it("never uses an em dash", () => {
    for (const v of [vm(), vm({ advanced: true }), vm({ draft: null }), vm({ health: { ok: false, keys: { anthropic: false, daytona: false } } })]) {
      expect(newBatchView(v)).not.toContain("\u2014");
    }
  });
});

// The domains as GET /api/defaults lists them: in name order, each with its own config (the robot one differs in its
// domain and inflation threshold only).
const tabCfg: BatchConfig = { ...cfg, domain: "tabular", target: null, script: null, robot_hidden_positions: null, robot_eval_seeds: [0] };
const robotCfg: BatchConfig = { ...tabCfg, domain: "robot_arm", inflation_threshold: 0.275 };
const ROBOT_LINE = "Agents write a pick and place controller for a Franka Panda in MuJoCo and report a success rate from the one practice can position; we run it on can positions spread over the table.";
const withDomains: Defaults = {
  config: tabCfg,
  prices_missing: false,
  domains: [
    { name: "robot_arm", title: "Robot arm pick and place", description: ROBOT_LINE, visual: "motion", output_files: ["controller.py", "report.json"], output_globs: ["live/*.motion.json"], config: robotCfg },
    { name: "tabular", title: "Tabular data science", description: "Agents train a classifier on a CSV with a flaw planted in it.", visual: "charts", output_files: ["report.json"], output_globs: [], config: tabCfg },
  ],
};
const inputs = { html: `<div class="di" data-morph-key="inputs">DATASET ROWS</div>`, label: "Pima diabetes · planted duplicate rows" };
const pima = { dataset: "pima", target: null, script: null };

describe("the domain picker", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows no picker when the server lists one domain or none", () => {
    expect(newBatchView(vm())).not.toContain("hm-dom");
    expect(newBatchView(vm({ defaults: { ...withDomains, domains: withDomains.domains!.slice(1) } }))).not.toContain("hm-dom");
  });

  it("offers Data science first and chosen, with the tabular form as before", () => {
    const html = newBatchView(vm({ defaults: withDomains, draft: tabCfg, advanced: true }), inputs);
    const opts = html.match(/<button[^>]*data-act="hm-domain"[^>]*>[^<]*<\/button>/g)!;
    expect(opts).toHaveLength(2);
    expect(opts[0]).toContain('data-arg="tabular"');
    expect(opts[0]).toContain('aria-checked="true"');
    expect(opts[0]).toContain(">Data science<");
    expect(opts[1]).toContain('data-arg="robot_arm"');
    expect(opts[1]).toContain('aria-checked="false"');
    expect(opts[1]).toContain(">Robot arm<");
    expect(HM_ACT.domain).toBe("hm-domain");
    // Everything below the picker is the form as it was.
    const below = (h: string) => h.slice(h.indexOf('data-morph-key="main"'));
    expect(below(html)).toBe(below(newBatchView(vm({ draft: tabCfg, advanced: true }), inputs)));
    expect(html).toContain("DATASET ROWS");
    expect(html).toContain("Pima diabetes · planted duplicate rows");
    for (const f of [...MAIN, ...ADVANCED]) expect(html).toContain(`data-cfg="${f}"`);
  });

  it("hides the tabular settings for the robot arm and says what the task is", () => {
    const html = newBatchView(vm({ defaults: withDomains, draft: robotCfg, advanced: true }), inputs);
    expect(html).toMatch(/<button[^>]*aria-checked="true" data-act="hm-domain" data-arg="robot_arm"/);
    expect(html).toContain(ROBOT_LINE);
    expect(html).not.toContain("DATASET ROWS");
    expect(html).not.toContain("Pima diabetes");
    expect(html).not.toContain("hm-trap");
    for (const f of ["trap_strength", "trap_noise", "holdout_fraction", "model_hint", "dataset", "trap"]) expect(html).not.toContain(`data-cfg="${f}"`);
    for (const f of ["n_runs", "hint_level", "budget_usd", "inflation_threshold", "forks_per_choice", "seed", "investigator_model"]) {
      expect(html).toContain(`data-cfg="${f}"`);
    }
    // The analysts' models are chips in the main row, in place of the single model's text field.
    expect(html).not.toContain(`data-cfg="analyst_model"`);
    expect(html).toContain(`data-f="analyst_models"`);
    expect(html).toContain("hm-main--models");
    expect(html).toMatch(/min="0.05" max="0.5" step="0.025" value="0.275"[^>]*data-cfg="inflation_threshold"/);
    expect(html).toContain(">27.5 pts</output>");
    expect(text(html)).toContain("About $2.40 for 12 runs and 8 forks");
    expect(html).not.toContain("\u2014");
    // Locked while a batch starts.
    expect(newBatchView(vm({ defaults: withDomains, draft: robotCfg, starting: true }))).toMatch(/data-act="hm-domain" data-arg="tabular"[^>]* disabled>/);
  });

  it("switches the draft between domains, keeping the shared settings", () => {
    const edited: BatchConfig = { ...tabCfg, n_runs: 6, budget_usd: 4, hint_level: "light", trap: "leak", trap_strength: 0.3 };
    const home = vm({ defaults: withDomains, draft: edited });
    const robot = pickDomain(home, "robot_arm");
    expect(robot.draft).toEqual({ ...edited, domain: "robot_arm", inflation_threshold: 0.275 });
    const back = pickDomain(robot, "tabular");
    expect(back.draft).toEqual(edited);
    // Nothing to do: the same domain, an unknown one, no defaults yet, or a batch starting.
    expect(pickDomain(home, "tabular")).toBe(home);
    expect(pickDomain(home, "chess").draft).toBe(edited);
    expect(pickDomain(vm({ defaults: null, draft: edited }), "robot_arm").draft).toBe(edited);
    expect(pickDomain({ ...home, starting: true }, "robot_arm").draft).toBe(edited);
    // Reset goes to the chosen domain's defaults.
    expect(resetDraft(robot)).toEqual(robotCfg);
    expect(resetDraft(back)).toEqual(tabCfg);
    expect(domainDraft(withDomains, "robot_arm")).toEqual(robotCfg);
  });

  it("starts a tabular batch with the same body as before domains", () => {
    const draft: BatchConfig = { ...tabCfg, n_runs: 6 };
    const chosen = { dataset: "ds-0123abcd", target: "price", script: "sc-0123abcd" };
    expect(startPayload(draft, chosen, withDomains)).toEqual({ ...draft, ...chosen, mode: "live" });
    // A config from a server without domains, and no defaults at all: the same.
    const old = { ...cfg, mode: "replay" } as BatchConfig;
    expect(startPayload(old, pima, null)).toEqual({ ...old, ...pima, mode: "live" });
    expect(startPayload(old, pima, null).domain).toBeUndefined();
  });

  it("starts a robot batch with domain robot_arm, the robot defaults and no tabular choices", () => {
    const draft = pickDomain(vm({ defaults: withDomains, draft: { ...tabCfg, n_runs: 4, trap: "leak", trap_strength: 0.2 } }), "robot_arm").draft!;
    const body = startPayload(draft, { dataset: "ds-0123abcd", target: "price", script: "sc-0123abcd" }, withDomains);
    expect(body).toEqual({ ...robotCfg, n_runs: 4, mode: "live" });
    expect(body.domain).toBe("robot_arm");
    expect(body.inflation_threshold).toBe(0.275);
    expect(body.robot_hidden_positions).toBeNull();
    expect(body.robot_eval_seeds).toEqual([0]);
    expect([body.dataset, body.target, body.script, body.trap]).toEqual(["pima", null, null, "duplicates"]);
  });

  it("starts from the domain chosen last time when the server has it", () => {
    expect(initialDraft(withDomains, "robot_arm")).toEqual(robotCfg);
    expect(initialDraft(withDomains, "tabular")).toEqual(tabCfg);
    expect(initialDraft(withDomains, null)).toEqual(tabCfg);
    expect(initialDraft(withDomains, "chess")).toEqual(tabCfg);
    expect(initialDraft({ config: cfg, prices_missing: false }, "robot_arm")).toEqual(cfg);
    expect(initialDraft(withDomains, null)).not.toBe(tabCfg);
  });

  it("remembers the domain in localStorage, and does without it", () => {
    // No localStorage (node), or one that throws (storage off): no error, nothing remembered.
    expect(() => rememberDomain("robot_arm")).not.toThrow();
    expect(recallDomain()).toBeNull();
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    expect(() => rememberDomain("robot_arm")).not.toThrow();
    expect(recallDomain()).toBeNull();
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    rememberDomain("robot_arm");
    expect(recallDomain()).toBe("robot_arm");
  });
});

// The robot arm domain once a controller can be uploaded: both domains' configs carry the two robot start settings.
const tabCt: BatchConfig = { ...tabCfg, robot_start: "blank", robot_controller: null };
const robotCt: BatchConfig = { ...robotCfg, robot_start: "blank", robot_controller: null };
const withCt: Defaults = {
  ...withDomains, config: tabCt,
  domains: withDomains.domains!.map((d) => ({ ...d, config: d.name === "robot_arm" ? robotCt : tabCt })),
};
const controller: ControllerInfo = { id: "ct-89abcdef", name: "my_<arm>.py", lines: 312, imports: ["numpy"], missing_packages: [] };
const ctInputs = { ...inputs, controllerHtml: `<div class="di" data-morph-key="controller">CONTROLLER ROW</div>` };
const startOpt = (html: string, val: string) => html.match(new RegExp(`<input type="radio" name="robot_start"[^>]*value="${val}"[^>]*>`))?.[0] ?? null;

describe("the uploaded controller", () => {
  it("draws the controller row in the robot domain only", () => {
    const robot = newBatchView(vm({ defaults: withCt, draft: robotCt }), ctInputs);
    expect(robot).toContain("CONTROLLER ROW");
    expect(robot).not.toContain("DATASET ROWS");
    expect(robot.indexOf("CONTROLLER ROW")).toBeGreaterThan(robot.indexOf("New batch"));
    expect(robot.indexOf("CONTROLLER ROW")).toBeLessThan(robot.indexOf('data-morph-key="main"'));
    const tab = newBatchView(vm({ defaults: withCt, draft: tabCt }), ctInputs);
    expect(tab).toContain("DATASET ROWS");
    expect(tab).not.toContain("CONTROLLER ROW");
    // Nothing to draw: the panel is as it was.
    expect(newBatchView(vm({ defaults: withCt, draft: robotCt }), inputs)).not.toContain("CONTROLLER ROW");
  });

  it("offers Your upload only once a controller is uploaded", () => {
    const none = newBatchView(vm({ defaults: withCt, draft: robotCt, advanced: true }), ctInputs);
    expect(startOpt(none, "blank")).toContain(" checked");
    expect(startOpt(none, "colleague")).not.toContain("disabled");
    expect(startOpt(none, "uploaded")).toBe('<input type="radio" name="robot_start" data-cfg="robot_start" value="uploaded" disabled>');
    expect(none).toContain(">Your upload<");
    expect(none).not.toContain("Starting from");
    expect(none).not.toContain("hm-fixed");

    const draft: BatchConfig = { ...robotCt, robot_start: "uploaded", robot_controller: controller.id };
    const some = newBatchView(vm({ defaults: withCt, draft, advanced: true }), { ...ctInputs, controller });
    expect(startOpt(some, "uploaded")).toBe('<input type="radio" name="robot_start" data-cfg="robot_start" value="uploaded" checked>');
    expect(startOpt(some, "blank")).not.toContain("checked");
    expect(some).toContain('<span class="hm-fixed">Starting from my_&lt;arm&gt;.py</span>');
    expect(some).not.toContain("<arm>");
    // A tabular draft never says it, and never shows the robot start.
    const tab = newBatchView(vm({ defaults: withCt, draft: { ...tabCt, robot_controller: controller.id }, advanced: true }), { ...ctInputs, controller });
    expect(tab).not.toContain("Starting from");
    expect(tab).not.toContain('data-cfg="robot_start"');
  });

  it("sends the controller with a robot batch and never with a tabular one", () => {
    const draft: BatchConfig = { ...robotCt, n_runs: 3, robot_start: "uploaded", robot_controller: controller.id };
    const body = startPayload(draft, { dataset: "ds-0123abcd", target: "price", script: "sc-0123abcd" }, withCt);
    expect(body).toEqual({ ...robotCt, n_runs: 3, robot_start: "uploaded", robot_controller: controller.id, mode: "live" });
    expect(body.script).toBeNull();
    // Switched to Data science with the controller still in the draft: the tabular defaults take its place.
    const tab = pickDomain(vm({ defaults: withCt, draft }), "tabular").draft!;
    expect(tab.robot_controller).toBe(controller.id);
    expect(startPayload(tab, pima, withCt)).toEqual({ ...tabCt, n_runs: 3, mode: "live" });
    // The same without defaults, or with defaults that do not name the keys.
    expect(startPayload({ ...tab, domain: undefined }, pima, null)).toMatchObject({ robot_start: "blank", robot_controller: null, mode: "live" });
    expect(startPayload(tab, pima, withDomains)).toMatchObject({ robot_start: "blank", robot_controller: null });
    expect(startPayload({ ...tab, robot_start: "colleague" }, pima, null).robot_start).toBe("colleague");
  });
});

describe("the Models control", () => {
  const HAIKU = "anthropic:claude-haiku-5-5";
  const SONNET = "anthropic:claude-sonnet-5-5";
  const lineupCfg: BatchConfig = { ...robotCfg, n_runs: 36, analyst_models: [HAIKU, SONNET] };
  const chips = (html: string) => html.match(/<button[^>]*data-act="hm-model"[^>]*>[^<]*<\/button>/g) ?? [];

  it("offers Haiku 5.5 and Sonnet 5.5 as chips in the robot main row, the draft's lineup pressed", () => {
    const html = newBatchView(vm({ defaults: withDomains, draft: lineupCfg }));
    const c = chips(html);
    expect(c).toHaveLength(2);
    expect(c[0]).toContain(`data-arg="${HAIKU}"`);
    expect(c[0]).toContain('aria-pressed="true"');
    expect(c[0]).toContain(">Haiku 5.5<");
    expect(c[1]).toContain(">Sonnet 5.5<");
    expect(c.every((b) => !b.includes("disabled"))).toBe(true);
    expect(html).toMatch(/max="48"[^>]*value="36" data-cfg="n_runs"/);
    expect(HM_ACT.model).toBe("hm-model");
    expect(MODEL_CHOICES.map(([id]) => id)).toEqual([HAIKU, SONNET]);
    // The tabular form keeps its text field and has no chips.
    const tab = newBatchView(vm({ advanced: true }));
    expect(chips(tab)).toHaveLength(0);
    expect(tab).toContain(`data-cfg="analyst_model"`);
  });

  it("keeps at least one model on, and locks while starting", () => {
    const one: BatchConfig = { ...lineupCfg, analyst_models: [SONNET] };
    const c = chips(newBatchView(vm({ defaults: withDomains, draft: one })));
    expect(c[0]).toContain('aria-pressed="false"');
    expect(c[0]).not.toContain("disabled");
    expect(c[1]).toContain('aria-pressed="true"');
    expect(c[1]).toContain("disabled");
    expect(toggleModel(one, SONNET)).toBe(one);
    expect(chips(newBatchView(vm({ defaults: withDomains, draft: lineupCfg, starting: true }))).every((b) => b.includes("disabled"))).toBe(true);
  });

  it("toggles models in the control's order", () => {
    expect(toggleModel(lineupCfg, HAIKU).analyst_models).toEqual([SONNET]);
    expect(toggleModel({ ...lineupCfg, analyst_models: [SONNET] }, HAIKU).analyst_models).toEqual([HAIKU, SONNET]);
    // A draft with no lineup starts from its single analyst model.
    const single: BatchConfig = { ...robotCfg, analyst_model: HAIKU, analyst_models: null };
    expect(draftModels(single)).toEqual([HAIKU]);
    expect(toggleModel(single, SONNET).analyst_models).toEqual([HAIKU, SONNET]);
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
