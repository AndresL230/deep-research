"""The research papers a batch builds on (deep_research/papers.py): arXiv's record read, kept, and replaced by the
saved facts when arXiv cannot be reached. No test asks arXiv for anything."""

import pytest
from fastapi.testclient import TestClient

from deep_research import api, papers

ATOM = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>arXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2412.13196v2</id>
    <updated>2025-03-12T00:40:43Z</updated>
    <published>2024-12-17T18:59:51Z</published>
    <title>ExBody2: Advanced Expressive
  Humanoid Whole-Body Control</title>
    <summary>  A method for whole-body
tracking controllers.  </summary>
    <author><name>Mazeyu Ji</name></author>
    <author><name>Xiaolong Wang</name></author>
    <category term="cs.RO"/>
    <category term="cs.AI"/>
  </entry>
</feed>"""


@pytest.fixture(autouse=True)
def _fresh():
    papers.forget()
    yield
    papers.forget()


def test_an_arxiv_answer_is_read_with_its_whitespace_set_right():
    p = papers.parse_atom(ATOM, "2412.13196")
    assert p == {"title": "ExBody2: Advanced Expressive Humanoid Whole-Body Control", "authors": ["Mazeyu Ji", "Xiaolong Wang"],
                 "published": "2024-12-17", "updated": "2025-03-12", "abstract": "A method for whole-body tracking controllers.",
                 "categories": ["cs.RO", "cs.AI"], "version": "v2"}
    for bad, why in ((ATOM, "2510.03827"), ("<feed xmlns='http://www.w3.org/2005/Atom'/>", "2412.13196"), ("not xml", "2412.13196"),
                     (ATOM.replace("<summary>", "<summary><!--").replace("</summary>", "--></summary>"), "2412.13196"),
                     (" " * (papers.MAX_BYTES + 1), "2412.13196")):
        with pytest.raises(ValueError):
            papers.parse_atom(bad, why)


def test_a_record_is_fetched_once_and_kept_for_a_day():
    asked, clock = [], [1000.0]

    def fetch(arxiv_id):
        asked.append(arxiv_id)
        return ATOM

    p = papers.paper("2412.13196", fetch, lambda: clock[0])
    assert p["live"] is True and p["url"] == "https://arxiv.org/abs/2412.13196" and p["abstract"].startswith("A method")
    clock[0] += papers.KEEP_SECONDS - 1
    assert papers.paper("2412.13196", fetch, lambda: clock[0]) is p and asked == ["2412.13196"]
    clock[0] += 2
    papers.paper("2412.13196", fetch, lambda: clock[0])
    assert asked == ["2412.13196", "2412.13196"]
    with pytest.raises(KeyError):
        papers.paper("1706.03762", fetch)


def test_when_arxiv_cannot_be_reached_the_saved_facts_are_served_and_say_so():
    clock, calls = [0.0], []

    def down(arxiv_id):
        calls.append(arxiv_id)
        raise OSError("no route to host")

    p = papers.paper("2510.03827", down, lambda: clock[0])
    assert p["live"] is False and p["abstract"] is None and p["title"].startswith("LIBERO-PRO") and len(p["authors"]) == 8
    # Not asked again for a few minutes, then asked again; a record once fetched outlives a later failure.
    papers.paper("2510.03827", down, lambda: clock[0] + 10)
    assert len(calls) == 1
    papers.paper("2510.03827", down, lambda: clock[0] + papers.RETRY_SECONDS + 1)
    assert len(calls) == 2
    papers.forget()
    live = papers.paper("2412.13196", lambda i: ATOM, lambda: 0.0)
    assert papers.paper("2412.13196", down, lambda: papers.KEEP_SECONDS + 5.0) is live


def test_the_route_serves_only_the_papers_the_app_knows(monkeypatch):
    monkeypatch.setattr(papers, "fetch_arxiv", lambda arxiv_id: ATOM)
    with TestClient(api.app) as client:
        res = client.get("/api/papers/arxiv/2412.13196")
        assert res.status_code == 200 and res.json()["live"] is True and res.json()["authors"] == ["Mazeyu Ji", "Xiaolong Wang"]
        assert "max-age" in res.headers["cache-control"]
        assert client.get("/api/papers/arxiv/1706.03762").status_code == 404
        assert client.get("/api/papers/arxiv/..%2Fsecret").status_code == 404
    papers.forget()
    monkeypatch.setattr(papers, "fetch_arxiv", lambda arxiv_id: (_ for _ in ()).throw(TimeoutError()))
    with TestClient(api.app) as client:
        saved = client.get("/api/papers/arxiv/2510.03827").json()
    assert saved["live"] is False and saved["abstract"] is None and saved["published"] == "2025-10-04"
