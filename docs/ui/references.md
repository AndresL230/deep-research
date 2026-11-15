# References studied (Phase A)

## Links

The brief's three link slots were placeholders. These were used, pending confirmation:

- Design system 1: Orro Design System, https://claude.ai/artifact/Mkyrymtke9AJcHgtJGiygz
- Design system 2: Orro Landing, https://claude.ai/artifact/Y4YnY2w14TVAbtdgPbxp7r
- Landing page: orrolab.dev (named in the Orro Landing system; not opened in this session)
- Reference site: https://mubien.com/case/lifemed-website-and-motion

## Mubien, the Lifemed case study

Measured in a live browser at 1312 px wide on 14 November 2026. The page is 8416 px tall.

### Type

- **Two sizes on the whole page.** The headline is 53.5 px on a 61.2 px line. Everything else is 13 px on an 18 px
  line: section labels, body copy, buttons, captions.
- **One family, two weights.** 400 for all text, 700 only for the active section label.
- **Four text colours.** Ink `rgb(29,29,29)`, body `rgb(107,107,107)`, quiet `rgb(161,161,161)`, white on dark.

### Layout

- 8 px page margin, 8 px gaps between frames, 8 px corner radius. One spacing value does all three jobs.
- A sticky left rail, 210 px wide, holds three section names: About the Project, MB Approach, Outcome. Only the
  section in view shows its text; the other two are grey single lines. Copy is disclosed as you scroll, never all at
  once.
- The media column is 1079 px wide and carries the page. Rows, in order:

| Row | Frames | Ratios |
| --- | --- | --- |
| 1 | one full-width video, 1079 × 720 | 3:2 |
| 2 | two halves, 536 × 357 each | 3:2, 3:2 |
| 3 | 716 × 477 and 356 × 477 | 3:2 beside 3:4 |
| 4 | 356 × 618 and 716 × 618 | the same split, mirrored and taller |
| 5 | two halves, 536 × 618 each | about 7:8 |

- A fixed bar floats at the bottom centre (343 × 64): a logo tile, "Back to work", a menu button.
- The page closes on a two-line statement and one grey link.

### Words against pictures

About the Project is one paragraph of about 30 words. MB Approach is two paragraphs of about 85 words. Ten frames carry
everything else. Inside the frames there is almost no sentence: labels, names and numbers only.

### What is inside the frames

- **Focus by depth.** A graph of claim files: the card in focus ("837 Claim File", an id, a green dot) is sharp, its
  neighbours are blurred and faded, thin lines join them.
- **Three steps as three cards.** "Analyze", "Integrate", "Automate": one small coloured tile and one word each.
- **A bento of parts.** A rendered object, a type specimen, a photo, a ribbon with one chip, and a number pair: "21%"
  in black over "80%" in grey.
- **A dashboard as a figure.** Two white cards on a soft ring. Each card is a title, one grey line, then one chart: a
  ring with "96 Anomalies" at its centre; grey and blue bars with one bar labelled directly ("Recoverable") and no
  legend. Under them three stat tiles: two muted grey, one white. One tile is lit; the others recede.
- **A toast as an event.** "Lifemed · 3.1k claim issues resolved · now" on glass, over the ribbon.
- **A list row.** In the menu frame each row is an icon, a title and one line of description.
- **Grounds.** Each frame has one quiet ground: flat warm grey with a faint dot grid, or a soft lilac gradient. The
  component floats in the middle and takes roughly half the frame's width.

### Motion

Videos are 4 to 5 second loops, muted, autoplaying. One thing moves per loop: a node comes into focus, a shape turns.
Text does not animate.

### Numbers

Whole values with their unit attached: "96 Anomalies", "< 46 hrs", "10%", "$48,210,722". The unit or noun sits under or
beside the number, never in a sentence.

## What to take from it for Orro

| Mubien does | Orro today | Take |
| --- | --- | --- |
| Two type sizes | At least six on the fork page | One claim size, one small size, mono for ids |
| One idea per frame, half the frame empty | Five sections per stage | One figure per stage on a quiet ground |
| Sharp in focus, neighbours blurred | Every tile and card at full strength | One run or one arm in focus, the rest receded |
| Title, one grey line, one chart | Title, sentence, two bars, axis, gap, caption, note | The same three-part card everywhere |
| One lit tile among muted tiles | Five equal stat tiles | Light the one number that answers the screen's question |
| One bar labelled directly | Legends and footnotes | Label the bar that matters, drop the legend |
| Copy disclosed by a sticky rail | Everything printed at once | The stage rail owns the words; details open on demand |
| Loops where one thing moves | Text typing in, cards growing | Motion only for rewind, split and the meter |
| "21%" over "80%" | "Claimed 89.2% · Measured 75.1% · +14.1 pts claimed above measured" | Claimed over True, the gap beside them |

## The two Orro systems

Both were read earlier in this session from their README and token files.

- **App (Orro Design System):** Geist at 400 and 500, ground `#f7f7f5` or `#15171b`, hairlines, radii 4 px for controls
  and 8 px for cards, nothing pill-shaped, one dark button per view, purple only for what is live or interactive.
  Status pairs a tinted ground with a word. Its README says to state what happened with the number and to put a real
  question as a page heading.
- **Landing (Orro Landing):** Hanken Grotesk at 400 and 500, white ground with warm grey panels, a gradient used as
  light only, a 1176 px column. Its README says every word is on the page from the first frame and only pictures
  move. The app's arrival motion breaks that rule.

## Outside patterns

Not re-researched here. Notes from earlier in this session are in `research_notes/Orro hackathon winning angle/` (paper
figures and captions, experiment tools, product-tour practice). No `frontend-design` skill is installed in this
session; the artifact design guidance and the data visualisation skill were the ones available.

## Two Lifemed motion clips (vid1, vid2)

Supplied by the team on 14 November 2026 as `vid1.mp4` (9.2 s) and `vid2.mp4` (12.4 s), both 3240 × 2160 at 30 fps.
Studied from contact sheets (16 frames each) and ten enlarged frames.

### vid1, scene 1 (0 to about 3.7 s): one job moves down a rail

- Five or six identical white cards sit on thin grey rails. Only the centre card is sharp. The others are blurred and
  cut by the frame's edge, so they read as "more of the same" without being read.
- The card is two lines, an icon tile on the left and a status mark on the right. Line 1 is the name ("837 Claim
  File"), line 2 the id in grey.
- The same card changes state in place, never moving or resizing:
  1. A spinner in the icon tile, no status.
  2. The icon becomes "$" and a small green dot appears on the right.
  3. Line 1 becomes the result, "$3,920.00". The name drops to line 2 and replaces the id. The dot grows into a green
     disc with a tick.
- The result takes the title's place. The name is demoted, not the number.
- A short bright pulse runs along the rail into the card and out the other side: cause, then effect.
- The ground starts as a saturated magenta and blue mesh and fades to near white as the job completes. Colour means
  something is happening; calm means done.

### vid1, scene 2 (about 4.3 to 9.2 s): three steps, one at a time

- A glass ribbon wipes the first scene away.
- Three equal white cards on flat grey. Each holds a small gradient tile at the top left and one word at the bottom
  left: Analyze, Integrate, Automate. Most of each card is empty.
- The steps light in order. The active card gets a thin glowing edge on two corners and its tile animates into its
  meaning: bars rise for Analyze, two squares slide together for Integrate, a path joins two corners for Automate.
  Then the glow moves on. The other cards stay fully visible and still.
- There is no sentence anywhere in the clip.

### vid2: hover shows one thing in one place

- A nav bar sits alone on a large warm grey ground and takes about a third of the frame's width.
- The cursor reaches "Platform". That link gets an underline and its chevron flips; the other four links fade to
  about a quarter strength. A white panel opens under the bar at the bar's own width.
- The panel has three columns: a preview on the left (one picture, a title, three lines, "Learn more"), four rows in
  the middle (icon tile, title, one grey line), six plain links on the right under "More".
- Hovering a row does three things together: the row gets a grey fill, its icon tile inverts to black, and the
  preview's picture cross-fades to that row's picture. The preview's text stays where it is.
- When the cursor leaves, the panel blurs out and the dimmed links come back.
- Each row is held for about a second and a half; each change takes about a quarter of a second.

### What these give Orro

| Pattern | Where it replaces what |
| --- | --- |
| Result takes the title's place | A run tile or a fork arm reads "0 of 4 inflated" first, its name second |
| One card sharp, the rest blurred | The step that differs, the forced arm, the run in focus |
| A pulse along the rail | The fork: the run rewinds to the cut, then the copies leave it |
| Steps light one at a time | The investigator's progress: suspect, experiment, verdict |
| Hover a row, one preview changes | Four arm cards, "Exact step" and "Show the 16 copies" become four rows and one preview |
| Siblings dim when one is active | The stage rail and the arm list |
| Colour while working, calm when done | The lilac haze at the top of every page, which today never goes away |
