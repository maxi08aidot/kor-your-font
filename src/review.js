'use strict';
// Side-by-side review sheets: for every character in the font, the region of
// the source photo it came from, above the glyph the font actually draws.
//
// Judging a finished font by scanning a grid of small glyphs does not work -
// it hides broken letters and invents faults in sound ones. Each glyph has to
// be looked at large, next to the ink it was made from, which is what these
// sheets are for. They render straight from the placed vectors, so no font
// rasterizer is involved.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { UPM } = require('./metrics');

const CELL = 240;      // px per tile side
const GAP = 8;
const LABEL = 30;

function glyphSvg(glyph, size) {
  if (!glyph || !glyph.d) return '';
  const k = (size * 0.78) / UPM;
  const x = size * 0.11;
  const y = size * 0.84;
  return `<path transform="translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${k.toFixed(4)},${(-k).toFixed(4)})" d="${glyph.d}" fill="#111" fill-rule="evenodd"/>`;
}

async function renderReview(dir, outFile, { perSheet = 7, manifest } = {}) {
  if (!manifest) manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const blobs = JSON.parse(fs.readFileSync(path.join(dir, 'blobs.json'), 'utf8'));
  const byCrop = new Map(blobs.blobs.map((b) => [b.crop, b]));
  const entries = Object.entries(manifest.glyphs).filter(([, g]) => g && g.d);
  if (!entries.length) throw new Error('No glyphs in this workdir - build the font first.');

  const sheets = [];
  for (let start = 0; start < entries.length; start += perSheet) {
    const slice = entries.slice(start, start + perSheet);
    const tiles = [];
    let x = 0;
    for (const [char, glyph] of slice) {
      const blob = byCrop.get(glyph.source);
      if (blob) {
        const photo = blob.photo || blobs.photos[0];
        const meta = await sharp(photo, { limitInputPixels: 1e9 }).rotate().metadata();
        const left = Math.max(0, blob.box.x0 - 4);
        const top = Math.max(0, blob.box.y0 - 4);
        const region = {
          left, top,
          width: Math.min(meta.width, blob.box.x1 + 5) - left,
          height: Math.min(meta.height, blob.box.y1 + 5) - top,
        };
        tiles.push({
          input: await sharp(photo, { limitInputPixels: 1e9 }).rotate().grayscale().extract(region)
            .resize({ width: CELL, height: CELL, fit: 'contain', background: { r: 255, g: 255, b: 255 } })
            .png().toBuffer(),
          left: x, top: 0,
        });
      }
      const svg = `<svg width="${CELL}" height="${CELL}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/>${glyphSvg(glyph, CELL)}</svg>`;
      tiles.push({ input: await sharp(Buffer.from(svg)).png().toBuffer(), left: x, top: CELL + GAP });
      const label = `<svg width="${CELL}" height="${LABEL}" xmlns="http://www.w3.org/2000/svg"><text x="6" y="23" font-size="22" fill="#0b62d6" font-weight="bold">${char.replace(/[<&>]/g, '')}</text></svg>`;
      tiles.push({ input: Buffer.from(label), left: x, top: 2 * CELL + 2 * GAP });
      x += CELL + GAP;
    }
    const file = sheets.length || entries.length > perSheet
      ? outFile.replace(/(\.png)?$/i, `-${sheets.length + 1}.png`)
      : outFile;
    await sharp({ create: { width: x, height: 2 * CELL + 2 * GAP + LABEL, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite(tiles).png().toFile(file);
    sheets.push(file);
  }
  return sheets;
}

module.exports = { renderReview };
