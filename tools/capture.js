'use strict';
/**
 * Dev-only visual check (`npm start -- --shot out.png`).
 *
 * Grabs the popover's web contents and composites it over a blurred synthetic
 * desktop, approximating what the Windows acrylic backdrop puts behind it —
 * DWM draws that outside the page, so a raw capture alone shows the glass
 * floating on nothing.
 */
const fs = require('fs');
const g = require('../src/main/gfx');

/** A plausible desktop: deep gradient plus a few soft colour pools. */
function wallpaper(width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  const pools = [
    { x: 0.25, y: 0.3, r: 0.55, c: [0.16, 0.2, 0.42] },
    { x: 0.78, y: 0.68, r: 0.5, c: [0.36, 0.16, 0.3] },
    { x: 0.55, y: 0.12, r: 0.4, c: [0.1, 0.28, 0.34] },
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      let r = g.mix(0.06, 0.12, v);
      let gg = g.mix(0.07, 0.1, v);
      let b = g.mix(0.12, 0.16, 1 - v);
      for (const pool of pools) {
        const d = Math.hypot(u - pool.x, (v - pool.y) * (height / width));
        const w = Math.max(0, 1 - d / pool.r) ** 2;
        r += pool.c[0] * w;
        gg += pool.c[1] * w;
        b += pool.c[2] * w;
      }
      const i = (y * width + x) * 4;
      rgba[i] = Math.min(255, r * 255);
      rgba[i + 1] = Math.min(255, gg * 255);
      rgba[i + 2] = Math.min(255, b * 255);
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/** Separable box blur — stands in for the acrylic backdrop blur. */
function blur(rgba, width, height, radius) {
  const pass = (src, w, h, horizontal) => {
    const dst = Buffer.alloc(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0;
        let gg = 0;
        let b = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
          const sy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
          const i = (sy * w + sx) * 4;
          r += src[i];
          gg += src[i + 1];
          b += src[i + 2];
          n++;
        }
        const o = (y * w + x) * 4;
        dst[o] = r / n;
        dst[o + 1] = gg / n;
        dst[o + 2] = b / n;
        dst[o + 3] = 255;
      }
    }
    return dst;
  };
  return pass(pass(rgba, width, height, true), width, height, false);
}

/**
 * @param {Electron.BrowserWindow} win
 * @param {string} out       png path
 * @param {number} opacity   window opacity to simulate
 */
async function capture(win, out, opacity = 1) {
  const image = await win.webContents.capturePage();
  const { width, height } = image.getSize();
  if (!width || !height) throw new Error('empty capture');
  const fg = image.toBitmap(); // BGRA, premultiplied by the compositor

  const pad = 26;
  const W = width + pad * 2;
  const H = height + pad * 2;
  const bg = blur(wallpaper(W, H), W, H, 14);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const a = (fg[s + 3] / 255) * opacity;
      if (a <= 0) continue;
      const d = ((y + pad) * W + x + pad) * 4;
      // Source is premultiplied: scale straight, then over.
      bg[d] = fg[s + 2] * opacity + bg[d] * (1 - a);
      bg[d + 1] = fg[s + 1] * opacity + bg[d + 1] * (1 - a);
      bg[d + 2] = fg[s] * opacity + bg[d + 2] * (1 - a);
    }
  }
  fs.writeFileSync(out, g.encodePNG(W, H, bg));
  return { out, width: W, height: H };
}

module.exports = capture;
