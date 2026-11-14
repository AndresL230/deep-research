"""Screenshot both demo batches at their end, for before and after pictures in a PR.

    uv run --with playwright python scripts/screens.py http://localhost:8011 out_dir

Takes the batch page (full height) of fixtures/demo-batch and fixtures/robot-demo-batch, plus one run page of each.
Needs a Playwright Chromium (`uv run --with playwright playwright install chromium` once).
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

PAGES = [
    ("tabular-batch", "demo-batch", ""),
    ("tabular-run", "demo-batch", "/run/r02"),
    ("robot-batch", "robot-demo-batch", ""),
    ("robot-run", "robot-demo-batch", "/run/r02"),
]


def main(base: str, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"])
        page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        for name, batch, rest in PAGES:
            page.goto(f"{base}/?end#/b/{batch}{rest}")
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(2500)
            # The app scrolls inside its own element, so grow the viewport to the content to get the whole page.
            h = page.evaluate("""() => Math.max(document.body.scrollHeight,
                ...[...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 4
                   && getComputedStyle(e).overflowY.match(/auto|scroll/)).map(e => e.scrollHeight))""")
            page.set_viewport_size({"width": 1440, "height": min(max(900, int(h) + 40), 12000)})
            page.wait_for_timeout(800)
            page.screenshot(path=str(out / f"{name}.png"), full_page=True)
            page.set_viewport_size({"width": 1440, "height": 900})
            print(out / f"{name}.png")
        browser.close()


if __name__ == "__main__":
    main(sys.argv[1], Path(sys.argv[2]))
