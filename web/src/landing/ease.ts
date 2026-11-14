// The curves the landing page's motion is made of (timeline.ts, bench.ts, devices.ts). Each takes how far through
// a move something is and gives how far along it should look; anything outside 0 to 1 is held at the ends.

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Starts and ends gently. */
export const smooth = (x: number): number => { const u = clamp01(x); return u * u * (3 - 2 * u); };

/** Starts fast and settles. The cubic settles harder. */
export const easeOutQuad = (x: number): number => { const u = 1 - clamp01(x); return 1 - u * u; };
export const easeOutCubic = (x: number): number => { const u = 1 - clamp01(x); return 1 - u * u * u; };

/** Starts and ends gently, and is quick in the middle. */
export const easeInOutCubic = (x: number): number => {
  const u = clamp01(x);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
};
