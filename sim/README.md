# sim: the robot pick and place domain

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
