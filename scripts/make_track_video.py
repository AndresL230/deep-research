"""Render a video of the humanoid tracking sim: plain playback and the balance-feedback tracker side by side on the
same reference motions, with the reference drawn as a blue ghost.

Every frame is a real episode of the sim (sim/g1/track/episode.py), drawn by MuJoCo's own renderer. The script
writes numbered PNG frames; `scripts/frames_to_mp4.swift` turns them into an H.264 file on a Mac, and with ffmpeg
installed `ffmpeg -framerate 50 -i frames/%05d.png -c:v libx264 -crf 16 -pix_fmt yuv420p out.mp4` does the same.

    uv run python scripts/make_track_video.py --frames /tmp/frames
    swift scripts/frames_to_mp4.swift /tmp/frames 50 exbody2-tracking.mp4
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

FPS = 50
W, H = 1920, 1080
PANEL = W // 2
HOLD = 1.2          # s on the last frame of a segment, with each side's outcome
GHOST = (0.30, 0.60, 1.0, 0.30)
# (motion, set): a calm one both follow, then two demanding ones.
SEGMENTS = [("cmu_26_03_t010", "public"), ("cmu_14_20_t014", "public"), ("cmu_55_03_t026", "hidden")]
SIDES = [("playback", "Plain playback", "sends the clip's joint angles as they are"),
         ("baseline", "With balance feedback", "the same angles, corrected by where the robot really is")]
FONT = "/System/Library/Fonts/HelveticaNeue.ttc"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--frames", type=Path, required=True, help="the folder the PNG frames are written to")
    ap.add_argument("--only", type=int, default=None, help="render only this many frames of each segment (a quick look)")
    args = ap.parse_args()

    import mujoco
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont

    from sim.g1.scene import build_track_model
    from sim.g1.track.episode import run_episode
    from sim.g1.track.motions import duration, load, reference

    model = build_track_model()
    model.vis.global_.offwidth, model.vis.global_.offheight = PANEL, H
    model.vis.quality.offsamples = 8
    renderer = mujoco.Renderer(model, H, PANEL)
    data, ghost = mujoco.MjData(model), mujoco.MjData(model)
    option, perturb = mujoco.MjvOption(), mujoco.MjvPerturb()
    camera = mujoco.MjvCamera()
    camera.type = mujoco.mjtCamera.mjCAMERA_FREE
    camera.lookat[:] = [0.0, 0.0, 0.70]
    camera.distance, camera.azimuth, camera.elevation = 3.0, 160.0, -8.0

    def font(size: int, index: int = 0):
        try:
            return ImageFont.truetype(FONT, size, index=index)
        except OSError:
            return ImageFont.load_default()

    big, mid, small = font(40, 1), font(26), font(22)

    def panel(qpos, ref_qpos) -> "Image.Image":
        data.qpos[:] = qpos
        mujoco.mj_forward(model, data)
        renderer.update_scene(data, camera, option)
        scene = renderer.scene
        first = scene.ngeom
        ghost.qpos[:] = ref_qpos
        mujoco.mj_forward(model, ghost)
        mujoco.mjv_addGeoms(model, ghost, option, perturb, int(mujoco.mjtCatBit.mjCAT_DYNAMIC), scene)
        for i in range(first, scene.ngeom):
            scene.geoms[i].rgba[:] = GHOST
        return Image.fromarray(renderer.render())

    args.frames.mkdir(parents=True, exist_ok=True)
    for old in args.frames.glob("*.png"):
        old.unlink()
    n = 0
    controllers = ROOT / "sim" / "g1" / "track" / "controllers"
    for name, set_name in SEGMENTS:
        motion = load(name, set_name)
        total = int(round((duration(motion) + 1.0) * FPS))
        runs = []
        for controller, _, _ in SIDES:
            result, recording = run_episode(controllers / f"{controller}.py", {"set": set_name, "name": name}, motion_fps=FPS, motion_decimals=6)
            runs.append((result, [f["qpos"] for f in recording["frames"]]))
            print(f"{name:16s} {controller:9s} {'tracked' if result['success'] else 'fell' if result['fell'] else 'off track'}"
                  f"  e_mpkpe {result['e_mpkpe']}  fell_at {result['fell_at']}", flush=True)
        frames = total + int(HOLD * FPS)
        for k in range(frames if args.only is None else min(frames, args.only)):
            t = min(k, total - 1) / FPS
            ref = reference(motion, t)
            page = Image.new("RGB", (W, H))
            draw = ImageDraw.Draw(page, "RGBA")
            for side, ((result, qpos), (_, title, how)) in enumerate(zip(runs, SIDES)):
                # A robot that fell stays where it ended; the reference goes on.
                page.paste(panel(qpos[min(k, len(qpos) - 1)], ref), (side * PANEL, 0))
                x = side * PANEL + 44
                draw.text((x, 40), title, font=big, fill=(255, 255, 255, 255))
                draw.text((x, 92), how, font=small, fill=(255, 255, 255, 190))
                fell = result["fell_at"] is not None and t >= result["fell_at"]
                if fell or k >= total:
                    text = (f"Fell at {result['fell_at']:.1f} s" if result["fell"] else
                            f"Tracked: {result['e_mpkpe'] * 100:.1f} cm from the reference" if result["success"] else "Off track")
                    color = (220, 38, 38, 235) if result["fell"] else (21, 128, 61, 235)
                    box = draw.textbbox((x + 14, 142), text, font=mid)
                    draw.rounded_rectangle((x, box[1] - 9, box[2] + 14, box[3] + 11), 8, fill=color)
                    draw.text((x + 14, 142), text, font=mid, fill=(255, 255, 255, 255))
            draw.line((PANEL, 0, PANEL, H), fill=(0, 0, 0, 255), width=3)
            lead = t < motion["lead_in"]
            note = f"Reference (blue): {motion['description']}  ·  CMU motion capture, fitted to the Unitree G1" + ("  ·  lead-in" if lead else "")
            box = draw.textbbox((0, 0), note, font=small)
            draw.rounded_rectangle(((W - box[2]) / 2 - 18, H - 74, (W + box[2]) / 2 + 18, H - 30), 8, fill=(0, 0, 0, 150))
            draw.text(((W - box[2]) / 2, H - 66), note, font=small, fill=(255, 255, 255, 235))
            draw.text((W - 150, 44), f"{min(t, duration(motion)):4.1f} s", font=mid, fill=(255, 255, 255, 200))
            page.save(args.frames / f"{n:05d}.png", compress_level=1)
            n += 1
    print(f"wrote {n} frames at {FPS} fps to {args.frames}: {n / FPS:.1f} s")


if __name__ == "__main__":
    main()
