"""The findings paper (deep_research/paper.py): LaTeX built with PyLaTeX from a case file, compiled by pdflatex, and
served at /api/batches/{id}/paper.tex and paper.pdf."""

import json
import shutil

import pytest
from fastapi.testclient import TestClient

from deep_research import api, paper
from deep_research.config import FIXTURES_DIR

FIXTURES = sorted(p.parent.parent.name for p in FIXTURES_DIR.glob("*/case/case.json"))
HAS_TEX = shutil.which(paper.ENGINE) is not None


def case_of(name: str) -> dict:
    return json.loads((FIXTURES_DIR / name / "case" / "case.json").read_text())


@pytest.mark.parametrize("name", FIXTURES)
def test_every_fixture_makes_a_whole_paper_with_its_run_id(name):
    src = paper.build_paper(case_of(name), name)
    assert src.startswith("\\documentclass")
    assert src.rstrip().endswith("\\end{document}")
    for part in ("\\begin{abstract}", "\\section{Introduction}", "\\section{Setup and methods}", "\\section{Results}",
                 "\\section{Discussion}", "\\appendix"):
        assert part in src
    assert f"Platform run ID: \\texttt{{{paper.tex(name)}" in src


def test_an_open_result_only_suggests():
    c = case_of("robot-live-investigation")
    assert c["verdict"]["evidence"]["level"] == "open"
    src = paper.build_paper(c, "robot-live-investigation")
    assert "\\emph{suggests} why the claims were inflated and does not" in src
    assert "as a cause:" not in src
    # The hypothesis the server calls "inconclusive" at an open score is said "open", as on the page.
    assert "&method&open&13.03&f1" in src


def test_a_supported_result_is_called_a_cause():
    c = case_of("tabular-live-investigation")
    assert c["verdict"]["evidence"]["level"] == "supported"
    assert "as a cause:" in paper.build_paper(c, "tabular-live-investigation")


def test_agent_text_cannot_reach_latex_as_commands():
    c = case_of("robot-live-investigation")
    c["hypotheses"][0]["sentence"] = r"\input{/etc/passwd} 100% & $x$ #1 ~ ^ _ {}"
    c["verdict"]["sentence"] = "\\end{agentquote}\\immediate\\write18{rm -rf /}"
    src = paper.build_paper(c, "robot-live-investigation")
    assert "\\input{/etc/passwd}" not in src and "\\write18" not in src
    assert r"\textbackslash{}input\{/etc/passwd\} 100\% \& \$x\$ \#1" in src
    # A listing keeps its text verbatim but can never close itself early.
    assert "\\end {lstlisting}" in paper.listing("a\n\\end{lstlisting}\n\\input{x}").dumps()


def test_text_outside_latin1_is_set_or_replaced():
    assert paper.tex("0.65 → 0.25 ≥ 2×") == r"0.65 $\rightarrow$ 0.25 $\geq$ 2$\times$"
    assert paper.tex("日本") == "??"


@pytest.mark.skipif(not HAS_TEX, reason="no pdflatex")
@pytest.mark.parametrize("name", FIXTURES)
def test_every_fixture_compiles(name):
    assert paper.compile_pdf(paper.build_paper(case_of(name), name)).startswith(b"%PDF")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "BATCHES_DIR", tmp_path / "batches")
    monkeypatch.setattr(api, "STATS_FILE", tmp_path / "batches" / "_stats.json")
    with TestClient(api.app) as c:
        yield c


def test_serves_the_latex_as_a_download(client):
    r = client.get("/api/batches/robot-live-investigation/paper.tex")
    assert r.status_code == 200
    assert 'filename="orro-findings-robot-live-investigation.tex"' in r.headers["content-disposition"]
    assert r.text.startswith("\\documentclass")


@pytest.mark.skipif(not HAS_TEX, reason="no pdflatex")
def test_serves_the_pdf_as_a_download(client):
    r = client.get("/api/batches/robot-live-investigation/paper.pdf")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert r.content.startswith(b"%PDF")
    assert 'filename="orro-findings-robot-live-investigation.pdf"' in r.headers["content-disposition"]


def test_without_a_latex_engine_the_pdf_is_503_and_the_tex_still_works(client, monkeypatch):
    monkeypatch.setattr(paper, "ENGINE", "no-such-latex-engine")
    monkeypatch.setattr(paper, "_cache", type(paper._cache)())
    r = client.get("/api/batches/demo-batch/paper.pdf")
    assert r.status_code == 503 and "LaTeX" in r.json()["detail"]
    assert client.get("/api/batches/demo-batch/paper.tex").status_code == 200


def test_unknown_batch_is_404(client):
    assert client.get("/api/batches/nope/paper.pdf").status_code == 404
