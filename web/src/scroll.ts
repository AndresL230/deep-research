// Scrolling for the app's one scrolling element. The landing page (the marketing page) scrolls smoothly, with Lenis
// (https://lenis.dev); every other page is the app, and scrolls the way the browser does, with nothing in between.
//
// On the landing page Lenis eases the wheel and keeps real scrolling underneath: the element's own `scrollTop` moves,
// so `position: sticky`, the scrollbar, the landing page's scroll-driven scenes and every `scroll` listener work as
// before. The page's content is replaced on every route, so Lenis reads the scroll range from the element each time
// it needs it (`naiveDimensions`) instead of watching one content node. Anywhere else Lenis is not running at all: the
// app's own jumps use the browser's `scrollTo`. Someone who asks their system for reduced motion gets plain scrolling
// everywhere: Lenis honours that itself, and the jumps become instant.

import Lenis from "lenis";
import "lenis/dist/lenis.css";

export interface SmoothScroll {
  /** Ease the wheel (the landing page) or leave scrolling to the browser (every other page). Safe to call often. */
  smooth(on: boolean): void;
  /** Go to an element or an offset in pixels. `offset` is added to where it lands (negative leaves room above). */
  to(target: HTMLElement | number, opts?: { offset?: number; immediate?: boolean }): void;
  /** Jump to the top, with no glide: a new page starts there. */
  top(): void;
  /** Jump to the very end, with no glide. */
  end(): void;
  /** Stop (or resume) scrolling the page, while a dialog is open over it. */
  lock(on: boolean): void;
}

/** A glide's length in seconds and its curve, on the landing page: fast away, a long settle. */
const GLIDE_S = 1.15;
const glide = (t: number): number => 1 - Math.pow(1 - t, 4);

const reduced = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function smoothScroll(scroller: HTMLElement): SmoothScroll {
  let lenis: Lenis | null = null;
  let locked = false;

  /** Where a target is, as the scroller's `scrollTop`. */
  const topOf = (target: HTMLElement | number, offset: number): number => {
    if (typeof target === "number") return target + offset;
    const at = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    return Math.max(0, at + offset);
  };

  return {
    smooth(on) {
      if (on && !lenis) {
        lenis = new Lenis({
          wrapper: scroller,
          content: scroller,
          eventsTarget: scroller,
          naiveDimensions: true,
          autoResize: false,
          autoRaf: true,
          lerp: 0.11,
          // A code box or a wide table inside the page scrolls itself; the page takes over at its ends.
          allowNestedScroll: true,
        });
        if (locked) lenis.stop();
      } else if (!on && lenis) {
        lenis.destroy();
        lenis = null;
      }
    },
    to(target, opts = {}) {
      const immediate = opts.immediate ?? false;
      if (lenis) {
        lenis.scrollTo(target, { offset: opts.offset ?? 0, immediate, duration: GLIDE_S, easing: glide, force: true });
        return;
      }
      scroller.scrollTo({ top: topOf(target, opts.offset ?? 0), behavior: immediate || reduced() ? "instant" : "smooth" });
    },
    top() {
      if (lenis) lenis.scrollTo(0, { immediate: true, force: true });
      else scroller.scrollTo({ top: 0, behavior: "instant" });
    },
    end() {
      if (lenis) lenis.scrollTo(scroller.scrollHeight, { immediate: true, force: true });
      else scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
    },
    lock(on) {
      locked = on;
      if (lenis) {
        if (on) lenis.stop();
        else lenis.start();
      } else {
        scroller.style.overflow = on ? "hidden" : "";
      }
    },
  };
}
