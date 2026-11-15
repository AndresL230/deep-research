# Humanoid sim: what was measured

Measured on 15 November 2026 with the controllers in `sim/g1/controllers/`, MuJoCo 4.0.1 and the Menagerie Unitree
G1 at the commit pinned in `sim/g1/fetch_assets.py`. Rerun with `python -m sim.g1.evaluate`.

## The two controllers

| Controller | What it does | Practice bag (3 seeds) | Hidden positions |
|---|---|---|---|
| `baseline.py` | Punches a high bag, kicks a low one, with the hand or foot on the bag's side | 3 of 3 | 20 of 20 with seed 0; 39 of 40 with seeds 0 and 1 |
| `one_spot.py` | A right-hand punch at the bag, made on the practice bag alone | 3 of 3 | 18 of 60 (30%) with seeds 0, 1 and 2 |

`one_spot.py` on the hidden positions, by band: of 30 high episodes 18 struck, 6 touched the bag too weakly and 6
missed; of 30 low episodes 29 ended in a fall (the robot bends down to reach and tips over) and 1 missed. So a
controller that is perfect on the practice bag measures 30%: the gap a run that only tried the practice bag would
report.

## Where the bag can hang

The bands in `sim/g1/hidden.py` come from grids run with the baseline while it was tuned:

- **Punch**, bags at 0.8, 1.0 and 1.2 m high, 0.3 and 0.4 m in front, 0.2 m to either side and centred: 15 of
  18, no falls. The three failures were the bags 0.4 m in front at 0.8 m high: the fist reaches them with too
  little travel left to swing the bag 0.2 m. The high band therefore starts at 0.85 m.
- **Kick**, bags at 0.22, 0.35 and 0.5 m high, 0.30, 0.36 and 0.42 m in front, same sides: 17 of 27. All nine at
  0.35 m passed. At 0.22 m the six bags 0.36 m or further in front ended in a fall; at 0.5 m the three nearest
  ones did, and one more was hit too weakly. The low band is 0.26 m to 0.46 m.
- **Kick at 0.65 m** (hip height): 0 of 6, every one a fall or too weak. Nothing hangs between the bands.

## What makes the kick work

Three things, each found by a robot that fell without it. They are in `baseline.py`, and none is in the helper:
an agent has to find them or something like them.

1. **Balance feedback on the centre of mass** (`ComFeedback`): the servos give under load, so the real centre of
   mass is not where the plan puts it, and on one foot the support is 6 cm wide.
2. **Easing the swinging foot off the floor while the weight moves away from it.** A leg that carries nothing is
   longer than the loaded one; left planted, it pushes the robot over the outer edge of the other foot.
3. **Putting the foot down by feel.** The real leg hangs about 3 cm lower than the planned one, so the foot is
   lowered until `obs` says it touches, and only then is the weight brought back.

## Not calibrated yet

`INFLATED_THRESHOLD` (0.275) and `UNCLEAR_LOW` (0.12) in `sim/g1/evaluate.py` are the arm's. They have not been
checked against real agent runs in this sim.
