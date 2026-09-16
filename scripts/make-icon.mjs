#!/usr/bin/env node
/**
 * Generates scripts/icon-source.png -- a 1024x1024 PLACEHOLDER app icon.
 *
 * !! PLACEHOLDER !!  There is no Caelon brand asset in this repo. Replace
 * scripts/icon-source.png with the real 1024x1024 artwork and re-run
 * `pnpm icon` to regenerate the full icon set.
 *
 * Written with zero dependencies: PNG chunk assembly and CRC32 are implemented
 * here, compression uses node:zlib.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SIZE = 1024;

// ---------------------------------------------------------------- PNG codec

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter byte (0 = None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ drawing

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Analytic antialiasing: convert a signed distance (in px) to coverage. */
const cover = (signedDistance) => clamp01(0.5 - signedDistance);

/** Coverage of a rounded square centred on the canvas. */
function roundedRectCoverage(x, y, size, radius) {
  const half = size / 2;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const dx = Math.abs(x - cx) - (half - radius);
  const dy = Math.abs(y - cy) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return cover(outside + inside - radius);
}

/** Coverage of a filled disc. */
function discCoverage(x, y, cx, cy, r) {
  return cover(Math.hypot(x - cx, y - cy) - r);
}

/**
 * Coverage of a "C": an annulus with a wedge removed on the east side, with
 * round caps at the wedge boundary so the terminals read as pen strokes.
 */
function letterCCoverage(x, y) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const rOuter = 340;
  const rInner = 215;
  const mid = (rOuter + rInner) / 2;
  const capR = (rOuter - rInner) / 2;
  const openingDeg = 38;

  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.hypot(dx, dy);

  // Annulus coverage: inside the outer edge AND outside the inner edge.
  let ring = Math.min(cover(dist - rOuter), cover(rInner - dist));

  // Remove the wedge that opens to the right.
  const angle = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
  if (angle < openingDeg) {
    ring = 0;
  }

  // Round caps sit exactly on the wedge boundary, hiding the hard cut.
  const theta = (openingDeg * Math.PI) / 180;
  const caps = Math.max(
    discCoverage(x, y, cx + mid * Math.cos(theta), cy + mid * Math.sin(theta), capR),
    discCoverage(x, y, cx + mid * Math.cos(-theta), cy + mid * Math.sin(-theta), capR)
  );

  return Math.max(ring, caps);
}

function render() {
  const bg = [0x0b, 0x0d, 0x10];
  const fg = [0xf5, 0xf7, 0xfa];
  const rgba = Buffer.alloc(SIZE * SIZE * 4);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Sample at pixel centres.
      const px = x + 0.5;
      const py = y + 0.5;

      const plate = roundedRectCoverage(px, py, SIZE, 224);
      const glyph = letterCCoverage(px, py) * plate;

      // Composite glyph over plate, then plate over transparency.
      const r = bg[0] * (1 - glyph) + fg[0] * glyph;
      const g = bg[1] * (1 - glyph) + fg[1] * glyph;
      const b = bg[2] * (1 - glyph) + fg[2] * glyph;

      const i = (y * SIZE + x) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(plate * 255);
    }
  }

  return encodePng(SIZE, SIZE, rgba);
}

const outPath = join(dirname(fileURLToPath(import.meta.url)), "icon-source.png");
writeFileSync(outPath, render());
console.log(`wrote placeholder icon: ${outPath} (${SIZE}x${SIZE})`);
