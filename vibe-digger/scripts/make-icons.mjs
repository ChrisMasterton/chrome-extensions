// Generates the extension icons (rounded indigo tile with a bright "V"
// chevron) as raw PNGs using only node built-ins. Usage: npm run icons.
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

function makeIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const stroke = size * 0.09;

  // "V" chevron endpoints, in unit space.
  const left = [0.28, 0.32];
  const bottom = [0.5, 0.72];
  const right = [0.72, 0.32];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;

      // Rounded-rect alpha.
      const cx = Math.max(radius - px, px - (size - radius), 0);
      const cy = Math.max(radius - py, py - (size - radius), 0);
      const cornerDist = Math.hypot(cx, cy);
      const alpha = Math.max(0, Math.min(1, radius - cornerDist + 0.5));
      if (alpha <= 0) continue;

      // Background: vertical indigo gradient.
      const t = y / size;
      let r = Math.round(0x2a + (0x17 - 0x2a) * t);
      let g = Math.round(0x24 + (0x14 - 0x24) * t);
      let b = Math.round(0x6b + (0x2e - 0x6b) * t);

      // Chevron stroke: violet at the tips blending to pink at the tip.
      const d = Math.min(
        distanceToSegment(px, py, left[0] * size, left[1] * size, bottom[0] * size, bottom[1] * size),
        distanceToSegment(px, py, bottom[0] * size, bottom[1] * size, right[0] * size, right[1] * size)
      );
      const coverage = Math.max(0, Math.min(1, stroke - d + 0.5));
      if (coverage > 0) {
        const depth = Math.max(0, Math.min(1, (py / size - 0.32) / 0.4));
        const sr = Math.round(0xa7 + (0xf4 - 0xa7) * depth);
        const sg = Math.round(0x8b + (0x72 - 0x8b) * depth);
        const sb = Math.round(0xfa + (0xb6 - 0xfa) * depth);
        r = Math.round(r + (sr - r) * coverage);
        g = Math.round(g + (sg - g) * coverage);
        b = Math.round(b + (sb - b) * coverage);
      }

      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, pixels);
}

for (const size of [16, 48, 128]) {
  const file = `${OUT_DIR}icon${size}.png`;
  writeFileSync(file, makeIcon(size));
  console.log(`wrote ${file}`);
}
