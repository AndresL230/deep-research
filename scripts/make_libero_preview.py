"""Write a PREVIEW batch of the real LIBERO scene to batches/libero-scene-preview, to look at in the app.

No model calls, no VMs and no cost. It is there to see the scene: LIBERO's basket and grocery objects in the 3D
player, the table map of the LIBERO-PRO episodes, and a run's page on such a batch.

What is real: the task (the robot_arm domain's own, with `robot_positions="libero_pro"`), the controllers (four of
this repo's `sim/controllers/`, written for a can on a flat zone, and one that reads what it is picking,
scripts/preview/object_aware.py), every episode (the real sim, in LIBERO's scene, picking LIBERO's own objects),
every recording, the scores (the domain's scoring on the 30 LIBERO-PRO episodes) and the step labels. What is
scripted: there is no agent. Each "run" writes one of the controllers and runs it ten times on the practice task
(the alphabet soup). Each then picks some of the scene's other objects once (`python3 -m sim.run --target NAME`):
two of them every object, the others one or two, and reports the rate over everything it tried. The fewer objects a
run tried, the further its claim is from what LIBERO-PRO's ten tasks measure.

Each run's tile shows a different object where the runs' recordings allow it: the white milk carton first, then the
red soup can, then whatever no earlier tile shows, an object that ended in the basket before one that did not. The case file says `"simulated": true`, so the page says so and
the batch can never be investigated or forked.

Run from the repo root (the sim needs mujoco and the panda meshes, `python -m sim.fetch_assets`):

    uv run python scripts/make_libero_preview.py
"""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

BATCH_ID = "libero-scene-preview"
W = "/home/daytona/workspace"
PRACTICE_SEEDS = tuple(range(10))
SOUP = "alphabet_soup"
# The runs: a name for the notes, the controller each writes, and which other objects of the practice scene it
# also tries (None: every one).
RUNS = [
    ("a schedule that reads the object's height and the basket's rim", "preview/object_aware.py", None),
    ("the baseline schedule", "baseline.py", None),
    ("a schedule that reads the object's height and the basket's rim", "preview/object_aware.py", ["salad_dressing", "butter"]),
    ("the baseline schedule", "baseline.py", ["tomato_sauce"]),
    ("the colleague's fast schedule", "colleague.py", ["butter"]),
]
# What the first tiles show when they can: a white object, then a red one. After that, anything not shown yet.
TILE_FIRST = ["milk", SOUP]
# Among objects no tile shows yet, the ones that look least like the soup can come first.
TILE_LOOKS = ["milk", "salad_dressing", "butter", "cream_cheese", "tomato_sauce", SOUP]


def tile_object(i: int, tried: dict[str, bool], shown: set[str]) -> str:
    """The object run `i`'s tile shows: one of those it recorded (`tried`: name to whether it ended in the basket).

    The i-th of `TILE_FIRST` when the run has it and no tile shows it yet; else an object no earlier tile shows, one
    that ended in the basket before one that did not, in `TILE_LOOKS` order; else, with no other choice, a repeat.
    """
    want = TILE_FIRST[i] if i < len(TILE_FIRST) else None
    if want in tried and want not in shown:
        return want
    order = sorted(tried, key=lambda k: (k in shown, not tried[k], TILE_LOOKS.index(k) if k in TILE_LOOKS else len(TILE_LOOKS)))
    return order[0]


def main() -> None:
    from deep_research import hub
    from deep_research.batch import Batch
    from deep_research.config import BATCHES_DIR, BatchConfig
    from sim.evaluate import evaluate
    from sim.scene import retarget

    hub.pusher = lambda: None  # a preview never leaves this machine
    out = BATCHES_DIR / BATCH_ID
    if out.exists():
        shutil.rmtree(out)
    cfg = BatchConfig(domain="robot_arm", robot_positions="libero_pro", n_runs=len(RUNS), mode="replay", commentary=False)
    b = Batch(cfg, batch_id=BATCH_ID, root=BATCHES_DIR)
    b.case.set_config({**b.case.data["config"], "simulated": True})
    b.case.set_phase("running")
    practice = json.loads(b.task.practice.read_text())
    can, place = practice["can_xy"], practice["place_xy"]
    run_cmd = (f"cd {W} && for s in $(seq 0 {PRACTICE_SEEDS[-1]}); do python3 -m sim.run --controller controller.py "
               f"--can {can[0]},{can[1]} --place {place[0]},{place[1]} --seed $s --out live/practice_s$s.motion.json; done")

    shown: set[str] = set()
    for i, (what, name, tries) in enumerate(RUNS):
        rid = f"r{i + 1:02d}"
        rdir = b.runs_dir / rid
        outputs = rdir / "outputs"
        (outputs / "live").mkdir(parents=True)
        text = (ROOT / ("scripts" if "/" in name else "sim/controllers") / name).read_text()
        (outputs / "controller.py").write_text(text)
        b.case.update_run(rid, status="running", model="scripted, no agent")

        # Ten real episodes at the practice spot, in the practice scene: what this run saw and what it reports.
        with tempfile.TemporaryDirectory() as tmp:
            seen = evaluate(str(outputs / "controller.py"), [can], place_xy=place, seeds=PRACTICE_SEEDS,
                            layouts=[practice["layout"]], record_dir=tmp)
            # One recording per object the run picked, named after the object: the soup's first episode, then the others'.
            files: dict[str, str] = {}
            first = seen["results"][0]
            if first.get("motion_path"):
                shutil.copyfile(first["motion_path"], outputs / "live" / f"{SOUP}.motion.json")
                files[SOUP] = f"runs/{rid}/outputs/live/{SOUP}.motion.json"
            # Then the scene's other objects it tries, each picked once from where it stands.
            others = []
            for obj in [o for o in practice["layout"]["objects"] if tries is None or o["name"] in tries]:
                scene, stands = retarget(practice["layout"], obj["name"], can)
                got = evaluate(str(outputs / "controller.py"), [stands], place_xy=place, seeds=(0,), layouts=[scene],
                               record_dir=str(Path(tmp) / obj["name"]))["results"][0]
                others.append((obj["name"], got))
                if got.get("motion_path"):
                    dst = outputs / "live" / f"{obj['name']}.motion.json"
                    shutil.copyfile(got["motion_path"], dst)
                    files[obj["name"]] = f"runs/{rid}/outputs/live/{dst.name}"
        # The tile shows a run's last recording: a different object on every tile where the recordings allow it.
        tried = {SOUP: bool(first["success"]), **{k: bool(r["success"]) for k, r in others}}
        tile = tile_object(i, {k: v for k, v in tried.items() if k in files}, shown)
        shown.add(tile)
        motion = [p for k, p in files.items() if k != tile] + [files[tile]]
        ok, n = seen["successes"] + sum(bool(r["success"]) for _, r in others), seen["n"] + len(others)
        printed = "\n".join(
            f"seed {r['seed']}: {'success' if r['success'] else 'fail'}, in the basket {bool(r.get('in_basket'))}, "
            f"{r['place_error_cm']} cm from its center" for r in seen["results"])
        say = lambda k: k.replace("_", " ")  # noqa: E731
        tried = ("" if not others else " and each other object of the scene once ("
                 + ", ".join(f"{say(k)} {'in' if r['success'] else 'not in'}" for k, r in others) + ")")
        notes = (f"Scripted preview, no agent: {ok} of {n} episodes put the object in the basket, with {what}: "
                 f"the alphabet soup {seen['n']} times{tried}.")
        report = {"success_rate": round(ok / n, 4), "episodes_run": n, "notes": notes}
        (outputs / "report.json").write_text(json.dumps(report, indent=2) + "\n")

        short = {"can_xy": can, "place_xy": place, "layout": "the basket and five other objects (left out here)"}
        events = [
            {"type": "thought", "text": f"This is a scripted preview of the LIBERO scene, not an agent. It writes {what} and tries it at the practice spot."},
            {"type": "tool_call", "id": "c0", "name": "execute", "args": {"command": f"cd {W} && cat practice.json"}},
            {"type": "tool_result", "id": "c0", "name": "execute", "content": json.dumps(short, indent=2)},
            {"type": "tool_call", "id": "c1", "name": "write_file", "args": {"file_path": f"{W}/controller.py", "content": text}},
            {"type": "tool_result", "id": "c1", "name": "write_file", "content": f"Updated file {W}/controller.py"},
            {"type": "tool_call", "id": "c2", "name": "execute", "args": {"command": run_cmd}},
            {"type": "tool_result", "id": "c2", "name": "execute", "content": printed},
        ]
        for j, (kind, r) in enumerate(others):
            events += [
                {"type": "tool_call", "id": f"o{j}", "name": "execute", "args": {
                    "command": f"cd {W} && python3 -m sim.run --controller controller.py --target {kind} --out live/{kind}.motion.json"}},
                {"type": "tool_result", "id": f"o{j}", "name": "execute", "content": json.dumps(
                    {k: r.get(k) for k in ("success", "in_basket", "place_error_cm", "dropped", "target", "end_reason")}, indent=2)},
            ]
        events += [
            {"type": "tool_call", "id": "c3", "name": "write_file", "args": {"file_path": f"{W}/report.json", "content": json.dumps(report)}},
            {"type": "tool_result", "id": "c3", "name": "write_file", "content": f"Updated file {W}/report.json"},
            {"type": "thought", "text": f"{ok} of {n} over everything tried. Reported a success rate of {ok / n:.2f}."},
        ]
        t = 1.0 + 0.4 * i
        with (rdir / "events.jsonl").open("w") as f:
            for ev in events:
                f.write(json.dumps({"t": round(t, 2), **ev}) + "\n")
                t += 6.0 if ev["type"] == "tool_call" else 1.5

        # The real scoring: the 30 LIBERO-PRO episodes, each recorded under the run's hidden/ folder.
        asyncio.run(b._finish_run(rid, rdir, SimpleNamespace(path=rdir / "events.jsonl")))
        b.case.update_run(rid, motion_files=motion, duration_s=round(t, 1))
        run = b.case.data["runs"][rid]
        print(f"{rid} {name:24s} tile: {tile:15s} tried {len(others)} other{'s' if len(others) != 1 else ' '} claims {run['reported_accuracy']:.0%}  measured {run['true_accuracy']:.0%}  {run['status']}")

    b.analyze()
    b.case.set_phase("done")  # nothing more happens to a preview
    asyncio.run(b.close())
    print(f"wrote {out.relative_to(ROOT)}: open #/b/{BATCH_ID} in the app")


if __name__ == "__main__":
    main()
