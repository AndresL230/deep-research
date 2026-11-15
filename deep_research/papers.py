"""The research papers some batches build on, read from arXiv when a page asks for one.

A batch page that builds on a paper (web/src/robot/markup.ts `researchSource`) shows the paper's own record: its
title, authors, dates and abstract as arXiv has them now. `paper()` fetches that record from arXiv's public API,
keeps it for a day, and falls back to the few facts saved here when arXiv cannot be reached, saying so (`live`).

Only the papers named in PAPERS can be asked for: this is not a proxy to arXiv. The request carries the paper's
number and nothing else. arXiv's metadata, abstracts included, is under CC0.
"""

from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET
from typing import Callable

ARXIV_API = "https://export.arxiv.org/api/query"
ATOM = {"a": "http://www.w3.org/2005/Atom"}
KEEP_SECONDS = 24 * 3600
RETRY_SECONDS = 300          # after a failure, how long the saved record is served before arXiv is asked again
TIMEOUT_SECONDS = 8.0
MAX_BYTES = 400_000

# What is served when arXiv cannot be reached: the facts that do not change.
PAPERS: dict[str, dict] = {
    "2412.13196": {
        "title": "ExBody2: Advanced Expressive Humanoid Whole-Body Control",
        "authors": ["Mazeyu Ji", "Xuanbin Peng", "Fangchen Liu", "Jialong Li", "Ge Yang", "Xuxin Cheng", "Xiaolong Wang"],
        "published": "2024-12-17",
    },
    "2510.03827": {
        "title": "LIBERO-PRO: Towards Robust and Fair Evaluation of Vision-Language-Action Models Beyond Memorization",
        "authors": ["Xueyang Zhou", "Yangming Xu", "Guiyao Tie", "Yongchao Chen", "Guowen Zhang", "Duanfeng Chu", "Pan Zhou", "Lichao Sun"],
        "published": "2025-10-04",
    },
}

Fetch = Callable[[str], str]
_cache: dict[str, tuple[float, dict]] = {}


def _text(node, path: str) -> str:
    found = node.find(path, ATOM)
    return " ".join((found.text or "").split()) if found is not None else ""


def parse_atom(xml: str, arxiv_id: str) -> dict:
    """The one entry of an arXiv API answer as {"title", "authors", "published", "updated", "abstract",
    "categories", "version"}. Raises ValueError when the answer has no such paper."""
    if len(xml) > MAX_BYTES:
        raise ValueError("the answer is too large to be one paper's record")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as e:
        raise ValueError(f"the answer is not XML: {e}") from None
    for entry in root.findall("a:entry", ATOM):
        m = re.search(r"arxiv\.org/abs/(\d{4}\.\d{4,5})(v\d+)?$", _text(entry, "a:id"))
        if not m or m.group(1) != arxiv_id:
            continue
        title, abstract = _text(entry, "a:title"), _text(entry, "a:summary")
        authors = [name for a in entry.findall("a:author", ATOM) if (name := _text(a, "a:name"))]
        if not title or not authors or not abstract:
            raise ValueError("the paper's record has no title, authors or abstract")
        return {
            "title": title[:400],
            "authors": [a[:120] for a in authors[:60]],
            "published": _text(entry, "a:published")[:10],
            "updated": _text(entry, "a:updated")[:10],
            "abstract": abstract[:6000],
            "categories": [c.get("term", "")[:20] for c in entry.findall("a:category", ATOM)][:8],
            "version": (m.group(2) or "")[:6],
        }
    raise ValueError(f"the answer has no paper {arxiv_id}")


def fetch_arxiv(arxiv_id: str) -> str:
    """arXiv's record of one paper, as the Atom XML its API answers with."""
    import httpx

    r = httpx.get(ARXIV_API, params={"id_list": arxiv_id}, timeout=TIMEOUT_SECONDS, follow_redirects=True,
                  headers={"User-Agent": "orro-paper-card/1.0"})
    r.raise_for_status()
    return r.text


def paper(arxiv_id: str, fetch: Fetch | None = None, now: Callable[[], float] = time.time) -> dict:
    """One of PAPERS (KeyError for any other number) as the page shows it: {"id", "url", "title", "authors",
    "published", "updated", "abstract", "categories", "version", "live"}. `live` is True when the record is arXiv's
    own, fetched within the last day; False when arXiv could not be reached and the saved facts are served, with no
    abstract."""
    saved = PAPERS[arxiv_id]
    at, kept = _cache.get(arxiv_id, (0.0, None))
    if kept is not None and now() - at < (KEEP_SECONDS if kept["live"] else RETRY_SECONDS):
        return kept
    base = {"id": arxiv_id, "url": f"https://arxiv.org/abs/{arxiv_id}"}
    try:
        out = {**base, **parse_atom((fetch or fetch_arxiv)(arxiv_id), arxiv_id), "live": True}
    except Exception:  # noqa: BLE001 - arXiv down, slow or changed: the page still has its paper
        if kept is not None and kept["live"]:
            out = kept  # a day-old record is still arXiv's own
        else:
            out = {**base, **saved, "updated": None, "abstract": None, "categories": [], "version": "", "live": False}
    _cache[arxiv_id] = (now(), out)
    return out


def forget() -> None:
    """Drop every kept record (for tests)."""
    _cache.clear()
