// Smooth scrolling for the app's one scrolling element, with Lenis (https://lenis.dev).
//
// Lenis eases the wheel and keeps real scrolling underneath: the element's own `scrollTop` moves, so `position:
// sticky`, the scrollbar, the landing page's scroll-driven scenes and every `scroll` listener work as before. The
// page's content is replaced on every route, so Lenis reads the scroll range from the element each time it needs it
// (`naiveDimensions`) instead of watching one content node. Someone who asks their system for reduced motion gets
// plain scrolling: Lenis honours that itself, and the jumps below become instant.

import Lenis from "lenis";
import "lenis/dist/lenis.css";

export interface SmoothScroll {
  /** Glide to an element or an offset in pixels. `offset` is added to where it lands (negative leaves room above). */
  to(target: HTMLElement | number, opts?: { offset?: number; immediate?: boolean }): void;
  /** Jump to the top, with no glide: a new page starts there. */
  top(): void;
  /** Jump to the very end, with no glide. */
  end(): void;
}

/** A glide's length in seconds and its curve: fast away, a long settle. */
const GLIDE_S = 1.15;
const glide = (t: number): number => 1 - Math.pow(1 - t, 4);

export function smoothScroll(scroller: HTMLElement): SmoothScroll {
  const lenis = new Lenis({
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
  return {
    to(target, opts = {}) {
      lenis.scrollTo(target, { offset: opts.offset ?? 0, immediate: opts.immediate ?? false, duration: GLIDE_S, easing: glide, force: true });
    },
    top() {
      lenis.scrollTo(0, { immediate: true, force: true });
    },
    end() {
      lenis.scrollTo(scroller.scrollHeight, { immediate: true, force: true });
    },
  };
}
