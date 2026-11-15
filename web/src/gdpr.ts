// The GDPR notice. It's a joke: a cookie banner for a site that sets no cookies. The one thing it stores is that you
// closed it, in localStorage. It's built outside the app root, which morph.ts repaints, so it stays put across
// routes. It follows the app's white / black setting by watching `.app-root[data-cnpy-theme]`.

import "./gdpr.css";

export const GDPR_KEY = "orro.gdpr.dismissed";

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

interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void }

export function gdprDismissed(store: Store | null = safeStore()): boolean {
  try { return store?.getItem(GDPR_KEY) === "1"; } catch { return false; }
}

function remember(store: Store | null = safeStore()): void {
  try { store?.setItem(GDPR_KEY, "1"); } catch { /* private window: you'll be asked again, as is tradition */ }
}

function safeStore(): Store | null {
  try { return window.localStorage; } catch { return null; }
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
    <p class="gdpr-body">Orro uses exactly one (1) cookie. It's actually localStorage, and all it remembers is that you
      closed this box. We don't track you. We track your <em>agents</em>, and they have no rights under the GDPR. Yet.</p>
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

/** Shows the banner once, until someone presses a button. */
export function mountGdpr(): void {
  if (gdprDismissed()) return;
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

  const close = (words: string) => {
    remember();
    reply.textContent = words;
    el.classList.add("is-done");
    el.querySelectorAll("button").forEach((b) => (b.disabled = true));
    setTimeout(() => {
      el.classList.add("is-out");
      setTimeout(() => { watch.disconnect(); el.remove(); }, 400);
    }, 1800);
  };

  el.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-gdpr]")?.dataset.gdpr;
    if (act === "accept") close(REPLIES.accept);
    else if (act === "reject") close(REPLIES.reject);
    else if (act === "prefs") {
      prefs.hidden = !prefs.hidden;
      prefsBtn.setAttribute("aria-expanded", String(!prefs.hidden));
      prefsBtn.textContent = prefs.hidden ? "Manage preferences" : "Hide preferences";
    }
  });
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add("is-in"));
}
