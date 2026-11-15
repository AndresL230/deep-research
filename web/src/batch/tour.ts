// The How it works tour's ring and bubble (how.ts draws them; this places them). The stage names, as a selector, the
// part of its picture to point at (`data-how-target`). The ring is drawn round that part and dims the rest of the
// stage; the bubble sits under it. Without a part to point at (the picture is
// not there, or has no size yet) the ring is off and the bubble stays where the page put it, under the picture.
//
// DOM only, and called after every paint: morph takes the positions off again each time it patches the page. So the
// ring and the bubble are put back where they were with no motion, and move (once) only when their place has changed:
// from one stop to the next, or when the picture under them has moved.

const PAD = 6;
const GAP = 12;
const EDGE = 12;
/** A stage this narrow or narrower is a phone's: the picture sits under the text and runs the screen's width. */
const NARROW = 400;
/** On a narrow stage, the room kept between the bubble and the stage's left and right edges. */
const SIDE = 16;
/** The bubble's widest (how.css `.hw-tip`). */
const TIP_MAX = 300;

/** Where the ring and the bubble were last put, as the style text that put them there. Null when they are not shown. */
let last: { ring: string; tip: string } | null = null;

/** Put `el` at `to`. From `from`, with the stylesheet's glide, when it was somewhere else; otherwise at once, with no
 *  motion: a repaint that changes nothing must not play the arrival again. */
function settle(el: HTMLElement, from: string | null, to: string): void {
  if (!from || from === to) { el.style.cssText = `${to};transition:none`; return; }
  el.style.cssText = `${from};transition:none`;
  // The start is taken in before the glide is switched back on.
  void el.offsetWidth;
  el.style.cssText = to;
}

/** Place the ring and the bubble of the stage inside `root`, if there is one. */
export function placeHowTour(root: ParentNode): void {
  const stage = root.querySelector<HTMLElement>("[data-how-stage]");
  if (!stage) { last = null; return; }
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
    // Out of the flow where it last was (the stage's corner the first time), and still, while it is measured.
    tip.classList.add("is-placed");
    tip.style.cssText = `${last?.tip ?? `left:0;top:0${fit}`};transition:none`;
    // The ring is lit before anything is measured, so a repaint does not fade it in again.
    ring.classList.add("is-on");
    if (last) ring.style.cssText = `${last.ring};transition:none`;
    stage.style.minHeight = "";
  }
  const t = target?.getBoundingClientRect();
  if (!ring || !t || !t.width || !t.height) {
    ring?.classList.remove("is-on");
    ring?.removeAttribute("style");
    tip?.classList.remove("is-placed");
    tip?.removeAttribute("style");
    stage.style.minHeight = "";
    last = null;
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
  const ringAt = `left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px`;
  ring.classList.add("is-on");
  settle(ring, last?.ring ?? null, ringAt);
  if (!tip) { last = { ring: ringAt, tip: "" }; return; }
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  // Under the part, and never over the picture: when the picture goes on below the ringed part (a tile in the middle
  // of a grid, a bar with a note under the chart), the bubble opens under the picture's last line instead.
  const pic = stage.querySelector<HTMLElement>(".hw-pic");
  const picEnd = pic ? pic.getBoundingClientRect().bottom - oy : 0;
  const top = Math.max(y + h, picEnd) + GAP;
  const left = Math.max(side, Math.min(x, stage.clientWidth - tw - side));
  const arrow = Math.max(14, Math.min(x + w / 2 - left, tw - 14));
  const tipAt = `left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;--hw-ax:${arrow.toFixed(1)}px${fit}`;
  settle(tip, last?.tip || null, tipAt);
  last = { ring: ringAt, tip: tipAt };
  // With no room left under it, the stage grows to hold the bubble.
  stage.style.minHeight = top + th + EDGE > stage.clientHeight ? `${Math.ceil(top + th + EDGE + stage.clientTop * 2)}px` : "";
}
