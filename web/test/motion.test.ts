// The markup motion.ts writes for things that move: text that arrives a character at a time, numbers that count,
// status chips. (What the browser does with it is CSS, in system.css, and the small runtime in the same file.)

import { describe, expect, it } from "vitest";
import { badge, chip, count, reveal, spinner } from "../src/motion";

const keys = (html: string): string[] => [...html.matchAll(/class="mo-w" data-morph-key="([^"]*)"/g)].map((m) => m[1]);

describe("reveal", () => {
  it("keeps the whole text for a screen reader and hides the animated copy from it", () => {
    const html = reveal("Agents are running");
    expect(html).toContain('<span class="mo-sr">Agents are running</span>');
    expect(html).toContain('<span class="mo-t" aria-hidden="true" data-morph-list>');
  });

  it("numbers every character across the words, so they arrive in reading order", () => {
    const html = reveal("ab cd");
    expect([...html.matchAll(/--c:(\d+)">(.)</g)].map((m) => `${m[2]}${m[1]}`)).toEqual(["a0", "b1", "c3", "d4"]);
    // A space ends every word but the last, inside the word, so a keyed list of words still reads as a sentence.
    expect(html).toContain('<span class="mo-c" style="--c:1">b</span> </span>');
    expect(html.endsWith("d</span></span></span>")).toBe(true);
  });

  it("keys each word by its place and its text, so only a changed word is a new element", () => {
    expect(keys(reveal("4 of 12 running"))).toEqual(["0:4", "1:of", "2:12", "3:running"]);
    const before = keys(reveal("4 of 12 running"));
    const after = keys(reveal("5 of 12 running"));
    expect(after.filter((k) => !before.includes(k))).toEqual(["0:5"]);
  });

  it("can move a long sentence a word at a time", () => {
    const html = reveal("Skipping the check", "word");
    expect(html.match(/class="mo-c"/g)).toHaveLength(3);
    expect(html).toContain('<span class="mo-c" style="--c:9">the</span>');
  });

  it("escapes what it is given", () => {
    expect(reveal("<b>&")).toContain("&lt;");
    expect(reveal("<b>&")).not.toContain("<b>");
  });
});

describe("count", () => {
  it("carries the number, how to write it on the way, and what it reads on arrival", () => {
    const html = count(0.892, "pct", "89.2%");
    expect(html).toBe('<span class="mo-n" data-count="0.892" data-fmt="pct" data-text="89.2%"><span data-keep>89.2%</span></span>');
    expect(count(12, "int", "12", { linear: true })).toContain(" data-linear>");
  });

  it("is plain text when there is no number to count to", () => {
    expect(count(null, "pts", "-")).toBe('<span class="mo-n">-</span>');
    expect(count(Number.NaN, "pct", "-")).not.toContain("data-count");
  });
});

describe("chip", () => {
  it("is keyed by what it says and its mark, so a new status is a new element that animates in", () => {
    const running = chip("Running", "live", "spin", "bw-pill bw-pill--running");
    expect(running).toContain('class="ds-chip ds-chip--live bw-pill bw-pill--running" data-morph-key="chip:Running:spin"');
    expect(running).toContain("ds-spin");
    const honest = chip("Honest", "ok", "check");
    expect(honest).toContain('data-morph-key="chip:Honest:check"');
    expect(honest).toContain("ds-badge ds-badge--check");
    expect(chip("Queued", "warn", "dot")).toContain('<i class="ds-dot"></i>');
  });
});

describe("the marks", () => {
  it("draws the spinner as eight ticks, each stronger than the one before", () => {
    const ticks = [...spinner().matchAll(/opacity="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(ticks).toHaveLength(8);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    expect(ticks[7]).toBe(1);
  });

  it("gives a badge's mark a length of one, so it can be drawn in", () => {
    for (const kind of ["check", "alert", "cross", "hold"] as const) {
      expect(badge(kind)).toContain(`ds-badge--${kind}`);
      expect(badge(kind)).toContain('class="ds-badge-p" pathLength="1"');
    }
  });
});
