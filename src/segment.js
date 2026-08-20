'use strict';
// Ink mask -> ordered glyph blobs (connected components, multi-part merge,
// reading order), glyph crops as PNGs, and a numbered contact sheet for labeling.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { connectedComponents, mergeParts, orderBlobs, labelComponents, assignComponents } = require('./blob-core');

const PAD = 8; // white border around each crop, px

// A glyph box is a rectangle, but handwriting is not. Whatever a neighbouring
// syllable sweeps through that rectangle gets cropped along with the glyph and
// traced as part of it - the flecks and bars that show up around finished
// glyphs. Edge contact cannot identify them: the box is the bounding box of the
// ink, so the outermost real strokes touch it too. What separates an intruder
// is that its stroke *continues outside* the box - only a fragment of it landed
// here - while the glyph's own detached pieces (the circle of an ieung, the
// short stroke of a vowel) lie wholly within.
async function writeCrop(ink, width, blob, file, parts, owner, ownIndex) {
  const w = blob.x1 - blob.x0 + 1, h = blob.y1 - blob.y0 + 1;
  const cw = w + 2 * PAD, ch = h + 2 * PAD;
  const inside = new Map(); // component id -> pixels of it that fall in this box
  if (parts) {
    for (let y = 0; y < h; y++) {
      const src = (blob.y0 + y) * width + blob.x0;
      for (let x = 0; x < w; x++) {
        if (!ink[src + x]) continue;
        const id = parts.labels[src + x];
        inside.set(id, (inside.get(id) || 0) + 1);
      }
    }
  }
  let mainInside = 0;
  for (const n of inside.values()) if (n > mainInside) mainInside = n;
  const keep = (id) => {
    const here = inside.get(id) || 0;
    if (here < 0.005 * mainInside) return false;      // paper grain, JPEG specks
    if (!owner) return here >= 0.5 * parts.areas[id];
    // Every stroke belongs to whichever glyph holds most of it. Judging that
    // inside one box cannot work: a neighbour's stroke can be a large share of
    // a small glyph and look native, while a stroke this glyph shares with its
    // neighbour looks foreign to both.
    if (owner.get(id) === ownIndex) return true;
    // A stroke the cut runs through must survive in both halves. Measured on
    // cursive Korean: intruders reached 17% of their component, the smallest
    // genuinely shared stroke 30%. Proximity to the glyph body was tried as an
    // additional condition and rejected - a shared stroke can sit a clear gap
    // away from the rest of its syllable, and requiring contact deleted it.
    return here >= 0.25 * parts.areas[id];
  };
  // A stroke shared with the neighbour survives `keep` on purpose - it is
  // genuinely part of both syllables - but only the half on this side of the
  // boundary belongs here. The seam says where that half ends. A stroke this
  // glyph owns outright is never trimmed: its descender may well cross.
  const { seamL, seamR, seamY0 } = blob;
  const beyondSeam = (x, y) => {
    if (seamL) { const r = y - seamY0; if (r >= 0 && r < seamL.length && x < seamL[r]) return true; }
    if (seamR) { const r = y - seamY0; if (r >= 0 && r < seamR.length && x >= seamR[r]) return true; }
    return false;
  };
  const buf = Buffer.alloc(cw * ch, 255);
  for (let y = 0; y < h; y++) {
    const src = (blob.y0 + y) * width + blob.x0;
    const dst = (y + PAD) * cw + PAD;
    for (let x = 0; x < w; x++) {
      if (!ink[src + x]) continue;
      const id = parts ? parts.labels[src + x] : -1;
      if (parts && !keep(id)) continue;
      if ((seamL || seamR) && (!owner || owner.get(id) !== ownIndex)
          && beyondSeam(blob.x0 + x, blob.y0 + y)) continue;
      buf[dst + x] = 0;
    }
  }
  await sharp(buf, { raw: { width: cw, height: ch, channels: 1 } }).png().toFile(file);
  return { width: cw, height: ch };
}

async function writeContactSheet(gray, width, height, blobs, file) {
  const outW = Math.min(1600, width);
  const sf = outW / width;
  const outH = Math.round(height * sf);
  const marks = blobs
    .map((b) => {
      const x = b.x0 * sf, y = b.y0 * sf;
      const w = (b.x1 - b.x0 + 1) * sf, h = (b.y1 - b.y0 + 1) * sf;
      return (
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"` +
        ` fill="none" stroke="#e11" stroke-width="2"/>` +
        `<text x="${(x + 2).toFixed(1)}" y="${Math.max(14, y - 4).toFixed(1)}"` +
        ` font-family="sans-serif" font-size="18" font-weight="bold" fill="#e11">${b.id}</text>`
      );
    })
    .join('');
  const overlay = Buffer.from(`<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg">${marks}</svg>`);
  await sharp(gray, { raw: { width, height, channels: 1 } })
    .resize(outW, outH)
    .composite([{ input: overlay }])
    .png()
    .toFile(file);
}

/**
 * Segment photos into labeled-ready glyph crops.
 * @param {string[]} photos paths
 * @param {string} dir workdir (created if missing)
 * @returns blobs.json content
 */
async function segment(photos, dir, { delta, cap } = {}) {
  const { binarize } = require('./capture');
  fs.mkdirSync(path.join(dir, 'crops'), { recursive: true });
  const all = [];
  let id = 0;
  for (let p = 0; p < photos.length; p++) {
    const { ink, width, height, gray } = await binarize(photos[p], { delta, cap });
    const minArea = Math.max(30, Math.round(width * height * 3e-6));
    let boxes = connectedComponents(ink, width, height, minArea);
    // real pen strokes are never 3px thin at phone-photo resolution
    boxes = boxes.filter((b) => b.x1 - b.x0 + 1 >= 4 && b.y1 - b.y0 + 1 >= 4);
    boxes = mergeParts(boxes);
    const ordered = orderBlobs(boxes).map((b) => ({ ...b, id: id++, photo: photos[p] }));
    for (const b of ordered) {
      b.crop = path.join('crops', `${b.id}.png`);
      b.cropSize = await writeCrop(ink, width, b, path.join(dir, b.crop));
    }
    await writeContactSheet(gray, width, height, ordered, path.join(dir, `contact-${p + 1}.png`));
    all.push(...ordered.map(({ x0, y0, x1, y1, area, row, id: bid, photo, crop, cropSize }) => ({
      id: bid, photo, row, box: { x0, y0, x1, y1 }, area, crop, cropSize,
    })));
  }
  const manifest = { pad: PAD, photos, blobs: all };
  fs.writeFileSync(path.join(dir, 'blobs.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

module.exports = { segment, PAD, writeCrop, writeContactSheet, labelComponents, assignComponents };
