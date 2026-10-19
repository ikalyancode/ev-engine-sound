// Generates PWA icons (192px + 512px PNG) with a pure-JS PNG encoder.
// No dependencies — draws a tachometer mark programmatically.
// Run: node scripts/generate-icons.mjs  (also wired as npm "prebuild")
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

// ---------- minimal PNG encoder ----------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const rowBytes = size * 4;
  const raw = Buffer.alloc((rowBytes + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (rowBytes + 1)] = 0; // filter: none
    rgba.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- tiny software rasterizer ----------
function makeCanvas(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const set = (x, y, r, g, b, a = 255) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const sa = a / 255;
    const da = 1 - sa;
    px[i] = r * sa + px[i] * da;
    px[i + 1] = g * sa + px[i + 1] * da;
    px[i + 2] = b * sa + px[i + 2] * da;
    px[i + 3] = Math.max(px[i + 3], a);
  };
  return { px, set, size };
}

function roundedRect(c, x0, y0, x1, y1, r, col) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) c.set(x, y, ...col);
    }
  }
}

function disc(c, cx, cy, r, col) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) c.set(x, y, ...col);
}

function line(c, x0, y0, x1, y1, w, col) {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.ceil(Math.hypot(dx, dy)) * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    disc(c, x0 + dx * t, y0 + dy * t, w / 2, col);
  }
}

function arcBand(c, cx, cy, r, a0, a1, w, col) {
  const steps = Math.ceil(Math.abs(a1 - a0) * r);
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    disc(c, cx + r * Math.cos(a), cy + r * Math.sin(a), w / 2, col);
  }
}

const D2R = Math.PI / 180;

function drawIcon(size) {
  const c = makeCanvas(size);
  const s = size / 512; // scale factor
  // background
  roundedRect(c, 0, 0, size, size, size * 0.22, [11, 14, 20]);
  // subtle inner glow ring
  arcBand(c, size / 2, size / 2, 200 * s, 0, 360 * D2R, 3 * s, [26, 32, 46]);
  // tach sweep: 135° -> 405° (y-down coords, clockwise)
  const cx = size / 2, cy = size / 2, R = 168 * s;
  arcBand(c, cx, cy, R, 135 * D2R, 345 * D2R, 14 * s, [42, 49, 66]);
  arcBand(c, cx, cy, R, 345 * D2R, 405 * D2R, 14 * s, [255, 59, 48]); // redline zone
  // tick marks
  for (let i = 0; i <= 18; i++) {
    const a = (135 + i * 15) * D2R;
    const major = i % 3 === 0;
    const r0 = R - (major ? 34 : 24) * s;
    const red = a >= 345 * D2R;
    line(
      c,
      cx + r0 * Math.cos(a), cy + r0 * Math.sin(a),
      cx + (R - 8 * s) * Math.cos(a), cy + (R - 8 * s) * Math.sin(a),
      (major ? 7 : 4) * s,
      red ? [255, 90, 80] : [150, 160, 180],
    );
  }
  // needle pointing high-rev (~330°)
  const na = 330 * D2R;
  line(c, cx, cy, cx + (R - 20 * s) * Math.cos(na), cy + (R - 20 * s) * Math.sin(na), 12 * s, [255, 69, 58]);
  line(c, cx, cy, cx - 26 * s * Math.cos(na), cy - 26 * s * Math.sin(na), 12 * s, [255, 69, 58]);
  disc(c, cx, cy, 26 * s, [22, 27, 38]);
  disc(c, cx, cy, 10 * s, [255, 69, 58]);
  return c.px;
}

for (const size of [192, 512]) {
  const png = encodePng(size, drawIcon(size));
  const path = join(outDir, `icon-${size}.png`);
  writeFileSync(path, png);
  console.log(`wrote ${path} (${png.length} bytes)`);
}
