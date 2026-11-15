// Fills a batch's research paper card (robot/markup.ts `researchCard`) from the paper's own record.
//
// The card is a `data-keep` placeholder with the saved title and authors. This asks the server for the record as
// arXiv has it now (`/api/papers/arxiv/<number>`, deep_research/papers.py), and when it arrives:
//   - sets the title and authors arXiv gives, and a line saying when the paper was published and last revised;
//   - sets the abstract, with the phrases each row of the batch's setup comes from marked in it (`markTerms` looks
//     for them in the text that arrived, so a phrase a later revision drops is simply not marked);
//   - lets the setup rows in one after another, each mark lighting with its row (robot.css).
// Pointing at a row lights its phrases, and at a phrase its row. When arXiv cannot be reached the card says so and
// shows the rows with the saved facts.
//
// Like robot/mount.ts, this watches the document for placeholders: the views are strings patched in by morph.ts.

import { esc } from "../ui";
import { researchByPaper, type ResearchSource } from "../robot/markup";

/** A paper's record (deep_research/papers.py `paper`). `live` is false for the saved facts, which have no abstract. */
export interface Paper {
  id: string;
  url: string;
  title: string;
  authors: string[];
  published: string | null;
  updated: string | null;
  abstract: string | null;
  categories: string[];
  version: string;
  live: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2024-12-17" as "17 Dec 2024"; anything else as it is. */
export function day(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m && MONTHS[Number(m[2]) - 1] ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso ?? "";
}

/** The line under the authors once the record is in: where it came from and the paper's dates. */
export function statusText(p: Paper | null): string {
  if (!p || !p.live) return "arxiv.org could not be reached. Showing the saved title and authors.";
  const revised = p.updated && p.updated !== p.published ? `, last revised ${day(p.updated)}${p.version ? ` (${p.version})` : ""}` : "";
  const field = p.categories.length ? ` · ${p.categories.slice(0, 3).join(", ")}` : "";
  return `From arxiv.org · published ${day(p.published)}${revised}${field}`;
}

/** Where each row's phrases are in `text`: [start, end, row], in order, none overlapping. Whole words, any case. */
export function findTerms(text: string, setup: ResearchSource["setup"]): [number, number, number][] {
  const found: [number, number, number][] = [];
  setup.forEach(([, , terms], row) => {
    for (const term of terms ?? []) {
      const re = new RegExp(`(?<![A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "gi");
      for (let m = re.exec(text); m; m = re.exec(text)) found.push([m.index, m.index + m[0].length, row]);
    }
  });
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: [number, number, number][] = [];
  for (const f of found) if (!out.length || f[0] >= out[out.length - 1][1]) out.push(f);
  return out;
}

/** `text` as HTML with each found phrase in a `<mark>` that names its row. */
export function markTerms(text: string, setup: ResearchSource["setup"]): string {
  let at = 0;
  let html = "";
  for (const [a, b, row] of findTerms(text, setup)) {
    html += `${esc(text.slice(at, a))}<mark data-i="${row}" style="--i:${row}">${esc(text.slice(a, b))}</mark>`;
    at = b;
  }
  return html + esc(text.slice(at));
}

/** The abstract's block: the marked text, folded to a few lines, and what the marks are. */
export function abstractView(p: Paper, source: ResearchSource): string {
  if (!p.abstract) return "";
  const n = new Set(findTerms(p.abstract, source.setup).map((f) => f[2])).size;
  const key = n ? `<span class="rp-key"><mark class="is-on">Marked</mark> the phrases ${n === 1 ? "a setup row comes" : `${n} of the setup rows come`} from</span>` : "";
  return `<h4 class="rp-sub">Abstract</h4>`
    + `<p class="rp-abs-t" data-rp-text>${markTerms(p.abstract, source.setup)}</p>`
    + `<div class="rp-abs-f"><button type="button" class="rp-more" data-rp-more aria-expanded="false">Show all</button>${key}</div>`;
}

const asked = new Map<string, Promise<Paper>>();

/** The paper's record, asked for once per page; a failed ask is forgotten, so the next card asks again. */
export function fetchPaper(id: string): Promise<Paper> {
  let p = asked.get(id);
  if (!p) {
    p = fetch(`/api/papers/arxiv/${encodeURIComponent(id)}`).then((res) => {
      if (!res.ok) throw new Error(`The server answered HTTP ${res.status}`);
      return res.json() as Promise<Paper>;
    });
    p.catch(() => asked.delete(id));
    asked.set(id, p);
  }
  return p;
}

/** Put a record (or, with null, the fact that there is none) into its card and let the rows in. */
export function fill(el: HTMLElement, source: ResearchSource, p: Paper | null): void {
  const q = (sel: string): HTMLElement | null => el.querySelector<HTMLElement>(sel);
  const status = q("[data-rp-status]");
  if (status) status.textContent = statusText(p);
  if (p?.live) {
    const title = q("[data-rp-title]");
    if (title) title.textContent = p.title;
    const authors = q("[data-rp-authors]");
    if (authors) authors.textContent = `${p.authors.join(", ")} · ${(p.published ?? "").slice(0, 4) || source.year}`;
    const abs = q("[data-rp-abs]");
    if (abs && p.abstract) {
      abs.innerHTML = abstractView(p, source);
      abs.hidden = false;
      const rows = new Set(findTerms(p.abstract, source.setup).map((f) => f[2]));
      el.querySelectorAll<HTMLElement>(".rp-row").forEach((row) => row.classList.toggle("has-src", rows.has(Number(row.dataset.i))));
    }
  }
  el.classList.toggle("is-saved", !p?.live);
  el.classList.add("is-ready");
}

function mount(el: HTMLElement): void {
  const source = researchByPaper(el.dataset.paper ?? "");
  if (!source) { el.classList.add("is-ready"); return; }
  fetchPaper(source.arxiv).then((p) => { if (el.isConnected) fill(el, source, p); }, () => { if (el.isConnected) fill(el, source, null); });
  el.addEventListener("click", (e) => {
    const more = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-rp-more]");
    if (!more) return;
    const open = more.getAttribute("aria-expanded") !== "true";
    more.setAttribute("aria-expanded", String(open));
    more.textContent = open ? "Show less" : "Show all";
    el.classList.toggle("is-open", open);
  });
  // A row and its phrases light together, whichever is pointed at.
  const light = (e: Event, on: boolean): void => {
    const at = (e.target as HTMLElement | null)?.closest<HTMLElement>(".rp-row, mark[data-i]");
    if (!at?.dataset.i) return;
    el.querySelectorAll<HTMLElement>(`.rp-row[data-i="${at.dataset.i}"], mark[data-i="${at.dataset.i}"]`).forEach((x) => x.classList.toggle("is-lit", on));
  };
  el.addEventListener("pointerover", (e) => light(e, true));
  el.addEventListener("pointerout", (e) => light(e, false));
}

const seen = new WeakSet<HTMLElement>();
let queued = 0;

function scan(): void {
  queued = 0;
  document.querySelectorAll<HTMLElement>("[data-paper]").forEach((el) => {
    if (seen.has(el)) return;
    seen.add(el);
    mount(el);
  });
}

if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
  const schedule = (): void => { if (!queued) queued = requestAnimationFrame(scan); };
  const start = (): void => {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
}
