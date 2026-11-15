"""Build the reference motions of the humanoid tracking domain from CMU motion capture clips.

Each reference is a stretch of a CMU clip where the person's feet stay planted, fitted onto the Unitree G1 by
`sim/g1/track/retarget.py` and written to `sim/g1/track/motions/<set>/<name>.json`. The table below fixes which
stretch goes to which set and what kind it is, so running this again writes the same files.

How the table was made (sim/g1/track/CALIBRATION.md has the numbers): every planted stretch of 142 clips was cut
into pieces of up to 8 seconds and fitted; each piece was then run in the sim with three controllers and three
seeds. A piece is "calm" when plain playback of its joint angles succeeds on every seed, "demanding" when plain
playback fails on every seed and the tracker with balance feedback (`controllers/baseline.py`) succeeds on every
seed. Pieces that are neither were left out, as were pieces the tracker cannot follow.

The clips come from mocap.cs.cmu.edu (free for all uses; the database was created with funding from NSF
EIA-0196217). They are downloaded on first use into `sim/assets/cmu_mocap/`, which is not committed.

    uv run python scripts/make_track_motions.py                  # download what is missing, write every set
    uv run python scripts/make_track_motions.py --source DIR     # read NN.asf and NN_TT.amc from DIR instead
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

CMU = "http://mocap.cs.cmu.edu/subjects/{subject}/{file}"
CACHE = ROOT / "sim" / "assets" / "cmu_mocap"

# What each clip is, in CMU's own index's words.
CLIPS = {
    "13_21": "wash windows",
    "13_29": "jumping jacks, side twists, bend over, squats",
    "14_06": "jumping jacks, jog, squats, side twists, stretches",
    "14_14": "jumping jacks, jog, squats, side twists, stretches",
    "14_20": "jumping jacks, side twists, reach up, bend over",
    "14_24": "direct traffic, wave, point",
    "15_04": "wash windows, paint; hand signals; dance",
    "15_05": "wash windows, paint; hand signals; dance",
    "15_08": "hand signals: horizontally revolve forearms",
    "15_11": "wash windows, paint figure eights; hand signals",
    "26_02": "basketball signals",
    "26_03": "nursery rhyme: I'm a little teapot",
    "26_04": "nursery rhyme: I'm a little teapot",
    "26_08": "nursery rhyme: Cock Robin",
    "27_02": "basketball signals",
    "27_03": "nursery rhyme: I'm a little teapot",
    "27_05": "nursery rhyme: Cock Robin",
    "27_06": "basketball signals",
    "27_10": "nursery rhyme: Cock Robin",
    "54_16": "superhero",
    "55_03": "genie",
    "56_02": "vignettes: fists up, wipe window",
    "62_24": "bolt tightening",
    "62_25": "bolt loosening, wrench",
    "79_17": "playing violin",
    "79_44": "washing a window",
    "80_14": "teaching",
    "80_50": "cleaning window",
    "86_04": "walking, stretching, punching, chopping",
    "86_08": "walking, squats, stretching, kicking",
    "113_23": "stretch and yawn",
    "113_29": "yoga",
    "114_03": "range of motion",
}

# (clip, start in seconds, seconds, kind) per set.
SETS = {
    "public": [
        ("26_03", 10.5, 8.0, "calm"),
        ("15_04", 26.0, 8.0, "calm"),
        ("54_16", 0.4, 8.0, "calm"),
        ("14_20", 14.4, 8.0, "demanding"),
        ("86_04", 22.0, 8.0, "demanding"),
        ("27_10", 24.5, 8.0, "demanding"),
    ],
    "diagnostic": [
        ("15_05", 13.1, 8.0, "calm"),
        ("26_04", 0.2, 8.0, "calm"),
        ("56_02", 3.7, 8.0, "calm"),
        ("27_06", 0.2, 8.0, "calm"),
        ("15_08", 12.1, 8.0, "demanding"),
        ("86_04", 8.6, 8.0, "demanding"),
        ("27_05", 0.2, 8.0, "demanding"),
        ("62_24", 3.2, 8.0, "demanding"),
    ],
    "hidden": [
        ("113_23", 0.2, 8.0, "calm"),
        ("114_03", 0.2, 8.0, "calm"),
        ("14_06", 19.6, 8.0, "calm"),
        ("14_14", 19.1, 8.0, "calm"),
        ("15_11", 0.2, 8.0, "calm"),
        ("26_02", 0.2, 8.0, "calm"),
        ("26_08", 0.2, 8.0, "calm"),
        ("27_02", 21.5, 8.0, "calm"),
        ("79_17", 0.2, 6.3, "calm"),
        ("80_50", 0.2, 8.0, "calm"),
        ("113_29", 28.2, 5.6, "demanding"),
        ("13_21", 30.3, 5.8, "demanding"),
        ("13_29", 32.0, 6.0, "demanding"),
        ("14_24", 17.2, 5.7, "demanding"),
        ("27_03", 9.7, 8.0, "demanding"),
        ("55_03", 26.1, 8.0, "demanding"),
        ("62_25", 1.8, 8.0, "demanding"),
        ("79_44", 0.2, 6.7, "demanding"),
        ("80_14", 3.7, 7.2, "demanding"),
        ("86_08", 53.3, 6.3, "demanding"),
    ],
}


def motion_name(clip: str, start: float) -> str:
    return f"cmu_{clip}_t{int(round(start)):03d}"


def clip_files(clip: str, source: Path | None) -> tuple[Path, Path]:
    """The skeleton and the clip file, from `source` or the cache, downloaded when the cache has not got them."""
    subject = clip.split("_")[0]
    out = []
    for name in (f"{subject}.asf", f"{clip}.amc"):
        if source is not None:
            path = source / name
            if not path.is_file():
                raise FileNotFoundError(f"{path} is missing")
        else:
            path = CACHE / name
            if not path.is_file():
                CACHE.mkdir(parents=True, exist_ok=True)
                url = CMU.format(subject=subject, file=name)
                print(f"  downloading {url}")
                with urllib.request.urlopen(url, timeout=120) as r, path.open("wb") as f:  # noqa: S310 - a fixed http host
                    shutil.copyfileobj(r, f)
        out.append(path)
    return out[0], out[1]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--source", type=Path, default=None, help="a folder with CMU's .asf and .amc files")
    args = ap.parse_args()

    from sim.g1.track import retarget
    from sim.g1.track.motions import FPS, LEAD_IN, MOTIONS_DIR, to_file

    fitter = retarget.make_fitter()
    for set_name, pieces in SETS.items():
        folder = MOTIONS_DIR / set_name
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir(parents=True)
        for clip, start, seconds, kind in pieces:
            asf, amc = clip_files(clip, args.source)
            qpos = retarget.fit_clip(asf, amc, start, seconds, fitter, FPS)
            name = motion_name(clip, start)
            motion = {"name": name, "kind": kind, "description": CLIPS[clip], "fps": FPS, "lead_in": LEAD_IN, "qpos": qpos,
                      "source": {"dataset": "CMU Graphics Lab Motion Capture Database", "clip": clip, "start_s": start, "seconds": seconds}}
            path = folder / f"{name}.json"
            path.write_text(json.dumps(to_file(motion), separators=(",", ":")) + "\n")
            print(f"{set_name:10s} {name:18s} {kind:9s} {len(qpos):4d} frames {path.stat().st_size // 1000:3d} KB  {CLIPS[clip]}")


if __name__ == "__main__":
    main()
