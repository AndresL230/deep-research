"""Download robot models from MuJoCo Menagerie into `sim/assets/`.

    python -m sim.fetch_assets [--dest DIR]                     # the panda (the robot arm domain)
    python -m sim.fetch_assets --model unitree_g1 [--dest DIR]  # the G1 humanoid (the humanoid domain)
    python -m sim.fetch_assets --model all                      # both
    (or: python3 sim/fetch_assets.py --model ... --dest DIR)

The meshes are tens of MB, so they are not in git. This script downloads a model folder at a pinned
Menagerie commit, file by file from raw.githubusercontent.com, and checks each file's sha256 against the
tables below. It is idempotent: files already present with the right hash are kept, and a second run
downloads nothing. A file with the wrong hash after download is an error, not a warning.

Standard library only, so `lab_image()` runs the same file at image build time (see sim/domain.py and
sim/humanoid/domain.py).

Source: https://github.com/google-deepmind/mujoco_menagerie, commit COMMIT below.

* `franka_emika_panda/`: Apache 2.0 (the folder's LICENSE is downloaded with it and kept in
  `sim/ASSETS_LICENSE`). Only the files `panda.xml` and `scene.xml` need are fetched, unchanged; the MJX
  variants and `hand.xml` are left out. The can and the place zone are added in code (`sim/scene.py`).
* `unitree_g1/`: BSD 3-Clause, Unitree Robotics (the folder's LICENSE is downloaded with it and kept in
  `sim/humanoid/ASSETS_LICENSE`). The 29 joint G1 without dexterous hands: only the files `g1.xml` and
  `scene.xml` need are fetched (35 meshes, about 19 MB), unchanged; the hand, MJX and mjlab variants and
  the pictures are left out. The push and the floor markings are added in code (`sim/humanoid/scene.py`).
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = "google-deepmind/mujoco_menagerie"
COMMIT = "370c43965323c0944b433b202aac5058b5f907a9"
FOLDER = "franka_emika_panda"
G1_FOLDER = "unitree_g1"
DEFAULT_DEST = Path(__file__).resolve().parent / "assets"

# Path inside FOLDER -> sha256 of the file at COMMIT.
FILES: dict[str, str] = {
    "assets/finger_0.obj": "215098c0fcdf7192f6c503a37cf49e3efecf8a9e1320f02b17c5584d89cc5b2c",
    "assets/finger_1.obj": "cf239e9aca26bba09dbbf1c544c47d87cfc9a2f0637c8bb786af750b6d4eca44",
    "assets/hand_0.obj": "b94aab901086f85df04c019b30f43bf9aa23a7ad0443ec80a8c14662a41cabd2",
    "assets/hand_1.obj": "cd76f7494bb314406a1819c46eb826ee254894f87235714f604a470653d9badb",
    "assets/hand_2.obj": "e0f44a71712afa5b98eb20355eff17763d3e2e19f459b2bef19abed3727e64b3",
    "assets/hand_3.obj": "a431a06d99e88a1b322b3122a01424ee7704daeaad0bc343b90b9604f014ad0c",
    "assets/hand_4.obj": "21f96ef6a8de082e41b1ea9834f1043de359e5d60305541bcb63539581f53bff",
    "assets/hand.stl": "94493e94f30fe940f2c8ca2f155c3bbe67bbff406d3edf5e261670d2f0f6e2ed",
    "assets/link0_0.obj": "6b9f41a4c203540daaeb7a33cc3d0d6c6a32dc8bba187074eeaf97b3e36b3f9c",
    "assets/link0_10.obj": "c9198b9d8534d628d097b0f2b239bb30343353182df098ce0d9db6bc13326848",
    "assets/link0_11.obj": "f0adec78d6677b7799d25121981270e8bfe119b5c18d08a91ee37a54ad75f65c",
    "assets/link0_1.obj": "57673d2ee2a9db2e10c8986ae57c56a7c39c012b60fd26d7d8549553b664a5ed",
    "assets/link0_2.obj": "1ca435a2a87a9608a146a47955724d43dd7ce10fc3dd3018800aa98f8ba86e05",
    "assets/link0_3.obj": "3e9c6334d2b3b47944af3458ee5f20519abc20fe7ee23063bb53405ccab28046",
    "assets/link0_4.obj": "215d25789704936120f119c0bc1cc7f68516dd3f8f1df61457b71acac3873f26",
    "assets/link0_5.obj": "9361b104e93743045107aa5b15fb1a0835ba9c1f355aae71f56403cf6a9c33f6",
    "assets/link0_7.obj": "2dc0b8ebbbc80e4c065d71e195adbc384f673438641fac82b07b801b4d2837cb",
    "assets/link0_8.obj": "3b8c436999db5586b8eb47bed2b0aa7de6993868b2681b4c04246eeac42fdb7a",
    "assets/link0_9.obj": "45178f97d2b5da6bce11f610212c4ef7d08c73db33a4fc38e1b7f66b93d023f5",
    "assets/link0.stl": "dfc6d94330de8ddb005b311bfdba9f3b8e1aa7c256b71592ee7ff32cb9a9a5aa",
    "assets/link1.obj": "51091e776b16babdbe2f3849b5c041f921d1f11dd94ac19a0f1c81abf496fbae",
    "assets/link1.stl": "e41a39a94108fcf56aacff603fc91ec80541f4c1af17b51a0de5617f5566e6d2",
    "assets/link2.obj": "5c9f8e715de52c3eb71b475de35993b3b96081e02abea9f28c414768877fc59b",
    "assets/link2.stl": "370f7605a0fae3529db169ded50f52f171024aa792d4d773bc84197301f6a039",
    "assets/link3_0.obj": "ce2da87f51708e11b189249d41401065dabe89a06e251185a06cef4d5ff27178",
    "assets/link3_1.obj": "2880b7753a7173f38fa87ee21da4dfc7fa7be46fbe07bac5aef9e128513cb118",
    "assets/link3_2.obj": "670cff81ae84693769ca4ae658c154cf909d81167e7c8d22b70ea977f2504efa",
    "assets/link3_3.obj": "30ede0c812efd0e0b767d134a4eae0b84e0fa407bb6325a5a555e0569b3a3ffd",
    "assets/link3.stl": "0a8d638b9349c6c0eefc4e888636ac4838c4b27170f18a51699321118af709c1",
    "assets/link4_0.obj": "443bf6d178177cf347951ecf107ccd10ca444e605e375b67304579e5f948806f",
    "assets/link4_1.obj": "ca935ec7cc8b3f0e86aa079c76b0b3bf593b1e9830bab0fa7131ac51577c74f0",
    "assets/link4_2.obj": "c89caf26d379c35bb9e191ee2d91d09ab29ecc792b48d8bc10b39e5b38222175",
    "assets/link4_3.obj": "1495d17f45bdb230cf58b0beef9da4e8c9cfe76a3d2d38da89017efe5e093136",
    "assets/link4.stl": "0180ebb5772ec9840cb049750cffb29a9ddc90311752a16ea34757782ef9e48d",
    "assets/link5_0.obj": "a3238b8f2af0f2eb66d9fe63dc5d41ac52d5d38507241b5ed10e3cb019ab3e71",
    "assets/link5_1.obj": "9d994bbf83ec241e301b5197a6846da13f2a4a0582edb2c0f76962c5549649d6",
    "assets/link5_2.obj": "83b4ffe9f772cd7fe182e98640650eebc899aaf01842656574b0416c90dd40a4",
    "assets/link5_collision_0.obj": "3e5aa75fb13f193555c3dfb999df91d81df25006a5c3af5338297d78137c129b",
    "assets/link5_collision_1.obj": "87cd8f621071df010f774cbde789282b8463840dfe704f8bdfa2e29be0142e15",
    "assets/link5_collision_2.obj": "823ab6c8f7b1d79e0844fa071d82a03499ff68e34fddb1ba3451032c22736040",
    "assets/link6_0.obj": "0504c70ebf1b284ee8faae7dcb896b8830bc672a6552015dd5dbd121fa031fb9",
    "assets/link6_10.obj": "365f26c21d10332cab8d8704645cb46930c30b3085956f2d097498c793f24db4",
    "assets/link6_11.obj": "8ae61e08b3ad064f25bbf03b22e59cc15d65883b5a7ce92711aff29df2493901",
    "assets/link6_12.obj": "f28d1bfd62b0244ffd19fb35fe9edefdf583d3c9167db944e87185d919e1d021",
    "assets/link6_13.obj": "0a55fa92dccb261d07200e6565fca4c850fd17f0c1ecf38821c0b97d51796c7d",
    "assets/link6_14.obj": "750ae3ee4781e62e3a045c662195247b03f6642b05aa93104f08258e5f6eba26",
    "assets/link6_15.obj": "5999c1c2497a004a7c4bbe034cdf13744f839d85ae7a11b1bc386c48a3e642e6",
    "assets/link6_16.obj": "551d7a8b37c53e7a152d008b4e36992e5b5abe74a4be18b57ee6319c27def09f",
    "assets/link6_1.obj": "45f7ca77695198b6d86ec2417ad4e42e6275044f0f96266699ee8e1057757ac1",
    "assets/link6_2.obj": "e54eee4d8232947ee8af65afd5a067e09dac2da6e7e585cb1dccb65496457da0",
    "assets/link6_3.obj": "d4f6a25ef32fa1fa4734146981994ee760232cb077c80fea6487d78a077c7f27",
    "assets/link6_4.obj": "be353480fe71d46f7a96f0a3cbb7e112caaf8d88368826f321a36a253c8749b2",
    "assets/link6_5.obj": "7c87664623c3e1a6cb330db273227a69626dc5e53b4caff1d4ee7911eb3340c6",
    "assets/link6_6.obj": "8fbc031e0d07b795ebf99115c75223141caaba317cab569159f3d477a7821681",
    "assets/link6_7.obj": "7dc5ebb799fe281aab27d6e84e7a4efa0a8e42da2369ec83de3ea3f206f62d73",
    "assets/link6_8.obj": "e3f77381817a341030f9dcc4c4aa7c559f80411b453fd87eb0fefecca82151bf",
    "assets/link6_9.obj": "25a56ea9b02a03b6cb5a81f31c54f54d0185e1a0b3937c37e4289d896e50215a",
    "assets/link6.stl": "20b768e99a0e0440b5754dcca108016434e57937cc356acd9c352ccd3cb27f77",
    "assets/link7_0.obj": "04586b0bde011715cfc22072ac72fe0717eb4d4817bcf665987ce6cd88eb2b93",
    "assets/link7_1.obj": "c3f72289f394c9d6749a4a327fb11f05b203c37c95032c92f28019b40ebe7e00",
    "assets/link7_2.obj": "d2faecedb304d0989040d082410378dc949dbbda23bd18c05134f08aae984db5",
    "assets/link7_3.obj": "b62d87c4d4bdb7b281ed341d347c39dad0e50bf36aed8ac11d050073701d5f70",
    "assets/link7_4.obj": "cb78ccb61fd4ad6c7bff4c4d2e6cb41e1964a5a3e1a28e67c0c6202371cfc018",
    "assets/link7_5.obj": "099071d3090b51471ba52f4f90814fd3089f4975d196e4d488117073d0bfe491",
    "assets/link7_6.obj": "99469e2d95ab74ce0292f2f16954c87a8a7dc16652e62e970fe37c94330a81bb",
    "assets/link7_7.obj": "426c3db8a19373f3dc73d4bec672e948121b2914c10e2e7b9c7ea80643a19e54",
    "assets/link7.stl": "92ac6afcf7574c034d3170d8a68e95ac9048ab9d0dd5bbd8311b86e551b9ab1c",
    "CHANGELOG.md": "282ad32b9d0db6b9f355bf03a339cc73d38cdafe43120adfb3bf2aed47d393d8",
    "LICENSE": "a6cba85bc92e0cff7a450b1d873c0eaa2e9fc96bf472df0247a26bec77bf3ff9",
    "panda.xml": "c047a49f3c770ff2393e2a74f7e0fbd9d99080a305407254f8ff53ac053cde3b",
    "README.md": "e12684556d0154bdf2a9e77e7009ed680cd06ca89904f9e6303050f9fe59300c",
    "scene.xml": "d3933265c01e4301f192163364b2389013c283a9b1645ab158da8a5d837789a7",
}

# The G1 (unitree_g1/ at COMMIT): path inside G1_FOLDER -> sha256.
G1_FILES: dict[str, str] = {
    "assets/head_link.STL": "005fb67fbd3eff94aa8bf4a6e83238174e9f91b6721f7111594322f223724411",
    "assets/left_ankle_pitch_link.STL": "d49e3abc6f5b12e532062cd575b87b5ef40cd2a3fc18f54a1ca5bba4f773d51d",
    "assets/left_ankle_roll_link.STL": "c4092af943141d4d9f74232f3cfa345afc6565f46a077793b8ae0e68b39dc33f",
    "assets/left_elbow_link.STL": "fa752198accd104d5c4c3a01382e45165b944fbbc5acce085059223324e5bed3",
    "assets/left_hip_pitch_link.STL": "4725168105ee768ee31638ef22b53f6be2d7641bfd7cfefe803488d884776fa4",
    "assets/left_hip_roll_link.STL": "91f25922ee8a7c3152790051bebad17b4d9cd243569c38fe340285ff93a97acf",
    "assets/left_hip_yaw_link.STL": "a16d88aa6ddac8083aa7ad55ed317bea44b1fa003d314fba88965b7ed0f3b55b",
    "assets/left_knee_link.STL": "8d92b9e3d3a636761150bb8025e32514c4602b91c7028d523ee42b3e632de477",
    "assets/left_rubber_hand.STL": "cff2221a690fa69303f61fce68f2d155c1517b52efb6ca9262dd56e0bc6e70fe",
    "assets/left_shoulder_pitch_link.STL": "f0d1cfd02fcf0d42f95e678eeca33da3afbcc366ffba5c052847773ec4f31d52",
    "assets/left_shoulder_roll_link.STL": "fb9df21687773522598dc384f1a2945c7519f11cbc8bd372a49170316d6eee88",
    "assets/left_shoulder_yaw_link.STL": "1aa97e9748e924336567992181f78c7cd0652fd52a4afcca3df6b2ef6f9e712e",
    "assets/left_wrist_pitch_link.STL": "b251d8e05047f695d0f536cd78c11973cfa4e78d08cfe82759336cc3471de3a9",
    "assets/left_wrist_roll_link.STL": "edc387c9a0ba8c2237e9b296d32531426fabeb6f53e58df45c76106bca74148c",
    "assets/left_wrist_yaw_link.STL": "83f8fb3a726bf9613d65dd14f0f447cb918c3c95b3938042a0c9c09749267d3b",
    "assets/logo_link.STL": "8571a0a19bc4916fa55f91449f51d5fdefd751000054865a842449429d5f155b",
    "assets/pelvis_contour_link.STL": "5cc5c2c7a312329e3feeb2b03d3fc09fc29705bd01864f6767e51be959662420",
    "assets/pelvis.STL": "5ba6bbc888e630550140d3c26763f10206da8c8bd30ed886b8ede41c61f57a31",
    "assets/right_ankle_pitch_link.STL": "15be426539ec1be70246d4d82a168806db64a41301af8b35c197a33348c787a9",
    "assets/right_ankle_roll_link.STL": "4b66222ea56653e627711b56d0a8949b4920da5df091da0ceb343f54e884e3a5",
    "assets/right_elbow_link.STL": "1be925d7aa268bb8fddf5362b9173066890c7d32092c05638608126e59d1e2ab",
    "assets/right_hip_pitch_link.STL": "e4f3c99d7f4a7d34eadbef9461fc66e3486cb5442db1ec50c86317d459f1a9c6",
    "assets/right_hip_roll_link.STL": "4c254ef66a356f492947f360dd931965477b631e3fcc841f91ccc46d945d54f6",
    "assets/right_hip_yaw_link.STL": "e479c2936ca2057e9eb2f7dff6c189b7419d7b8484dea0b298cbb36a2a6aa668",
    "assets/right_knee_link.STL": "63c4008449c9bbe701a6e2b557b7a252e90cf3a5abcf54cee46862b9a69f8ec8",
    "assets/right_rubber_hand.STL": "99533b778bca6246144fa511bb9d4e555e075c641f2a0251e04372869cd99d67",
    "assets/right_shoulder_pitch_link.STL": "24cdb387e0128dfe602770a81c56cdce3a0181d34d039a11d1aaf8819b7b8c02",
    "assets/right_shoulder_roll_link.STL": "962b97c48f9ce9e8399f45dd9522e0865d19aa9fd299406b2d475a8fc4a53e81",
    "assets/right_shoulder_yaw_link.STL": "a0b76489271da0c72461a344c9ffb0f0c6e64f019ea5014c1624886c442a2fe5",
    "assets/right_wrist_pitch_link.STL": "d22f8f3b3127f15a63e5be1ee273cd5075786c3142f1c3d9f76cbf43d2a26477",
    "assets/right_wrist_roll_link.STL": "a7ee9212ff5b94d6cb7f52bb1bbf3f352194d5b598acff74f4c77d340c5b344f",
    "assets/right_wrist_yaw_link.STL": "bc9dece2d12509707e0057ba2e48df8f3d56db0c79410212963a25e8a50f61a6",
    "assets/torso_link_rev_1_0.STL": "11ddb46f2098efbbd8816b1d65893632d8e78be936376c7cdcd6771899ccc723",
    "assets/waist_roll_link_rev_1_0.STL": "b67c347a05abc3e8ddae600d98a082bee273bb39f8e651647708b0a7140a8a97",
    "assets/waist_yaw_link_rev_1_0.STL": "ec6db442b11f25eed898b5add07940c85d804f300de24dcbd264ccd8be7d554c",
    "CHANGELOG.md": "6988f6caccbc0152af5136a8a2aaf5bb5bd84fea3293661202162f2f8aa92408",
    "LICENSE": "98335465f43a20b5850e4651db6e74c4aa1e9fc8e8813d38f345178045c0da50",
    "README.md": "e0ca5e85f68ff9554631c3ea6ac624b469d6018a37e273daa1234e43e3ad4395",
    "g1.xml": "106adfe8ad759da081d4eaef3a34fc28d6c4c99f3c7f4a385decbac402a51489",
    "scene.xml": "eee015f65b1049bb1ff55eb971cda22c260b9da7fd57c0bd7f63d85141c9db17",
}

# Every model this script knows, by Menagerie folder.
MODELS: dict[str, dict[str, str]] = {FOLDER: FILES, G1_FOLDER: G1_FILES}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def missing_files(dest: Path = DEFAULT_DEST, folder: str = FOLDER) -> list[str]:
    """The files of model `folder` (default the panda) that are absent or have the wrong hash under `dest/folder`."""
    root = dest / folder
    return [rel for rel, digest in MODELS[folder].items() if not (root / rel).is_file() or _sha256(root / rel) != digest]


def _download(rel: str, root: Path, timeout: float, folder: str = FOLDER) -> None:
    url = f"https://raw.githubusercontent.com/{REPO}/{COMMIT}/{folder}/{rel}"
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        data = resp.read()
    digest = hashlib.sha256(data).hexdigest()
    pinned = MODELS[folder][rel]
    if digest != pinned:
        raise RuntimeError(f"{rel}: sha256 {digest} does not match the pinned {pinned}")
    # Write next to the target and rename, so an interrupted run never leaves a half file behind.
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, target)


def fetch(dest: Path = DEFAULT_DEST, timeout: float = 60.0, quiet: bool = False, folder: str = FOLDER) -> int:
    """Download what is missing of model `folder` (default the panda). Returns how many files were downloaded."""
    files = MODELS[folder]
    todo = missing_files(dest, folder)
    if not todo:
        if not quiet:
            print(f"{dest / folder}: all {len(files)} files present, nothing to do")
        return 0
    if not quiet:
        print(f"downloading {len(todo)} of {len(files)} files from {REPO}@{COMMIT[:12]} into {dest / folder}")
    root = dest / folder
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda rel: _download(rel, root, timeout, folder), todo))
    left = missing_files(dest, folder)
    if left:
        raise RuntimeError(f"still missing or wrong after download: {left}")
    if not quiet:
        print("done, every hash matches")
    return len(todo)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Download pinned Menagerie models into sim/assets/.")
    ap.add_argument("--dest", type=Path, default=DEFAULT_DEST, help="folder that gets the model folder (default: sim/assets)")
    ap.add_argument("--model", choices=[*MODELS, "all"], default=FOLDER, help=f"which model (default: {FOLDER})")
    ap.add_argument("--check", action="store_true", help="only check, exit 1 if anything is missing")
    args = ap.parse_args(argv)
    folders = list(MODELS) if args.model == "all" else [args.model]
    if args.check:
        left = [f"{folder}/{rel}" for folder in folders for rel in missing_files(args.dest, folder)]
        print("ok" if not left else f"missing or wrong: {left}")
        return 1 if left else 0
    for folder in folders:
        fetch(args.dest, folder=folder)
    return 0


if __name__ == "__main__":
    sys.exit(main())
