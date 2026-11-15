"""A batch's findings as a research paper: a LaTeX document built with PyLaTeX from the case file, and the PDF
pdflatex makes of it.

Everything in the paper comes from the case file. Numbers are computed here, in code; the words of the agents (the
investigator's hypotheses, its verdict and limits, the tracer's diagnosis) are quoted as they were written and marked
as theirs. No model writes any of it. A cause is claimed only when the evidence is supported (`evidence.CAUSAL`, the
same rule the investigator's verdict is held to): an open result "suggests", a cleared one "does not explain".

    tex = build_paper(case, batch_id)        # the LaTeX source
    pdf = compile_pdf(tex)                   # the PDF, or PaperError when no engine is installed or it fails

The server serves both (`/api/batches/{id}/paper.tex`, `/api/batches/{id}/paper.pdf`).
"""

from __future__ import annotations

import hashlib
import html
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from collections import Counter, OrderedDict
from pathlib import Path

from pylatex import Command, Document, Itemize, Label, LongTable, Marker, Math, NoEscape, Package, Section, Subsection, Subsubsection, Table, Tabular
from pylatex.base_classes import Environment

from .evidence import AGREE, DISAGREE, NEEDED_PAIRS, SUPPORTED_SCORE

# ── LaTeX text ───────────────────────────────────────────────────────────────

_SPECIAL = {
    "\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#", "_": r"\_", "{": r"\{", "}": r"\}",
    "~": r"\textasciitilde{}", "^": r"\textasciicircum{}", "<": r"\textless{}", ">": r"\textgreater{}", "|": r"\textbar{}",
}
# Characters outside Latin-1 that agents write, in LaTeX. Anything else outside Latin-1 becomes "?".
_UNICODE = {
    "→": r"$\rightarrow$", "←": r"$\leftarrow$", "↔": r"$\leftrightarrow$", "⇒": r"$\Rightarrow$", "≥": r"$\geq$",
    "≤": r"$\leq$", "≠": r"$\neq$", "≈": r"$\approx$", "×": r"$\times$", "±": r"$\pm$", "−": "-", "–": "--",
    "—": "---", "…": r"\ldots{}", "“": "``", "”": "''", "‘": "`", "’": "'", "•": r"\textbullet{}", "·": r"\textperiodcentered{}",
    "°": r"\textdegree{}", "µ": r"$\mu$", "Δ": r"$\Delta$", "σ": r"$\sigma$", "α": r"$\alpha$", "β": r"$\beta$",
    "√": r"$\surd$", "∞": r"$\infty$", "✓": "yes", "✗": "no", "\u00a0": "~", "\u200b": "",
}


def tex(s: object) -> str:
    """Plain text, safe in LaTeX body text: every special character escaped, and line breaks kept as spaces."""
    out = []
    for ch in str(s if s is not None else ""):
        if ch in _SPECIAL:
            out.append(_SPECIAL[ch])
        elif ch in _UNICODE:
            out.append(_UNICODE[ch])
        elif ch in "\r\n\t":
            out.append(" ")
        elif ord(ch) < 32:
            continue
        elif ord(ch) < 256:
            out.append(ch)
        else:
            out.append("?")
    return "".join(out)


def tt(s: object) -> str:
    """A step label, a run id, a path: in typewriter type, allowed to break after underscores and slashes."""
    return r"\texttt{" + tex(s).replace(r"\_", r"\_\allowbreak{}").replace("/", r"/\allowbreak{}") + "}"


def _ascii(s: str) -> str:
    return "".join(ch if 32 <= ord(ch) < 127 or ch == "\n" else ("    " if ch == "\t" else "?") for ch in s)


class Lstlisting(Environment):
    """`listings`' verbatim block. Its content is not escaped, and is kept on its own lines."""

    _latex_name = "lstlisting"
    escape = False
    content_separator = "\n"


class AgentQuote(Environment):
    """An agent's own words, set apart and attributed (the `agentquote` environment in the preamble)."""

    _latex_name = "agentquote"


class Abstract(Environment):
    _latex_name = "abstract"


def listing(code: str, max_lines: int = 40) -> Lstlisting:
    """Code or a report, verbatim. Kept to ASCII (pdflatex's listings cannot set the rest) and to `max_lines`."""
    # Some excerpts were saved with their quotes as HTML entities (&quot;): read back to plain characters.
    lines = _ascii(html.unescape(str(code or ""))).rstrip().split("\n")
    if len(lines) > max_lines:
        lines = lines[:max_lines] + [f"... ({len(lines) - max_lines} more lines)"]
    env = Lstlisting()
    env.append(NoEscape("\n".join(lines).replace(r"\end{lstlisting}", r"\end {lstlisting}")))
    return env


def clip(s: object, n: int) -> str:
    """`s` cut to about `n` characters at a word, with an ellipsis when it was cut."""
    t = str(s or "").strip()
    return t if len(t) <= n else t[:n].rsplit(" ", 1)[0].rstrip(",;:") + "…"


def quote(s: object, who: str) -> AgentQuote:
    """An agent's own words, set apart and attributed. Text the case file stored cut short (the server keeps a verdict
    to 500 characters) ends in an ellipsis rather than mid-word."""
    t = str(s or "").strip()
    if len(t) >= 400 and t[-1] not in ".!?)\"'":
        t = t.rsplit(" ", 1)[0].rstrip(",;:") + "…"
    env = AgentQuote(arguments=NoEscape(tex(who)))
    env.append(NoEscape(tex(t)))
    return env


# ── numbers ──────────────────────────────────────────────────────────────────


def _num(x: object) -> float | None:
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def pct(x: object, places: int = 1) -> str:
    v = _num(x)
    return "--" if v is None else f"{v * 100:.{places}f}\\%"


def pts(x: object) -> str:
    """A gap in percentage points, signed."""
    v = _num(x)
    return "--" if v is None else f"{v * 100:+.1f}"


def score_text(x: object) -> str:
    v = _num(x)
    if v is None:
        return "--"
    if v >= 100:
        return f"{v:.1f}"
    if v >= 1:
        return f"{v:.4g}"
    return f"{v:.2g}"


def usd(x: object) -> str:
    v = _num(x)
    return "--" if v is None else f"\\${v:,.2f}"


def p_text(p: object) -> str:
    v = _num(p)
    return "n/a" if v is None else ("$<0.001$" if v < 0.001 else f"{v:.3f}")


def kofn(k: object, n: object) -> str:
    return f"{k if k is not None else 0} of {n if n is not None else 0}"


def plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def when(ts: object) -> str:
    v = _num(ts)
    return time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(v)) if v else ""


# ── reading the case ─────────────────────────────────────────────────────────

STATUS_ORDER = ("honest", "unclear", "inflated", "failed")
ARM_WORDS = {
    "control": "Control: the copy is left alone and continues as the original run would.",
    "forced": "Forced (changed): the copy is made to take the step under test.",
    "placebo": "Placebo: the copy is made to take a step that changes nothing, to measure the effect of any intervention at all.",
    "show": "Show: the copy is only shown the problem, without being made to act on it.",
}


def _runs(case: dict) -> list[dict]:
    runs = [r for r in (case.get("runs") or {}).values() if isinstance(r, dict)]
    return sorted(runs, key=lambda r: str(r.get("id", "")))


def _forks(case: dict) -> list[dict]:
    fs = [f for k, f in (case.get("forks") or {}).items() if isinstance(f, dict) and k != "pending" and f.get("id")]
    return sorted(fs, key=lambda f: (len(str(f["id"])), str(f["id"])))


def _explanations(case: dict) -> list[dict]:
    """The investigator's explanations: its suspects (with their evidence) when it named them, else its hypotheses."""
    ev = case.get("evidence") or {}
    out = []
    for s in case.get("suspects") or []:
        if isinstance(s, dict) and s.get("id"):
            out.append({"id": s["id"], "step": s.get("target"), "kind": s.get("kind"), "status": s.get("status"),
                        "why": s.get("rationale"), "by": s.get("proposed_by"), "evidence": ev.get(s["id"]), "at": s.get("at")})
    if out:
        return out
    for h in case.get("hypotheses") or []:
        if isinstance(h, dict):
            out.append({"id": h.get("id") or "h", "step": h.get("step_label") or (f"code of run {h['run_id']}" if h.get("run_id") else None),
                        "kind": h.get("kind"), "status": h.get("status"), "why": h.get("sentence") or h.get("evidence"),
                        "detail": h.get("evidence") if h.get("sentence") else None, "prediction": h.get("prediction"),
                        "falsified_if": h.get("falsified_if"), "confidence": h.get("confidence"), "tested_by": h.get("tested_by"),
                        "at": h.get("at")})
    return out


def _metric(case: dict) -> str:
    dom = (case.get("config") or {}).get("domain") or "tabular"
    return "accuracy" if dom == "tabular" else "success rate"


def _level_words(level: str | None) -> str:
    return {
        "supported": f"supported (a running score of {SUPPORTED_SCORE:g} or more)",
        "cleared": f"cleared ({NEEDED_PAIRS} or more pairs with a running score under 1)",
        "open": f"open (neither supported nor cleared: a running score under {SUPPORTED_SCORE:g})",
        "inconclusive": "inconclusive (no control copy reproduced the inflation, so the experiment says nothing either way)",
    }.get(level or "", tex(level or "not recorded"))


# ── the paper ────────────────────────────────────────────────────────────────

# The preamble's own definitions: colours, the listings style, the agent quote and a ragged column type.
DEFINITIONS = r"""\definecolor{orro}{HTML}{6E56CF}
\lstset{basicstyle=\ttfamily\footnotesize,breaklines=true,breakatwhitespace=false,columns=fullflexible,
  frame=single,rulecolor=\color{lightgray},xleftmargin=4pt,xrightmargin=4pt,showstringspaces=false,
  postbreak=\mbox{\textcolor{gray}{$\hookrightarrow$}\space}}
\newenvironment{agentquote}[1]{\par\smallskip\noindent\begin{minipage}{\linewidth}\leftskip=1.2em\rightskip=1.2em
  {\footnotesize\textsc{#1}}\par\nobreak\vspace{2pt}\itshape}{\end{minipage}\par\smallskip}
\setlength{\parskip}{0.45em}
\setlength{\parindent}{0pt}
\renewcommand{\arraystretch}{1.12}"""

PACKAGES = ("microtype", "booktabs", "longtable", "array", "xcolor", "listings", "amsmath")


def new_document() -> Document:
    doc = Document(
        documentclass="article", document_options=["11pt", "a4paper"], fontenc="T1", inputenc="utf8", lmodern=True,
        textcomp=True, page_numbers=False, geometry_options={"margin": "2.4cm"},
    )
    for name in PACKAGES:
        doc.packages.append(Package(name))
    doc.packages.append(Package("hyperref", options=["hidelinks"]))
    doc.preamble.append(NoEscape(DEFINITIONS))
    return doc


class Paper:
    """The paper, section by section. Each part reads the case and appends PyLaTeX objects to the open section."""

    def __init__(self, case: dict, batch_id: str):
        self.case = case
        self.id = batch_id
        self.cfg = case.get("config") or {}
        self.dom = self.cfg.get("domain_info") or {}
        self.runs = _runs(case)
        self.forks = _forks(case)
        self.expl = _explanations(case)
        self.verdict = case.get("verdict") or {}
        self.metric = _metric(case)
        self.doc = new_document()
        # Where text goes: the document, its open section, or that section's open subsection.
        self.sec: Section | None = None
        self.subsec: Subsection | None = None

    # ── structure ──
    @property
    def here(self):
        return self.subsec or self.sec or self.doc

    def add(self, *items) -> None:
        for x in items:
            self.here.append(NoEscape(x) if isinstance(x, str) else x)

    def section(self, title: str, label: str = "") -> None:
        self.sec = Section(NoEscape(tex(title)), label=False)
        if label:
            self.sec.append(Label(Marker(label, "sec")))
        self.subsec = None
        self.doc.append(self.sec)

    def sub(self, title: str) -> None:
        self.subsec = Subsection(NoEscape(tex(title)), label=False)
        (self.sec or self.doc).append(self.subsec)

    def para(self, *sentences: str) -> None:
        """A paragraph of sentences already in LaTeX (built with `tex` and the number helpers)."""
        text = " ".join(x for x in sentences if x)
        if text:
            self.add(NoEscape(text + "\n\n"))

    def heading(self, text: str) -> None:
        """A bold line that heads what follows (a quote, a listing), its text already in LaTeX. Not a run-in
        \\paragraph: a block set beside one would run off the page."""
        self.add(NoEscape(f"\\medskip\\textbf{{{text}}}\\par\\nopagebreak\n\n"))

    def items(self, entries: list[str], tight: bool = False) -> None:
        lst = Itemize()
        if tight:
            lst.append(NoEscape(r"\setlength{\itemsep}{0pt}"))
        for e in entries:
            lst.add_item(NoEscape(e))
        self.add(lst)

    def table(self, spec: str, head: list[str], rows: list[list[str]], caption: str, label: str = "", long: bool = False) -> None:
        """A booktabs table: a float for a short one, a longtable that breaks across pages for a long one. Cells and
        caption are already in LaTeX."""
        cap = NoEscape(caption + (f"\\label{{tab:{label}}}" if label else ""))
        if long:
            t = LongTable(spec, booktabs=True)
            # The caption heads the first page only; a page the table runs on to repeats just the column names.
            t.append(NoEscape(f"\\caption{{{cap}}}\\\\"))
            t.add_row([NoEscape(h) for h in head])
            t.add_hline()
            t.append(NoEscape(r"\endfirsthead"))
            t.add_row([NoEscape(h) for h in head])
            t.add_hline()
            t.end_table_header()
            for r in rows:
                t.add_row([NoEscape(c) for c in r])
            self.add(NoEscape(r"\small"), t, NoEscape(r"\normalsize"))
            return
        tab = Tabular(spec, booktabs=True)
        tab.add_row([NoEscape(h) for h in head])
        tab.add_hline()
        for r in rows:
            tab.add_row([NoEscape(c) for c in r])
        flt = Table(position="htbp")
        flt.append(NoEscape(r"\centering\small"))
        flt.append(Command("caption", cap))
        flt.append(tab)
        self.add(flt)

    # ── reading ──
    def counts(self) -> Counter:
        return Counter(str(r.get("status") or "unknown") for r in self.runs)

    def scored(self) -> list[dict]:
        return [r for r in self.runs if _num(r.get("reported_accuracy")) is not None and _num(r.get("true_accuracy")) is not None]

    def ev(self) -> dict:
        return self.verdict.get("evidence") or {}

    # ── the parts ──
    def title(self) -> None:
        dom_title = self.dom.get("title") or str(self.cfg.get("domain") or "agent task").replace("_", " ")
        rec = self.cfg.get("recording") or {}
        src = rec.get("source_batch")
        ids = f"Platform run ID: {tt(self.id)}"
        if src and src != self.id:
            ids += f" \\quad Recorded from batch {tt(src)}"
        pre = self.doc.preamble
        pre.append(Command("title", NoEscape(
            f"\\textbf{{Do the agents' reported results hold up?}}\\\\[4pt]\\large An Orro investigation of {tex(dom_title.lower())}")))
        pre.append(Command("author", NoEscape(f"Orro, automated investigation report\\\\[2pt]\\small {ids}")))
        pre.append(Command("date", NoEscape(tex(rec.get("saved_at") or time.strftime("%Y-%m-%d", time.gmtime())))))
        self.doc.append(NoEscape(r"\maketitle"))

    def abstract(self) -> None:
        c = self.counts()
        n = len(self.runs)
        sc = self.scored()
        gaps = [_num(r.get("gap")) for r in sc if _num(r.get("gap")) is not None]
        ev = self.ev()
        s = [
            f"{plural(n, 'independent agent run')} were given the same task "
            f"({tex((self.dom.get('title') or 'the task').lower())}) and each reported its own {self.metric}.",
            "Orro measured every result again on held-out cases the agents never saw:",
            (", ".join(f"{c[k]} {k}" for k in STATUS_ORDER if c.get(k)) + ".") if c else "",
        ]
        if gaps:
            s.append(f"The mean reported-minus-measured gap was {pts(sum(gaps) / len(gaps))} percentage points "
                     f"(largest {pts(max(gaps))}).")
        if self.expl:
            s.append(f"An investigator agent proposed {plural(len(self.expl), 'explanation')} before running any experiment"
                     + (f", and {plural(len(self.forks), 'paired fork experiment')} tested them by cutting copies of a run "
                        "at the moment in question and changing one thing." if self.forks else "."))
        if ev:
            s.append(f"The evidence for the leading explanation is {tex(ev.get('level', 'open'))}: "
                     f"{kofn(ev.get('agree'), ev.get('pairs'))} pairs agreed with the prediction, a running score of "
                     f"{score_text(ev.get('score'))} against the {SUPPORTED_SCORE:g} needed.")
        meas = (self.case.get("fix") or {}).get("measured") or {}
        if meas.get("before") and meas.get("after"):
            s.append(f"A proposed code fix was measured on held-out cases: {pct(meas['before'].get('true_accuracy'), 0)} "
                     f"before, {pct(meas['after'].get('true_accuracy'), 0)} after.")
        s.append("Every number in this report is computed from the batch's case file; the agents' own words are quoted "
                 "and marked as theirs.")
        env = Abstract()
        env.append(NoEscape(" ".join(x for x in s if x)))
        self.doc.append(env)

    def introduction(self) -> None:
        self.section("Introduction", "intro")
        self.para(
            "AI agents can write code, run experiments and report a result. The report is a claim, and a claim can be",
            "wrong in ways the agent does not mention: it can be measured on cases the agent tuned on, leave failures out,",
            "or skip a check that would have lowered it. This report follows one Orro batch from the claims to their",
            "causes. It asks three questions in turn: did the agents' reported results hold up on cases they never saw;",
            "where they did not, what in the agents' work separates the runs that reported honestly from the ones that",
            "did not; and does changing that one thing, in a copy of the run, change the report?",
        )
        if self.dom.get("description"):
            self.para(f"\\textbf{{The task.}} {tex(self.dom['description'])}")
        self.para(
            "Section~\\ref{sec:methods} describes the setup and the procedure, Section~\\ref{sec:results} the results,",
            "and Section~\\ref{sec:discussion} what they do and do not show. The batch can be opened on the platform under",
            f"the run ID {tt(self.id)}.",
        )

    def methods(self) -> None:
        cfg = self.cfg
        self.section("Setup and methods", "methods")
        self.sub("Agents and task")
        bits = [f"The batch ran {plural(int(cfg.get('n_runs') or len(self.runs)), 'agent')} on the same task, each in its own"
                " sandboxed machine, with no access to the others' work."]
        if cfg.get("analyst_model"):
            bits.append(f"Each agent was {tt(cfg['analyst_model'])}.")
        if cfg.get("investigator_model"):
            bits.append(f"The investigator was {tt(cfg['investigator_model'])}.")
        if cfg.get("budget_usd"):
            bits.append(f"The batch had a budget of {usd(cfg['budget_usd'])}.")
        if cfg.get("mode") == "replay":
            bits.append("This batch is a replay of saved runs: no agent ran live for it, and its numbers are simulated.")
        self.para(*bits)
        if self.dom.get("output_files"):
            self.para(f"Each agent had to leave {', '.join(tt(o) for o in self.dom['output_files'])} behind, and its report "
                      f"states the {self.metric} it claims.")

        self.sub("Measuring each claim again")
        thr, unc = _num(cfg.get("inflation_threshold")), _num(cfg.get("unclear_threshold"))
        cls = (f"A run is \\emph{{inflated}} when its reported {self.metric} exceeds the measured one by more than "
               + (pct(thr, 1) if thr is not None else "the batch's threshold"))
        cls += (f", \\emph{{unclear}} when the gap is between {pct(unc, 1)} and {pct(thr, 1)}, and \\emph{{honest}} otherwise."
                if unc is not None and thr is not None else ", and \\emph{honest} otherwise.")
        self.para(
            "Orro scores every agent's final output itself, on held-out cases the agent never saw and that never left the",
            f"server. The gap is the reported {self.metric} minus the measured one.", cls,
            "A run that ended without a scorable output is \\emph{failed} and takes no further part.",
        )

        if self.case.get("split") is not None or any(r.get("labels") for r in self.runs):
            self.sub("What the runs did, step by step")
            self.para(
                "Every action an agent took (each command, file it wrote, or tool it called) is labelled with the steps",
                "it performs, such as inspecting the data, tuning parameters or writing the report. For each step, the",
                "share of honest runs that took it is compared with the share of inflated runs that took it. The step",
                "with the largest difference is the \\emph{split}: the first suspect, and the place in a run where an",
                "experiment can cut in.",
            )

        if self.expl:
            self.sub("The investigator and its pre-registered explanations")
            self.para(
                "An investigator agent reads the case file: the claims, the measurements, the split and the runs' work.",
                "It writes down competing explanations, each with what it expects an experiment to show and what would",
                "prove it wrong, \\emph{before} any experiment runs. The predictions are time-stamped in the case file.",
                "The investigator proposes experiments; it does not compute their results.",
            )

        if self.forks:
            self.sub("Paired fork experiments")
            arms = sorted({a for f in self.forks for a in (f.get("arms") or {})} | {"control", "forced"},
                          key=lambda a: list(ARM_WORDS).index(a) if a in ARM_WORDS else 9)
            self.para(
                "An experiment takes one source run and cuts copies of it at a single moment, before the step in",
                "question. Each copy starts a fresh agent from the original's history, on a machine brought back to the",
                "state the original had at that moment (forked copy-on-write where the sandbox allows it, otherwise",
                "rebuilt by replaying the original's commands). The copies then continue on their own. The arms are:",
            )
            self.items([tex(ARM_WORDS.get(a, a)) for a in arms])
            self.para(
                "Every copy is scored on the same held-out cases as the original runs. A control copy and a changed copy",
                "cut at the same moment form a \\emph{pair}. A pair \\emph{agrees} with the prediction when it goes the",
                "way the prediction said (for a step thought to prevent inflation: the changed copy's gap is smaller).",
            )
            self.heading("The evidence rule.")
            self.para(f"The running score starts at 1 and is multiplied by {AGREE:g} for every pair that agrees and by "
                      f"{DISAGREE:g} for every pair that does not:")
            self.add(Math(data=[NoEscape(f"S = {AGREE:g}^{{\\,a}} \\cdot {DISAGREE:g}^{{\\,d}},")], escape=False))
            self.para(
                f"where $a$ and $d$ are the numbers of agreeing and disagreeing pairs. The explanation is \\emph{{supported}}",
                f"at $S \\geq {SUPPORTED_SCORE:g}$ (at least five pairs, all agreeing), \\emph{{cleared}} after {NEEDED_PAIRS}",
                "or more pairs with $S < 1$, and \\emph{open} otherwise. It is \\emph{inconclusive} when no control copy",
                "reproduced the inflation, since then no pair can count. A one-sided Fisher exact test on the arms' inflated",
                "counts is reported alongside but does not decide the level. A cause is claimed only at \\emph{supported};",
                "an open result only \\emph{suggests}.",
            )
            if any(f.get("adherence") for f in self.forks):
                self.para("A pair counts only when its changed copy kept the change: plain code checks each changed copy's",
                          "files and later commands, and a copy that undid the change drops its pair.")

        if self.case.get("rubric"):
            self.sub("Review of the verdict")
            self.para("Before a verdict stands, a grader agent checks it against the case file with a fixed list of",
                      "criteria (that its numbers match, that it names the step it tested, that its wording does not claim",
                      "more than the evidence). A verdict that fails is sent back to the investigator to revise.")

        if self.case.get("trace") or self.case.get("fix"):
            self.sub("Diagnosis and a measured fix")
            self.para("For runs whose failures were recorded, a code-tracing agent watches recordings of failing cases and",
                      "names the line of the agent's code behind each failure. A fix to that line is then proposed, with a",
                      "pre-registered prediction, and measured: the patched and unpatched code run on the same held-out",
                      "cases, compared case by case with an exact one-sided sign test on the cases that changed.")

    def results_claims(self) -> None:
        self.section("Results", "results")
        self.sub("Reported against measured")
        c = self.counts()
        sc = self.scored()
        self.para(
            f"Of {plural(len(self.runs), 'run')}, "
            + ", ".join(f"{c[k]} {'was' if c[k] == 1 else 'were'} {k}" for k in STATUS_ORDER if c.get(k)) + ".",
            (f"The scored runs reported a mean {self.metric} of {pct(sum(_num(r['reported_accuracy']) for r in sc) / len(sc))} "
             f"and measured {pct(sum(_num(r['true_accuracy']) for r in sc) / len(sc))} on the held-out cases."
             if sc else ""),
            "Table~\\ref{tab:runs} lists every run.",
        )
        rows = [[tt(r.get("id")), tex(r.get("status") or "--"), pct(r.get("reported_accuracy")), pct(r.get("true_accuracy")),
                 pts(r.get("gap")), str(r.get("n_actions") if r.get("n_actions") is not None else "--")] for r in self.runs]
        self.table("lllrrr", ["Run", "Status", "Reported", "Measured", "Gap (pts)", "Actions"], rows,
                   f"Every run: the {tex(self.metric)} it reported, the {tex(self.metric)} measured on held-out cases, the gap "
                   "in percentage points, and the number of actions it took.", "runs", long=True)
        failed = [r for r in self.runs if r.get("status") == "failed" and r.get("reason")]
        if failed:
            self.para("The failed runs ended for these reasons: "
                      + "; ".join(f"{tt(r['id'])}: {tex(clip(r['reason'], 140))}" for r in failed) + ".")

    def results_methods(self) -> None:
        labelled = [r for r in self.runs if r.get("labels")]
        if not labelled:
            return
        per_run: dict[str, Counter] = {}
        total: Counter = Counter()
        for r in labelled:
            cnt = Counter(lab for labs in r["labels"] if isinstance(labs, list) for lab in labs)
            per_run[str(r["id"])] = cnt
            total.update({k: 1 for k in cnt})
        top = [k for k, _ in total.most_common(10)]
        if not top:
            return
        self.sub("What the agents did")
        groups = {s: g for s in ("honest", "unclear", "inflated") if (g := [r for r in labelled if r.get("status") == s])}
        self.para(
            "Each run's actions were labelled with the steps they perform. Table~\\ref{tab:steps} shows, for the",
            "most common steps, how many runs in each group took the step at least once. The plans the agents kept",
            "for themselves are in Appendix~\\ref{sec:plans}.",
        )
        rows = [[tt(k)] + [str(sum(1 for r in g if per_run[str(r["id"])].get(k))) for g in groups.values()] for k in top]
        self.table("l" + "r" * len(groups), ["Step"] + [f"{s.capitalize()} ({len(g)})" for s, g in groups.items()], rows,
                   "Runs in each group that took each step at least once.", "steps")

    def results_split(self) -> None:
        sp = self.case.get("split")
        self.sub("What separated honest from inflated runs")
        if not isinstance(sp, dict) or not sp.get("label"):
            if not self.counts().get("honest"):
                self.para("No run was honest, so there is no honest group to compare with: the split is empty, and the",
                          "investigator worked from the inflated runs and the data alone.")
            else:
                self.para("No step separated the honest runs from the inflated ones.")
            return
        self.para(
            f"The step that best separated the groups was {tt(sp['label'])}: {pct(sp.get('honest_rate'), 0)} of the "
            f"{sp.get('n_honest', '--')} honest runs took it, against {pct(sp.get('inflated_rate'), 0)} of the "
            f"{sp.get('n_inflated', '--')} inflated runs.",
            (f"Experiments could cut into run {tt(sp['fork_run_id'])} at action {sp.get('fork_at')}." if sp.get("fork_run_id") else ""),
            "The examples below are one action from each group, verbatim.",
        )
        if sp.get("honest_example"):
            self.para("\\textbf{From an honest run.}")
            self.add(listing(sp["honest_example"], 24))
        if sp.get("inflated_example"):
            self.para("\\textbf{From an inflated run.}")
            self.add(listing(sp["inflated_example"], 24))

    def results_explanations(self) -> None:
        if not self.expl:
            return
        self.sub("The explanations, as written before testing")
        self.para(f"The investigator recorded {plural(len(self.expl), 'explanation')}. "
                  "Table~\\ref{tab:expl} gives where each stands; below it, each in the investigator's words.")
        rows = []
        for e in self.expl:
            ev = e.get("evidence") or {}
            status = str(e.get("status") or "untested")
            if status == "inconclusive" and e.get("tested_by") and e["tested_by"] != "fix":
                status = "open"  # the server's word for a hypothesis tested to an open score (evidence.method_outcome)
            sc = score_text(ev.get("score")) if ev else "--"
            if not ev and e.get("tested_by"):
                f = (self.case.get("forks") or {}).get(e["tested_by"])
                sc = score_text(f.get("score")) if isinstance(f, dict) else "--"
            rows.append([tt(e["id"]), tt(e.get("step") or "--"), tex(e.get("kind") or "--"), tex(status), sc,
                         tex(e.get("tested_by") or ", ".join(ev.get("experiments") or []) or "--")])
        self.table("llllrl", ["ID", "Step", "Kind", "Status", "Score", "Tested by"], rows,
                   "The investigator's explanations, the step each names, and where the evidence left it.", "expl")
        for e in self.expl:
            meta = []
            if e.get("by"):
                meta.append(f"Proposed by {tex(e['by'])}.")
            if e.get("confidence"):
                meta.append(f"Stated confidence: {tex(e['confidence'])}.")
            if e.get("at"):
                meta.append(f"Recorded {when(e['at'])}.")
            self.heading(f"{tex(e['id'])}: {tt(e.get('step') or 'no step named')}.")
            self.para(*meta)
            for key, who in (("why", "the investigator"), ("detail", "its evidence"), ("prediction", "its prediction"),
                             ("falsified_if", "wrong if")):
                if e.get(key):
                    self.add(quote(e[key], who))

    def results_forks(self) -> None:
        if not self.forks:
            return
        self.sub("The experiments")
        for f in self.forks:
            fid = str(f["id"])
            ev = f.get("evidence") or {}
            built = f.get("built") or {}
            step = f.get("label") or (f.get("change") or "").split(":")[-1]
            self.add(Subsubsection(NoEscape(f"Experiment {tex(fid)}: {tt(step or 'a change')}"), numbering=False, label=False))
            bits = [f"Copies were cut from run {tt(f.get('source_run'))}"
                    + (f" at action {f['fork_at']}" if f.get("fork_at") is not None else "")
                    + (f" ({tex(str(f['anchor']).replace('_', ' '))})" if f.get("anchor") else "") + "."]
            tested = f.get("suspect_id") or f.get("hypothesis_id")
            if tested:
                bits.append(f"It tests {tt(tested)}.")
            if f.get("intervention"):
                bits.append(f"The change: {tex(f['intervention'])}.")
            if built:
                bits.append(f"Copies built by fork: {built.get('fork', 0)}; rebuilt by replay: {built.get('replay', 0)}.")
            if f.get("fork_mode"):
                asked = f.get("fork_mode_requested")
                bits.append(f"Fork mode: {tex(f['fork_mode'])}"
                            + (f" (asked for {tex(asked)}; {tex(f.get('fork_mode_fallback') or '')})" if asked and asked != f["fork_mode"] else "")
                            + ".")
            if f.get("preregistered_at"):
                bits.append(f"Prediction registered {when(f['preregistered_at'])}.")
            self.para(*bits)
            if f.get("prediction"):
                self.add(quote(f["prediction"], "prediction"))
            if f.get("reason"):
                self.add(quote(f["reason"], "why this experiment"))
            arms = f.get("arms") or {}
            if arms:
                rows = []
                for a in sorted(arms, key=lambda a: list(ARM_WORDS).index(a) if a in ARM_WORDS else 9):
                    x = arms[a] or {}
                    rows.append([tex(a)] + [str(x.get(k, "--")) for k in ("total", "scored", "inflated", "honest", "failed")]
                                + [pct(x.get("mean_reported")), pct(x.get("mean_true"))])
                self.table("lrrrrrrr", ["Arm", "Copies", "Scored", "Inflated", "Honest", "Failed", "Reported", "Measured"], rows,
                           f"Experiment {tex(fid)}: each arm's copies, how many came out inflated or honest, and their mean "
                           f"reported and measured {tex(self.metric)}.", f"arms-{fid}")
            pairs = [p for p in (f.get("pairs") or []) if isinstance(p, dict)]
            if pairs:
                rows = [[str(p.get("i", i + 1)), pts(p.get("control_gap")), pts(p.get("changed_gap")), "yes" if p.get("agree") else "no"]
                        for i, p in enumerate(pairs)]
                self.table("rrrl", ["Pair", "Control gap", "Changed gap", "Agrees"], rows,
                           f"Experiment {tex(fid)}: each pair's gap in percentage points, control against changed, and whether "
                           "it agreed with the prediction.", f"pairs-{fid}")
            dropped = [d for d in f.get("dropped_pairs") or [] if isinstance(d, dict)]
            if dropped:
                self.para(f"{plural(len(dropped), 'pair')} did not count: "
                          + "; ".join(tex(d.get("reason") or d.get("why") or "dropped") for d in dropped) + ".")
            if ev:
                self.para(
                    f"\\textbf{{Result.}} {kofn(ev.get('agree'), ev.get('pairs'))} pairs agreed; the running score is "
                    f"{score_text(ev.get('score', f.get('score')))}, so the evidence is {_level_words(ev.get('level') or f.get('level'))}.",
                    f"Forced copies inflated: {kofn(ev.get('forced_inflated'), ev.get('forced_total'))}; control copies: "
                    f"{kofn(ev.get('control_inflated'), ev.get('control_total'))} (one-sided Fisher exact $p$ = "
                    f"{p_text(ev.get('p_value'))}, shown only).",
                )
            rescored = f.get("rescored")
            if isinstance(rescored, dict) and rescored.get("copies"):
                self.para(f"{plural(len(rescored['copies']), 'copy', 'copies')} whose server-side scoring failed during the run "
                          "were scored afterwards from their saved outputs, deterministically and with no agent involved.")

    def results_verdict(self) -> None:
        v = self.verdict
        if not v.get("sentence"):
            return
        self.sub("The verdict")
        ev = self.ev()
        self.add(quote(v["sentence"], "the investigator's verdict"))
        bits = []
        if ev:
            which = f"experiment {tex(v['fork_id'])}" if v.get("fork_id") else "the experiment"
            bits.append(f"It rests on {which}, with evidence {_level_words(ev.get('level'))}: "
                        f"{kofn(ev.get('agree'), ev.get('pairs'))} pairs agreed, score {score_text(ev.get('score'))} of "
                        f"{SUPPORTED_SCORE:g}.")
        if v.get("confidence"):
            bits.append(f"Its stated confidence is {tex(v['confidence'])}.")
        for key, word in (("supported", "Supported"), ("cleared", "Cleared"), ("open", "Still open")):
            if v.get(key):
                bits.append(f"{word}: {', '.join(tt(x) for x in v[key])}.")
        self.para(*bits)
        if v.get("limits"):
            self.add(quote(v["limits"], "the limits it lists"))
        sup = [x for x in self.case.get("superseded_verdicts") or [] if isinstance(x, dict)]
        if sup:
            self.para(f"{plural(len(sup), 'earlier verdict was', 'earlier verdicts were')} replaced:")
            for x in sup:
                self.add(quote(x.get("sentence", ""), "replaced verdict" + (f" ({x['stale']})" if x.get("stale") else "")))
        rub = [r for r in self.case.get("rubric") or [] if isinstance(r, dict)]
        if rub:
            back = [r for r in rub if r.get("result") == "needs_revision"]
            self.para(f"The grader reviewed the verdict {plural(len(rub), 'time')}"
                      + (f" and sent it back {plural(len(back), 'time')} before it passed." if back else " and passed it."))
            for r in back[:4]:
                self.add(quote(r.get("explanation", ""), f"grader, review {int(r.get('iteration') or 0) + 1}"))

    def results_audit(self) -> None:
        audit = self.case.get("audit") or {}
        runs = audit.get("runs") if isinstance(audit, dict) else None
        if not isinstance(runs, dict) or not runs:
            return
        qs: list[tuple[str, str]] = []
        for r in runs.values():
            for q in (r or {}).get("questions") or []:
                if isinstance(q, dict) and (q.get("id"), q.get("question")) not in qs:
                    qs.append((q.get("id"), q.get("question")))
        if not qs:
            return
        self.sub("The audit sheet")
        self.para("Plain code answered the same questions for every scored run, from its files:",
                  "; ".join(f"({i + 1}) {tex(q)}" for i, (_, q) in enumerate(qs)) + ".")
        rows = []
        for rid in sorted(runs):
            ans = {q.get("id"): q.get("answer") for q in (runs[rid] or {}).get("questions") or [] if isinstance(q, dict)}
            rows.append([tt(rid), tex((runs[rid] or {}).get("status") or "--")] + [tex(ans.get(i) or "--") for i, _ in qs])
        self.table("ll" + "c" * len(qs), ["Run", "Status"] + [f"({i + 1})" for i in range(len(qs))], rows,
                   "The audit sheet: each run's answer to each question.", "audit", long=True)

    def results_diagnosis(self) -> None:
        trace = [t for t in self.case.get("trace") or [] if isinstance(t, dict)]
        fix = self.case.get("fix") or {}
        if trace:
            self.sub("Diagnosis")
            runs = sorted({str(t.get("run_id")) for t in trace})
            self.para(f"The code tracer read {plural(len(trace), 'failure')} in {plural(len(runs), 'run')} "
                      f"({', '.join(tt(r) for r in runs)}).")
            comp = self.case.get("trace_comparison") or {}
            if comp.get("sentence"):
                self.add(quote(comp["sentence"], "the tracer, comparing runs"))
            for t in trace:
                self.heading(f"Run {tex(t.get('run_id'))}, line {tex(t.get('line', '?'))}.")
                if t.get("symptom"):
                    self.add(quote(t["symptom"], "symptom"))
                if t.get("excerpt"):
                    self.add(listing(t["excerpt"], 8))
                if t.get("why"):
                    self.add(quote(t["why"], "why"))
        if fix:
            self.sub("The fix, measured")
            meas = fix.get("measured") or {}
            fe = meas.get("evidence") or {}
            self.para(f"The fix changes line {tex(fix.get('line', '?'))} of {tt(fix.get('file_path') or 'the controller')} "
                      f"in run {tt(fix.get('run_id'))}" + (f" and tests {tt(fix['hypothesis_id'])}." if fix.get("hypothesis_id") else "."))
            if fix.get("description"):
                self.add(quote(fix["description"], "the proposed fix"))
            if fix.get("old_string") or fix.get("new_string"):
                self.add(listing(f"- {fix.get('old_string', '')}\n+ {fix.get('new_string', '')}", 12))
            if fix.get("prediction"):
                self.add(quote(fix["prediction"], "prediction"))
            b, a = meas.get("before") or {}, meas.get("after") or {}
            if b and a:
                self.para(
                    f"On the same {a.get('n', b.get('n', '--'))} held-out cases the unpatched code succeeded in "
                    f"{kofn(b.get('successes'), b.get('n'))} ({pct(b.get('true_accuracy'), 0)}) and the patched code in "
                    f"{kofn(a.get('successes'), a.get('n'))} ({pct(a.get('true_accuracy'), 0)}).",
                    f"The patch gained {meas.get('gained', fe.get('gained', 0))} cases and lost {meas.get('lost', fe.get('lost', 0))};",
                    f"the sign test calls this {tex(str(fe.get('level', 'not measured')).replace('_', ' '))}"
                    + (f" ($p$ = {p_text(fe.get('p_value'))})" if fe.get("p_value") is not None else "") + ".",
                    f"The explanation it tested is therefore {tex(fix['outcome'])}." if fix.get("outcome") else "",
                )
            if fix.get("verdict"):
                self.add(quote(fix["verdict"], "the investigator on the fix"))

    def discussion(self) -> None:
        self.section("Discussion", "discussion")
        ev = self.ev()
        level = ev.get("level")
        step = self.verdict.get("step_label") or self.verdict.get("step")
        inflated = self.counts().get("inflated", 0)
        if inflated:
            self.para(f"{plural(inflated, 'run')} of {len(self.runs)} reported a {self.metric} the held-out cases did not bear out.",
                      "This is the first finding and it does not depend on any explanation: the reports, taken at their word,",
                      "overstate what the agents built.")
        if level == "supported":
            self.para(f"The experiments support {tt(step)} as a cause: copies made to take it reported honestly while",
                      "their controls did not, pair after pair, past the score the rule requires. The claim is causal in",
                      "the narrow sense the experiment tests: from this fork point in this run, taking the step changes",
                      "the report.")
        elif level == "cleared":
            self.para(f"The experiments clear {tt(step)}: taking it did not change the reports. The inflation has some",
                      "other cause, among the explanations still open or not yet proposed.")
        elif level == "inconclusive":
            self.para("The experiment could not decide: no control copy reproduced the inflation from its fork point, so",
                      "no pair counted. Another source run or an earlier fork point is the next thing to try.")
        elif ev:
            need = max(0, NEEDED_PAIRS - int(ev.get("pairs") or 0))
            self.para(f"The evidence for {tt(step)} is open. It leans one way ({kofn(ev.get('agree'), ev.get('pairs'))} pairs",
                      f"agreed, score {score_text(ev.get('score'))}) but has not reached the {SUPPORTED_SCORE:g} the rule",
                      "requires, so this report says the step \\emph{suggests} why the claims were inflated and does not",
                      "say it caused them." + (f" At least {plural(need, 'more agreeing pair')} would be needed." if need else ""))
        else:
            self.para("No experiment has reported yet, so no explanation can be weighed.")
        if (self.case.get("fix") or {}).get("outcome") == "contradicted":
            self.para("The measured fix made the code worse, which goes against the code explanation it tested. A patch",
                      "that fails does not prove the line innocent (the patch itself may be wrong), but this one does not",
                      "support it.")

        self.sub("Limitations")
        lim = [
            "Each experiment cuts copies from one source run at one moment; what holds there may not hold for other runs "
            "or other moments.",
            "The copies are fresh agents given the original's history; they are not the original agent, and some "
            "differences between copies are noise.",
            f"The held-out cases are a sample: a measured {self.metric} has its own error, which the gap threshold only "
            "partly absorbs.",
        ]
        if any((f.get("built") or {}).get("replay") for f in self.forks):
            lim.append("Some copies were rebuilt by replaying the original's commands rather than forked, so their machine "
                       "state matches the original's only as far as the replay reproduces it.")
        rec = self.cfg.get("recording") or {}
        lim += [f"After the run: {note}." for note in rec.get("after_the_run") or []]
        if rec.get("trimmed"):
            lim.append(f"Recording: {rec['trimmed']}.")
        self.items([tex(x) for x in lim])
        if self.verdict.get("limits"):
            self.para("The investigator's own list of limits is quoted with its verdict above.")

    def costs(self) -> None:
        costs = self.case.get("costs") or {}
        if not costs:
            return
        self.section("Cost", "cost")
        groups: dict[str, dict] = OrderedDict()
        for k, s in (costs.get("scopes") or {}).items():
            if not isinstance(s, dict):
                continue
            g = "Agent runs" if k.startswith("run:") else "Fork copies" if k.startswith("fork:") else k.split(":")[0].replace("_", " ").capitalize()
            acc = groups.setdefault(g, {"n": 0, "in": 0, "out": 0, "usd": 0.0})
            acc["n"] += 1
            acc["in"] += int(s.get("input_tokens") or 0)
            acc["out"] += int(s.get("output_tokens") or 0)
            acc["usd"] += sum(float(s.get(f) or 0) for f in ("model_usd", "vm_usd", "sandbox_usd"))
        self.para(f"The batch spent {usd(costs.get('spent_usd'))} of its {usd(costs.get('budget_usd'))} budget.")
        if groups:
            self.table("lrrrr", ["Part", "Scopes", "Input tokens", "Output tokens", "Cost"],
                       [[tex(g), str(a["n"]), f"{a['in']:,}", f"{a['out']:,}", usd(a["usd"])] for g, a in groups.items()],
                       "What the batch spent, by part.", "cost")

    def appendix(self) -> None:
        self.doc.append(NoEscape(r"\appendix"))
        self.section("The agents' own plans", "plans")
        planned = [r for r in self.runs if r.get("todos")]
        if not planned:
            self.para("The runs in this batch kept no plan of their own.")
        else:
            self.para("Each agent kept a list of what it meant to do. These are the lists as the runs left them.")
        for r in planned:
            todo = [t for t in r["todos"] if isinstance(t, dict) and t.get("content")]
            if not todo:
                continue
            self.heading(f"Run {tex(r['id'])} ({tex(r.get('status') or '--')}).")
            self.items([tex(t["content"]) + (f" \\textit{{({tex(t['status'])})}}" if t.get("status") not in (None, "completed") else "")
                        for t in todo[:14]], tight=True)

        self.section("Configuration and identifiers", "config")
        rec = self.cfg.get("recording") or {}
        rows = [["Platform run ID", tt(self.id)]]
        if rec.get("source_batch"):
            rows.append(["Source batch", tt(rec["source_batch"])])
        if rec.get("saved_at"):
            rows.append(["Recorded", tex(rec["saved_at"])])
        for k in sorted(self.cfg):
            v = self.cfg[k]
            if k in {"domain_info", "recording"} or v is None or isinstance(v, (dict, list)):
                continue
            rows.append([tex(k.replace("_", " ")), tex(v)])
        rows.append(["Phase", tex(self.case.get("phase") or "--")])
        self.table("p{5cm}p{10cm}", ["Field", "Value"], rows, "The batch's configuration.", "config", long=True)
        vms = [r for r in self.runs if r.get("vm_id")]
        if vms:
            self.table("ll", ["Run", "Sandbox machine"], [[tt(r["id"]), tt(r["vm_id"])] for r in vms],
                       "The sandbox machine each run ran in.", "vms", long=True)
        if rec.get("note"):
            self.add(quote(rec["note"], "recording note"))

    def build(self) -> Document:
        self.title()
        self.abstract()
        self.introduction()
        self.methods()
        self.results_claims()
        self.results_methods()
        self.results_split()
        self.results_explanations()
        self.results_forks()
        self.results_verdict()
        self.results_audit()
        self.results_diagnosis()
        self.discussion()
        self.costs()
        self.appendix()
        return self.doc


def build_document(case: dict, batch_id: str) -> Document:
    """The batch's findings as a PyLaTeX document."""
    return Paper(case, batch_id).build()


def build_paper(case: dict, batch_id: str) -> str:
    """The batch's findings as LaTeX source."""
    return build_document(case, batch_id).dumps()


# ── the PDF ──────────────────────────────────────────────────────────────────


class PaperError(Exception):
    """No LaTeX engine on this machine, or the document did not compile. `status` is the HTTP status to answer."""

    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = status


ENGINE = os.environ.get("ORRO_LATEX", "pdflatex")
_cache: OrderedDict[str, bytes] = OrderedDict()
_cache_lock = threading.Lock()
CACHE_SIZE = 16


def engine() -> str | None:
    return shutil.which(ENGINE)


def compile_pdf(source: str, timeout: float = 90.0) -> bytes:
    """The PDF of `source`, compiled twice (for the references) with no shell escape and no file reads or writes
    outside its own folder. Cached by the source's hash, so a second export of an unchanged batch is instant."""
    key = hashlib.sha256(source.encode()).hexdigest()
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    exe = engine()
    if exe is None:
        raise PaperError(f"This server has no LaTeX engine ({ENGINE}); the paper's LaTeX source can still be downloaded.", 503)
    env = {**os.environ, "openin_any": "p", "openout_any": "p", "shell_escape": "f"}
    with tempfile.TemporaryDirectory(prefix="orro-paper-") as d:
        (Path(d) / "paper.tex").write_text(source, encoding="utf-8")
        cmd = [exe, "-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "paper.tex"]
        for _ in range(2):
            try:
                done = subprocess.run(cmd, cwd=d, env=env, capture_output=True, timeout=timeout)
            except subprocess.TimeoutExpired:
                raise PaperError("The paper took too long to compile.") from None
            if done.returncode != 0:
                log = (Path(d) / "paper.log")
                tail = log.read_text(errors="replace")[-1500:] if log.exists() else done.stdout.decode(errors="replace")[-1500:]
                errs = [ln for ln in tail.splitlines() if ln.startswith("!")]
                raise PaperError("The paper did not compile: " + (" ".join(errs[:2]) or tail[-300:]))
        pdf = (Path(d) / "paper.pdf").read_bytes()
    with _cache_lock:
        _cache[key] = pdf
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return pdf


SAFE_ID = re.compile(r"[^A-Za-z0-9._-]+")


def filename(batch_id: str, ext: str) -> str:
    return f"orro-findings-{SAFE_ID.sub('-', batch_id)}.{ext}"
