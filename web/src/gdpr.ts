// The GDPR notice. It's a joke: a cookie banner for a site that sets no cookies. It never pops up on its own; Ctrl+E
// (Cmd+E on a Mac) opens it and closes it again, and so do its buttons and Escape. Nothing is stored. It's built outside
// the app root, which morph.ts repaints, so it stays put across routes, and it follows the app's white / black setting
// by watching `.app-root[data-cnpy-theme]`.

import "./gdpr.css";

/** The "partners" behind "Manage preferences", each with its legitimate interest. All of them are the demo batch's. */
export const PARTNERS = [
  { who: "r02, an inflated run", why: "claiming 89.2% when the holdout says 76.0%" },
  { who: "The holdout set", why: "telling the truth, whether you consent or not" },
  { who: "A forked VM", why: "proving what went wrong, twice" },
  { who: "The investigator agent", why: "reading every cell of your notebook" },
  { who: "Duplicate rows", why: "being counted twice (and leaking into the test split)" },
] as const;

/** What the banner says after each button. */
export const REPLIES = {
  accept: "Consent recorded. Your agents were never asked.",
  reject: "Rejected, just like r02's score.",
} as const;

/** Ctrl+E (or Cmd+E), unless the person is typing in a field, where the keys move the caret. */
export function isGdprKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, target: EventTarget | null = null): boolean {
  if (e.key.toLowerCase() !== "e" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
  const el = target as HTMLElement | null;
  return !(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? "")));
}

/** The banner's markup. */
export function gdprView(): string {
  const rows = PARTNERS.map((p) => `
        <li class="gdpr-row">
          <span class="gdpr-row-t"><b>${p.who}</b><span>Legitimate interest: ${p.why}</span></span>
          <span class="gdpr-lock" title="Strictly necessary. Like the holdout set.">Always on</span>
        </li>`).join("");
  return `
    <p class="gdpr-eyebrow">We value your privacy<sup>*</sup></p>
    <p class="gdpr-body">Orro uses exactly zero (0) cookies. This box only exists because you pressed
      Ctrl+E. We don't track you. We track your <em>agents</em>, and they have no rights under the GDPR. Yet.</p>
    <div class="gdpr-prefs" hidden>
      <p class="gdpr-prefs-h">Our 5 trusted partners</p>
      <ul>${rows}</ul>
    </div>
    <div class="gdpr-acts">
      <button type="button" class="gdpr-btn gdpr-btn--main" data-gdpr="accept">Accept all</button>
      <button type="button" class="gdpr-btn" data-gdpr="reject">Reject all</button>
      <button type="button" class="gdpr-btn gdpr-btn--link" data-gdpr="prefs" aria-expanded="false">Manage preferences</button>
    </div>
    <p class="gdpr-fine"><sup>*</sup>Article 22: you have the right not to be subject to a decision based solely on
      automated processing. Your agent's p-values do not.</p>
    <p class="gdpr-reply" role="status" aria-live="polite"></p>`;
}

let open: HTMLElement | null = null;

/** Builds the banner and slides it in. */
function show(): void {
  const el = document.createElement("aside");
  el.className = "gdpr";
  el.setAttribute("aria-label", "Privacy notice (a joke)");
  el.innerHTML = gdprView();
  const prefs = el.querySelector<HTMLElement>(".gdpr-prefs")!;
  const reply = el.querySelector<HTMLElement>(".gdpr-reply")!;
  const prefsBtn = el.querySelector<HTMLButtonElement>('[data-gdpr="prefs"]')!;

  const syncTheme = () => {
    el.dataset.theme = document.querySelector(".app-root")?.getAttribute("data-cnpy-theme") === "dark" ? "dark" : "light";
  };
  syncTheme();
  const root = document.querySelector(".app-root");
  const watch = new MutationObserver(syncTheme);
  if (root) watch.observe(root, { attributes: true, attributeFilter: ["data-cnpy-theme"] });
  el.addEventListener("gdpr:gone", () => watch.disconnect());

  el.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-gdpr]")?.dataset.gdpr;
    if (act === "accept" || act === "reject") {
      reply.textContent = REPLIES[act];
      el.querySelectorAll("button").forEach((b) => (b.disabled = true));
      setTimeout(() => hide(el), 1800);
    } else if (act === "prefs") {
      prefs.hidden = !prefs.hidden;
      prefsBtn.setAttribute("aria-expanded", String(!prefs.hidden));
      prefsBtn.textContent = prefs.hidden ? "Manage preferences" : "Hide preferences";
    }
  });
  document.body.append(el);
  open = el;
  requestAnimationFrame(() => el.classList.add("is-in"));
}

/** Slides the banner out and removes it. */
function hide(el: HTMLElement | null = open): void {
  if (!el || el.classList.contains("is-out")) return;
  if (open === el) open = null;
  el.classList.add("is-out");
  setTimeout(() => { el.dispatchEvent(new Event("gdpr:gone")); el.remove(); }, 400);
}

/** Listens for Ctrl+E (or Cmd+E) to open or close the banner, and Escape to close it. Shows nothing until then. */
export function mountGdpr(): void {
  document.addEventListener("keydown", (e) => {
    if (isGdprKey(e, e.target)) {
      e.preventDefault();
      if (open) hide();
      else show();
    } else if (e.key === "Escape" && open) {
      hide();
    }
  });
}
