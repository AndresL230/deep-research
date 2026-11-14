// Ported from Trov (~/Projects/trov/web/src/morph.ts) — the patcher core only (`morph`, `morphList`).
//
// In-place DOM patching for the conversation and the composer. Re-rendering them with innerHTML on every streamed
// word would replace every <img> (a chart reloads and flickers), every orb <canvas> (blank for a frame), restart
// every CSS animation (the shimmer, the cursor's blink), drop a text selection, and lose the composer's focus and
// caret. Patched, an element that is still there stays the element it was.
//
// Deliberately small: nodes pair by index, same-name nodes are patched, anything else is replaced.
// `data-morph-key` names what an element IS: two paired nodes whose keys differ are different things, so the new one
// replaces the old instead of being patched into it. A container marked `data-morph-list` pairs its children by key
// (`morphList`). Dropped from Trov: `paint` / `syncOverlays` / `paintRoot` (Trov's app-shell regions).

/** Make `live`'s attributes equal `next`'s. */
export function syncAttrs(live: Element, next: Element): void {
  for (const a of Array.from(live.attributes)) if (!next.hasAttribute(a.name)) live.removeAttribute(a.name);
  for (const a of Array.from(next.attributes)) if (live.getAttribute(a.name) !== a.value) live.setAttribute(a.name, a.value);
}

/** A form control's LIVE value is a property, not the attribute morph syncs — so bring it along (a cleared box must
 *  clear). The focused control is left alone: the person is typing in it, and state already holds what they typed. */
function syncValue(live: Element, next: Element): void {
  if (live === document.activeElement) return;
  if (live instanceof HTMLInputElement && next instanceof HTMLInputElement) {
    if (live.type === "checkbox" || live.type === "radio") live.checked = next.hasAttribute("checked");
    else if (live.type !== "file" && live.value !== (next.getAttribute("value") ?? "")) live.value = next.getAttribute("value") ?? "";
  } else if (live instanceof HTMLTextAreaElement && next instanceof HTMLTextAreaElement) {
    if (live.value !== next.value) live.value = next.value;
  }
}

/** A KEYED list (`data-morph-list` on the container, `data-morph-key` on each child): children pair by key, not by
 *  index. A child still in the list stays the element it was (patched), a new one is inserted where it belongs, and
 *  one that is gone is removed. Children are elements only; a child without a key is always replaced. */
function morphList(live: Element, next: Element): void {
  const wanted = new Map<string, Element>();
  for (const c of Array.from(next.children)) {
    const k = c.getAttribute("data-morph-key");
    if (k !== null && !wanted.has(k)) wanted.set(k, c);
  }
  const byKey = new Map<string, Element>();
  for (const c of Array.from(live.childNodes)) {
    const k = c instanceof Element ? c.getAttribute("data-morph-key") : null;
    if (c instanceof Element && k !== null && !byKey.has(k) && wanted.get(k)?.nodeName === c.nodeName) byKey.set(k, c);
    else c.remove();
  }
  let cursor: ChildNode | null = live.firstChild;   // the live node standing where the next child goes
  for (const to of Array.from(next.children)) {
    const k = to.getAttribute("data-morph-key");
    const from = k !== null && wanted.get(k) === to ? byKey.get(k) : undefined;
    if (!from) { live.insertBefore(to, cursor); continue; }
    if (from === cursor) cursor = from.nextSibling;
    else live.insertBefore(from, cursor);   // a real reorder
    morph(from, to);
  }
}

/** Patch `live` (and its subtree) to match `next`. Both must be the same element type.
 *  A `data-keep` element is owned by script and left alone. */
export function morph(live: Element, next: Element): void {
  if (live.hasAttribute("data-keep")) return;
  syncAttrs(live, next);
  syncValue(live, next);
  if (next.hasAttribute("data-morph-list")) { morphList(live, next); return; }
  const a = Array.from(live.childNodes);
  const b = Array.from(next.childNodes);
  for (let i = 0; i < b.length; i++) {
    const from = a[i];
    const to = b[i];
    if (!from) { live.appendChild(to); continue; }
    if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) { live.replaceChild(to, from); continue; }
    if (from instanceof Element && from.getAttribute("data-morph-key") !== (to as Element).getAttribute("data-morph-key")) { live.replaceChild(to, from); continue; }
    if (from instanceof Element) morph(from, to as Element);
    else if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
  }
  for (let i = b.length; i < a.length; i++) a[i].remove();
}

/** Patch `live`'s CHILDREN to match the markup `html` (`live` itself keeps its attributes). */
export function morphInner(live: Element, html: string): void {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const next = live.cloneNode(false) as Element;
  next.append(tpl.content);
  morph(live, next);
}
