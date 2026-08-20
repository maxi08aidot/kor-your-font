'use strict';
// Printable A4 template PDF. Everything prints in light grey so the adaptive
// threshold in capture.js erases it - only the user's pen ink survives.
// Cell order = charset order, so a filled template needs no recognition at all.
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { CHARSETS } = require('./charsets');

const GREY = '#c8c8c8';
const A4 = { w: 595.28, h: 841.89 };
const M = 40; // page margin
const COLS = 6;
const ROWS = 7;

function drawCell(doc, x, y, w, h, char, { guides = true, labelFont = null } = {}) {
  doc.rect(x, y, w, h).lineWidth(0.8).stroke(GREY);
  if (!guides) {
    // Baseline and x-height mean nothing for a Hangul syllable - it fills a
    // square block. Printing them would invite the writer to sit the character
    // on a line it does not belong on.
    if (labelFont) doc.font(labelFont);
    doc.fontSize(labelFont ? 13 : 9).fillColor(GREY).text(char, x + 3, y + 3, { lineBreak: false });
    if (labelFont) doc.font('Helvetica');
    return;
  }
  // guides: cap line, x-height (dashed), baseline, sized like metrics.js bands
  const baseline = y + h * 0.78;
  const capLine = y + h * 0.18;
  const xLine = baseline - (baseline - capLine) * (480 / 700);
  doc.moveTo(x, baseline).lineTo(x + w, baseline).lineWidth(0.8).stroke(GREY);
  doc.dash(2, { space: 3 });
  doc.moveTo(x, xLine).lineTo(x + w, xLine).lineWidth(0.5).stroke(GREY);
  doc.moveTo(x, capLine).lineTo(x + w, capLine).lineWidth(0.5).stroke(GREY);
  doc.undash();
  doc.fontSize(9).fillColor(GREY).text(char, x + 3, y + 3, { lineBreak: false });
}

// `chars` prints a sheet for exactly the characters given, in that order -
// Hangul included, which needs a label font because PDFKit's built-in faces
// have no CJK glyphs. Cell order is the answer key: a filled sheet needs no
// recognition, so nothing can be mis-ordered.
function generateTemplate(out, { charset = 'minimal', chars: explicit, labelFont } = {}) {
  const chars = explicit
    ? [...String(explicit).normalize('NFC').replace(/[\s/\n\r]/g, '')]
    : CHARSETS[charset];
  if (!chars) throw new Error(`Unknown charset "${charset}". Available: ${Object.keys(CHARSETS).join(', ')}`);
  if (!chars.length) throw new Error('No characters to put on the sheet.');
  const wide = chars.some((c) => c.codePointAt(0) > 0x2100);
  let face = null;
  if (wide) {
    const { defaultKoreanLabelFont } = require('./hangul');
    face = labelFont || defaultKoreanLabelFont();
    if (face && !fs.existsSync(face)) throw new Error(`Label font not found: ${face}`);
    if (!face) throw new Error('This sheet contains Hangul, which needs a label font to print. Pass --label-font <font.ttf>.');
  }
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  const stream = fs.createWriteStream(out);
  doc.pipe(stream);

  const headerH = 70;
  const gridW = A4.w - 2 * M;
  const gridH = A4.h - M - (M + headerH);
  const cw = gridW / COLS;
  const ch = gridH / ROWS;
  const perPage = COLS * ROWS;

  for (let page = 0; page * perPage < chars.length; page++) {
    if (page > 0) doc.addPage();
    doc.fontSize(14).fillColor('#999').text(`kor-your-font - page ${page + 1}`, M, M, { lineBreak: false });
    doc.fontSize(8).fillColor('#aaa').text(
      wide
        ? 'Use a dark pen. Write the character shown in each cell, large and centred, keeping every stroke inside its box. '
          + 'Then photograph each page from above in good light.'
        : 'Use a dark pen (0.5 mm or thicker). Write each character large, inside its box, sitting on the solid line. '
          + 'Lowercase body between the dashed lines. Then photograph each page from above in good light.',
      M, M + 22, { width: gridW }
    );
    const slice = chars.slice(page * perPage, (page + 1) * perPage);
    slice.forEach((c, i) => {
      const x = M + (i % COLS) * cw;
      const y = M + headerH + Math.floor(i / COLS) * ch;
      drawCell(doc, x, y, cw - 4, ch - 4, c, { guides: !wide, labelFont: face });
    });
  }
  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(out));
    stream.on('error', reject);
  });
}

module.exports = { generateTemplate };
