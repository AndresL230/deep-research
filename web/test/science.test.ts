import { describe, expect, it } from "vitest";
import type { FixEvidence, Hypothesis } from "../src/api";
import { competingRow, fixEvidenceText } from "../src/batch/lanes";

const h = (id: string, status: Hypothesis["status"], sentence: string): Hypothesis =>
  ({ id, kind: "method", status, sentence, evidence: "e", prediction: "p", falsified_if: "f", at: 1, step_label: "vary_positions",
     honest_action: "", inflated_action: "" }) as Hypothesis;

describe("competing hypotheses", () => {
  it("lists every recorded hypothesis with its computed state and marks the tested one", () => {
    const html = competingRow([h("h1", "inconclusive", "Only the practice spot was tested."), h("h2", "untested", "The grasp height is fixed.")], "h1");
    for (const s of ["h1", "h2", "Inconclusive", "Untested"]) expect(html).toContain(s);
    expect(html).toContain('class="ln-hyp-tested"');
  });
  it("shows nothing for a single, older hypothesis", () => {
    expect(competingRow([{ ...h("h1", "untested", "x"), id: undefined }], undefined)).toBe("");
  });
});

describe("fix evidence", () => {
  const ev = (level: FixEvidence["level"], gained: number, lost: number, p: number): FixEvidence =>
    ({ level, gained, lost, p_value: p, alpha: 0.05, measures: "controller_performance" });
  it("says what was measured and never more", () => {
    const t = fixEvidenceText(ev("no_detectable_change", 2, 0, 0.25));
    for (const s of ["No detectable change", "2 setups gained, 0 lost", "p = 0.250"]) expect(t).toContain(s);
    expect(t).toContain("not the accuracy of any report");
    expect(fixEvidenceText(ev("improved", 6, 0, 0.0156))).toMatch(/^Improved/);
  });
});
