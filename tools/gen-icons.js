'use strict';
/**
 * Generates build/icon.ico (app + installer) and build/icon.png (about box)
 * from code. Run with `npm run icons`.
 *
 * The mark: a warm squircle with a glass sheen, carrying a two-arrow swap
 * cycle — the same "rotate between accounts" idea the CLI is built around.
 */
const fs = require('fs');
const path = require('path');
const g = require('../src/main/gfx');

const TOP = g.hex('#F0916B');
const BOTTOM = g.hex('#BE5333');
const GLYPH = g.hex('#FFF6F1');

/** One arm of the cycle: an arc plus the arrowhead at its leading end. */
function arm(x, y, turn) {
  const ap = 1.15; // half-sweep in radians
  const ra = 0.46; // ring radius
  const rb = 0.098; // half-thickness
  const [rx, ry] = g.rot(x, y, turn);
  const d = g.sdArc(rx, ry, ap, ra, rb);

  // Leading tip sits at +ap from +Y, travelling clockwise.
  const tx = Math.sin(ap) * ra;
  const ty = Math.cos(ap) * ra;
  const dirx = Math.cos(ap);
  const diry = -Math.sin(ap);
  const head = 0.205;
  const half = 0.158;
  const tri = g.sdTriangle(
    rx,
    ry,
    [tx + dirx * head, ty + diry * head],
    [tx - diry * half, ty + dirx * half],
    [tx + diry * half, ty - dirx * half]
  );
  return Math.min(d, tri);
}

function shade(x, y, px) {
  let c = [0, 0, 0, 0];

  // Body: squircle with a vertical warm gradient.
  const body = g.sdRoundBox(x, y, 0.9, 0.9, 0.42);
  const t = g.clamp((0.9 - y) / 1.8, 0, 1);
  let base = g.mixC(TOP, BOTTOM, t * t * 0.85 + t * 0.15);

  // Diagonal specular sweep across the upper-left, and a soft rim light.
  const sheen = g.smoothstep(0.35, -0.85, x - y * 0.85) * 0.22;
  base = g.mixC(base, [1, 1, 1], sheen);
  const rim = g.smoothstep(0.06, 0.0, Math.abs(body + 0.035)) * 0.3;
  base = g.mixC(base, [1, 1, 1], rim * g.smoothstep(-0.2, 0.9, y));

  c = g.over(c, base, g.cov(body, px));

  // Glyph: two opposed arms, with a drop shadow for separation.
  const glyph = Math.min(arm(x, y, 0), arm(x, y, Math.PI));
  c = g.over(c, [0.35, 0.12, 0.05], g.cov(glyph + 0.02, px, 2.6) * 0.28);
  c = g.over(c, GLYPH, g.cov(glyph, px));
  return c;
}

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const images = SIZES.map((size) => ({
  size,
  // Small sizes need more samples to keep the thin arms clean.
  rgba: g.render(size, size, shade, size <= 32 ? 6 : 3),
}));

fs.writeFileSync(path.join(outDir, 'icon.ico'), g.encodeICO(images));

const big = g.render(512, 512, shade, 3);
fs.writeFileSync(path.join(outDir, 'icon.png'), g.encodePNG(512, 512, big));

console.log('wrote build/icon.ico (' + SIZES.join(', ') + ') and build/icon.png (512)');
