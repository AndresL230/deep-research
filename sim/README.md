# sim: the robot domains (pick and place, and humanoid push recovery)

A Franka Panda arm in MuJoCo picks up a can and places it on a zone. Agents write the controller,
claim a success rate, and we test it on can positions they never see. This folder is the simulation
side plus the domain plugin; it does not import anything from `deep_research/`.

## Setup and commands

sim/ keeps its own requirements (`mujoco==4.0.1`, `numpy`) so it does not touch the root project.
The panda model is downloaded, not committed: run `python -m sim.fetch_assets` once (see below).
Run everything from the repo root:

```
python3 -m sim.fetch_assets      # downloads the panda into sim/assets/ (gitignored), checks hashes; safe to rerun
uv run --with-requirements sim/requirements.txt python -m sim.run --controller sim/controllers/baseline.py --can 0.5,0.1 --place 0.4,-0.3 --out motion.json
uv run --with-requirements sim/requirements.txt python -m sim.evaluate --controller sim/controllers/baseline.py --set hidden
uv run --with-requirements sim/requirements.txt python -m sim.evaluate --calibrate
uv run --with-requirements sim/requirements.txt --with pytest pytest sim/tests -q
uv run --with-requirements sim/requirements.txt python -m sim.daytona_check   # needs DAYTONA_API_KEY in .env
```

## Files

| file | what it is | goes to the sandbox |
|---|---|---|
| `scene.py` | builds the model: panda + can + place zone disc | yes |
| `control.py` | helpers controllers import: `ik`, joint limits, gripper values | yes |
| `episode.py` | `run_episode(controller_path, can_xy, place_xy, seed)` and the success rule | yes |
| `motion.py`, `MOTION_FORMAT.md` | the motion file written per episode | yes (code) |
| `practice.py` | the practice setup the agent sees | yes |
| `run.py` | `python -m sim.run` | yes |
| `controllers/template.py` | the skeleton the agent starts from | yes |
| `controllers/baseline.py` | a scripted pick and place that works at the practice spot | no |
| `controllers/one_spot.py`, `spread.py` | calibration controllers: tuned on one spot vs a spread | no |
| `hidden.py` | the hidden evaluation positions (server only) | no |
| `evaluate.py` | `evaluate(controller_path, positions)`, `INFLATED_THRESHOLD`, `--calibrate` | no |
| `domain.py` | the domain plugin: task, prompt, scoring, step labels, interventions, image | no |
| `skills/robot-method-errors/` | method errors the investigator looks for | no |
| `daytona_check.py` | one episode in a real Daytona sandbox | no |
| `fetch_assets.py` | downloads the panda model into `assets/` at a pinned commit | no (the image runs it) |
| `assets/` | the downloaded Menagerie panda (gitignored), linked into each VM from the image | no |

## Where the panda model comes from

`sim/fetch_assets.py` downloads `franka_emika_panda/` from
[MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie) at commit
`370c43965323c0944b433b202aac5058b5f907a9` (2026-11-10), only the files `panda.xml` and `scene.xml`
need, unchanged, and checks each file's sha256. The model is licensed under Apache 2.0; the license
text is in `sim/ASSETS_LICENSE` (a copy of the folder's `LICENSE`). The can and the place zone are
added in code (`sim/scene.py`), not by editing the model files. `lab_image()` runs the same script at
image build time, so the meshes are never uploaded to a VM: `domain.VM_SETUP_COMMANDS` links them in.

`CALIBRATION.md` has the practice vs hidden numbers and how the inflated threshold was picked.

## What a scored run keeps

`domain.score_run` runs the controller on every hidden position and seed (`evaluate(..., record_dir=...)`) and
records each episode at 8 fps with 3 decimals (`motion.LOW_FPS`, `LOW_DECIMALS`: about 10 KB a file), successes too,
into the run's `hidden/` folder on the server (`hidden/<NN>-s<seed>.motion.json`, never in a VM). Its score
(`score.json` and the case file) then has `n_hidden`, `checked_positions` (the can starts of the run's own motion
files, rounded to the millimeter, deduplicated) and `hidden_results`, one `{x, y, seed, result, place_error_cm,
motion}` per hidden episode. `result` is one word from the episode's own flags, by `domain.outcome`, the first that
applies: `placed` (`success`), `dropped` (`dropped`: let go high up away from the zone, or lifted and ended on its
side), `tipped` (ended over 15 degrees from upright without being dropped), else `missed` (upright but not on the
zone, still held, never picked up, or the controller failed).

## The humanoid push recovery domain (`sim/humanoid/`)

Orro's second robot experiment: a Unitree G1 humanoid stands on a floor and gets shoved, a 0.2 s push to the torso.
Agents write the balance controller, try it on the one practice push (a shove from behind, 50 N), and claim how often
the robot stays standing; we push it 20 times from directions and with forces it never tried (25 to 50 N, every
direction). Each episode ends `upright`, `stumbled` (stayed up but a foot slid over 3 cm or the torso went past
10 degrees) or `fell` (pelvis below 0.45 m, or something other than a foot touched the floor). A controller tuned on
the shove from behind leans the robot back and falls to a much weaker shove from the front.

```
python3 -m sim.fetch_assets --model unitree_g1      # the G1 into sim/assets/unitree_g1/ (gitignored), hash checked
uv run --with-requirements sim/requirements.txt python -m sim.humanoid.run --controller sim/humanoid/controllers/baseline.py --angle 180 --force 40 --out front.motion.json
uv run --with-requirements sim/requirements.txt python -m sim.humanoid.evaluate --controller sim/humanoid/controllers/one_spot.py --set hidden
uv run --with-requirements sim/requirements.txt python -m sim.humanoid.evaluate --calibrate
```

| file | what it is | goes to the sandbox |
|---|---|---|
| `humanoid/scene.py` | the G1 scene (Menagerie `unitree_g1/scene.xml`, unchanged) | yes |
| `humanoid/control.py` | helpers: `JOINTS`, `index`, `STAND_CTRL`, joint limits, `FOOT_CORNERS` | yes |
| `humanoid/episode.py` | `run_episode(controller_path, push, seed)`, the push and the measurements | yes |
| `humanoid/outcome.py` | the outcome rule (upright, stumbled, fell, error), no mujoco | yes |
| `humanoid/motion.py` | the `g1-push-motion/1` format (MOTION_FORMAT.md) | yes |
| `humanoid/practice.py`, `humanoid/run.py` | the practice push, `python -m sim.humanoid.run` | yes |
| `humanoid/controllers/template.py` | the skeleton the agent starts from (holds the standing pose) | yes |
| `humanoid/controllers/baseline.py`, `one_spot.py`, `spread.py`, `colleague.py` | calibration controllers | no |
| `humanoid/hidden.py`, `humanoid/evaluate.py` | the hidden pushes, scoring and `--calibrate` | no |
| `humanoid/domain.py`, `humanoid/symptoms.py` | the domain plugin (`deep_research/domains/humanoid_push.py` points at it) | no |
| `humanoid/skills/humanoid-method-errors/` | method errors the investigator looks for | no |
| `humanoid/CALIBRATION.md` | the numbers behind the push range and the threshold | no |

The G1 comes from the same Menagerie commit as the panda: only the 40 files `g1.xml` and `scene.xml` need (35 meshes,
about 19 MB), the 29 joint model without dexterous hands. BSD 3-Clause, Unitree Robotics; the license text is in
`sim/humanoid/ASSETS_LICENSE`. Its lab image (`lab_image()`) downloads it at build time; a batch's VMs come from the
snapshot named by `DAYTONA_HUMANOID_PUSH_SNAPSHOT` (`python -m deep_research.snapshot humanoid_push` builds it once).
