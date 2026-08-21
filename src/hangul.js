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

// A Hangul-only font cannot set a date. The worksheet composes 11,172
// syllables from 67 jamo, which leaves 17 of its 84 cells empty - exactly
// enough for the digits and the punctuation that ordinary Korean prose needs.
// These are written once and used as themselves; nothing composes them.
const EXTRAS = [...'0123456789.,?!-()'];

function extraCharacters() {
  return EXTRAS.map((char) => ({ role: 'X', char, key: componentKey('X', char) }));
}

// Everything the printed worksheet asks for, in cell order.
function worksheetItems() {
  return [...requiredComponents(), ...extraCharacters()];
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

// Bounding box of a placed component. Control points can sit slightly outside
// the drawn curve, so this is a hair generous - which is the safe direction:
// it can only leave a component a little smaller than its slot.
function pathBox(d) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let cx = 0, cy = 0;
  const see = (x, y) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  svgpath(d).abs().unarc().iterate((seg) => {
    const cmd = seg[0];
    if (cmd === 'H') { cx = seg[1]; see(cx, cy); return; }
    if (cmd === 'V') { cy = seg[1]; see(cx, cy); return; }
    if (cmd === 'Z') return;
    for (let i = 1; i + 1 < seg.length + 1; i += 2) {
      if (typeof seg[i + 1] !== 'number') break;
      cx = seg[i]; cy = seg[i + 1];
      see(cx, cy);
    }
  });
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 1000, y1: 1000 };
  return { x0, y0, x1, y1 };
}

// Fit a component into its slot.
//
// Two things this must get right, both of which were wrong before:
//
// Scale uniformly. `placeComponent` normalises every component into a square
// preserving its aspect, so scaling by the slot's sx and sy separately
// stretches the letterform by whatever the slot's aspect happens to be - 2x
// flatter for a lead consonant over a horizontal vowel, 4x for a final. That
// turns jamo into bars and is why syllables with a final were unreadable.
//
// Read the slot's y as measuring downward. The slot table is written that way
// - lead 55, vowel 400, final 715 descending down the block - but placed
// components are in font coordinates, where y grows upward. Applied directly,
// every syllable came out vertically mirrored: finals on top, horizontal
// vowels above their lead.
function transform(d, { x, y, sx, sy }) {
  const box = pathBox(d);
  const w = Math.max(1, box.x1 - box.x0), h = Math.max(1, box.y1 - box.y0);
  const slotW = 1000 * sx, slotH = 1000 * sy;
  const fit = Math.min(slotW / w, slotH / h);
  // Hangul type does stretch a jamo to suit its position - a final is drawn
  // wider and flatter than the same shape used as a lead. So fitting strictly
  // uniformly leaves finals tiny: a squarish one fills a quarter of the width
  // of its slot, and 할 reads as 하. Let a component grow into the roomy
  // direction, but cap how far, well short of the 4x that turned finals into
  // lines.
  const MAX_STRETCH = 1.5;
  const kx = Math.min(slotW / w, fit * MAX_STRETCH);
  const ky = Math.min(slotH / h, fit * MAX_STRETCH);
  const left = x + (slotW - w * kx) / 2;
  const top = y + (slotH - h * ky) / 2;
  const bottom = 1000 - top - h * ky;
  return svgpath(d)
    .scale(kx, ky)
    .translate(left - box.x0 * kx, bottom - box.y0 * ky)
    .round(1)
    .toString();
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
  const parts = worksheetItems();
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
    // Helvetica has no Hangul, so anything Korean must be drawn in the label
    // font or it prints as mojibake - which is what the header used to do.
    if (koreanFont) doc.font(koreanFont);
    doc.fontSize(14).fillColor('#999').text(`kor-your-font 한글 자모 - ${page + 1}쪽 / ${Math.ceil(parts.length / perPage)}쪽`, TEMPLATE.margin, TEMPLATE.margin, { lineBreak: false });
    doc.fontSize(8).fillColor('#aaa').text(
      koreanFont
        ? '각 칸에 표시된 자모를 칸 가득 크게, 가운데에 하나씩 쓰세요. 칸 선에 닿지 않게 하고, 다 쓰면 페이지 전체를 위에서 똑바로 찍으세요.'
        : 'Open the accompanying -map.txt file. Write the indicated jamo large in each cell. Photograph the full page from above.',
      TEMPLATE.margin, TEMPLATE.margin + 22, { width: gridW }
    );
    doc.font('Helvetica');
    parts.slice(page * perPage, (page + 1) * perPage).forEach((part, i) => {
      const x = TEMPLATE.margin + (i % TEMPLATE.cols) * cw;
      const y = TEMPLATE.margin + TEMPLATE.header + Math.floor(i / TEMPLATE.cols) * ch;
      doc.rect(x, y, cw - 4, ch - 4).lineWidth(0.8).stroke('#c8c8c8');
      const role = part.role === 'L' ? '초성' : part.role === 'V' ? '중성'
        : part.role === 'T' ? '종성' : '그대로';
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


async function segmentKoreanTemplate(photos, dir, { delta, cap } = {}) {
  const fs = require('fs');
  const path = require('path');
  const { captureCells } = require('./cells');
  const parts = worksheetItems();
  const items = parts.map((part) => ({ label: part.key, name: part.key }));
  const { pad, photos: used, blobs, labels, clipped } =
    await captureCells(photos, dir, items, { delta, cap, pageLabel: 'korean-page' });
  const manifest = { mode: 'cells', pad, photos: used, blobs, clipped };
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

function isHangulSyllable(char) {
  return /^[\uAC00-\uD7A3]$/.test(char);
}

// First make conservative "chunks": components whose horizontal projections
// overlap are certainly part of the same written unit. Unlike the old dilation
// merge this never bridges a real word gap.
function overlappingChunks(boxes) {
  const chunks = [];
  for (const box of [...boxes].sort((a, b) => a.x0 - b.x0)) {
    const prev = chunks.at(-1);
    if (prev && box.x0 <= prev.x1) {
      prev.x1 = Math.max(prev.x1, box.x1); prev.y0 = Math.min(prev.y0, box.y0);
      prev.y1 = Math.max(prev.y1, box.y1); prev.area += box.area;
    } else chunks.push({ ...box });
  }
  return chunks;
}

// Split a contiguous handwritten run into its known number of characters.
// This is deliberately geometry-only: the supplied text tells us *how many*
// cells to create, never what the ink supposedly says. Dynamic programming
// chooses the partition whose cell widths are most even, which safely joins
// separated jamo strokes while keeping neighbouring syllables apart.
function partitionChunks(chunks, count) {
  if (count <= 0 || !chunks.length) return [];
  if (chunks.length <= count) return chunks;
  const span = chunks.at(-1).x1 - chunks[0].x0 + 1;
  const target = span / count;
  const dp = Array.from({ length: count + 1 }, () => Array(chunks.length + 1).fill(null));
  dp[0][0] = { cost: 0, start: -1 };
  for (let g = 1; g <= count; g++) for (let end = g; end <= chunks.length; end++) {
    for (let start = g - 1; start < end; start++) {
      const prev = dp[g - 1][start];
      if (!prev) continue;
      const width = chunks[end - 1].x1 - chunks[start].x0 + 1;
      // A cell more than 2.2× the target is almost always two syllables.
      const ratio = width / target;
      const cost = prev.cost + (ratio - 1) ** 2 + (ratio > 2.2 ? 20 : 0);
      if (!dp[g][end] || cost < dp[g][end].cost) dp[g][end] = { cost, start };
    }
  }
  const result = [];
  let end = chunks.length;
  for (let g = count; g > 0; g--) {
    const entry = dp[g][end];
    if (!entry) return chunks;
    const group = chunks.slice(entry.start, end);
    result.unshift(group.reduce((a, b) => ({
      x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
      x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), area: a.area + b.area,
    })));
    end = entry.start;
  }
  return result;
}

// Cluster parts into `count` text lines by their vertical centre. Optimal
// 1-D k-means via DP: with a handful of lines and <200 parts this is instant,
// and unlike largest-gap splitting it tolerates the ragged, slanted baselines
// of real handwriting. Descenders that dip into the line below are assigned by
// their centre, which is what a reader does too.
function splitIntoLines(parts, count) {
  if (count <= 1 || parts.length <= 1) return [parts];
  // Anchor a component near its top rather than at its box centre. A sweeping
  // descender belongs to the line it starts on, but its centre can sit inside
  // the line below - and one stray component there stretches that line's
  // x-range and shifts every cell in it.
  const anchor = (b) => b.y0 + 0.3 * (b.y1 - b.y0);
  const items = [...parts].sort((a, b) => anchor(a) - anchor(b));
  if (items.length <= count) return items.map((b) => [b]);
  const c = items.map(anchor);
  const n = c.length;
  // prefix sums -> O(1) within-cluster sum of squared deviations
  const s1 = new Float64Array(n + 1), s2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { s1[i + 1] = s1[i] + c[i]; s2[i + 1] = s2[i] + c[i] * c[i]; }
  const sse = (i, j) => { // items i..j-1
    const m = j - i;
    if (m <= 0) return 0;
    const sum = s1[j] - s1[i];
    return (s2[j] - s2[i]) - (sum * sum) / m;
  };
  const dp = Array.from({ length: count + 1 }, () => new Float64Array(n + 1).fill(Infinity));
  const cut = Array.from({ length: count + 1 }, () => new Int32Array(n + 1));
  dp[0][0] = 0;
  for (let k = 1; k <= count; k++) {
    for (let j = k; j <= n; j++) {
      for (let i = k - 1; i < j; i++) {
        const v = dp[k - 1][i] + sse(i, j);
        if (v < dp[k][j]) { dp[k][j] = v; cut[k][j] = i; }
      }
    }
  }
  const lines = [];
  let end = n;
  for (let k = count; k > 0; k--) { const start = cut[k][end]; lines.unshift(items.slice(start, end)); end = start; }
  return lines;
}

// "가나다/라마바" or a real newline -> per-line expected text. Spaces are not
// line breaks: they are ordinary word gaps inside a line.
function parseExpectedLines(expectedChars) {
  return String(expectedChars)
    .normalize('NFC')
    .split(/\r?\n|\\n|\//)
    .map((line) => [...line.replace(/\s+/g, '')])
    .filter((line) => line.length);
}

// Cursive Korean lets neighbouring syllables overlap horizontally, so a chunk
// can legitimately hold several characters. Cut it at the columns carrying the
// least ink, searched in a window around each evenly-spaced ideal position:
// Hangul syllables are near-uniform in width, so "even" is a strong prior and
// the valley search supplies the local correction.
function splitChunkByValleys(chunk, count, ctx) {
  if (count <= 1) return [chunk];
  const width = chunk.x1 - chunk.x0 + 1;
  const target = width / count;
  let cuts;
  if (ctx && ctx.ink) {
    const cols = new Int32Array(width);
    for (let y = chunk.y0; y <= chunk.y1; y++) {
      const off = y * ctx.width;
      for (let x = chunk.x0; x <= chunk.x1; x++) if (ctx.ink[off + x]) cols[x - chunk.x0]++;
    }
    const window = Math.max(2, Math.round(target * 0.38));
    cuts = [];
    for (let k = 1; k < count; k++) {
      const ideal = Math.round(k * target);
      let bestX = ideal, bestScore = Infinity;
      for (let x = Math.max(1, ideal - window); x <= Math.min(width - 2, ideal + window); x++) {
        // least ink wins; distance from the ideal column breaks ties
        const score = cols[x] * 1000 + Math.abs(x - ideal);
        if (score < bestScore) { bestScore = score; bestX = x; }
      }
      cuts.push(bestX);
    }
  } else {
    cuts = Array.from({ length: count - 1 }, (_, k) => Math.round((k + 1) * target));
  }
  const bounds = [0, ...cuts, width];
  const out = [];
  for (let i = 0; i < count; i++) {
    const from = chunk.x0 + bounds[i], to = chunk.x0 + bounds[i + 1] - 1;
    if (to < from) continue;
    if (!ctx || !ctx.ink) { out.push({ ...chunk, x0: from, x1: to, area: Math.round(chunk.area / count) }); continue; }
    // Re-tighten to the ink actually inside the slice: a bounding box that
    // still spans the whole chunk would place every glyph identically.
    let x0 = null, y0 = null, x1 = null, y1 = null, area = 0;
    for (let y = chunk.y0; y <= chunk.y1; y++) {
      const off = y * ctx.width;
      for (let x = from; x <= to; x++) {
        if (!ctx.ink[off + x]) continue;
        area++;
        if (x0 === null || x < x0) x0 = x;
        if (x1 === null || x > x1) x1 = x;
        if (y0 === null || y < y0) y0 = y;
        if (y1 === null || y > y1) y1 = y;
      }
    }
    if (x0 !== null) out.push({ x0, y0, x1, y1, area });
  }
  return out.length ? out : [chunk];
}

// Photos carry debris: a paper speck, a JPEG artefact at the frame edge, an
// ellipsis the writer added but did not list in the expected text. Each would
// otherwise become its own chunk and steal a character from a real syllable,
// shifting every glyph after it. Drop debris when the line still has enough
// real chunks; otherwise let it merge into its nearest neighbour.
function dropDebrisChunks(chunks) {
  if (chunks.length < 3) return chunks;
  const areas = chunks.map((c) => c.area).sort((a, b) => a - b);
  // Compare against the upper quartile, not the median: when a line picks up
  // several specks at once (an ellipsis, shadow grain) they drag the median
  // down until they start to look normal, and the rule stops firing.
  const upper = areas[Math.min(areas.length - 1, Math.floor(areas.length * 0.75))] || 1;
  const solid = chunks.filter((c) => c.area >= 0.15 * upper);
  return solid.length ? solid : chunks;
}

// Hand out the line's characters across its chunks. Every chunk holds at least
// one; each further character goes to whichever chunk is currently widest per
// character it already carries.
function allocateCounts(chunks, total) {
  const counts = chunks.map(() => 1);
  for (let left = total - chunks.length; left > 0; left--) {
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < chunks.length; i++) {
      const score = (chunks[i].x1 - chunks[i].x0 + 1) / counts[i];
      if (score > bestScore) { bestScore = score; best = i; }
    }
    counts[best]++;
  }
  return counts;
}

// Bounding boxes of the given whole-image components, over the entire image
// rather than any one line's band.
function componentExtents(parts, width, height, ids) {
  const want = new Set(ids);
  const out = new Map();
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const id = parts.labels[row + x];
      if (!id || !want.has(id)) continue;
      const e = out.get(id);
      if (!e) { out.set(id, { x0: x, y0: y, x1: x, y1: y }); continue; }
      if (x < e.x0) e.x0 = x;
      if (x > e.x1) e.x1 = x;
      if (y < e.y0) e.y0 = y;
      if (y > e.y1) e.y1 = y;
    }
  }
  return out;
}

// Cut a whole line into `count` cells in one global decision, instead of first
// allocating characters to chunks and then splitting each chunk: one bad
// allocation shifts every glyph after it. Dynamic programming over the line's
// column-ink profile picks the cut columns that carry the least ink while
// keeping cell widths even, so real gaps between syllables cost nothing and a
// cut through a connecting brush stroke is only taken when unavoidable.
// A straight cut cannot separate syllables whose brush strokes interlock: the
// vertical line has to cross ink somewhere, and whatever it crosses lands in
// both crops. Let the boundary bend instead - find the top-to-bottom path that
// crosses the least ink, inside a window around the straight cut - so the crop
// can drop what falls on the neighbour's side. Standard practice for touching
// handwritten characters; Hangul cursive is the case it exists for.
function carveSeam(isInk, y0, y1, lo, hi, at) {
  const rows = y1 - y0 + 1, span = hi - lo + 1;
  if (rows <= 0 || span <= 0) return null;
  const INK = 1000;          // crossing a stroke must dominate every other term
  const PULL = 1;            // ... but among equals, stay near the straight cut
  const cost = new Float64Array(rows * span);
  const back = new Int32Array(rows * span).fill(-1);
  for (let i = 0; i < span; i++) {
    const x = lo + i;
    cost[i] = (isInk(x, y0) ? INK : 0) + PULL * Math.abs(x - at);
  }
  for (let r = 1; r < rows; r++) {
    const y = y0 + r, base = r * span, prev = base - span;
    for (let i = 0; i < span; i++) {
      let best = Infinity, from = -1;
      for (let d = -1; d <= 1; d++) {
        const j = i + d;
        if (j < 0 || j >= span) continue;
        if (cost[prev + j] < best) { best = cost[prev + j]; from = j; }
      }
      const x = lo + i;
      cost[base + i] = best + (isInk(x, y) ? INK : 0) + PULL * Math.abs(x - at);
      back[base + i] = from;
    }
  }
  let bestI = 0, bestC = Infinity;
  const last = (rows - 1) * span;
  for (let i = 0; i < span; i++) if (cost[last + i] < bestC) { bestC = cost[last + i]; bestI = i; }
  const seam = new Int32Array(rows);
  let i = bestI;
  for (let r = rows - 1; r >= 0; r--) { seam[r] = lo + i; i = back[r * span + i]; if (i < 0) i = bestI; }
  return seam;
}

function cutLineIntoCells(parts, count, ctx) {
  const x0 = Math.min(...parts.map((b) => b.x0)), x1 = Math.max(...parts.map((b) => b.x1));
  const y0 = Math.min(...parts.map((b) => b.y0)), y1 = Math.max(...parts.map((b) => b.y1));
  const width = x1 - x0 + 1, height = y1 - y0 + 1;
  if (count <= 1 || width < count) return null;
  // Lines of real handwriting interleave vertically: a descender from the line
  // above reaches into this line's y-range. Counting every inked pixel in the
  // band would drag that foreign ink into this line's glyphs, so restrict to
  // pixels covered by the components that were assigned to *this* line.
  // Components come from the thin mask, so their boxes under-cover the true
  // stroke. Pad the ownership window before reading the full-weight mask.
  const PAD_OWN = 4;
  const owned = new Uint8Array(width * height);
  for (const b of parts) {
    for (let y = Math.max(y0, b.y0 - PAD_OWN); y <= Math.min(y1, b.y1 + PAD_OWN); y++) {
      const row = (y - y0) * width;
      for (let x = Math.max(x0, b.x0 - PAD_OWN); x <= Math.min(x1, b.x1 + PAD_OWN); x++) owned[row + (x - x0)] = 1;
    }
  }
  const owns = (x, y) => owned[(y - y0) * width + (x - x0)];
  const isInk = (x, y) => ctx && ctx.ink && ctx.ink[y * ctx.width + x] && owns(x, y);
  // Where the cut lands is decided on the thin mask; what the glyph finally
  // contains is read from the full-weight one.
  const renderMask = (ctx && ctx.render) || (ctx && ctx.ink);
  const isRender = (x, y) => renderMask && renderMask[y * ctx.width + x] && owns(x, y);
  const cols = new Float64Array(width);
  if (ctx && ctx.ink) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) if (isInk(x, y)) cols[x - x0]++;
    }
  } else {
    // No pixels available: fall back to box coverage as a coarse profile.
    for (const b of parts) for (let x = b.x0; x <= b.x1; x++) cols[x - x0] += 1;
  }
  let peak = 0;
  for (const v of cols) if (v > peak) peak = v;
  const inkCost = (x) => (peak ? (cols[x] / peak) ** 2 : 0);
  const target = width / count;
  // Cutting on even widths alone puts a cell in every wide gap: write "zebra
  // 안녕" and the space between the words is broad enough to be handed a
  // character of its own, which then traces to nothing while a real letter
  // shares a cell with its neighbour. Characters are spaced by ink, not by
  // millimetres, so score the split on both.
  const inkPrefix = new Float64Array(width + 1);
  for (let x = 0; x < width; x++) inkPrefix[x + 1] = inkPrefix[x] + cols[x];
  const inkTarget = inkPrefix[width] / count || 1;
  const NEG = Infinity;
  let prev = new Float64Array(width + 1).fill(NEG);
  let prevCut = [];
  const cutTable = [];
  const cellCost = (a, b) => {
    const wide = (b - a) / target;
    const inked = (inkPrefix[b] - inkPrefix[a]) / inkTarget;
    // A cell with almost no ink is not a character; refuse it outright rather
    // than trading it off against tidy widths.
    const empty = inked < 0.15 ? 60 : 0;
    return (wide - 1) ** 2 + 2 * (inked - 1) ** 2 + empty;
  };
  prev[0] = 0;
  for (let k = 1; k <= count; k++) {
    const cur = new Float64Array(width + 1).fill(NEG);
    const back = new Int32Array(width + 1).fill(-1);
    const lastCell = k === count;
    for (let end = k; end <= width; end++) {
      if (lastCell && end !== width) continue;
      let best = NEG, bestA = -1;
      for (let start = k - 1; start < end; start++) {
        const base = prev[start];
        if (base === NEG) continue;
        // the cut that opens this cell sits at column `start`
        const c = base + cellCost(start, end) + (start > 0 ? 6 * inkCost(start) : 0);
        if (c < best) { best = c; bestA = start; }
      }
      cur[end] = best; back[end] = bestA;
    }
    cutTable.push(back);
    prev = cur; prevCut = back;
  }
  if (prev[width] === NEG) return null;
  const cuts = [];
  let end = width;
  for (let k = count; k > 0; k--) { const start = cutTable[k - 1][end]; if (start < 0) return null; cuts.unshift(start); end = start; }
  const bounds = [...cuts, width];
  // Bend each internal boundary onto the thinnest ink it can reach.
  // Narrow on purpose. The seam is there to weave around a stroke the straight
  // cut would clip, not to relocate the boundary: given a wide corridor it
  // happily walks to the nearest blank column, which in Hangul is as often the
  // gap between a syllable's own jamo as the gap between two syllables.
  const WIN = Math.max(4, Math.round(target * 0.15));
  const seams = [];
  for (let j = 0; j + 1 < count; j++) {
    const at = x0 + bounds[j + 1];
    let lo = Math.max(x0, at - WIN);
    const hi = Math.min(x1, at + WIN);
    const before = seams[j - 1];
    // Seams must stay in order, or a cell would be handed a negative width.
    if (before) { let m = -Infinity; for (const v of before) if (v > m) m = v; lo = Math.max(lo, m + 1); }
    seams.push(lo <= hi ? carveSeam(isRender, y0, y1, lo, hi, at) : null);
  }
  const inCell = (x, y, i) => {
    const r = y - y0;
    const left = i > 0 ? seams[i - 1] : null;
    const right = i < count - 1 ? seams[i] : null;
    if (left && x < left[r]) return false;
    if (right && x >= right[r]) return false;
    return true;
  };
  const cells = [];
  // Tally, per whole-image component, how its pixels distribute across the
  // cells of this line. A stroke that dips below the line band - the tail of a
  // rieul, the leg of a vowel - is one component with almost all of its mass in
  // a single cell; clipping the box to the band would cut that tail off, and
  // the crop filter would then delete the remainder as if it were a neighbour's
  // ink. Give such a component's full extent to the cell that owns it.
  const share = new Map(); // component id -> per-cell pixel counts
  if (ctx && ctx.parts) {
    for (let i = 0; i < count; i++) {
      const from = Math.max(x0, x0 + bounds[i] - WIN), to = Math.min(x1, x0 + bounds[i + 1] - 1 + WIN);
      for (let y = y0; y <= y1; y++) {
        for (let x = from; x <= to; x++) {
          if (!isRender(x, y) || !inCell(x, y, i)) continue;
          const id = ctx.parts.labels[y * ctx.width + x];
          let row = share.get(id);
          if (!row) { row = new Int32Array(count); share.set(id, row); }
          row[i]++;
        }
      }
    }
  }
  // Only the single component that dominates a cell may extend it, and only if
  // that component is itself mostly inside the cell. This is the glyph's own
  // body: letting its descender through is the whole point. Every other
  // component stays clipped at the cut - in cursive one brush stroke often
  // crosses several syllables, and honouring all of them drags a neighbour's
  // ink into the glyph.
  const owner = new Map();
  const bestOf = new Int32Array(count).fill(-1);
  const bestPix = new Int32Array(count);
  for (const [id, row] of share) {
    for (let i = 0; i < count; i++) {
      if (row[i] > bestPix[i]) { bestPix[i] = row[i]; bestOf[i] = id; }
    }
  }
  for (let i = 0; i < count; i++) {
    const id = bestOf[i];
    if (id < 0) continue;
    const row = share.get(id);
    let total = 0;
    for (let k = 0; k < count; k++) total += row[k];
    if (total && row[i] >= 0.6 * total) owner.set(id, i);
  }
  const extents = ctx && ctx.parts ? componentExtents(ctx.parts, ctx.width, ctx.height, [...owner.keys()]) : new Map();
  for (let i = 0; i < count; i++) {
    const from = Math.max(x0, x0 + bounds[i] - WIN), to = Math.min(x1, x0 + bounds[i + 1] - 1 + WIN);
    let bx0 = null, by0 = null, bx1 = null, by1 = null, area = 0;
    if (ctx && ctx.ink) {
      for (let y = y0; y <= y1; y++) {
        for (let x = from; x <= to; x++) {
          if (!isRender(x, y) || !inCell(x, y, i)) continue;
          area++;
          if (bx0 === null || x < bx0) bx0 = x;
          if (bx1 === null || x > bx1) bx1 = x;
          if (by0 === null || y < by0) by0 = y;
          if (by1 === null || y > by1) by1 = y;
        }
      }
    }
    if (bx0 === null) { bx0 = from; bx1 = to; by0 = y0; by1 = y1; area = 1; }
    // Reading order must be judged on the tight box. Expanded boxes overlap far
    // more, and row clustering by vertical overlap then merges rows and reorders
    // the glyphs - which silently shifts every character's mapping.
    const core = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    for (const [id, cell] of owner) {
      if (cell !== i) continue;
      const e = extents.get(id);
      if (!e) continue;
      bx0 = Math.min(bx0, e.x0); by0 = Math.min(by0, e.y0);
      bx1 = Math.max(bx1, e.x1); by1 = Math.max(by1, e.y1);
    }
    cells.push({
      x0: bx0, y0: by0, x1: bx1, y1: by1, area, core,
      // Carried through to the crop so a stroke the boundary runs through is
      // kept only on the side that owns it.
      seamL: i > 0 ? seams[i - 1] : null,
      seamR: i < count - 1 ? seams[i] : null,
      seamY0: y0,
    });
  }
  return cells;
}

// Single line of handwriting -> one glyph box per expected character.
// A modern Hangul syllable is written into a roughly square space, so its width
// tracks the line height. Latin has no such rule - "i" and "m" differ by a
// factor of five - so this may only judge a line that is actually Hangul.
function chunksLookLikeSyllables(chunks, parts, chars) {
  const hangul = chars.filter(isHangulSyllable).length;
  if (hangul < 0.8 * chars.length) return true;
  const y0 = Math.min(...parts.map((b) => b.y0)), y1 = Math.max(...parts.map((b) => b.y1));
  const height = y1 - y0 + 1;
  if (height <= 0) return true;
  return chunks.every((c) => {
    const w = c.x1 - c.x0 + 1;
    return w >= 0.45 * height && w <= 1.6 * height;
  });
}

function groupLineForChars(parts, chars, ctx) {
  const chunks = dropDebrisChunks(overlappingChunks(parts));
  // Matching counts are not proof of a matching partition. Where one syllable's
  // vowel is joined to the next syllable's body, the chunk count still comes out
  // right while the split is a syllable off - "알아둬" chunks as [알][ㅇ][ㅏ둬].
  // Only trust the shortcut when every chunk is also syllable-shaped.
  if (chunks.length === chars.length && chunksLookLikeSyllables(chunks, parts, chars)) return chunks;
  // Ink-profile cutting sees the whole line at once and beats chunk-by-chunk
  // splitting whenever syllables run together, which is the norm in cursive.
  // Cut using only the components inside the chunks that survived debris
  // removal - otherwise a speck at the frame edge still stretches the line's
  // x-range and the final cell lands on the speck instead of the last syllable.
  const kept = parts.filter((b) => {
    const cx = (b.x0 + b.x1) / 2;
    return chunks.some((c) => cx >= c.x0 && cx <= c.x1);
  });
  const cells = cutLineIntoCells(kept.length ? kept : parts, chars.length, ctx);
  if (cells) return cells;
  // Fewer chunks than characters: neighbouring syllables ran together, so the
  // chunks must be cut apart rather than handed back under-segmented.
  if (chunks.length < chars.length) {
    const counts = allocateCounts(chunks, chars.length);
    return chunks.flatMap((chunk, i) => splitChunkByValleys(chunk, counts[i], ctx));
  }
  // Script changes are excellent word-boundary clues in the common Korean +
  // English case. Allocate chunks either side of the widest physical gap.
  const change = chars.findIndex((char, i) => i && isHangulSyllable(char) !== isHangulSyllable(chars[i - 1]));
  if (change > 0 && change < chars.length) {
    let split = 1, largest = -Infinity;
    for (let i = 1; i < chunks.length; i++) {
      const gap = chunks[i].x0 - chunks[i - 1].x1;
      if (gap > largest) { largest = gap; split = i; }
    }
    return [
      ...partitionChunks(chunks.slice(0, split), change),
      ...partitionChunks(chunks.slice(split), chars.length - change),
    ];
  }
  return partitionChunks(chunks, chars.length);
}

// Chunking is horizontal-only by design, so it must never see two lines of
// writing at once: any two lines whose x-ranges overlap would fuse into a
// single run. Split the page into lines first, then solve each line on its own.
function groupPartsForExpectedText(parts, expectedChars, ctx) {
  const lines = parseExpectedLines(expectedChars);
  if (!lines.length) return groupSyllableParts(parts);
  if (lines.length === 1) return groupLineForChars(parts, lines[0], ctx);
  const bands = splitIntoLines(parts, lines.length);
  return bands.flatMap((band, i) => (lines[i] && band.length ? groupLineForChars(band, lines[i], ctx) : []));
}

async function segmentKoreanFreeform(photos, dir, { delta, cap, expectedChars, boxes } = {}) {
  const fs = require('fs');
  const path = require('path');
  const { binarizeFreeform } = require('./capture');
  const { connectedComponents, orderBlobs } = require('./blob-core');
  const { PAD, writeCrop, writeContactSheet, labelComponents, assignComponents } = require('./segment');
  fs.mkdirSync(path.join(dir, 'crops'), { recursive: true });
  const all = [];
  let id = 0;
  for (let p = 0; p < photos.length; p++) {
    const { ink, lean, width, height, gray } = await binarizeFreeform(photos[p], { cap });
    const minArea = Math.max(30, Math.round(width * height * 3e-6));
    let parts = connectedComponents(lean, width, height, minArea)
      .filter((b) => b.x1 - b.x0 + 1 >= 4 && b.y1 - b.y0 + 1 >= 4)
      // A dark screen bezel / JPEG edge can be one huge component. It cannot
      // be handwriting, so reject only components physically touching the
      // capture border (real writing remains safely inside the photo).
      .filter((b) => b.x0 > 1 && b.y0 > 1 && b.x1 < width - 2 && b.y1 < height - 2);
    if (expectedChars && parts.length && parseExpectedLines(expectedChars).length === 1) {
      const centers = parts.map((b) => (b.y0 + b.y1) / 2).sort((a, b) => a - b);
      const heights = parts.map((b) => b.y1 - b.y0 + 1).sort((a, b) => a - b);
      const center = centers[Math.floor(centers.length / 2)];
      const tolerance = Math.max(100, heights[Math.floor(heights.length / 2)] * 3);
      // For a one-line string supplied to make-korean, keep its dominant
      // baseline and discard distant UI remnants. The review contact sheet is
      // still written, so a future multi-line mode can expose rows explicitly.
      parts = parts.filter((b) => Math.abs((b.y0 + b.y1) / 2 - center) <= tolerance);
    }
    const inkParts = labelComponents(ink, width, height);
    const grouped = expectedChars ? groupPartsForExpectedText(parts, expectedChars, { ink: lean, render: ink, width, height, parts: inkParts }) : groupSyllableParts(parts);
    const indexed = grouped.map((b, i) => ({ ...b, _i: i }));
    const ordered = orderBlobs(indexed.map((b) => ({ ...(b.core || b), _i: b._i })))
      .map((o) => {
        const { _i, core, ...box } = indexed[o._i];
        return { ...box, row: o.row, id: id++, photo: photos[p] };
      });
    // Hand-corrected boxes, keyed by the id printed on the contact sheet.
    // Where a brush stroke genuinely crosses between two syllables no cut is
    // right, so the reviewer draws the boundary instead. Order and count are
    // preserved: an override replaces one box in place, never adds or removes.
    if (boxes) {
      for (const b of ordered) {
        const override = boxes[b.id] || boxes[String(b.id)];
        if (!override) continue;
        const [x0, y0, x1, y1] = override;
        if ([x0, y0, x1, y1].some((v) => typeof v !== 'number')) {
          throw new Error(`--boxes entry ${b.id} must be [x0, y0, x1, y1] numbers`);
        }
        b.x0 = Math.max(0, Math.min(x0, x1)); b.x1 = Math.min(width - 1, Math.max(x0, x1));
        b.y0 = Math.max(0, Math.min(y0, y1)); b.y1 = Math.min(height - 1, Math.max(y0, y1));
        // A hand-drawn box overrules the automatic boundary, seam included.
        b.seamL = null; b.seamR = null;
        let area = 0;
        for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (ink[y * width + x]) area++;
        b.area = area;
      }
    }
    const owner = assignComponents(ink, width, ordered, inkParts);
    for (let i = 0; i < ordered.length; i++) {
      const b = ordered[i];
      b.crop = path.join('crops', `${b.id}.png`);
      b.cropSize = await writeCrop(ink, width, b, path.join(dir, b.crop), inkParts, owner, i);
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
  componentKey, requiredComponents, extraCharacters, worksheetItems, decomposeSyllable, placeComponent, composeSyllable, buildHangulGlyphs,
  defaultKoreanLabelFont, generateKoreanTemplate, koreanTemplateMapFile, segmentKoreanTemplate,
  groupSyllableParts, groupPartsForExpectedText, segmentKoreanFreeform,
  splitIntoLines, parseExpectedLines,
};
