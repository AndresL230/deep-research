// The evidence math (src/batch/evidence.ts) against the two committed batches. Every number pinned here was worked
// out by hand from the fixtures' fork f1 gaps and arm counts; the demo's three also sit in MASTER_PLAN 6.4.

import { describe, expect, it } from "vitest";
import demoRaw from "../../fixtures/demo-batch/case/case.json?raw";
import robotRaw from "../../fixtures/robot-demo-batch/case/case.json?raw";
import type { CaseFile, ForkChild, ForkExperiment } from "../src/api";
import {
  ceiling, ceilingText, causeWords, compare, effect, fisherOneSided, fmtFrac, isDone, isDropped, isPending, kOfN, level, nHidden, pairs,
  permutationP, trace, verdictFork,
} from "../src/batch/evidence";

const demo = JSON.parse(demoRaw) as CaseFile;
const robot = JSON.parse(robotRaw) as CaseFile;
const f1 = (c: CaseFile): ForkExperiment => structuredClone(c.forks.f1) as ForkExperiment;

/** Each value equal to four places. */
const near = (got: number[], want: number[]): void => {
  expect(got).toHaveLength(want.length);
  got.forEach((x, i) => expect(x).toBeCloseTo(want[i], 4));
};
const frac = (f: { num: number; den: number } | null): string => (f ? `${f.num}/${f.den}` : "null");

describe("demo fork f1, control vs forced", () => {
  const r = compare(f1(demo), "control", "forced");

  it("scores four agreeing pairs to 13.03 and stays open", () => {
    near(r.trace, [1.9, 3.61, 6.859, 13.0321]);
    expect(r.score).toBeCloseTo(13.0321, 4);
    expect(r.level).toBe("open");
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

  it("has no pairs left, so it can reach at most 13.03", () => {
    expect(r.ceiling.remaining).toBe(0);
    expect(r.ceiling.max).toBeCloseTo(13.0321, 4);
    expect(r.ceiling.needed).toBe(1);
    expect(r.ceiling.text).toBe("can reach at most 13.03, under 20");
  });
});

describe("robot fork f1", () => {
  const f = f1(robot);

  it("control vs forced: 13.03, Fisher 1/70, permutation 1/70, lowered by 45.1 pts", () => {
    const r = compare(f, "control", "forced");
    expect(r.score).toBeCloseTo(13.0321, 4);
    expect(r.level).toBe("open");
    expect(frac(r.fisher)).toBe("1/70");
    expect(frac(r.permutation)).toBe("1/70");
    expect(r.effect?.meanDiff).toBe(0.4511);
    expect(r.effect?.range).toEqual([0.4, 0.5]);
    expect(r.ceiling.text).toBe("can reach at most 13.03, under 20");
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
    // Three per arm, one done and one dropped: one pair left, and it cannot reach 20.
    expect(r.ceiling.remaining).toBe(1);
    expect(r.ceiling.text).toBe("can reach at most 3.61, under 20");
    expect(effect(ps)).toEqual({ meanDiff: 0.2, range: [0.2, 0.2] });
  });

  it("leaves a pair pending when a copy has not started", () => {
    const ps = pairs(fork({ "control-1": kid("control", "inflated", 0.2) }, 1), "control", "forced");
    expect(isPending(ps[0]) && ps[0].waiting).toEqual(["forced-1"]);
    expect(trace(ps)).toEqual([]);
    expect(compare(fork({}, 1), "control", "forced").score).toBe(1);
  });

  it("flips the direction when the saved prediction is a larger gap", () => {
    const f = { ...f1(demo), prediction: "larger_gap" } as ForkExperiment;
    const r = compare(f, "control", "forced");
    expect(r.predicted).toBe(true);
    expect(r.agree).toBe(0);
    expect(frac(r.permutation)).toBe("70/70");
  });
});

describe("level and ceiling", () => {
  it("follows the MASTER_PLAN 6.4 thresholds", () => {
    expect(level(24.76, 5)).toBe("supported");
    expect(level(0.5, 5)).toBe("cleared");
    expect(level(0.5, 4)).toBe("open");
    expect(level(13.03, 4)).toBe("open");
  });

  it("says how many agreeing pairs would reach 20 when enough remain", () => {
    const c = ceiling(3.61, 3);
    expect(c.needed).toBe(3);
    expect(c.text).toBe("3 more agreeing pairs would reach 24.76");
    expect(ceiling(13.0321, 2).text).toBe("1 more agreeing pair would reach 24.76");
    expect(ceiling(24.76, 0).needed).toBe(0);
  });

  it("tells a request with 4 copies per arm that it cannot reach 20", () => {
    expect(ceilingText(4)).toBe("With 4 copies per arm the paired score can reach at most 1.9^4 = 13.03. Supported needs 20, so this request cannot prove a cause; 5 or more copies per arm can.");
    expect(ceilingText(5)).toBe("Supported needs a score of 20: at least 5 agreeing pairs.");
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
  it("prefers forks.f1.score when the case file has it", () => {
    const f = { ...f1(demo), score: 30 } as ForkExperiment;
    const r = compare(f, "control", "forced");
    expect(r.source).toBe("case");
    expect(r.score).toBe(30);
    expect(r.level).toBe("supported");
    // Only control vs forced is recorded on the server; other pairings stay derived.
    expect(compare({ ...f1(robot), score: 30 } as ForkExperiment, "placebo", "forced").source).toBe("derived");
  });

  it("goes by the score when the server's level disagrees with it: never supported under 20", () => {
    const low = compare({ ...f1(demo), score: 13.0321, level: "supported" } as ForkExperiment, "control", "forced");
    expect(low.level).toBe("open");
    const high = compare({ ...f1(demo), score: 30, level: "open" } as ForkExperiment, "control", "forced");
    expect(high.level).toBe("supported");
  });

  it("leaves no pairs to come on a stopped fork", () => {
    const f = structuredClone(f1(demo));
    f.status = "stopped";
    delete f.children["control-4"];
    delete f.children["forced-4"];
    delete (f as { arms?: unknown }).arms;
    const r = compare(f, "control", "forced");
    expect(r.ceiling.remaining).toBe(0);
    expect(r.ceiling.max).toBeCloseTo(6.859, 3);
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

  it("finds a claim of cause in both fixtures' sentences, by whole word", () => {
    expect(causeWords(demo.verdict?.sentence)).toBe(true);
    expect(causeWords(robot.verdict?.sentence)).toBe(true);
    expect(causeWords("This would PROVE it")).toBe(true);
    expect(causeWords("This proves skipping dedupe drove the inflation.")).toBe(true);
    expect(causeWords("It is proven.")).toBe(true);
    expect(causeWords("The proof is in the gap.")).toBe(true);
    expect(causeWords("A causal step.")).toBe(true);
    expect(causeWords("Because of the split")).toBe(false);
    expect(causeWords(null)).toBe(false);
  });
});
