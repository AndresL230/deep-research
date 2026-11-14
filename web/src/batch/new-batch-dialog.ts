// The New batch dialog (main.ts): a native <dialog> opened with showModal(), so the browser traps focus in it, makes
// the page behind it inert and closes it on Esc. This adds what the element does not do on its own: closing on a press
// on the backdrop, locking the page's scrolling while it is open, and putting focus back on the button that opened it.
//
// The dialog element sits outside the regions morph.ts patches, so a repaint never touches it (an open dialog is never
// torn down or closed by one); only the frame inside it is patched, from home.ts `newBatchView`. That view is a pure
// function of state main.ts keeps for the whole session (`HomeVm`, `DatasetUi`): closing the dialog drops none of it,
// so the draft, the chosen domain, an uploaded dataset, script or controller, and a Start error are all there again on
// the next open, from any page.

export interface Focusable { focus(opts?: FocusOptions): void; readonly isConnected?: boolean }

/** What this needs of the <dialog> element (an HTMLDialogElement in the page, a stand-in in the tests). */
export interface DialogEl extends EventTarget {
  readonly open: boolean;
  showModal(): void;
  close(): void;
  getBoundingClientRect?(): { left: number; top: number; right: number; bottom: number };
}

export interface DialogHooks {
  /** Draw the form into the dialog. Called before it shows, so the browser's first focus lands in the form. */
  fill(): void;
  /** Lock (or unlock) the page's own scrolling behind the dialog. */
  lock(on: boolean): void;
  /** It has closed, whichever way: its X, Esc, the backdrop, or a batch that started. */
  closed(): void;
  /** Where focus goes back to when the element that opened it is gone. */
  fallback(): Focusable | null;
}

export interface NewBatchDialog {
  readonly isOpen: boolean;
  /** Show it. `opener` gets focus back once it closes. Nothing happens when it is open already. */
  open(opener?: Focusable | null): void;
  close(): void;
}

export function newBatchDialog(el: DialogEl, hooks: DialogHooks): NewBatchDialog {
  let opener: Focusable | null = null;
  let pressedOutside = false;

  /** A press on the backdrop: the event is the dialog's own (not a child's) and, when it has a position, outside the
   *  dialog's box (its border is the dialog's own too). */
  const outside = (e: Event): boolean => {
    if (e.target !== el) return false;
    const p = e as Partial<MouseEvent>;
    const r = el.getBoundingClientRect?.();
    if (!r || typeof p.clientX !== "number" || typeof p.clientY !== "number") return true;
    return p.clientX < r.left || p.clientX > r.right || p.clientY < r.top || p.clientY > r.bottom;
  };

  // Both ends of the press on the backdrop: a drag that starts on a slider inside and ends outside is not a close.
  el.addEventListener("pointerdown", (e) => { pressedOutside = outside(e); });
  el.addEventListener("click", (e) => {
    const close = pressedOutside && outside(e);
    pressedOutside = false;
    if (close) api.close();
  });
  el.addEventListener("close", () => {
    hooks.lock(false);
    const back = opener && opener.isConnected !== false ? opener : hooks.fallback();
    opener = null;
    back?.focus({ preventScroll: true });
    hooks.closed();
  });

  const api: NewBatchDialog = {
    get isOpen() { return el.open; },
    open(from = null) {
      if (el.open) return;
      opener = from;
      hooks.fill();
      el.showModal();
      hooks.lock(true);
    },
    close() {
      if (el.open) el.close();
    },
  };
  return api;
}
