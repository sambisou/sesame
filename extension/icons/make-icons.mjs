#!/usr/bin/env node
// Génère 16.png, 48.png et 128.png : la graine dorée du site (site/index.html, symbole #mark) sur fond sombre.
// Node pur, sans dépendance : les courbes du logo sont échantillonnées, le PNG est écrit à la main (zlib natif).
// Usage : node extension/icons/make-icons.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

// Contour de la graine (viewBox 64×64) : point de départ puis quatre courbes de Bézier cubiques.
const START = [32, 3];
const CURVES = [
  [46, 14, 54, 27, 54, 41],
  [54, 54, 44, 61, 32, 61],
  [20, 61, 10, 54, 10, 41],
  [10, 27, 18, 14, 32, 3],
];
function seedPolygon() {
  const pts = [START];
  let p = START;
  for (const [x1, y1, x2, y2, x3, y3] of CURVES) {
    for (let i = 1; i <= 32; i++) {
      const t = i / 32, u = 1 - t;
      pts.push([
        u * u * u * p[0] + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * p[1] + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      ]);
    }
    p = [x3, y3];
  }
  return pts;
}
function inPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Trou de serrure : cercle (32,31) r=7 et trapèze (29.4,36) (34.6,36) (37,48) (27,48).
const HOLE = [[29.4, 36], [34.6, 36], [37, 48], [27, 48]];
function inKeyhole(x, y) {
  const dx = x - 32, dy = y - 31;
  return dx * dx + dy * dy <= 49 || inPolygon(HOLE, x, y);
}

const BG = [0x1a, 0x17, 0x14];
const GOLD_A = [0xe5, 0xb4, 0x4d], GOLD_B = [0xb5, 0x7a, 0x18];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function render(size) {
  const poly = seedPolygon();
  const px = new Uint8ClampedArray(size * size * 4);
  const SS = 4; // sur-échantillonnage 4×4
  const radius = size * 0.22; // coins arrondis du fond
  const pad = 0.1; // marge autour de la graine
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
          // fond : carré à coins arrondis
          const cx = Math.min(Math.max(fx, radius), size - radius), cy = Math.min(Math.max(fy, radius), size - radius);
          if ((fx - cx) ** 2 + (fy - cy) ** 2 > radius * radius) continue;
          // coordonnées dans le repère 64×64 du logo, avec marge
          const u = ((fx / size - pad) / (1 - 2 * pad)) * 64, v = ((fy / size - pad) / (1 - 2 * pad)) * 64;
          let c = BG;
          if (inPolygon(poly, u, v)) c = inKeyhole(u, v) ? BG : mix(GOLD_A, GOLD_B, Math.min(1, Math.max(0, (u + v - 20) / 80)));
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = SS * SS, i = (y * size + x) * 4;
      const cov = a / n;
      if (cov > 0) { px[i] = r / (a / 255); px[i + 1] = g / (a / 255); px[i + 2] = b / (a / 255); px[i + 3] = cov; }
    }
  }
  return px;
}

// --- écriture PNG (RGBA 8 bits, sans filtre) ---
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  const file = path.join(DIR, `${size}.png`);
  fs.writeFileSync(file, png(size, render(size)));
  console.log("écrit", file);
}
