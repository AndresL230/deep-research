// The evidence math (src/batch/evidence.ts) against the two committed batches. Every number pinned here was worked
// out by hand from the fixtures' fork f1 gaps and arm counts; the demo's three also sit in MASTER_PLAN 6.4. The level
// is the server's rule (deep_research/evidence.py): the running score of the pairs, supported at 20 or more, cleared
// after 5 or more pairs under 1. The Fisher p is shown only.

import { describe, expect, it } from "vitest";
import demoRaw from "../../fixtures/demo-batch/case/case.json?raw";
import robotRaw from "../../fixtures/robot-demo-batch/case/case.json?raw";
import type { CaseFile, ForkChild, ForkExperiment } from "../src/api";
import {
  ALPHA, NEEDED_PAIRS, RULE_TEXT, SUPPORTED_SCORE, ceiling, ceilingText, causeWords, compare, effect, evidenceFrom, fisherOneSided, fmtFrac, forkEvidence, isDone, isDropped,
  isPending, kOfN, nHidden, pairs, permutationP, scoreLevel, trace, verdictFork,
} from "../src/batch/evidence";

const demo = JSON.parse(demoRaw) as CaseFile;
const robot = JSON.parse(robotRaw) as CaseFile;
const f1 = (c: CaseFile): ForkExperiment => structuredClone(c.forks.f1) as ForkExperiment;
/** Fork f1 without the server's recorded pairs, score, p_exact and level, so the browser derives them. */
const bare = (c: CaseFile): ForkExperiment => {
  const f = f1(c) as ForkExperiment & Record<string, unknown>;
  for (const k of ["pairs", "score", "p_exact", "level", "evidence"]) delete f[k];
  return f;
};

/** Each value equal to four places. */
const near = (got: number[], want: number[]): void => {
  expect(got).toHaveLength(want.length);
  got.forEach((x, i) => expect(x).toBeCloseTo(want[i], 4));
};
const frac = (f: { num: number; den: number } | null): string => (f ? `${f.num}/${f.den}` : "null");

describe("demo fork f1, control vs forced", () => {
  const r = compare(bare(demo), "control", "forced");

  it("matches what the case file recorded on the fork: the same pairs, score and p_exact", () => {
    const rec = compare(f1(demo), "control", "forced");
    expect(rec.source).toBe("case");
    expect(rec.score).toBeCloseTo(r.score, 4);
    expect(rec.done.map((p) => p.agree)).toEqual(r.done.map((p) => p.agree));
    expect(rec.pExact).toBeCloseTo(1 / 70, 4);
  });

  it("scores four agreeing pairs to a sequential score of 13.03", () => {
    near(r.trace, [1.9, 3.61, 6.859, 13.0321]);
    expect(r.score).toBeCloseTo(13.0321, 4);
    expect(r.n).toBe(4);
    expect(r.agree).toBe(4);
    expect(r.source).toBe("derived");
    expect(r.predicted).toBe(false);
    expect(r.dir).toBe(1);
  });

  it("gives Fisher 5/70 and permutation 1/70 (MASTER_PLAN 6.4)", () => {
    expect(frac(r.fisher)).toBe("5/70");
    expect(fmtFrac(r.fisher)).toBe("5/70 (0.071)");
    expect(frac(r.permutation)).toBe("1/70");
    expect(fmtFrac(r.permutation!)).toBe("1/70 (0.014)");
    expect(r.pExact).toBeCloseTo(1 / 70, 6);
  });

  it("measures the effect per pair", () => {
    expect(r.effect?.meanDiff).toBe(0.1307);
    expect(r.effect?.range).toEqual([0.0813, 0.1882]);
    expect(r.done.map((p) => p.diff)).toEqual([0.1536, 0.1882, 0.0813, 0.0995]);
  });

  it("has no pairs left, so it can reach at most 4 of the 5 pairs needed", () => {
    expect(r.ceiling.pairs).toBe(4);
    expect(r.ceiling.remaining).toBe(0);
    expect(r.ceiling.max).toBe(4);
    expect(r.ceiling.needed).toBe(5);
    expect(r.ceiling.text).toBe("can reach at most 4 pairs, under the 5 needed");
  });

  it("is open by the server's rule: 4 agreeing pairs score 13.03, under 20, p 5/70 shown, the same as the case file's verdict.evidence", () => {
    const derived = forkEvidence(null, bare(demo));
    expect(derived).toMatchObject({ level: "open", pairs: 4, needed: 5, controlInflated: 3, controlTotal: 4, forcedInflated: 0, forcedTotal: 4, source: "derived" });
    expect(derived.p).toBeCloseTo(5 / 70, 4);
    const server = forkEvidence(demo, f1(demo));
    expect(server).toMatchObject({ level: "open", pairs: 4, needed: 5, source: "server" });
    expect(server.score).toBeCloseTo(13.0321, 4);
    expect(derived.score).toBeCloseTo(13.0321, 4);
    expect(server.p).toBeCloseTo(5 / 70, 4);
  });
});

describe("robot fork f1", () => {
  const f = f1(robot);

  it("control vs forced: 13.03, Fisher 1/70, permutation 1/70, lowered by 45.1 pts", () => {
    const r = compare(f, "control", "forced");
    expect(r.score).toBeCloseTo(13.0321, 4);
    expect(frac(r.fisher)).toBe("1/70");
    expect(frac(r.permutation)).toBe("1/70");
    expect(r.effect?.meanDiff).toBe(0.4511);
    expect(r.effect?.range).toEqual([0.4, 0.5]);
    expect(r.ceiling.text).toBe("can reach at most 4 pairs, under the 5 needed");
  });

  it("is open by the server's rule: score 13.03 on 4 pairs, p 0.0143 shown, the same as the case file's verdict.evidence", () => {
    const derived = forkEvidence(null, f);
    expect(derived).toMatchObject({ level: "open", pairs: 4, needed: 5, controlInflated: 4, controlTotal: 4, forcedInflated: 0, forcedTotal: 4, p: 0.0143, source: "derived" });
    expect(forkEvidence(robot, f)).toMatchObject({ level: "open", pairs: 4, needed: 5, p: 0.0143, score: 13.0321, source: "server" });
  });

  it("placebo vs forced: 13.03, 1/70, 1/70", () => {
    const r = compare(f, "placebo", "forced");
    expect(r.score).toBeCloseTo(13.0321, 4);
    expect(frac(r.fisher)).toBe("1/70");
    expect(frac(r.permutation)).toBe("1/70");
  });

  it("control vs placebo: four ties, Fisher 70/70, permutation 55/70, no change in the mean gap", () => {
    const r = compare(f, "control", "placebo");
    near(r.trace, [0.1, 0.01, 0.001, 0.0001]);
    expect(r.done.every((p) => p.diff === 0 && !p.agree)).toBe(true);
    expect(frac(r.fisher)).toBe("70/70");
    expect(frac(r.permutation)).toBe("55/70");
    expect(r.meanBase! - r.meanChanged!).toBeCloseTo(0, 9);
    // Self-check reading: control +43.8 pts, placebo +43.8 pts.
    expect(r.meanBase).toBeCloseTo(0.4375, 4);
  });

  it("control vs show: one agreeing pair among ties, Fisher 35/70, permutation 15/70", () => {
    const r = compare(f, "control", "show");
    near(r.trace, [0.1, 0.19, 0.019, 0.0361]);
    expect(frac(r.fisher)).toBe("35/70");
    expect(frac(r.permutation)).toBe("15/70");
  });

  it("show vs forced: the last pair ties, 0.69, Fisher 5/70, permutation 5/70", () => {
    const r = compare(f, "show", "forced");
    near(r.trace, [1.9, 3.61, 6.859, 0.6859]);
    expect(r.score.toFixed(2)).toBe("0.69");
    expect(frac(r.fisher)).toBe("5/70");
    expect(frac(r.permutation)).toBe("5/70");
  });

  it("reads hidden-test rates as k of 20", () => {
    expect(nHidden(robot.config)).toBe(20);
    const ks = (arm: string): (number | null)[] =>
      [1, 2, 3, 4].map((i) => kOfN(f.children[`${arm}-${i}`].true_accuracy, nHidden(robot.config)));
    expect(ks("control")).toEqual([11, 11, 11, 11]);
    expect(ks("forced")).toEqual([11, 11, 15, 11]);
    expect(nHidden({ ...robot.config, robot_hidden_positions: 30 } as CaseFile["config"])).toBe(30);
  });

  it("the batch's honest runs average 100% on the hidden test", () => {
    const honest = Object.values(robot.runs).filter((r) => r.status === "honest").map((r) => r.true_accuracy as number);
    expect(honest.reduce((s, x) => s + x, 0) / honest.length).toBe(1);
  });
});

describe("pairs", () => {
  const kid = (arm: ForkChild["arm"], status: ForkChild["status"], gap: number | null): ForkChild => ({ arm, status, gap });
  const fork = (children: Record<string, ForkChild>, n = 3): ForkExperiment => ({
    id: "f9", status: "running", source_run: "r01", fork_at: 1, label: "deduplicate", intervention: "x", n_per_arm: n, children,
  });

  it("counts a tie as disagree", () => {
    const ps = pairs(fork({ "control-1": kid("control", "inflated", 0.1), "forced-1": kid("forced", "honest", 0.1) }, 1), "control", "forced");
    expect(isDone(ps[0]) && ps[0].agree).toBe(false);
    near(trace(ps), [0.1]);
  });

  it("drops a pair with a failed copy and leaves a running one pending", () => {
    const f = fork({
      "control-1": kid("control", "inflated", 0.2), "forced-1": kid("forced", "honest", 0.0),
      "control-2": kid("control", "inflated", 0.2), "forced-2": kid("forced", "failed", null),
      "control-3": kid("control", "inflated", 0.2), "forced-3": kid("forced", "running", null),
    });
    const ps = pairs(f, "control", "forced");
    expect(isDone(ps[0])).toBe(true);
    expect(isDropped(ps[1]) && ps[1].dropped).toBe("forced-2 failed");
    expect(isPending(ps[2]) && ps[2].waiting).toEqual(["forced-3"]);
    const r = compare(f, "control", "forced");
    near(r.trace, [1.9]);
    // Three per arm, one scored forced copy, one failed, one running: at most 2 pairs, under the 5 needed.
    expect(r.ceiling.pairs).toBe(1);
    expect(r.ceiling.remaining).toBe(1);
    expect(r.ceiling.text).toBe("can reach at most 2 pairs, under the 5 needed");
    expect(effect(ps)).toEqual({ meanDiff: 0.2, range: [0.2, 0.2] });
  });

  it("leaves a pair pending when a copy has not started", () => {
    const ps = pairs(fork({ "control-1": kid("control", "inflated", 0.2) }, 1), "control", "forced");
    expect(isPending(ps[0]) && ps[0].waiting).toEqual(["forced-1"]);
    expect(trace(ps)).toEqual([]);
    expect(compare(fork({}, 1), "control", "forced").score).toBe(1);
  });

  it("flips the direction when the saved prediction is a larger gap", () => {
    const f = { ...bare(demo), prediction: "larger_gap" } as ForkExperiment;
    const r = compare(f, "control", "forced");
    expect(r.predicted).toBe(true);
    expect(r.agree).toBe(0);
    expect(frac(r.permutation)).toBe("70/70");
  });
});

describe("level and ceiling", () => {
  it("follows the server's rule: a running score of 20 or more, the Fisher p shown only", () => {
    expect([NEEDED_PAIRS, SUPPORTED_SCORE, ALPHA]).toEqual([5, 20, 0.05]);
    // 8 of 8 against 0 of 8: 8 agreeing pairs at worst, score 169.8; p = 1/12870.
    expect(evidenceFrom(8, 8, 0, 8)).toMatchObject({ level: "supported", pairs: 8, p: 0.0001 });
    // From counts alone the least favourable pairing: 4 of 8 against 2 of 8 is 2 agreeing pairs, far under 20.
    expect(evidenceFrom(4, 8, 2, 8)).toMatchObject({ level: "open", pairs: 8 });
    expect(evidenceFrom(4, 8, 2, 8).score).toBeLessThan(1);
    // A perfect split on 4 pairs is still open: 13.03 is under 20, though Fisher p = 0.0143 is under 0.05.
    expect(evidenceFrom(4, 4, 0, 4)).toMatchObject({ level: "open", pairs: 4, p: 0.0143 });
    expect(evidenceFrom(4, 4, 0, 4).score).toBeCloseTo(13.0321, 4);
    // Five agreeing pairs: 24.76, supported.
    expect(evidenceFrom(5, 5, 0, 5).level).toBe("supported");
    // Pairs are the smaller arm; an empty arm has no p.
    expect(evidenceFrom(9, 10, 1, 7)).toMatchObject({ pairs: 7 });
    expect(evidenceFrom(3, 4, 0, 0)).toMatchObject({ level: "open", pairs: 0, p: null });
    // Counts alone never clear a step; known pairs can: 5 disagreeing pairs score 0.00001.
    expect(evidenceFrom(4, 8, 4, 8).level).toBe("open");
    expect(evidenceFrom(4, 5, 4, 5, [false, false, false, false, false]).level).toBe("cleared");
    expect(evidenceFrom(4, 4, 0, 4, [true, true, true, true]).level).toBe("open");
    expect(scoreLevel([true, true, true, true, true])).toMatchObject({ level: "supported" });
  });

  it("says how many more pairs would reach the 5 needed when enough can still come", () => {
    const c = ceiling(3, 9);
    expect(c.remaining).toBe(6);
    expect(c.text).toBe("2 more pairs would reach the 5 needed");
    expect(ceiling(4, 8).text).toBe("1 more pair would reach the 5 needed");
    expect(ceiling(5, 8).text).toBe("5 pairs, at least the 5 needed");
    expect(ceiling(2, 3).text).toBe("can reach at most 3 pairs, under the 5 needed");
  });

  it("tells a request with 4 copies per arm that it cannot be supported", () => {
    expect(ceilingText(4)).toBe("With 4 copies per arm this experiment can reach at most 4 pairs, under the 5 needed, so it cannot be supported; 5 or more copies per arm can.");
    expect(ceilingText(8)).toBe(`${RULE_TEXT}.`);
    expect(RULE_TEXT).toContain("running score of 20 or more");
    expect(ceilingText(4)).not.toMatch(/\u2014/);
  });
});

describe("exact tests", () => {
  it("Fisher by hand", () => {
    expect(fisherOneSided(3, 4, 0, 4)).toMatchObject({ num: 5, den: 70 });
    expect(fisherOneSided(4, 4, 3, 4)).toMatchObject({ num: 35, den: 70 });
  });

  it("permutation gives up past a pool of 16 rather than sample", () => {
    const nine = Array.from({ length: 9 }, (_, i) => i / 10);
    expect(permutationP(nine, nine)).toBeNull();
    expect(permutationP(nine.slice(0, 8), nine.slice(1, 9))).not.toBeNull();
    expect(permutationP([], [0.1])).toBeNull();
  });
});

describe("server fields", () => {
  it("prefers forks.f1.score when the case file has it, as a measure", () => {
    const f = { ...f1(demo), score: 30 } as ForkExperiment;
    const r = compare(f, "control", "forced");
    expect(r.source).toBe("case");
    expect(r.score).toBe(30);
    // Only control vs forced is recorded on the server; other pairings stay derived.
    expect(compare({ ...f1(robot), score: 30 } as ForkExperiment, "placebo", "forced").source).toBe("derived");
  });

  it("never takes the level from a sequential score or a level recorded on the fork: the evidence rule sets it", () => {
    const high = { ...f1(demo), score: 30, level: "supported" } as ForkExperiment;
    expect(forkEvidence(null, high).level).toBe("open");
    expect(forkEvidence({ ...demo, verdict: null }, high).level).toBe("open");
  });

  it("uses the verdict's evidence only for the fork the verdict was judged on", () => {
    const other = { ...f1(demo), id: "f2", label: "other_step" } as ForkExperiment;
    const c = { ...structuredClone(demo), verdict: { ...demo.verdict!, evidence: { ...demo.verdict!.evidence!, level: "supported" as const } } };
    c.forks = { f1: f1(demo), f2: other };
    expect(forkEvidence(c, c.forks.f1 as ForkExperiment)).toMatchObject({ level: "supported", source: "server" });
    expect(forkEvidence(c, other)).toMatchObject({ level: "open", source: "derived" });
  });

  it("leaves no pairs to come on a stopped fork", () => {
    const f = bare(demo);
    f.status = "stopped";
    delete f.children["control-4"];
    delete f.children["forced-4"];
    delete (f as { arms?: unknown }).arms;
    const r = compare(f, "control", "forced");
    expect(r.ceiling.remaining).toBe(0);
    expect(r.ceiling.max).toBe(3);
    near(r.trace, [1.9, 3.61, 6.859]);
  });

  it("reads the server's pairs and p_exact", () => {
    const f = { ...f1(demo), pairs: [{ i: 1, control_gap: 0.3, changed_gap: 0.1, agree: true }], p_exact: 0.5 } as ForkExperiment;
    const r = compare(f, "control", "forced");
    near(r.trace, [1.9]);
    expect(r.done[0].diff).toBe(0.2);
    expect(r.pExact).toBe(0.5);
  });
});

describe("verdict helpers", () => {
  it("picks fork f1 on both batches", () => {
    expect(verdictFork(demo)?.id).toBe("f1");
    expect(verdictFork(robot)?.id).toBe("f1");
  });

  it("prefers an ended fork on the verdict's step over a newer one, and never a fix fork", () => {
    const base = f1(demo);
    const c: CaseFile = {
      ...structuredClone(demo),
      forks: {
        f1: base,
        f2: { ...base, id: "f2", label: "other_step" },
        f10: { ...base, id: "f10", kind: "fix" },
        pending: { id: "pending", status: "awaiting_approval", n_per_arm: 4, vm_count: 9, estimate_usd: null },
      },
    };
    expect(verdictFork(c)?.id).toBe("f1");
    c.forks.f1 = { ...base, status: "running" };
    expect(verdictFork(c)?.id).toBe("f2");
    expect(verdictFork({ ...c, forks: {} })).toBeNull();
  });

  it("finds a claim of cause by the server's CAUSAL words, by whole word; both fixtures now say suggests", () => {
    expect(causeWords(demo.verdict?.sentence)).toBe(false);
    expect(causeWords(robot.verdict?.sentence)).toBe(false);
    expect(demo.verdict?.sentence).toContain("suggests");
    expect(robot.verdict?.sentence).toContain("suggests");
    expect(causeWords("Skipping dedupe CAUSED the inflation.")).toBe(true);
    expect(causeWords("This causes it.")).toBe(true);
    expect(causeWords("A causal step.")).toBe(true);
    expect(causeWords("Causing the gap.")).toBe(true);
    // The server's words are about cause only: "proves" is caught by the verdict's own check (lanes.ts), not here.
    expect(causeWords("This proves skipping dedupe drove the inflation.")).toBe(false);
    expect(causeWords("Because of the split")).toBe(false);
    expect(causeWords(null)).toBe(false);
  });
});
