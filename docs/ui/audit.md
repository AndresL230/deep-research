# UI audit (Phase A)

Audited Saturday 14 November 2026 on the `demo-batch` fixture (tabular, simulated), with counts also taken on
`robot-demo-batch`. No real saved batch exists on this machine (`batches/` is absent). No code was changed for this
audit.

## How it was measured

- Screenshots: headless Chrome at 1440 and 1024 px wide, 2600 px tall, in `docs/ui/screens/` (12 files, 3.3 MB,
  untracked). Pages were captured with reduced motion, because with motion on the pages were still arriving when the
  capture fired.
- Counts: taken in a live browser at 1312 px wide from the page's own text. "Words" are tokens containing a letter,
  inside the scrolling page (the header and replay bar are not counted). "Numbers" are digit runs. "Controls" are
  buttons, links, folds and inputs. "Screens" is page height divided by a 773 px viewport.
- The word budget in the brief is 25 words of prose per screen.

| Screen | Words | Numbers | Controls | Screens tall |
| --- | ---: | ---: | ---: | ---: |
| Agents, replay finished (reveal), demo | 960 | 251 | 18 | 3.6 |
| What changed, demo | 121 | 20 | 8 | 1.1 |
| Investigator, demo | 28 | 2 | 9 | 0.9 |
| Fork, demo | 552 | 111 | 9 | 3.4 |
| Fork, robot | 728 | 141 | 11 | 4.3 |
| Verdict, robot | 473 | 85 | 7 | 2.6 |
| Run r02, demo | 159 | 29 | 5 | 3.0 |

The demo verdict count was not taken cleanly (the replay had restarted); from the screenshot it is about 230 words.

Not captured: the Start dialog (New batch), the approval card (the fixture has no pending approval), and the wall at the
end of the replay as an image (counted only). The 1024 px captures were saved for every page; only the verdict was read
in detail at that width, where the layout holds and the header links fold into a menu.

## Top five problems

1. **The one screen that works starts below the fold.** On the Agents page the wall of sandboxes begins about 1130 px
   down. Above it sit three chips, a headline, a count line, a two-line explainer, the stage rail, five stat tiles and
   two chart cards. While the agents run, every one of those instruments reads 0 or a dash.
2. **Each fact is told three to five times.** "Control 3 of 4 inflated, forced 0 of 4" appears as a fork section
   heading, in both arm cards, in the verdict headline, in the verdict's second paragraph, in the investigator's quote
   and in the squares under "Other explanations checked". On the finished Agents page "measured" appears 34 times and
   "claimed" 32 times.
3. **No stage has one figure.** Fork has five sections, each with a headline-weight sentence, 552 words and 111 numbers
   (728 and 141 on the robot batch) against a budget of 25 words. The eye has no first place to land after the
   question.
4. **Evidence is shown four ways and none is named as the one that counts.** The fork page gives "4 of 8 pairs",
   "4 of 4 pairs went the predicted way", Fisher p = 5/70 (0.071), permutation p = 1/70 (0.014) and a sequential
   score of 13.03 with a plan line at 20. It also prints internal references in the interface: "MASTER_PLAN 6.4",
   `forks.f1.children.*.gap`, `verdict.evidence`, `record_verdict`, "copy-on-write fork".
5. **The two stages that carry the idea are empty or folded.** Investigator shows the word "Done" and a button. What
   changed hides the actual difference between the runs behind "Show the two runs side by side" and shows the effect
   on the score instead, which is the Reveal's job.

Two smaller problems cut across every screen:

- **Words.** The interface says "Measured"; the brief fixes "True". The tabular word table in `words.ts` says
  "Reported" and "True", but the screens show "Claimed" and "Measured". Gaps are written "+14.1 pts" with one decimal,
  scores "89.2%"; the brief wants whole numbers ("Gap +14 pts").
- **Colour.** Purple means at least six things: the brand, the primary button, the replay bar, the investigator and
  LLM tags, the forced arm's border, and the fill of "The claim moved" tile. Green means honest, done and the plan
  line. Amber means Open and also the Person tag.

## Screen by screen

### Agents while running (wall)

- **Question:** Are the agents working?
- **Eye lands on:** the headline "Agents are running". Right, but the next thing is a row of five tiles reading 0, and
  the wall is a full screen further down.
- **Words and numbers:** the explainer under the headline ("12 agents on the same task, each in its own sandbox. Orro
  scores every one, finds the step...") repeats How it works. The section heading "Each agent at work, in its own
  sandbox" is followed by another sentence saying what an agent does. The Agents tile showed "6" over "12 working, 0
  waiting" mid count-up, which reads as a contradiction.
- **Controls:** the replay bar (play, restart, scrubber, three speeds, skip to end), the stage rail, a per-tile open
  arrow. The speeds and restart do not belong on the main view of a live batch.
- **Keep:** the grid of live sandboxes with code typing in each.

### Agents after the replay (reveal)

- **Question:** Which runs fooled themselves, and by how much?
- **Eye lands on:** the headline "6 of 12 agents claimed 89%. Measured on 154 rows they never saw: 75%." Right, though
  it is two sentences and four numbers.
- **Words and numbers:** 960 words and 251 numbers over 3.6 screens. The split is told by the headline, the count
  line, the stat tiles, the ring, the bar chart, every tile and the Key points section.
- **Controls:** 18. The claimed-against-measured chart and the ring answer the same question twice.
- **Keep:** one bar per agent showing the claimed part above the true part.

### What changed

- **Question:** Where do honest and inflated runs differ?
- **Eye lands on:** "Honest runs removed duplicate rows before splitting into train and test. Inflated runs did not."
  Right, and it is the best sentence in the product.
- **Words and numbers:** the next line says it again with counts ("6 of 6 honest runs, 0 of 6 inflated did this before
  splitting into train and test"). Each card then gives a claimed bar, a measured bar, an axis, a gap, "claimed above
  measured" and a leakage share: eight numbers that belong to the Reveal.
- **Controls:** one fold, "Show the two runs side by side", which hides the only picture that answers the question.
- **Keep:** the headline sentence.

### Investigator

- **Question:** What could explain the gap?
- **Eye lands on:** the word "Done". Wrong: the page gives no suspect, no prediction and no evidence.
- **Words and numbers:** 28 words. The hypothesis is behind "Show its log and hypothesis".
- **Controls:** the fold and a Notebook link.
- **Keep:** nothing on the surface; the hypothesis inside the fold is the content.

### Approval

Not reachable on the fixture. From the code (`lanes.ts`), the card's sentence reads "The investigator wants to fork run
r02 just before splitting into train and test: ..." followed by a note that names `request_forks` and "human-in-the-loop
interrupt". The tool name and the mechanism do not belong in front of the person approving.

### Fork

- **Question:** Is the suspect the cause?
- **Eye lands on:** a three-line, 30-word question. Right in kind, too long, and it uses "measured".
- **Words and numbers:** 552 words, 111 numbers. Before any result the page gives a hypothesis quote, a prediction
  paragraph that says no prediction was saved, a fork strip, a sentence restating the strip, and a paragraph about base
  VMs. The Evidence card is a large "4" in an otherwise empty box. The pair rows read "pair 1: control +17.4 pts,
  forced +2.1 pts, agrees x1.9".
- **Controls:** three folds ("Exact step", "Show the 8 copies", the pager). The Provenance table with JSON paths
  belongs behind a click.
- **Keep:** the fork strip (what every copy inherited, the cut, what the run did next) and the two arms side by side.

### Verdict

- **Question:** What did we learn?
- **Eye lands on:** "The fork suggests that not removing duplicate rows inflates the claim: 3 of 4 inflated without it,
  0 of 4 with it, 4 pairs. Open: supported needs 8 pairs." It is a double negative with four counts and a status in
  one sentence.
- **Words and numbers:** the paragraph under it restates it, the statistics line restates it in four measures, the
  investigator's quote restates it a third time. "Record and limits" lists five bullets, three of them internal.
- **Controls:** none that matter; the page ends in a text link.
- **Keep:** "The model didn't get worse. Its claim got honest." with its two numbers (claim −11.6 pts, model +1.5
  pts). That pair is the figure; today it is the third section.

### Replay controls, header, cost

- The replay bar holds seven controls and sits above every stage, including pages where nothing plays.
- The header holds four links, a breadcrumb, the Simulated chip, a token count, the theme switch and New batch. The
  Simulated chip is correctly always visible.
- There is no cost bar. The header shows "573k tokens"; the stat tile says "token counts only, no real spend".
- There is no investigator side panel. Each stage is a page with its own skeleton, so the layout bones change from
  stage to stage.

### Motion

Headings arrive a character at a time and cards grow from nothing. In automated capture the pages were unreadable until
motion was turned off. Under the brief's rule that motion only explains cause, this arrival motion is decoration.

## What the brief describes that the app does not have yet

- A Suspects board with several suspects. The fixture records one hypothesis.
- An evidence figure written as "25×". The app computes a sequential score (13.03 here) and calls it a measure that
  does not set the level.
- The statuses Supported, Cleared and Open. The app has Supported and Open.
- A cost bar in dollars. The fixture has token counts and no prices.

These need a decision before Phase C: draw them from data that exists, or leave them out.
