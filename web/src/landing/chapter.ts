// The split finder's chapter, as a pure function of how far the page has scrolled through it. finder.ts draws what
// this returns; nothing here touches three.js or the DOM, so the chapter is tested in test/landing.test.ts.
//
// The section is pinned while the page scrolls, and the scrolling is the chapter's clock:
//
//   1  a ring of coins, one for each run of a batch, turning and tumbling
//   2  the coins leave the ring, shrink to points and settle where the web will have its seeds
//   3  a web grows out of those points until it is a whole sphere: every action of every run, tied to the ones
//      near it
//   4  the web thins out again, toward one point: the step where honest and inflated runs split
//   5  that point gets its tag, with the step's name and how many runs of each kind took it
//
// Only the coins' turning and tumbling run on real time; everything else stands still when the page does.

import { clamp01, smooth } from "./ease";

/** The chapter's length on its own clock. One unit is a pixel of scrolling on the screen the chapter was timed on;
 *  the page stretches the clock over however far its pinned section really travels (`clockAt`). */
export const CHAPTER = 1900;

type Span = readonly [from: number, to: number];

/** The coins leave the ring for their places in the web, shrinking as they go. */
const GATHER: Span = [250, 580];
/** What is drawn on a coin fades as it leaves, */
const FACES: Span = [250, 360];
/** it turns the web's colour, */
const GREY: Span = [330, 480];
/** and it stops tumbling and turns to face the viewer, which makes it a round point. */
const SETTLE: Span = [300, 480];
/** The web's own points come up under the coins, then the coins go. */
const POINTS_IN: Span = [650, 700];
const COINS_OUT: Span = [660, 700];
/** The web grows out of its seeds, */
const GROW: Span = [690, 1115];
/** stands whole for a moment, then thins down to the split, */
const THIN: Span = [1210, 1590];
/** its last ties fading as they go. */
const TIES_OUT: Span = [1500, 1600];
/** The split's tag comes up. It stays for the rest of the chapter. */
const MARK: Span = [1570, 1690];

/** How far past its ends the web's reveal runs, so the first and the last things drawn come on softly too. */
export const REVEAL_SOFT = 0.1;
/** The least share of the reveal a tie takes to draw, so ties between points of the same order never pop. */
export const REVEAL_SPAN = 0.25;

// The web turns with the scrolling: steadily while it grows, then a further swing as it thins.
const YAW_RATE = 0.000873;
const YAW_FROM = 661;
const YAW_SWING = 0.54;

const along = (u: number, [from, to]: Span): number => clamp01((u - from) / (to - from));

export interface ChapterView {
  /** How fast the ring of coins turns and how fast each coin tumbles, in radians a second. */
  spin: number;
  tumble: number;
  /** How far the coins are from the ring (0) to their places in the web (1), where each is a point. */
  gather: number;
  /** How much of what is drawn on a coin still shows, 1 to 0. */
  faces: number;
  /** How far a coin has gone from its own colour (0) to a point's (1). */
  grey: number;
  /** How far a coin has stopped tumbling and turned to face the viewer, 0 to 1. */
  settle: number;
  /** The coins' opacity: they give way to the web's own points once they are in place. */
  coins: number;
  /** The opacity of the web's points and of its ties. */
  points: number;
  ties: number;
  /** How much of the web is drawn: from just under 0 (only its seeds) to just over 1 (all of it). */
  reveal: number;
  /** Which order the web follows: growing out of the runs' seeds, or thinning down to the split. */
  thinning: boolean;
  /** The web's turn about its upright axis, in radians. It rolls a third as far. */
  yaw: number;
  /** The clock the web's points pulse on. */
  beat: number;
  /** How far the split's tag has come up, 0 to 1. */
  mark: number;
}

/** The chapter at `u` on its clock (0 to `CHAPTER`). */
export function chapterAt(u: number): ChapterView {
  const full = 1 + REVEAL_SOFT;
  const thinning = u >= THIN[0];
  const pointsIn = smooth(along(u, POINTS_IN));
  const mark = smooth(along(u, MARK));
  return {
    spin: 0.6 + 0.2 * smooth(u / 160),
    tumble: 1.07 + 0.93 * smooth(u / 240),
    gather: smooth(along(u, GATHER)),
    faces: 1 - smooth(along(u, FACES)),
    grey: smooth(along(u, GREY)),
    settle: smooth(along(u, SETTLE)),
    coins: 1 - smooth(along(u, COINS_OUT)),
    // The split's own point hands over to its tag, which draws the point itself.
    points: pointsIn * (1 - mark),
    ties: pointsIn * (1 - smooth(along(u, TIES_OUT))),
    reveal: thinning ? full - smooth(along(u, THIN)) * (full + REVEAL_SOFT) : smooth(along(u, GROW)) * full,
    thinning,
    yaw: YAW_RATE * Math.min(Math.max(u, YAW_FROM), GROW[1]) + YAW_SWING * smooth(along(u, [GROW[1], THIN[1]])),
    beat: u * 0.0081,
    mark,
  };
}

/** The chapter as one still picture, for reduced motion and for a page that does not pin it: the whole web, turned
 *  the way it ends, with the split tagged in it. */
export function chapterPoster(): ChapterView {
  const end = chapterAt(CHAPTER);
  return { ...end, points: 1, ties: 1, reveal: 1 + REVEAL_SOFT, thinning: false, mark: 1 };
}

/** Where the chapter's clock stands when the page has scrolled `scrolled` pixels into a pinned section that
 *  travels `travel` pixels in all. */
export function clockAt(scrolled: number, travel: number): number {
  return travel > 0 ? clamp01(scrolled / travel) * CHAPTER : 0;
}
