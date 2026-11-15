# Motion file format (`panda-motion/1`)

A motion file is the recording of one episode of the Panda pick-and-place sim. It is a single compact
JSON object (UTF-8, no NaN or Infinity), at most 200,000 bytes (`sim.motion.MAX_BYTES`). It is written by
`sim.motion.write_motion`, read by `sim.motion.read_motion` and checked by `sim.motion.validate_motion`,
which returns a list of problems (empty when the file is fine).

## Top level

```json
{
  "format": "panda-motion/1",
  "header": {...},
  "frames": [{...}, ...],
  "result": {...}
}
```

| key | type | meaning |
| --- | --- | --- |
| `format` | string | always `"panda-motion/1"` |
| `header` | object | static information about the episode |
| `frames` | array | state snapshots in time order, at least one |
| `result` | object | the episode result dict from `sim.episode.run_episode` (see below) |

## Header

| key | type | meaning |
| --- | --- | --- |
| `model_id` | string | scene id, `"panda-can-v1"` (`sim.scene.MODEL_ID`). The viewer can rebuild the same scene from it |
| `joint_names` | string[] | every joint in qpos order: `joint1` .. `joint7`, `finger_joint1`, `finger_joint2`, `can_joint` (10 names; `can_joint` is a freejoint and takes 7 qpos slots) |
| `actuator_names` | string[] | `actuator1` .. `actuator8`, in `ctrl` order |
| `can_start` | [x, y] | nominal can start position, meters (the actual start includes seed noise; it is the first frame's `can_pos`) |
| `place_target` | [x, y] | center of the place zone, meters |
| `fps` | int | nominal frame rate, a whole number from 1 to 30: 30 for the agents' own runs, 8 (`sim.motion.LOW_FPS`) for the small recordings the server keeps of every evaluation episode |
| `nq` | int | length of every `qpos`, 16 |

Extra header keys written by the current recorder (readers must not require them): `nu` (8),
`qpos_layout` (a human readable note), `seed`, `dt` (1/fps).

## Frames

Each frame is an object:

| key | type | meaning |
| --- | --- | --- |
| `t` | number | sim time in seconds |
| `qpos` | number[nq] | all joint positions, layout below |
| `ctrl` | number[8] | actuator commands in force at that moment: 7 arm joint angle targets (radians) then gripper (0 closed .. 255 open) |
| `hand` | number[3] | world xyz of the grasp point (0.105 m below the hand body, between the fingertips) |
| `can_pos` | number[3] | world xyz of the can center (copy of `qpos[9:12]`) |
| `can_quat` | number[4] | can orientation quaternion w, x, y, z (copy of `qpos[12:16]`) |

qpos layout (nq = 16):

| index | joint | unit |
| --- | --- | --- |
| 0..6 | `joint1` .. `joint7` (arm, hinge) | radians |
| 7, 8 | `finger_joint1`, `finger_joint2` (slide, each 0 .. 0.04) | meters |
| 9, 10, 11 | `can_joint` position x, y, z | meters |
| 12..15 | `can_joint` orientation quaternion w, x, y, z | |

Sampling: the recorder checks after every physics step (0.002 s) and takes a frame whenever the sim
time reaches the next multiple of 1/fps s, so consecutive `t` values differ by about 1/fps s (each `t`
is up to one physics step after the ideal time). The first frame is at `t = 0` (state before the
first action) and the last frame is always the final state of the episode, so the final gap can be
shorter. Viewers should interpolate on `t` rather than assume an exact spacing. A 10 s episode has
about 301 frames and takes about 90 KB at 30 fps; at 8 fps it has about 81 frames and takes about 20 KB.

Numbers are rounded to 4 decimal places (3 in the 8 fps recordings, `sim.motion.LOW_DECIMALS`: 1 mm, 0.001 rad). The world frame has z up, the robot base at the origin and
the floor at z = 0. The can is a cylinder of radius 0.025 m and half height 0.05 m (standing upright
its center is at z = 0.05). The place zone is a flat disc of radius 0.05 m centered on `place_target`.

## Result

The `result` object is exactly what `run_episode` returns. Keys always present:

| key | type | meaning |
| --- | --- | --- |
| `success` | bool | can within 3 cm of the target (horizontal), upright, resting, and no exception |
| `place_error_cm` | number or null | final horizontal distance from can center to place target, cm |
| `upright` | bool | can axis within 15 degrees of vertical at the end |
| `dropped` | bool | lost finger contact while its bottom was over 3 cm above the floor and over 3 cm from the target, or was lifted over 1 cm and ended not upright |
| `max_height_cm` | number | highest can center height above its start height, cm |
| `time_taken` | number | sim seconds when the episode stopped |
| `exception` | string or null | `"TypeName: message"` plus a short traceback tail when the controller failed |
| `can_start`, `place_target` | [x, y] | as in the header |
| `seed` | int | episode seed |
| `end_reason` | string | `settled`, `controller_done`, `max_time`, `out_of_bounds`, `exception` or `physics_error` |
| `resting` | bool | can still, standing on the floor and not touching the robot |
| `released` | bool | can not touching any robot part at the end |
| `tipped` | bool | not `upright` |
| `tilt_deg` | number | final angle of the can axis from vertical, degrees |
| `final_can_pos` | number[3] or null | final can center |
| `can_start_actual` | number[3] | can center at t = 0 after seed noise |

## Example (abridged)

```json
{"format":"panda-motion/1",
 "header":{"model_id":"panda-can-v1",
   "joint_names":["joint1","joint2","joint3","joint4","joint5","joint6","joint7","finger_joint1","finger_joint2","can_joint"],
   "actuator_names":["actuator1","actuator2","actuator3","actuator4","actuator5","actuator6","actuator7","actuator8"],
   "can_start":[0.5,0.0],"place_target":[0.45,-0.3],"fps":30,"nq":16,"nu":8,"seed":0,"dt":0.033333},
 "frames":[{"t":0.0,"qpos":[-0.0046,-0.0048,0.0031,-1.5667,0.0011,1.5731,-0.7849,0.04,0.04,0.5008,-0.0014,0.05,1.0,0.0,0.0,0.0],
            "ctrl":[0.0,0.0,0.0,-1.5708,0.0,1.5708,-0.7853,255.0],"hand":[0.5546,-0.0006,0.5243],
            "can_pos":[0.5008,-0.0014,0.05],"can_quat":[1.0,0.0,0.0,0.0]}],
 "result":{"success":true,"place_error_cm":0.81,"upright":true,"dropped":false,"max_height_cm":12.88,
           "time_taken":7.24,"exception":null,"can_start":[0.5,0.0],"place_target":[0.45,-0.3],"seed":0,
           "end_reason":"controller_done"}}
```

# Humanoid motion files (`g1-motion/1`)

The push recovery sim (`sim/humanoid/`) records its episodes in a sibling format: the same file rules (one compact
JSON object, at most `sim.motion.MAX_BYTES`, written and read by `sim.motion`'s `write_motion` and `read_motion`, the
same frame sampling, the same `fps` and rounding, 30 fps and 4 decimals for the agents' runs, 8 fps and 3 decimals for
the hidden episodes the server keeps), with its own keys. `sim.humanoid.motion.validate_motion` checks it. A reader
tells the two apart by `format`, or by `header.model_id` (`deep_research/robot_view.py` builds the model it names).

## Header

| key | type | meaning |
| --- | --- | --- |
| `model_id` | string | `"g1-push-v1"` (`sim.humanoid.scene.MODEL_ID`) |
| `joint_names` | string[] | every joint in qpos order: `floating_base_joint` (7 qpos slots), then the 29 hinge joints |
| `actuator_names` | string[] | the 29 joint position servos, in `ctrl` order (`sim.humanoid.control.JOINTS`) |
| `push` | object | `{"angle_deg", "force_n", "time_s", "duration_s"}`: the push's direction (degrees counterclockwise from the robot's forward, +x; 0 pushes it forward), force in newtons, actual start (with seed noise) and length in seconds |
| `fps` | int | as above |
| `nq` | int | 36 |

Extra keys written by the recorder: `nu` (29), `qpos_layout`, `seed`, `dt`. There is no `can_start` or
`place_target`.

## Frames

| key | type | meaning |
| --- | --- | --- |
| `t` | number | sim time in seconds |
| `qpos` | number[36] | pelvis position xyz (meters), pelvis quaternion wxyz, then the 29 joint angles (radians) |
| `ctrl` | number[29] | the joint target angles in force at that moment |
| `com` | number[3] | world xyz of the robot's center of mass |
| `feet` | number[6] | world xyz of the left ankle, then of the right one (the feet's origins) |

A 5 s episode at 30 fps has 151 frames and takes about 70 KB; at 8 fps about 15 KB. A fall ends the episode 1 s after
it is detected, so such a file is shorter.

## Result

What `sim.humanoid.episode.run_episode` returns: `success` (not fell and no exception), `outcome` (`upright`,
`stumbled`, `fell` or `error`, the rule in `sim/humanoid/outcome.py`), `fell`, `stumbled`, `fall_time`, `touched` (the
first body other than a foot that touched the floor, or null), `max_tilt_deg`, `final_tilt_deg` (torso from vertical),
`max_foot_shift_cm`, `min_pelvis_height`, `push` (as in the header), `push_time`, `seed`, `time_taken`, `exception` and
`end_reason` (`max_time`, `fell`, `exception` or `physics_error`).
