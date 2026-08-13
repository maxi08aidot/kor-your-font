'use strict';

// Modern Hangul is algorithmic: 19 leading consonants × 21 vowels ×
// (no final + 27 final consonants) = 11,172 precomposed Unicode syllables.
// We deliberately emit those precomposed codepoints. This works in ordinary
// Korean text fields and browsers without depending on optional GSUB shaping.
const svgpath = require('svgpath');
const { fixWinding } = require('./winding');

const LEADS = [...'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'];
const VOWELS = [...'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'];
const FINALS = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'];
const VERTICAL_VOWELS = new Set([...'ㅏㅐㅑㅒㅓㅔㅕㅖㅣ']);
const HANGUL_START = 0xac00;
const HANGUL_COUNT = LEADS.length * VOWELS.length * FINALS.length;
const A4 = { w: 595.28, h: 841.89 };
const TEMPLATE = { margin: 40, header: 70, cols: 6, rows: 7, pad: 8 };

function componentKey(role, char) {
  return `${role}:${char}`;
}

function requiredComponents() {
  return [
    ...LEADS.map((char) => ({ role: 'L', char, key: componentKey('L', char) })),
    ...VOWELS.map((char) => ({ role: 'V', char, key: componentKey('V', char) })),
    ...FINALS.slice(1).map((char) => ({ role: 'T', char, key: componentKey('T', char) })),
  ];
}

function decomposeSyllable(codepoint) {
  const n = codepoint - HANGUL_START;
  if (n < 0 || n >= HANGUL_COUNT) throw new Error('Not a modern Hangul syllable');
  const lead = Math.floor(n / (VOWELS.length * FINALS.length));
  const vowel = Math.floor((n % (VOWELS.length * FINALS.length)) / FINALS.length);
  const final = n % FINALS.length;
  return { lead: LEADS[lead], vowel: VOWELS[vowel], final: FINALS[final] };
}

// Fit one handwritten jamo into a neutral 1000 × 1000 design cell. The layout
// engine below then places that cell into its syllable slot.
function placeComponent(d, cropSize, pad, { inset = 60 } = {}) {
  const inkW = cropSize.width - 2 * pad;
  const inkH = cropSize.height - 2 * pad;
  if (inkW <= 0 || inkH <= 0) throw new Error('Invalid component crop');
  const size = 1000 - 2 * inset;
  const scale = Math.min(size / inkW, size / inkH);
  const x = (1000 - inkW * scale) / 2;
  const y = (1000 - inkH * scale) / 2;
  return fixWinding(svgpath(d).translate(-pad, -pad).scale(scale, -scale).translate(x, 1000 - y).round(1).toString());
}

function transform(d, { x, y, sx, sy }) {
  return svgpath(d).scale(sx, sy).translate(x, y).round(1).toString();
}

function slots(vowel, hasFinal) {
  // Vertical vowels (ㅏ, ㅓ, ㅣ ...) split a syllable left/right. Horizontal
  // vowels (ㅗ, ㅜ, ㅡ ...) split it top/bottom. A final consonant reserves the
  // lower quarter of the block. These are deliberately conservative slots so
  // freehand strokes do not collide as often as with a uniform 1/3 grid.
  const vertical = VERTICAL_VOWELS.has(vowel);
  if (vertical && !hasFinal) return { L: { x: 65, y: 75, sx: 0.46, sy: 0.85 }, V: { x: 545, y: 75, sx: 0.39, sy: 0.85 } };
  if (vertical) return { L: { x: 65, y: 65, sx: 0.46, sy: 0.59 }, V: { x: 545, y: 65, sx: 0.39, sy: 0.59 }, T: { x: 95, y: 715, sx: 0.81, sy: 0.20 } };
  if (!hasFinal) return { L: { x: 75, y: 60, sx: 0.85, sy: 0.43 }, V: { x: 75, y: 535, sx: 0.85, sy: 0.38 } };
  return { L: { x: 75, y: 55, sx: 0.85, sy: 0.31 }, V: { x: 75, y: 400, sx: 0.85, sy: 0.27 }, T: { x: 95, y: 715, sx: 0.81, sy: 0.20 } };
}

function composeSyllable(parts, lead, vowel, final) {
  const s = slots(vowel, Boolean(final));
  const paths = [transform(parts[componentKey('L', lead)], s.L), transform(parts[componentKey('V', vowel)], s.V)];
  if (final) paths.push(transform(parts[componentKey('T', final)], s.T));
  return fixWinding(paths.join(' '));
}

function buildHangulGlyphs(parts) {
  const missing = requiredComponents().filter(({ key }) => !parts[key]);
  if (missing.length) throw new Error(`Missing Hangul components: ${missing.map(({ key }) => key).join(', ')}`);
  const glyphs = [];
  for (let i = 0; i < HANGUL_COUNT; i++) {
    const char = String.fromCodePoint(HANGUL_START + i);
    const { lead, vowel, final } = decomposeSyllable(HANGUL_START + i);
    glyphs.push({ char, d: composeSyllable(parts, lead, vowel, final), advance: 1000 });
  }
  return glyphs;
}

function koreanTemplateMapFile(out) {
  const path = require('path');
  return path.join(path.dirname(out), `${path.basename(out, path.extname(out))}-map.txt`);
}

// PDFKit's built-in fonts do not contain Hangul. The printed page therefore
// uses durable ASCII cell IDs, and writes a UTF-8 companion map beside the PDF.
// This keeps the npm package portable rather than bundling a multi-megabyte CJK
// font merely to label a worksheet.
function defaultKoreanLabelFont() {
  const fs = require('fs');
  const candidates = [
    '/System/Library/Fonts/Supplemental/AppleGothic.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  ];
  return candidates.find((file) => fs.existsSync(file));
}

function generateKoreanTemplate(out, { labelFont } = {}) {
  const fs = require('fs');
  const PDFDocument = require('pdfkit');
  const parts = requiredComponents();
  const koreanFont = labelFont || defaultKoreanLabelFont();
  if (koreanFont && !fs.existsSync(koreanFont)) throw new Error(`Korean label font not found: ${koreanFont}`);
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  const stream = fs.createWriteStream(out);
  doc.pipe(stream);
  const gridW = A4.w - 2 * TEMPLATE.margin;
  const gridH = A4.h - TEMPLATE.margin - (TEMPLATE.margin + TEMPLATE.header);
  const cw = gridW / TEMPLATE.cols, ch = gridH / TEMPLATE.rows;
  const perPage = TEMPLATE.cols * TEMPLATE.rows;
  for (let page = 0; page * perPage < parts.length; page++) {
    if (page) doc.addPage();
    doc.fontSize(14).fillColor('#999').text(`draw-your-font Korean - page ${page + 1}`, TEMPLATE.margin, TEMPLATE.margin, { lineBreak: false });
    doc.fontSize(8).fillColor('#aaa').text(
      koreanFont
        ? 'Write the jamo shown in each cell, large and centered. Photograph the full page from above.'
        : 'Open the accompanying -map.txt file. Write the indicated jamo large in each cell. Photograph the full page from above.',
      TEMPLATE.margin, TEMPLATE.margin + 22, { width: gridW }
    );
    parts.slice(page * perPage, (page + 1) * perPage).forEach((part, i) => {
      const x = TEMPLATE.margin + (i % TEMPLATE.cols) * cw;
      const y = TEMPLATE.margin + TEMPLATE.header + Math.floor(i / TEMPLATE.cols) * ch;
      doc.rect(x, y, cw - 4, ch - 4).lineWidth(0.8).stroke('#c8c8c8');
      const role = part.role === 'L' ? 'initial' : part.role === 'V' ? 'vowel' : 'final';
      if (koreanFont) {
        doc.font(koreanFont).fontSize(14).fillColor('#aaa').text(`${role} ${part.char}`, x + 3, y + 3, { lineBreak: false });
        doc.font('Helvetica');
      } else {
        doc.fontSize(9).fillColor('#aaa').text(`${part.role}${String(parts.indexOf(part) + 1).padStart(2, '0')}`, x + 3, y + 3, { lineBreak: false });
      }
    });
  }
  doc.end();
  fs.writeFileSync(koreanTemplateMapFile(out), [
    'Korean component worksheet map',
    koreanFont ? 'The jamo is printed in each cell. Write it once, large, inside the matching cell.' : 'Write each jamo once inside its matching cell. Do not write the colon.',
    ...parts.map((part, i) => `${part.role}${String(i + 1).padStart(2, '0')} = ${part.char}    (${part.key})`),
    '',
  ].join('\n'));
  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve({ out, koreanFont }));
    stream.on('error', reject);
  });
}

function templateCellBox(width, height, index) {
  const sx = width / A4.w, sy = height / A4.h;
  const gridW = A4.w - 2 * TEMPLATE.margin;
  const gridH = A4.h - TEMPLATE.margin - (TEMPLATE.margin + TEMPLATE.header);
  const cw = gridW / TEMPLATE.cols, ch = gridH / TEMPLATE.rows;
  const x = Math.round((TEMPLATE.margin + (index % TEMPLATE.cols) * cw) * sx);
  const y = Math.round((TEMPLATE.margin + TEMPLATE.header + Math.floor(index / TEMPLATE.cols) * ch) * sy);
  const x1 = Math.round((TEMPLATE.margin + (index % TEMPLATE.cols) * cw + cw - 4) * sx);
  const y1 = Math.round((TEMPLATE.margin + TEMPLATE.header + Math.floor(index / TEMPLATE.cols) * ch + ch - 4) * sy);
  return { x, y, x1, y1 };
}

async function segmentKoreanTemplate(photos, dir, { delta, cap } = {}) {
  const fs = require('fs');
  const path = require('path');
  const sharp = require('sharp');
  const { binarize } = require('./capture');
  const parts = requiredComponents();
  const perPage = TEMPLATE.cols * TEMPLATE.rows;
  if (photos.length < Math.ceil(parts.length / perPage)) {
    throw new Error(`Korean template needs ${Math.ceil(parts.length / perPage)} page photos; received ${photos.length}.`);
  }
  fs.mkdirSync(path.join(dir, 'crops'), { recursive: true });
  const blobs = [], labels = {};
  let id = 0;
  for (let page = 0; page * perPage < parts.length; page++) {
    const { ink, width, height, gray } = await binarize(photos[page], { delta, cap });
    for (let i = 0; i < perPage && page * perPage + i < parts.length; i++) {
      const box = templateCellBox(width, height, i);
      let x0 = box.x1, y0 = box.y1, x1 = box.x, y1 = box.y;
      for (let y = box.y; y < box.y1; y++) for (let x = box.x; x < box.x1; x++) {
        if (!ink[y * width + x]) continue;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      const part = parts[page * perPage + i];
      if (x1 < x0 || y1 < y0) throw new Error(`No ink found in template cell ${part.key}. Re-shoot page ${page + 1}.`);
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const cw = w + 2 * TEMPLATE.pad, ch = h + 2 * TEMPLATE.pad;
      const pixels = Buffer.alloc(cw * ch, 255);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (ink[(y0 + y) * width + x0 + x]) pixels[(y + TEMPLATE.pad) * cw + x + TEMPLATE.pad] = 0;
      }
      const crop = path.join('crops', `${id}.png`);
      await sharp(pixels, { raw: { width: cw, height: ch, channels: 1 } }).png().toFile(path.join(dir, crop));
      blobs.push({ id, photo: photos[page], row: Math.floor(i / TEMPLATE.cols), box: { x0, y0, x1, y1 }, crop, cropSize: { width: cw, height: ch } });
      labels[id] = part.key;
      id++;
    }
    // Keep a lightly processed copy to make page-order mistakes diagnosable.
    await sharp(gray, { raw: { width, height, channels: 1 } }).png().toFile(path.join(dir, `korean-page-${page + 1}.png`));
  }
  const manifest = { pad: TEMPLATE.pad, photos: photos.slice(0, Math.ceil(parts.length / perPage)), blobs };
  fs.writeFileSync(path.join(dir, 'blobs.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'korean-labels.json'), JSON.stringify(labels, null, 2));
  return manifest;
}

// Freeform Korean is intentionally a *partial-font* flow. We keep every
// finished syllable block as one glyph, never pretend to recover its jamo.
// The user writes blocks with a clear one-block gap; close disconnected marks
// within a block are then grouped by geometric proximity.
function groupSyllableParts(boxes) {
  if (!boxes.length) return [];
  const heights = boxes.map((b) => b.y1 - b.y0 + 1).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 1;
  const grow = Math.max(4, medianH * 0.36);
  const parent = boxes.map((_, i) => i);
  const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const overlapX = Math.min(a.x1 + grow, b.x1 + grow) - Math.max(a.x0 - grow, b.x0 - grow);
    const overlapY = Math.min(a.y1 + grow, b.y1 + grow) - Math.max(a.y0 - grow, b.y0 - grow);
    if (overlapX >= 0 && overlapY >= 0) join(i, j);
  }
  const groups = new Map();
  boxes.forEach((b, i) => {
    const k = find(i);
    const g = groups.get(k) || { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, area: 0 };
    g.x0 = Math.min(g.x0, b.x0); g.y0 = Math.min(g.y0, b.y0);
    g.x1 = Math.max(g.x1, b.x1); g.y1 = Math.max(g.y1, b.y1); g.area += b.area;
    groups.set(k, g);
  });
  return [...groups.values()];
}

async function segmentKoreanFreeform(photos, dir, { delta, cap } = {}) {
  const fs = require('fs');
  const path = require('path');
  const { binarize } = require('./capture');
  const { connectedComponents, orderBlobs } = require('./blob-core');
  const { PAD, writeCrop, writeContactSheet } = require('./segment');
  fs.mkdirSync(path.join(dir, 'crops'), { recursive: true });
  const all = [];
  let id = 0;
  for (let p = 0; p < photos.length; p++) {
    const { ink, width, height, gray } = await binarize(photos[p], { delta, cap });
    const minArea = Math.max(30, Math.round(width * height * 3e-6));
    const parts = connectedComponents(ink, width, height, minArea)
      .filter((b) => b.x1 - b.x0 + 1 >= 4 && b.y1 - b.y0 + 1 >= 4);
    const ordered = orderBlobs(groupSyllableParts(parts)).map((b) => ({ ...b, id: id++, photo: photos[p] }));
    for (const b of ordered) {
      b.crop = path.join('crops', `${b.id}.png`);
      b.cropSize = await writeCrop(ink, width, b, path.join(dir, b.crop));
    }
    await writeContactSheet(gray, width, height, ordered, path.join(dir, `contact-${p + 1}.png`));
    all.push(...ordered.map(({ x0, y0, x1, y1, area, row, id: bid, photo, crop, cropSize }) => ({
      id: bid, photo, row, box: { x0, y0, x1, y1 }, area, crop, cropSize,
    })));
  }
  const manifest = { pad: PAD, photos, blobs: all, mode: 'korean-freeform' };
  fs.writeFileSync(path.join(dir, 'blobs.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

module.exports = {
  LEADS, VOWELS, FINALS, HANGUL_START, HANGUL_COUNT,
  componentKey, requiredComponents, decomposeSyllable, placeComponent, composeSyllable, buildHangulGlyphs,
  defaultKoreanLabelFont, generateKoreanTemplate, koreanTemplateMapFile, segmentKoreanTemplate,
  groupSyllableParts, segmentKoreanFreeform,
};
