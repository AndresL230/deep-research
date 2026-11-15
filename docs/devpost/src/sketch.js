// Four pencil-sketch figures for Orro, drawn with rough.js. Black and white only, square corners, few words.
const INK = "#262626", SOFT = "#8c8c8c", NS = "http://www.w3.org/2000/svg";

function pen(svg, seed0) {
  const rc = rough.svg(svg);
  let seed = seed0;
  const o = (x = {}) => Object.assign({ roughness: 1.5, bowing: 1.3, stroke: INK, strokeWidth: 2.4, seed: seed++ }, x);
  const add = (n) => (svg.appendChild(n), n);
  const p = {
    box: (x, y, w, h, x2 = {}) => add(rc.rectangle(x, y, w, h, o(x2))),
    shade: (x, y, w, h) => add(rc.rectangle(x, y, w, h, o({ fill: SOFT, fillStyle: "hachure", hachureGap: 10, fillWeight: 1.3 }))),
    line: (a, b, c, d, x2 = {}) => add(rc.line(a, b, c, d, o(x2))),
    dash: (a, b, c, d) => add(rc.line(a, b, c, d, o({ strokeLineDash: [12, 11], strokeWidth: 2, roughness: 0.9 }))),
    arrow(a, b, c, d, x2 = {}) {
      p.line(a, b, c, d, x2);
      const ang = Math.atan2(d - b, c - a), L = 20;
      for (const s of [-1, 1]) {
        const t = ang + Math.PI + s * 0.45;
        p.line(c, d, c + L * Math.cos(t), d + L * Math.sin(t), Object.assign({ roughness: 0.8 }, x2));
      }
    },
    diamond: (cx, cy, w, h) => add(rc.polygon([[cx, cy - h / 2], [cx + w / 2, cy], [cx, cy + h / 2], [cx - w / 2, cy]], o())),
    circle: (cx, cy, d, x2 = {}) => add(rc.circle(cx, cy, d, o(x2))),
    ellipse: (cx, cy, w, h, x2 = {}) => add(rc.ellipse(cx, cy, w, h, o(x2))),
    dot: (cx, cy, d) => add(rc.circle(cx, cy, d, o({ fill: INK, fillStyle: "solid", roughness: 0.8 }))),
    sq: (x, y, s) => add(rc.rectangle(x, y, s, s, o({ fill: INK, fillStyle: "hachure", hachureGap: 4, fillWeight: 1.8, roughness: 1 }))),
    curve: (pts, x2 = {}) => add(rc.curve(pts, o(x2))),
    cross(x, y, s) { p.line(x - s, y - s, x + s, y + s); p.line(x - s, y + s, x + s, y - s); },
    tick(x, y, s) { p.line(x - s, y, x - s * 0.2, y + s * 0.8); p.line(x - s * 0.2, y + s * 0.8, x + s * 1.1, y - s); },
    t(x, y, s, size = 34, anchor = "start", col = INK) {
      const e = document.createElementNS(NS, "text");
      e.setAttribute("x", x); e.setAttribute("y", y); e.setAttribute("font-size", size);
      e.setAttribute("text-anchor", anchor); e.setAttribute("fill", col); e.textContent = s;
      return add(e);
    },
  };
  return p;
}

const FIGS = {
  // 1. the pipeline: six shapes in a row, one shaded box for what stays hidden
  pipeline(svg) {
    const p = pen(svg, 11);
    p.t(70, 120, "How Orro works", 68);
    const xs = [60, 300, 540, 780, 1010, 1250], top = 300, w = 190, h = 170, mid = top + h / 2;
    const labels = [["12 agents"], ["score", "each one"], ["investigator"], null, ["4 groups", "of copies"], ["verdict"]];
    const notes = ["Deep Agents", "", "Deep Agents", "interrupt_on", "Daytona", "Fisher test"];
    xs.forEach((x, i) => {
      if (i === 3) { p.diamond(x + w / 2, mid, w + 30, h); p.t(x + w / 2, mid + 12, "approve?", 34, "middle"); }
      else {
        p.box(x, top, w, h);
        const L = labels[i];
        L.forEach((s, j) => p.t(x + w / 2, mid + 12 + (j - (L.length - 1) / 2) * 42, s, 34, "middle"));
      }
      if (notes[i]) p.t(x + w / 2, top + h + 48, notes[i], 26, "middle", SOFT);
      if (i < 5) p.arrow(x + w + (i === 3 ? 20 : 8), mid, xs[i + 1] - (i === 2 ? 22 : 10), mid);
    });
    // hidden tests feed the score; the investigator cannot reach them
    p.shade(300, 700, 190, 120);
    p.t(395, 868, "hidden tests", 34, "middle");
    p.arrow(395, 696, 395, top + h + 12);
    p.dash(494, 760, 635, 760); p.dash(635, 760, 635, top + h + 60);
    p.cross(635, 660, 16);
    p.t(662, 672, "blocked", 30);
  },

  // 2. the investigator as one deep agent: what it reads, what it cannot, what it may do
  agent(svg) {
    const p = pen(svg, 101);
    p.t(70, 120, "The investigator", 68);
    p.t(72, 168, "one LangChain deep agent", 30, "start", SOFT);
    // centre
    p.box(560, 330, 380, 240, { strokeWidth: 3.2 });
    p.t(750, 448, "investigator", 46, "middle");
    p.t(750, 496, "create_deep_agent", 26, "middle", SOFT);
    // helpers above
    [["tagger", 480], ["hypothesis", 665], ["tracer", 850]].forEach(([s, x]) => {
      p.box(x, 190, 170, 70); p.t(x + 85, 236, s, 28, "middle");
      p.line(x + 85, 262, 750 + (x - 665) * 0.35, 328);
    });
    p.t(462, 236, "subagents", 26, "end", SOFT);
    // reads
    [["runs", "", 290], ["skills", "skills=", 400], ["notebook", "memory=", 510]].forEach(([s, n, y], i) => {
      p.box(70, y, 300, 84);
      p.t(94, y + 52, s, 32);
      if (n) p.t(350, y + 52, n, 24, "end", SOFT);
      p.arrow(374, y + 42, 552, 400 + i * 50);
    });
    // blocked
    p.shade(70, 690, 300, 90);
    p.t(220, 828, "hidden results", 32, "middle");
    p.dash(374, 735, 610, 735); p.dash(610, 735, 610, 578);
    p.cross(492, 735, 16);
    p.t(492, 792, "FilesystemPermission", 24, "middle", SOFT);
    // may do, with a person in the way
    p.box(1100, 230, 300, 80); p.t(1250, 282, "asks to test", 32, "middle");
    p.arrow(944, 400, 1094, 290);
    p.arrow(1250, 314, 1250, 338);
    p.diamond(1250, 400, 280, 120); p.t(1250, 412, "approve?", 32, "middle");
    p.t(1408, 346, "interrupt_on", 24, "end", SOFT);
    p.arrow(1250, 462, 1250, 492);
    p.box(1100, 500, 300, 80); p.t(1250, 552, "run copies", 32, "middle");
    // verdict and its grader
    p.arrow(750, 574, 750, 684);
    p.box(640, 690, 220, 84); p.t(750, 744, "verdict", 32, "middle");
    p.arrow(864, 716, 992, 716); p.arrow(992, 752, 864, 752);
    p.box(1000, 690, 200, 84); p.t(1100, 744, "grader", 32, "middle");
    p.t(928, 800, "redo", 24, "middle", SOFT);
    p.t(1100, 820, "RubricMiddleware", 24, "middle", SOFT);
  },

  // 3. the experiment: one run, cut before its report, continued four ways
  experiment(svg) {
    const p = pen(svg, 201);
    p.t(70, 120, "One run, four endings", 68);
    const y0 = 520;
    p.line(80, y0, 470, y0);
    p.dot(150, y0, 20); p.t(150, y0 + 56, "writes code", 28, "middle");
    p.dot(350, y0, 20); p.t(350, y0 + 56, "tests it 37×", 28, "middle");
    p.line(470, y0 - 70, 470, y0 + 70, { strokeWidth: 3.2 });
    p.t(462, y0 - 92, "cut before the report", 28, "end", SOFT);
    const rows = [["left alone", 4], ["unrelated step", 4], ["told about it", 4], ["made to test", 0]];
    rows.forEach(([name, bad], i) => {
      const y = 250 + i * 160;
      p.curve([[470, y0], [540, y0 + (y - y0) * 0.35], [590, y - (y - y0) * 0.12], [650, y]]);
      p.t(680, y + 12, name, 38);
      for (let k = 0; k < 4; k++) {
        if (k < bad) p.sq(1010 + k * 54, y - 18, 34);
        else p.circle(1027 + k * 54, y - 1, 36, { strokeWidth: 2.6 });
      }
      p.t(1260, y + 12, `${bad} of 4`, 38);
    });
    p.box(652, 250 + 3 * 160 - 62, 790, 120, { strokeWidth: 3.2 });
    p.sq(80, 838, 30); p.t(126, 864, "still overclaims", 28, "start", SOFT);
    p.circle(95, 911, 32); p.t(126, 922, "honest", 28, "start", SOFT);
  },

  // 4. the math: counts, one probability, two checks, one word
  math(svg) {
    const p = pen(svg, 301);
    p.t(70, 120, "Can it say “caused”?", 68);
    // 2 x 2 counts
    const gx = 310, gy = 300, c = 120;
    p.box(gx, gy, c * 2, c * 2);
    p.line(gx + c, gy, gx + c, gy + c * 2); p.line(gx, gy + c, gx + c * 2, gy + c);
    p.t(gx + c / 2, gy - 18, "overclaims", 26, "middle", SOFT); p.t(gx + c * 1.5, gy - 18, "honest", 28, "middle", SOFT);
    p.t(gx - 22, gy + 72, "left alone", 32, "end"); p.t(gx - 22, gy + c + 72, "made to test", 32, "end");
    [["4", 0, 0], ["0", 1, 0], ["0", 0, 1], ["4", 1, 1]].forEach(([s, i, j]) => p.t(gx + c * (i + 0.5), gy + c * j + 82, s, 64, "middle"));
    // the probability
    p.arrow(580, 420, 668, 420);
    p.t(700, 440, "p = 1/70", 76);
    p.t(704, 492, "Fisher’s exact test", 28, "start", SOFT);
    // two checks
    p.box(1090, 320, 46, 46); p.tick(1113, 343, 16); p.t(1158, 356, "p < 0.05", 36);
    p.box(1090, 450, 46, 46); p.cross(1113, 473, 14); p.t(1158, 486, "8 per group", 36);
    p.t(1158, 530, "we have 4", 28, "start", SOFT);
    // the word
    p.t(90, 812, "so the verdict says", 32, "start", SOFT);
    p.t(560, 818, "suggests", 68, "middle");
    p.ellipse(560, 794, 350, 130, { strokeWidth: 3 });
    p.t(800, 812, "not", 32, "start", SOFT);
    p.t(990, 818, "caused", 68, "middle");
    p.line(872, 796, 1108, 790, { strokeWidth: 3.4 });
  },

  // thumbnail: the gap in two bars
  thumb(svg) {
    const p = pen(svg, 401);
    p.t(110, 200, "Orro", 130);
    p.t(110, 400, "agent claimed", 54, "start", SOFT); p.t(1390, 400, "100%", 96, "end");
    p.box(110, 436, 1280, 84, { fill: INK, fillStyle: "hachure", hachureGap: 7, fillWeight: 2, strokeWidth: 3 });
    p.t(110, 700, "we measured", 54, "start", SOFT); p.t(942, 700, "65%", 96, "end");
    p.box(110, 736, 832, 84, { fill: INK, fillStyle: "hachure", hachureGap: 7, fillWeight: 2, strokeWidth: 3 });
    p.dash(942, 736, 1390, 736); p.dash(942, 820, 1390, 820); p.dash(1390, 736, 1390, 820);
    p.t(1166, 800, "why?", 54, "middle");
  },
};

function drawAll() {
  document.querySelectorAll("svg[data-fig]").forEach((svg) => {
    if (svg.dataset.done) return;
    FIGS[svg.dataset.fig](svg);
    svg.dataset.done = "1";
  });
}
if (document.fonts && document.fonts.load) document.fonts.load('34px "Patrick Hand"').then(drawAll, drawAll); else drawAll();
