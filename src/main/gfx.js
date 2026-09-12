'use strict';
/**
 * Tiny dependency-free raster toolkit: PNG/ICO encoding plus the SDF helpers
 * the app and tray icons are drawn with. Icons are generated from code so they
 * can be re-rendered at any size (and the tray ring re-rendered on every poll)
 * without shipping binary assets or pulling in a canvas dependency.
 */
const zlib = require('zlib');

/* ------------------------------- PNG ---------------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode straight (non-premultiplied) RGBA8 pixels as a PNG buffer. */
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------- ICO --------------------------------- */

/** A 32bpp bottom-up DIB entry: BITMAPINFOHEADER + BGRA rows + empty AND mask. */
function dibEntry(w, h, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8); // XOR and AND masks stacked
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4; // DIB rows run bottom-up
    for (let x = 0; x < w; x++) {
      const s = src + x * 4;
      const d = (y * w + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }
  const maskStride = Math.ceil(w / 32) * 4;
  return Buffer.concat([header, xor, Buffer.alloc(maskStride * h)]);
}

/** Build a multi-resolution .ico. Sizes >= 256 are stored as PNG, the rest as DIB. */
function encodeICO(images) {
  const entries = images.map(({ size, rgba }) => ({
    size,
    data: size >= 256 ? encodePNG(size, size, rgba) : dibEntry(size, size, rgba),
  }));
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach((e, i) => {
    const p = 6 + i * 16;
    dir[p] = e.size >= 256 ? 0 : e.size;
    dir[p + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, p + 4); // planes
    dir.writeUInt16LE(32, p + 6); // bit count
    dir.writeUInt32LE(e.data.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += e.data.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.data)]);
}

/* ------------------------------ shading -------------------------------- */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const mixC = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Source-over a straight-alpha colour onto an accumulator [r,g,b,a]. */
function over(dst, rgb, alpha) {
  if (alpha <= 0) return dst;
  const a = clamp(alpha, 0, 1);
  const outA = a + dst[3] * (1 - a);
  if (outA <= 0) return [0, 0, 0, 0];
  return [
    (rgb[0] * a + dst[0] * dst[3] * (1 - a)) / outA,
    (rgb[1] * a + dst[1] * dst[3] * (1 - a)) / outA,
    (rgb[2] * a + dst[2] * dst[3] * (1 - a)) / outA,
    outA,
  ];
}

const hex = (s) => {
  const n = parseInt(s.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/* --------------------------- distance fields --------------------------- */

const len = (x, y) => Math.hypot(x, y);
const sdCircle = (x, y, r) => len(x, y) - r;

function sdRoundBox(x, y, bx, by, r) {
  const qx = Math.abs(x) - bx + r;
  const qy = Math.abs(y) - by + r;
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Round-capped arc centred on +Y, sweeping +/- `ap` radians, ring radius `ra`,
 * half-thickness `rb`. (Inigo Quilez's sdArc.)
 */
function sdArc(x, y, ap, ra, rb) {
  const sx = Math.sin(ap);
  const sy = Math.cos(ap);
  const px = Math.abs(x);
  return (
    (sy * px > sx * y ? len(px - sx * ra, y - sy * ra) : Math.abs(len(px, y) - ra)) - rb
  );
}

function sdTriangle(px, py, p0, p1, p2) {
  const e0 = [p1[0] - p0[0], p1[1] - p0[1]];
  const e1 = [p2[0] - p1[0], p2[1] - p1[1]];
  const e2 = [p0[0] - p2[0], p0[1] - p2[1]];
  const v0 = [px - p0[0], py - p0[1]];
  const v1 = [px - p1[0], py - p1[1]];
  const v2 = [px - p2[0], py - p2[1]];
  const proj = (v, e) => {
    const t = clamp((v[0] * e[0] + v[1] * e[1]) / (e[0] * e[0] + e[1] * e[1]), 0, 1);
    return [v[0] - e[0] * t, v[1] - e[1] * t];
  };
  const pq0 = proj(v0, e0);
  const pq1 = proj(v1, e1);
  const pq2 = proj(v2, e2);
  const s = Math.sign(e0[0] * e2[1] - e0[1] * e2[0]);
  const dx = Math.min(
    pq0[0] * pq0[0] + pq0[1] * pq0[1],
    pq1[0] * pq1[0] + pq1[1] * pq1[1],
    pq2[0] * pq2[0] + pq2[1] * pq2[1]
  );
  const dy = Math.min(
    s * (v0[0] * e0[1] - v0[1] * e0[0]),
    s * (v1[0] * e1[1] - v1[1] * e1[0]),
    s * (v2[0] * e2[1] - v2[1] * e2[0])
  );
  return -Math.sqrt(dx) * Math.sign(dy);
}

const rot = (x, y, a) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
};

/**
 * Render `shade(x, y, px)` into a w x h RGBA buffer. Coordinates are normalised
 * to [-1, 1] with +Y up; `px` is one device pixel in those units, for AA.
 * Supersampled ss x ss and averaged in premultiplied space.
 */
function render(w, h, shade, ss = 3) {
  const out = Buffer.alloc(w * h * 4);
  const px = 2 / w;
  const n = ss * ss;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const nx = ((x + (sx + 0.5) / ss) / w) * 2 - 1;
          const ny = 1 - ((y + (sy + 0.5) / ss) / h) * 2;
          const c = shade(nx, ny, px);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      a /= n;
      const i = (y * w + x) * 4;
      if (a > 1e-4) {
        out[i] = clamp(Math.round((r / n / a) * 255), 0, 255);
        out[i + 1] = clamp(Math.round((g / n / a) * 255), 0, 255);
        out[i + 2] = clamp(Math.round((b / n / a) * 255), 0, 255);
      }
      out[i + 3] = clamp(Math.round(a * 255), 0, 255);
    }
  }
  return out;
}

/** Antialiased coverage for a distance field, in normalised units. */
const cov = (d, px, feather = 1.0) => clamp(0.5 - d / (px * feather), 0, 1);

module.exports = {
  encodePNG,
  encodeICO,
  render,
  cov,
  over,
  hex,
  mix,
  mixC,
  clamp,
  smoothstep,
  sdCircle,
  sdRoundBox,
  sdArc,
  sdTriangle,
  rot,
};
