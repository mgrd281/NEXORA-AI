// Renders the JARVIS app icon (1024×1024, opaque RGB PNG) — the Presence ring on the
// Meridian dark canvas. No dependencies: anti-aliased by analytic pixel coverage and
// encoded with node:zlib.
//
//   node apps/ios/scripts/make-app-icon.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../Jarvis/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png',
);

// Meridian dark tokens (packages/tokens/src/tokens.ts).
const canvas = [0x0e, 0x0f, 0x12];
const track = [0x3f, 0x40, 0x42]; // borderStrong
const accent = [0x8e, 0xad, 0xff];

const cx = SIZE / 2;
const cy = SIZE / 2;
const radius = SIZE * 0.3;
const width = SIZE * 0.075;
const dotRadius = SIZE * 0.065;
const sweep = Math.PI * 1.5; // 270° arc, clockwise from 12 o'clock

const clamp = (v) => Math.min(1, Math.max(0, v));
const coverage = (signedDistance) => clamp(0.5 - signedDistance);
const mix = (base, top, a) => base.map((c, i) => c + (top[i] - c) * a);

const capA = [cx, cy - radius];
const capB = [cx + radius * Math.sin(sweep), cy - radius * Math.cos(sweep)];

const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE);
let offset = 0;
for (let y = 0; y < SIZE; y++) {
  raw[offset++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5;
    const py = y + 0.5;
    const dx = px - cx;
    const dy = py - cy;
    const d = Math.hypot(dx, dy);
    let angle = Math.atan2(dx, -dy);
    if (angle < 0) angle += Math.PI * 2;

    const band = coverage(Math.abs(d - radius) - width / 2);
    const inArc = angle <= sweep ? band : 0;
    const caps = Math.max(
      coverage(Math.hypot(px - capA[0], py - capA[1]) - width / 2),
      coverage(Math.hypot(px - capB[0], py - capB[1]) - width / 2),
    );
    const arc = Math.max(inArc, caps);
    const dot = coverage(d - dotRadius);

    let color = canvas;
    color = mix(color, track, band);
    color = mix(color, accent, arc);
    color = mix(color, accent, dot);
    for (const c of color) raw[offset++] = Math.round(c);
  }
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type: truecolour, no alpha (App Store icons must be opaque)
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${png.length} bytes)`);
