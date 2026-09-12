'use strict';
/**
 * The tray icon is redrawn on every poll so the taskbar itself reports state:
 * a ring whose sweep is the active account's 5h usage, coloured by headroom,
 * with the account's slot number in the middle.
 *
 * Rendered at several scale factors and handed to nativeImage as separate
 * representations, so Windows picks the right one per-DPI instead of
 * resampling a single bitmap.
 */
const g = require('./gfx');

const COLORS = {
  ok: g.hex('#4ADE80'),
  warn: g.hex('#FBBF24'),
  high: g.hex('#FB7185'),
  idle: g.hex('#9CA3AF'),
  accent: g.hex('#E0805F'),
};

/** Headroom banding, matching how the CLI's dashboard reads at a glance. */
function bandFor(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'idle';
  if (pct >= 85) return 'high';
  if (pct >= 60) return 'warn';
  return 'ok';
}

// 3x5 bitmap digits — the only text small enough to stay legible at 16px.
const DIGITS = {
  0: [0b111, 0b101, 0b101, 0b101, 0b111],
  1: [0b010, 0b110, 0b010, 0b010, 0b111],
  2: [0b111, 0b001, 0b111, 0b100, 0b111],
  3: [0b111, 0b001, 0b111, 0b001, 0b111],
  4: [0b101, 0b101, 0b111, 0b001, 0b001],
  5: [0b111, 0b100, 0b111, 0b001, 0b111],
  6: [0b111, 0b100, 0b111, 0b101, 0b111],
  7: [0b111, 0b001, 0b001, 0b010, 0b010],
  8: [0b111, 0b101, 0b111, 0b101, 0b111],
  9: [0b111, 0b101, 0b111, 0b001, 0b111],
};

/** Distance field for one digit in a box of half-width bw, half-height bh. */
function sdDigit(x, y, digit, bw, bh) {
  const rows = DIGITS[digit];
  if (!rows) return 1e9;
  const cw = bw / 3; // cell half-extents
  const ch = bh / 5;
  let d = 1e9;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 3; c++) {
      if (!(rows[r] & (1 << (2 - c)))) continue;
      const cx = -bw + cw * (2 * c + 1);
      const cy = bh - ch * (2 * r + 1);
      // Cells are grown slightly so strokes read as one solid mark, not a grid.
      d = Math.min(d, g.sdRoundBox(x - cx, y - cy, cw * 1.12, ch * 1.12, cw * 0.28));
    }
  }
  return d;
}

/** One or two digits, centred. Slots past 99 fall back to a dot elsewhere. */
function sdNumber(x, y, n, bw, bh) {
  if (n < 10) return sdDigit(x, y, n, bw, bh);
  const dw = bw * 0.46; // each digit narrows so the pair still fits the ring
  const gap = bw * 0.12;
  return Math.min(
    sdDigit(x + dw + gap, y, Math.floor(n / 10) % 10, dw, bh),
    sdDigit(x - dw - gap, y, n % 10, dw, bh)
  );
}

/**
 * Draw the ring at one pixel size.
 * @param {number} size            square edge in device pixels
 * @param {object} opts
 * @param {number|null} opts.pct   0-100 sweep, or null for "unknown"
 * @param {number|null} opts.slot  account number shown in the middle
 * @param {boolean} opts.dark      taskbar is dark (drives the track colour)
 * @param {boolean} opts.busy      dim everything while a refresh is in flight
 * @param {boolean} opts.colored   false = monochrome ring (accentUsage off)
 */
function renderRGBA(size, opts) {
  const { pct, slot, dark = true, busy = false, colored = true } = opts || {};
  const ink = dark ? [1, 1, 1] : [0.11, 0.12, 0.14];
  const band = bandFor(pct);
  const arcColor = colored ? COLORS[band] : ink;
  const trackAlpha = dark ? 0.24 : 0.2;

  const ra = 0.7; // ring radius
  const rb = 0.165; // ring half-thickness
  const sweep = pct == null ? 0 : Math.PI * 2 * g.clamp(pct / 100, 0, 1);
  const half = sweep / 2;
  const fade = busy ? 0.45 : 1;

  return g.render(
    size,
    size,
    (x, y, px) => {
      let c = [0, 0, 0, 0];

      // Track: the full annulus, under the progress sweep.
      const track = Math.abs(g.sdCircle(x, y, ra)) - rb;
      c = g.over(c, ink, g.cov(track, px) * trackAlpha * fade);

      // Progress: a sweep from 12 o'clock, clockwise. sdArc is symmetric about
      // +Y, so rotate the sample point by half the sweep to place its start there.
      if (sweep > 0.001) {
        if (sweep >= Math.PI * 2 - 0.001) {
          c = g.over(c, arcColor, g.cov(track, px) * fade);
        } else {
          const [ax, ay] = g.rot(x, y, half);
          c = g.over(c, arcColor, g.cov(g.sdArc(ax, ay, half, ra, rb), px) * fade);
        }
      }

      // Slot number, or a dot when there is nothing (useful) to number.
      if (slot != null && slot >= 0 && slot <= 99) {
        const d = sdNumber(x, y, slot, slot < 10 ? 0.24 : 0.4, 0.4);
        c = g.over(c, ink, g.cov(d, px) * 0.95 * fade);
      } else {
        c = g.over(c, ink, g.cov(g.sdCircle(x, y, 0.14), px) * 0.6 * fade);
      }
      return c;
    },
    size <= 20 ? 6 : 4
  );
}

/** Build a multi-DPI nativeImage for the tray. */
function buildTrayImage(opts) {
  // Required lazily so this module stays runnable outside Electron.
  const { nativeImage } = require('electron');
  const image = nativeImage.createEmpty();
  for (const [scaleFactor, size] of [
    [1, 16],
    [1.25, 20],
    [1.5, 24],
    [2, 32],
    [2.5, 40],
  ]) {
    image.addRepresentation({
      scaleFactor,
      width: size,
      height: size,
      buffer: g.encodePNG(size, size, renderRGBA(size, opts)),
    });
  }
  return image;
}

module.exports = { buildTrayImage, renderRGBA, bandFor, COLORS };
