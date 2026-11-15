// The investigator's science in a replay (replay.ts `caseAt`): the sections suspects.ts reads, as they stood `t`
// seconds in. Pure, from the final case file and the schedule replay.ts already built.
//
//   candidates      once the split is found (`readyAt`)
//   suspects        once the investigator starts; each is `proposed` until its first experiment is approved,
//                   `testing` while one runs, and takes its final status once its last experiment is done
//   evidence        per suspect, over the experiments done by `t`, scored by the 6.4 rule
//   forks.<id>      `pairs`, `score`, `p_exact` and `level` only once that experiment is done
//   forks.pending   the synthesized request gains the experiment's suspect, change, prediction and pairs
//   interaction, audit, lessons, investigator   only at the end (the final case file), like the verdict
import type { CaseFile, ForkExperiment, PendingForks, SuspectEvidence } from "../api";
import { isPendingForks } from "../api";
import type { ReplaySchedule } from "./replay";
import { levelOf, scoreOf, type SuspectPending, type SxCase } from "./suspects";

type Forks = Record<string, ForkExperiment | PendingForks>;
const LATE = ["pairs", "score", "p_exact", "level"] as const;

/** The sections to add to `caseAt`'s case before the end, and `forks` patched in place. */
export function scienceAt(full: CaseFile, s: ReplaySchedule, t: number, forks: Forks): Partial<SxCase> {
  const real = Object.values(full.forks).filter((f): f is ForkExperiment => !isPendingForks(f));
  const slotOf = (id: string) => { const i = real.findIndex((f) => f.id === id); return i >= 0 ? s.forks[i] : undefined; };
  const done = (id: string): boolean => { const sl = slotOf(id); return !!sl && t >= sl.doneAt; };

  // Forks: the paired numbers only once their copies are scored; a pending request with what it asks.
  for (const [id, f] of Object.entries(forks)) {
    if (isPendingForks(f)) continue;
    if (!done(id)) { const g = { ...f } as Record<string, unknown>; for (const k of LATE) delete g[k]; forks[id] = g as unknown as ForkExperiment; }
  }
  const p = forks.pending as SuspectPending | undefined;
  if (p && isPendingForks(p) && !p.suspect_id) {
    const next = real.find((f) => { const sl = slotOf(f.id); return !!sl && t >= sl.approvalStart && t < sl.rebuildAt; });
    if (next?.suspect_id) {
      forks.pending = {
        ...p, suspect_id: next.suspect_id, change: next.change ?? null, anchor: next.anchor ?? null, source_run: next.source_run,
        prediction: next.prediction ?? null, pairs: next.pairs_requested ?? next.n_per_arm, reason: next.reason ?? null,
      } as SuspectPending;
    }
  }

  const out: Partial<SxCase> = {};
  if (full.candidates && t >= s.readyAt) out.candidates = full.candidates;
  const sus = (full as SxCase).suspects;
  const start = s.hypothesesAt[0] ?? s.investigateStart;
  if (sus?.length && start != null && t >= start) {
    out.suspects = sus.map((x) => {
      const exps = real.filter((f) => f.suspect_id === x.id);
      if (!exps.length) return x;
      const begun = exps.some((f) => { const sl = slotOf(f.id); return !!sl && t >= sl.rebuildAt; });
      return exps.every((f) => done(f.id)) ? x : { ...x, status: begun ? "testing" : "proposed" };
    });
  }
  const ev: Record<string, SuspectEvidence> = {};
  for (const [id, e] of Object.entries(full.evidence ?? {})) {
    const exps = real.filter((f) => f.suspect_id === id && done(f.id));
    if (!exps.length) continue;
    if (exps.length === real.filter((f) => f.suspect_id === id).length) { ev[id] = e; continue; }
    const agree = exps.flatMap((f) => (f.pairs ?? []).map((q) => q.agree));
    const score = scoreOf(agree);
    ev[id] = { ...e, pairs: agree.length, agree: agree.filter(Boolean).length, score, level: levelOf(score, agree.length), experiments: exps.map((f) => f.id) };
  }
  if (Object.keys(ev).length) out.evidence = ev;
  return out;
}
