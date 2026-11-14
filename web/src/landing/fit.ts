// Where the hero's scene goes: the largest box that fits beside (or under) the copy without running into it. Pure
// arithmetic on CSS pixels, so the layout is tested in test/landing.test.ts. scene.ts turns the box into a camera.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FitInput {
  /** The hero, which the canvas covers. */
  width: number;
  height: number;
  /** Room to leave at each edge: the nav's height on top, a margin on the others. */
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** The copy's bottom-right corner. Nothing of the scene may be both left of it and above it. */
  copyRight: number;
  copyBottom: number;
  /** Clear space between the copy and the scene. */
  gap: number;
  /** The scene's bounding box, width over height. */
  aspect: number;
  /** Points the scene covers, in its bounding box's own units: 0,0 its top left and 1,1 its bottom right. */
  points: [number, number][];
  /** The box is never taller than this. */
  maxHeight?: number;
  /** Below this height the box stops shrinking and is placed as low as it has to go. */
  minHeight?: number;
}

/** The scene's bounding box: as large as the room allows, hard against the right edge, and low enough that the part
 *  of the scene left of the copy's corner stays below it. */
export function fitScene(input: FitInput): Box {
  const roomW = Math.max(0, input.width - input.left - input.right);
  const roomH = Math.max(0, input.height - input.top - input.bottom);
  const floor = input.height - input.bottom;
  let height = Math.min(roomH, roomW / input.aspect, input.maxHeight ?? Infinity);
  const least = Math.min(height, input.minHeight ?? 160);

  for (;;) {
    const width = height * input.aspect;
    const x = input.width - input.right - width;
    // The highest point of the scene that is left of the copy's corner decides how far down the box must start.
    let highest = Infinity;
    for (const [px, py] of input.points) {
      if (x + px * width <= input.copyRight + input.gap && py < highest) highest = py;
    }
    const clear = highest === Infinity ? -Infinity : input.copyBottom + input.gap - highest * height;
    const top = Math.max(input.top, clear);
    if (top + height <= floor + 0.5 || height <= least) {
      // Room to spare: beside the copy the scene sits a little under the middle; under the copy it stays near it.
      const spare = Math.max(0, floor - top - height);
      return { x, y: top + spare * (clear > input.top ? 0.3 : 0.6), width, height };
    }
    height = Math.max(least, height * 0.985);
  }
}
