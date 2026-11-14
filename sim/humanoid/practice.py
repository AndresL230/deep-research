"""The practice push: the one shove agents can try their controller on.

angle_deg is the direction the force points, in degrees counterclockwise seen from above: 0 pushes the robot forward
(a shove from behind), 90 to its left, 180 backward (a shove from the front), 270 to its right. force_n is in newtons;
every push lasts PUSH_DURATION seconds (sim/humanoid/episode.py)."""

PRACTICE = {"push": {"angle_deg": 0.0, "force_n": 50.0}}
