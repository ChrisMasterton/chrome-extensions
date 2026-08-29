// Generates the extension icons as raw PNGs using only node built-ins:
// a rounded indigo tile where a neon "V" digs down through glowing cyan
// strata and throws a spark at the tip. Usage: npm run icons.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('..', import.meta.url));

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;

// A four-point spark: two crossing rays that taper to points, plus a core.
function sparkCoverage(px, py, cx, cy, rayLength, maxHalfWidth) {
  let coverage = 0;
  for (const [dx, dy] of [[1, 0], [0, 1]]) {
    const along = Math.abs((px - cx) * dx + (py - cy) * dy);
    const across = Math.abs((px - cx) * dy + (py - cy) * dx);
    if (along > rayLength) continue;
    const halfWidth = maxHalfWidth * (1 - along / rayLength);
    coverage = Math.max(coverage, clamp01(halfWidth - across + 0.5));
  }
  const core = clamp01(maxHalfWidth * 1.4 - Math.hypot(px - cx, py - cy) + 0.5);
  return Math.max(coverage, core);
}

function makeIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const SS = 4; // supersamples per axis, for clean edges at 16px
  const radius = size * 0.22;
  const stroke = size * 0.088;

  // "V" chevron endpoints, in unit space.
  const left = [0.29, 0.28];
  const tip = [0.5, 0.7];
  const right = [0.71, 0.28];
  const tipX = tip[0] * size;
  const tipY = tip[1] * size;

  const sample = (px, py) => {
    // Rounded-rect tile alpha.
    const cx = Math.max(radius - px, px - (size - radius), 0);
    const cy = Math.max(radius - py, py - (size - radius), 0);
    const alpha = clamp01(radius - Math.hypot(cx, cy) + 0.5);
    if (alpha <= 0) return [0, 0, 0, 0];

    // Background: vertical indigo gradient, darker underground.
    const t = py / size;
    let r = lerp(0x2f, 0x14, t);
    let g = lerp(0x28, 0x11, t);
    let b = lerp(0x74, 0x2b, t);

    const chevronDist = Math.min(
      distanceToSegment(px, py, left[0] * size, left[1] * size, tipX, tipY),
      distanceToSegment(px, py, tipX, tipY, right[0] * size, right[1] * size)
    );

    // Strata the V digs through: wavy cyan seams, dimmer with depth,
    // broken open around the chevron.
    for (let layer = 0; layer < 3; layer += 1) {
      const baseY = (0.56 + layer * 0.13) * size;
      const waveY = baseY + 0.02 * size * Math.sin((px / size) * Math.PI * 3.2 + layer * 1.9 + 0.7);
      const lineCoverage = clamp01(0.017 * size - Math.abs(py - waveY) + 0.5);
      if (lineCoverage <= 0) continue;
      const gap = clamp01((chevronDist - stroke * 1.35) / (stroke * 0.9));
      const strength = lineCoverage * gap * (0.85 - layer * 0.26);
      r = lerp(r, 0x67, strength);
      g = lerp(g, 0xe8, strength);
      b = lerp(b, 0xf9, strength);
    }

    // Neon glow around the chevron, then the solid stroke:
    // violet up top blending to hot pink at the digging tip.
    const depth = clamp01((py / size - 0.28) / 0.42);
    const strokeR = lerp(0xa7, 0xf4, depth);
    const strokeG = lerp(0x8b, 0x72, depth);
    const strokeB = lerp(0xfa, 0xb6, depth);
    const glow = clamp01(1 - chevronDist / (stroke * 2.8)) ** 2 * 0.4;
    r = lerp(r, strokeR, glow);
    g = lerp(g, strokeG, glow);
    b = lerp(b, strokeB, glow);
    const coverage = clamp01(stroke - chevronDist + 0.5);
    r = lerp(r, strokeR, coverage);
    g = lerp(g, strokeG, coverage);
    b = lerp(b, strokeB, coverage);

    // Impact spark at the tip: warm halo, then a bright star.
    const sparkX = tipX;
    const sparkY = tipY + stroke * 0.9;
    const halo = clamp01(1 - Math.hypot(px - sparkX, py - sparkY) / (size * 0.13)) ** 2 * 0.5;
    r = lerp(r, 0xff, halo);
    g = lerp(g, 0xe4, halo);
    b = lerp(b, 0x8a, halo);
    const spark = sparkCoverage(px, py, sparkX, sparkY, size * 0.105, size * 0.02);
    r = lerp(r, 0xff, spark);
    g = lerp(g, 0xfb, spark);
    b = lerp(b, 0xdb, spark);

    // A tiny drifting sparkle in the open sky, top right.
    const twinkle = sparkCoverage(px, py, size * 0.79, size * 0.17, size * 0.05, size * 0.011) * 0.9;
    r = lerp(r, 0xbf, twinkle);
    g = lerp(g, 0xf3, twinkle);
    b = lerp(b, 0xff, twinkle);

    return [r, g, b, alpha * 255];
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const [sr, sg, sb, sa] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          r += sr;
          g += sg;
          b += sb;
          a += sa;
        }
      }
      const samples = SS * SS;
      pixels[offset] = Math.round(r / samples);
      pixels[offset + 1] = Math.round(g / samples);
      pixels[offset + 2] = Math.round(b / samples);
      pixels[offset + 3] = Math.round(a / samples);
    }
  }
  return encodePng(size, pixels);
}

for (const size of [16, 48, 128]) {
  const file = `${OUT_DIR}icon${size}.png`;
  writeFileSync(file, makeIcon(size));
  console.log(`wrote ${file}`);
}
