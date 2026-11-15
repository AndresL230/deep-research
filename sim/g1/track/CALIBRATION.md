# Humanoid tracking sim: what was measured

Measured on 15 November 2026 with the controllers in `sim/g1/track/controllers/`, MuJoCo 4.0.1 and the Menagerie
Unitree G1 at the commit pinned in `sim/g1/fetch_assets.py`. Rerun with
`python -m sim.g1.track.evaluate <controller> --motions hidden --seeds 0,1,2`.

## What is ExBody2's and what is ours

ExBody2 (Ji et al., arXiv:2412.13196) trains a whole-body tracking policy for the Unitree G1 on CMU motion capture
clips and measures three tracking errors on motions it trained on and on motions it did not.

| | ExBody2 | Here |
|---|---|---|
| Robot | Unitree G1 | Unitree G1 (MuJoCo Menagerie's model) |
| Task | Track a reference motion with the whole body | The same |
| Errors | E_vel, E_mpkpe, E_mpjpe, upper and lower body | The same three, defined in `episode.py` |
| Motions | CMU MoCap, retargeted, feasible ones kept | CMU MoCap, our own retargeting, **feet planted only** |
| Controller | A policy trained by reinforcement learning | Code written by hand (by an agent) |
| Simulator | IsaacGym | Our own MuJoCo scene |
| Test | Trained-on set and a held-out set | A practice motion and 20 hidden motions |

Nothing of ExBody2's code, data or policy runs here, its retargeted motions were not available to us, and our
numbers are not comparable with its numbers: the motions are easier (no steps, no walking) and the simulator and the
controller are different. What is borrowed is the task, the errors and the idea of the test.

## The three controllers

Every set, seeds 0, 1 and 2:

| Controller | What it does | Public (6) | Hidden (20) | Diagnostic (8) |
|---|---|---|---|---|
| `baseline.py` | The reference's joint angles 0.04 s ahead, with balance feedback on the centre of mass | 18 of 18 | 60 of 60 | 24 of 24 |
| `playback.py` | The reference's joint angles as they are | 9 of 18 | 30 of 60 | 12 of 24 |
| `template.py` | Holds the starting pose | 0 of 18 | 0 of 60 | 0 of 24 |

`playback.py` succeeds on every calm motion and falls on every demanding one, on every seed: that is how the two
kinds are defined. So a controller that is perfect on the practice motion (a calm one) measures 50% on the hidden
motions: the gap a run that only tracked the practice motion would report. A run that tracks the public motions
sees three of its six fail.

## How the motions were chosen

1. 142 CMU clips of mostly standing activities were downloaded (subjects 13, 14, 15, 22, 23, 26, 27, 54, 55, 56,
   62, 64, 79, 80, 86, 113, 114, 124, 141 and 143).
2. Every stretch where both ankles stay within 7 cm of where they were and within 4 cm of the floor was cut into
   pieces of up to 8 seconds: 141 pieces.
3. Each piece was fitted to the robot (`retarget.py`) and run once with `playback.py` and `baseline.py`. On 89
   both succeeded, on 42 only the baseline did, and on 10 neither did. Those 10 were dropped: fast window-washing
   with big weight shifts, punching, and fast twists that the baseline cannot follow either.
4. 74 pieces (at most two calm and three demanding per clip, calm ones with a mean joint speed of at least
   0.15 rad/s) were run with all three controllers and three seeds. 37 came out calm (playback and baseline 3 of
   3), 33 demanding (playback 0 of 3, baseline 3 of 3) and 4 mixed, which were dropped.
5. 34 of those were picked by hand for variety: 6 public, 20 hidden, 8 diagnostic, half of each set demanding. No
   hidden motion is cut from a clip a public motion is cut from.

## The limits

An episode succeeds when the robot never falls, E_mpkpe is at most 0.06 m and E_mpjpe at most 0.05 rad. Over the
74 pieces and three seeds:

- the baseline's largest E_mpkpe on a piece it follows was 0.051 m and its largest E_mpjpe 0.047 rad;
- standing still gave an E_mpjpe of at least 0.128 rad and an E_mpkpe of at least 0.068 m, so it fails every piece.

For comparison only, ExBody2 reports 0.100 m and 0.108 rad for its policy in simulation on full CMU motions, which
include walking. Our limits are tighter because our motions are easier.

## What the fitting does, and what it leaves out

`retarget.py` keeps the feet where the robot stands, lets the pelvis follow the person's (height down to 0.62 m,
sway up to 4 cm to either side, turn up to 0.25 rad), puts the trunk's lean and twist on the waist joints, and has
the arms follow the person's elbows and wrists scaled to the robot's arms. The pelvis is then moved until the
centre of mass is within 2 cm fore and aft and 3.5 cm to either side of the middle of the feet. So:

- no reference steps, walks, jumps or lifts a foot, however the person moved;
- a person's squat is flattened to at most 15 cm, and a sway to 4 cm;
- the shoulders can swing fast where an arm is nearly straight (up to 27 rad/s in one hidden motion), because the
  fit there has more than one answer.

## Not calibrated yet

`INFLATED_THRESHOLD` (0.275) and `UNCLEAR_LOW` (0.12) in `sim/g1/track/evaluate.py` are the arm's. They have not
been checked against real agent runs in this sim: no agent has run in this domain yet, only the scripted demo batch
(`scripts/make_track_preview.py`). The baseline measuring 100% and playback exactly 50% is also a result of how the
motions were chosen, not a finding about agents.
