// The How it works tour's ring and bubble (how.ts draws them; this places them). The stage names, as a selector, the
// part of its picture to point at (`data-how-target`). The ring is drawn round that part and dims the rest of the
// stage; the bubble sits under it. Without a part to point at (the picture is
// not there, or has no size yet) the ring is off and the bubble stays where the page put it, under the picture.
//
// DOM only, and called after every paint: morph takes the positions off again each time it patches the page.

const PAD = 6;
const GAP = 12;
const EDGE = 12;
/** A stage this narrow or narrower is a phone's: the picture sits under the text and runs the screen's width. */
const NARROW = 400;
/** On a narrow stage, the room kept between the bubble and the stage's left and right edges. */
const SIDE = 16;
/** The bubble's widest (how.css `.hw-tip`). */
const TIP_MAX = 300;

/** Place the ring and the bubble of the stage inside `root`, if there is one. */
export function placeHowTour(root: ParentNode): void {
  const stage = root.querySelector<HTMLElement>("[data-how-stage]");
  if (!stage) return;
  const ring = stage.querySelector<HTMLElement>("[data-how-ring]");
  const tip = stage.querySelector<HTMLElement>("[data-how-tip]");
  const sel = stage.dataset.howTarget;
  let target: Element | null = null;
  try { target = sel ? stage.querySelector(sel) : null; } catch { target = null; }
  // The bubble leaves the page's flow before anything is measured: while it sits under the picture it pushes the
  // picture up, and the ring would be drawn where the part no longer is.
  // A narrow stage holds the bubble to its own width less SIDE each side, before the bubble is measured.
  const narrow = stage.clientWidth > SIDE * 2 && stage.clientWidth <= NARROW;
  const fit = narrow ? `;max-width:${Math.min(TIP_MAX, stage.clientWidth - SIDE * 2)}px` : "";
  const side = narrow ? SIDE : EDGE;
  if (target && ring && tip) {
    tip.classList.add("is-placed");
    tip.style.cssText = `left:0;top:0${fit}`;
    stage.style.minHeight = "";
  }
  const t = target?.getBoundingClientRect();
  if (!ring || !t || !t.width || !t.height) {
    ring?.classList.remove("is-on");
    ring?.removeAttribute("style");
    tip?.classList.remove("is-placed");
    tip?.removeAttribute("style");
    stage.style.minHeight = "";
    return;
  }
  const s = stage.getBoundingClientRect();
  // Positions are from the stage's padding box.
  const ox = s.left + stage.clientLeft;
  const oy = s.top + stage.clientTop;
  const x = t.left - ox - PAD;
  const y = t.top - oy - PAD;
  const w = t.width + PAD * 2;
  const h = t.height + PAD * 2;
  ring.style.cssText = `left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px`;
  ring.classList.add("is-on");
  if (!tip) return;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  // Always under the part: each picture puts its ringed part last, so the bubble opens over nothing that matters.
  const top = y + h + GAP;
  const left = Math.max(side, Math.min(x, stage.clientWidth - tw - side));
  const arrow = Math.max(14, Math.min(x + w / 2 - left, tw - 14));
  tip.style.cssText = `left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;--hw-ax:${arrow.toFixed(1)}px${fit}`;
  // With no room left under it, the stage grows to hold the bubble.
  stage.style.minHeight = top + th + EDGE > stage.clientHeight ? `${Math.ceil(top + th + EDGE + stage.clientTop * 2)}px` : "";
}
