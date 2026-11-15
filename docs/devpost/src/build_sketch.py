"""Assembles the sketch figures: one artifact page, plus a standalone page per figure for PNG capture."""
from pathlib import Path
OUT = Path(__file__).parent
JS = (OUT / "sketch.js").read_text()
FONT = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Patrick+Hand&display=swap">'
ROUGH = '<script src="https://cdn.jsdelivr.net/npm/roughjs@4.6.6/bundled/rough.js"></script>'
HAND = '"Patrick Hand","Comic Sans MS","Segoe Print",cursive'
FIGS = [
    ("pipeline", "How Orro works: twelve agents, a score from hidden tests, a blind investigator, an approval, four groups of copies, a verdict.",
     "Six steps. The shaded box is what stays hidden: it feeds the score and the investigator cannot reach it."),
    ("experiment", "One run cut before its report and continued four ways. Only the group made to test stopped overclaiming: 0 of 4.",
     "One run, four endings. Only the copies made to run the missing test stopped overclaiming."),
    ("agent", "The investigator as one LangChain deep agent: three subagents, files it reads, hidden results it cannot, an approval before any test, and a grader on its verdict.",
     "The investigator is one LangChain deep agent. The grey words are the Deep Agents features doing each job."),
    ("math", "Four pairs of copies agree, each multiplying the score by 1.9, for a score of 13. A cause needs 20, so the verdict says suggests.",
     "Four pairs agree and the score is 13. A cause needs 20, so the verdict says “suggests”."),
]
def svg(fig, label, w="100%", h="auto"):
    return (f'<svg data-fig="{fig}" viewBox="0 0 1500 1000" role="img" aria-label="{label}" '
            f'style="display:block;width:{w};height:{h};font-family:{HAND.replace(chr(34), chr(39))}">'
            f'<rect x="0" y="0" width="1500" height="1000" fill="#ffffff"/></svg>')
page = f"""<title>Orro Figures</title>
<meta name="claude:viewport-fit-sides" content="cover">
{FONT}
<style>
/* layout: one column of four 3:2 pencil sketches on white paper, each with a one-line caption. Single look by choice: graphite on paper. */
:root {{ --paper:#ffffff; --ink:#262626; --soft:#6f6f6f; --rule:#d9d9d9; --hand:{HAND}; color-scheme:light; }}
body {{ background:var(--paper); color:var(--ink); font-family:var(--hand); font-size:20px; line-height:1.4;
  padding-block:36px 64px; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); }}
main {{ max-width:1040px; margin:0 auto; display:grid; gap:44px; }}
h1 {{ font-size:40px; font-weight:400; margin:0; text-wrap:balance; }}
p.lead {{ margin:6px 0 0; color:var(--soft); max-width:60ch; }}
figure {{ margin:0; display:grid; gap:10px; min-width:0; }}
.frame {{ border:1.5px solid var(--rule); overflow-x:auto; background:var(--paper); }}
.frame svg {{ min-width:640px; }}
figcaption {{ color:var(--soft); max-width:64ch; }}
</style>
<main>
<header><h1>Orro, in four sketches</h1>
<p class="lead">How it works, what happened to one run, what the investigator is made of, and how the verdict picks its word.</p></header>
{"".join(f'<figure><div class="frame">{svg(f, l)}</div><figcaption>{c}</figcaption></figure>' for f, l, c in FIGS)}
</main>
{ROUGH}
<script>
{JS}
</script>
"""
(OUT / "orro-figures.html").write_text(page)
for f in [x[0] for x in FIGS] + ["thumb"]:
    solo = (f'<!doctype html><html><head><meta charset="utf-8">{FONT}<style>html,body{{margin:0;background:#fff}}</style></head>'
            f'<body>{svg(f, f, "1500px", "1000px")}{ROUGH}<script>{JS}</script></body></html>')
    (OUT / f"sk-{f}.html").write_text(solo)
print("ok")
