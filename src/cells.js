'use strict';
// Cell-addressed capture, shared by every printed-sheet flow.
//
// A printed sheet tells us where each character is, so there is nothing to
// recognise and nothing to guess. That matters more than it sounds: the
// alternative - finding connected components and assuming they come out in
// reading order - miscounts as soon as writing is ornate enough to break into
// extra pieces, and one extra piece shifts every character after it.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SHEET = { margin: 40, header: 70, cols: 6, rows: 7, pad: 8 };
const A4 = { w: 595.28, h: 841.89 };
const PER_PAGE = SHEET.cols * SHEET.rows;

// Where cell `index` sits in a photo of the printed page. The 4pt inset keeps
// the printed rule itself outside the search area.
function cellBox(width, height, index) {
  const sx = width / A4.w, sy = height / A4.h;
  const gridW = A4.w - 2 * SHEET.margin;
  const gridH = A4.h - SHEET.margin - (SHEET.margin + SHEET.header);
  const cw = gridW / SHEET.cols, ch = gridH / SHEET.rows;
  const col = index % SHEET.cols, row = Math.floor(index / SHEET.cols);
  return {
    x: Math.round((SHEET.margin + col * cw) * sx),
    y: Math.round((SHEET.margin + SHEET.header + row * ch) * sy),
    x1: Math.round((SHEET.margin + col * cw + cw - 4) * sx),
    y1: Math.round((SHEET.margin + SHEET.header + row * ch + ch - 4) * sy),
  };
}

/**
 * @param {string[]} photos one per printed page, in order
 * @param {string} dir workdir
 * @param {Array<{label: string, name: string}>} items one per cell, in sheet order
 */
async function captureCells(photos, dir, items, { delta, cap, pageLabel = 'page' } = {}) {
  const { binarize } = require('./capture');
  const pages = Math.ceil(items.length / PER_PAGE);
  if (photos.length < pages) {
    throw new Error(`This sheet needs ${pages} page photo(s); received ${photos.length}.`);
  }
  fs.mkdirSync(path.join(dir, 'crops'), { recursive: true });
  const blobs = [], labels = {}, clipped = [];
  let id = 0;
  for (let page = 0; page * PER_PAGE < items.length; page++) {
    const { ink, width, height, gray } = await binarize(photos[page], { delta, cap });
    for (let i = 0; i < PER_PAGE && page * PER_PAGE + i < items.length; i++) {
      const item = items[page * PER_PAGE + i];
      const box = cellBox(width, height, i);
      let x0 = box.x1, y0 = box.y1, x1 = box.x, y1 = box.y;
      for (let y = box.y; y < box.y1; y++) for (let x = box.x; x < box.x1; x++) {
        if (!ink[y * width + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      if (x1 < x0 || y1 < y0) {
        throw new Error(`No ink found in cell ${item.name}. Re-shoot page ${page + 1}.`);
      }
      // Only this cell is searched, so a stroke that left it does not exist as
      // far as the build is concerned - the character is quietly wrong. Ink
      // reaching the boundary is the signal that it kept going.
      const EDGE = 2;
      const sides = [];
      if (y0 <= box.y + EDGE) sides.push('top');
      if (y1 >= box.y1 - 1 - EDGE) sides.push('bottom');
      if (x0 <= box.x + EDGE) sides.push('left');
      if (x1 >= box.x1 - 1 - EDGE) sides.push('right');
      if (sides.length) clipped.push({ name: item.name, page: page + 1, sides });

      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const cw = w + 2 * SHEET.pad, ch = h + 2 * SHEET.pad;
      const pixels = Buffer.alloc(cw * ch, 255);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (ink[(y0 + y) * width + x0 + x]) pixels[(y + SHEET.pad) * cw + x + SHEET.pad] = 0;
      }
      const crop = path.join('crops', `${id}.png`);
      await sharp(pixels, { raw: { width: cw, height: ch, channels: 1 } }).png().toFile(path.join(dir, crop));
      blobs.push({ id, photo: photos[page], row: Math.floor(i / SHEET.cols), box: { x0, y0, x1, y1 }, crop, cropSize: { width: cw, height: ch } });
      labels[id] = item.label;
      id++;
    }
    await sharp(gray, { raw: { width, height, channels: 1 } }).png()
      .toFile(path.join(dir, `${pageLabel}-${page + 1}.png`));
  }
  if (clipped.length) {
    console.warn(`  ! ${clipped.length} cell(s) run past their edge and were cut off:`);
    for (const c of clipped) console.warn(`      ${c.name} (page ${c.page}, ${c.sides.join(' and ')})`);
    console.warn('    Anything built from these will be wrong. Re-write them smaller,');
    console.warn('    inside their boxes, re-shoot that page, and rebuild.');
  }
  return { mode: 'cells', pad: SHEET.pad, photos: photos.slice(0, pages), blobs, labels, clipped };
}

module.exports = { SHEET, A4, PER_PAGE, cellBox, captureCells };
