// Without WebGL the 3D view is asked for once and replaced by its result line (robot/viewer.ts, robot/markup.ts).

import { afterEach, describe, expect, it } from "vitest";
import { NO_WEBGL, SUCCESS_LEGEND, SUCCESS_RADIUS_CM, noWebglView } from "../src/robot/markup";
import { resetWebglCheck, webglAvailable } from "../src/robot/viewer";

describe("webglAvailable", () => {
  afterEach(() => resetWebglCheck());

  it("asks once and remembers a missing WebGL, so it never tries again", () => {
    let asked = 0;
    const missing = (): boolean => { asked++; return false; };
    expect(webglAvailable(missing)).toBe(false);
    expect(webglAvailable(missing)).toBe(false);
    // A later probe that would succeed is not asked either: the answer is kept for the page.
    expect(webglAvailable(() => { asked++; return true; })).toBe(false);
    expect(asked).toBe(1);
  });

  it("remembers a working WebGL too", () => {
    expect(webglAvailable(() => true)).toBe(true);
    expect(webglAvailable(() => false)).toBe(true);
  });
});

describe("noWebglView", () => {
  it("says the view needs WebGL and gives the episode's result", () => {
    const html = noWebglView("far_left", { success: true, place_error_cm: 1.3 });
    expect(html).toContain(NO_WEBGL);
    expect(html).toContain("far_left");
    expect(html).toContain("Placed 1.3 cm from center");
    expect(html).toContain("rb-dot--ok");
  });

  it("shows the name alone until the result is known, escaped", () => {
    const html = noWebglView("<b>x", null);
    expect(html).toContain("&lt;b&gt;x");
    expect(html).toContain("rb-dot--none");
    expect(html).not.toContain("Placed");
  });
});

describe("the success area", () => {
  it("is one radius, used by the legend and the result lines", () => {
    expect(SUCCESS_RADIUS_CM).toBe(3);
    expect(SUCCESS_LEGEND).toContain(`within ${SUCCESS_RADIUS_CM} cm of the center`);
  });
});
