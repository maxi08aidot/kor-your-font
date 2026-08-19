'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const opentype = require('opentype.js');
const { buildTTF } = require('../src/assemble');
const {
  HANGUL_COUNT, componentKey, requiredComponents, decomposeSyllable, buildHangulGlyphs,
  groupPartsForExpectedText,
} = require('../src/hangul');

assert.equal(requiredComponents().length, 67, 'modern Hangul needs 67 base components');
assert.deepEqual(decomposeSyllable('한'.codePointAt(0)), { lead: 'ㅎ', vowel: 'ㅏ', final: 'ㄴ' });

// A freeform syllable can contain isolated jamo. With the known written text,
// those marks are partitioned into character cells without recognising or
// rewriting the handwriting itself.
const grouped = groupPartsForExpectedText([
  { x0: 0, x1: 42, y0: 20, y1: 80, area: 100 }, { x0: 8, x1: 55, y0: 85, y1: 120, area: 80 },
  { x0: 75, x1: 120, y0: 20, y1: 80, area: 100 }, { x0: 78, x1: 130, y0: 84, y1: 120, area: 80 },
  { x0: 155, x1: 195, y0: 20, y1: 80, area: 100 }, { x0: 212, x1: 245, y0: 20, y1: 80, area: 100 },
  { x0: 260, x1: 292, y0: 20, y1: 80, area: 100 }, { x0: 305, x1: 332, y0: 20, y1: 80, area: 100 },
], '안녕Hi');
assert.equal(grouped.length, 4, 'known-text grouping must preserve one cell per written character');

// Distinct, deliberately simple component outlines let this test exercise the
// full 11,172-syllable composition/cmap path without requiring a photo fixture.
const parts = {};
requiredComponents().forEach(({ role, char }, i) => {
  const inset = 40 + (i % 4) * 15;
  parts[componentKey(role, char)] = `M${inset} ${inset}L${960 - inset} ${inset}L${960 - inset} ${960 - inset}L${inset} ${960 - inset}Z`;
});
const glyphs = buildHangulGlyphs(parts);
assert.equal(glyphs.length, HANGUL_COUNT);
assert.equal(glyphs[0].char, '가');
assert.equal(glyphs.at(-1).char, '힣');

const out = path.join(os.tmpdir(), 'kor-your-font-hangul-test.ttf');
fs.writeFileSync(out, buildTTF('Hangul Test', glyphs, { wordSpace: 500 }));
const font = opentype.loadSync(out);
for (const char of ['가', '각', '한', '글', '힣']) {
  const glyph = font.charToGlyph(char);
  assert.notEqual(glyph.name, '.notdef', `${char} must be mapped in the font`);
  assert.equal(glyph.advanceWidth, 1000, `${char} must use full-width Korean metrics`);
}
console.log(`hangul OK - ${glyphs.length} modern syllables mapped into a valid TTF.`);

async function koreanTemplateE2E() {
  const root = path.join(__dirname, '..');
  const dir = path.join(os.tmpdir(), 'kor-your-font-hangul-e2e');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const photos = [];
  // Synthetic, aligned worksheet pages. Every cell contains two disconnected
  // strokes; this proves cell capture keeps a jamo together rather than
  // treating its parts as separate glyphs.
  for (let page = 0; page < 2; page++) {
    const paths = [];
    for (let i = 0; i < 42 && page * 42 + i < 67; i++) {
      const col = i % 6, row = Math.floor(i / 6);
      const x = 40 + col * (515.28 / 6), y = 110 + row * (691.89 / 7);
      paths.push(`<path d="M${x + 25} ${y + 32}L${x + 55} ${y + 58} M${x + 66} ${y + 30}L${x + 42} ${y + 66}" fill="none" stroke="#111" stroke-width="7"/>`);
    }
    const photo = path.join(dir, `page-${page + 1}.png`);
    await sharp(Buffer.from(`<svg width="595" height="842" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/>${paths.join('')}</svg>`)).png().toFile(photo);
    photos.push(photo);
  }
  const work = path.join(dir, 'work');
  const output = execFileSync(process.execPath, [path.join(root, 'src/cli.js'), 'make-korean-full', ...photos, '-d', work, '--name', 'Hangul Hand'], { encoding: 'utf8' });
  assert.match(output, /Built 11172 Hangul syllables/);
  assert.ok(fs.existsSync(path.join(work, 'HangulHand.ttf')));
  assert.ok(fs.existsSync(path.join(work, 'korean-preview.png')));
}

async function koreanFreeformE2E() {
  const root = path.join(__dirname, '..');
  const dir = path.join(os.tmpdir(), 'kor-your-font-hangul-freeform-e2e');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Three deliberately separated syllable blocks. Each block contains two
  // disconnected pen marks, which verifies block grouping rather than the
  // ordinary one-connected-blob-per-character assumption.
  const mark = (x, y) => `<path d="M${x} ${y}L${x + 34} ${y + 75} M${x + 70} ${y + 12}L${x + 42} ${y + 87}" fill="none" stroke="#171717" stroke-width="11" stroke-linecap="round"/>`;
  const photo = path.join(dir, 'note.jpg');
  await sharp(Buffer.from(`<svg width="900" height="260" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f8f4eb"/>${mark(70, 70)}${mark(310, 70)}${mark(550, 70)}</svg>`)).jpeg({ quality: 88 }).toFile(photo);
  const work = path.join(dir, 'work');
  const output = execFileSync(process.execPath, [path.join(root, 'src/cli.js'), 'make-korean', photo, '--chars', '안녕글', '-d', work, '--name', 'Freeform Hangul'], { encoding: 'utf8' });
  assert.match(output, /Found 3 Korean syllable candidates/);
  const font = opentype.loadSync(path.join(work, 'FreeformHangul.ttf'));
  for (const char of '안녕글') {
    const glyph = font.charToGlyph(char);
    assert.notEqual(glyph.name, '.notdef', `${char} must be in the partial font`);
    assert.equal(glyph.advanceWidth, 1000, `${char} must use square Hangul metrics`);
  }
}


// Regression: two lines of writing whose x-ranges overlap. Chunking is
// horizontal-only, so before line splitting existed the two rows fused into a
// single run and the whole photo collapsed to one or two glyph boxes.
async function koreanMultiLineE2E() {
  const root = path.join(__dirname, '..');
  const dir = path.join(os.tmpdir(), 'kor-your-font-hangul-multiline-e2e');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const mark = (x, y) => `<path d="M${x} ${y}L${x + 34} ${y + 75} M${x + 70} ${y + 12}L${x + 42} ${y + 87}" fill="none" stroke="#171717" stroke-width="11" stroke-linecap="round"/>`;
  const photo = path.join(dir, 'note.jpg');
  // Both rows start at the same x, so every column is shared between them.
  const row = (y) => `${mark(70, y)}${mark(310, y)}${mark(550, y)}`;
  await sharp(Buffer.from(`<svg width="900" height="460" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f8f4eb"/>${row(60)}${row(280)}</svg>`)).jpeg({ quality: 88 }).toFile(photo);
  const work = path.join(dir, 'work');
  const output = execFileSync(process.execPath, [path.join(root, 'src/cli.js'), 'make-korean', photo, '--chars', '안녕글/하세요', '-d', work, '--name', 'Multiline Hangul'], { encoding: 'utf8' });
  assert.match(output, /Found 6 Korean syllable candidates/);
  // The count alone does not prove the rows were separated: fusing both rows
  // and then cutting the fused run vertically also yields six boxes. Assert
  // the geometry instead - every box must sit inside one row, and the rows
  // must hold three boxes each.
  const { blobs } = JSON.parse(fs.readFileSync(path.join(work, 'blobs.json'), 'utf8'));
  assert.equal(blobs.length, 6);
  const spans = blobs.map((b) => b.box.y1 - b.box.y0 + 1);
  const pageInk = Math.max(...blobs.map((b) => b.box.y1)) - Math.min(...blobs.map((b) => b.box.y0)) + 1;
  assert.ok(Math.max(...spans) < 0.55 * pageInk,
    `no glyph may straddle both rows (tallest ${Math.max(...spans)} of ${pageInk})`);
  const mid = Math.min(...blobs.map((b) => b.box.y0)) + pageInk / 2;
  const upper = blobs.filter((b) => (b.box.y0 + b.box.y1) / 2 < mid).length;
  assert.equal(upper, 3, `expected 3 glyphs on the first row, got ${upper}`);
  const font = opentype.loadSync(path.join(work, 'MultilineHangul.ttf'));
  for (const char of '안녕글하세요') {
    assert.notEqual(font.charToGlyph(char).index, 0, `${char} must survive multi-line grouping`);
  }

  // --boxes: a reviewer overrides one glyph's box after reading the contact
  // sheet. The override must land verbatim and must not disturb the others.
  const fixes = path.join(dir, 'fixes.json');
  const override = [120, 40, 260, 170];
  fs.writeFileSync(fixes, JSON.stringify({ 1: override }));
  const fixedWork = path.join(dir, 'fixed');
  execFileSync(process.execPath, [path.join(root, 'src/cli.js'), 'make-korean', photo, '--chars', '안녕글/하세요', '-d', fixedWork, '--name', 'Fixed Hangul', '--boxes', fixes], { encoding: 'utf8' });
  const fixed = JSON.parse(fs.readFileSync(path.join(fixedWork, 'blobs.json'), 'utf8')).blobs;
  assert.equal(fixed.length, 6, 'an override must not change the glyph count');
  assert.deepEqual([fixed[1].box.x0, fixed[1].box.y0, fixed[1].box.x1, fixed[1].box.y1], override,
    'the overridden box must be used verbatim');
  assert.deepEqual(fixed[3].box, blobs[3].box, 'untouched glyphs must be unaffected');
  // The separator must never become a glyph of its own.
  assert.equal(font.charToGlyph('/').index, 0, 'the "/" line separator must not be a glyph');
}


// A neighbouring stroke that sweeps through a glyph's rectangle must not be
// baked into that glyph, while the glyph's own detached pieces must survive.
// Edge contact cannot tell them apart - the box is the ink's bounding box, so
// the outermost real strokes touch it too - hence the rule is whether the
// stroke continues outside the box.
async function foreignInkE2E() {
  const { writeCrop, labelComponents, PAD } = require('../src/segment');
  const dir = path.join(os.tmpdir(), 'kor-your-font-foreign-ink');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const W = 300, H = 140;
  const ink = new Uint8Array(W * H);
  const fill = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ink[y * W + x] = 1;
  };
  fill(40, 40, 90, 100);   // the glyph body
  fill(44, 108, 74, 120);  // a detached piece of the same glyph, wholly inside the box
  fill(80, 20, 280, 28);   // a neighbour's stroke crossing the box and running far outside
  ink[46 * W + 100] = 1;   // a speck of paper grain
  const box = { x0: 38, y0: 18, x1: 102, y1: 122 };
  const file = path.join(dir, 'crop.png');
  await writeCrop(ink, W, box, file, labelComponents(ink, W, H));

  const { data, info } = await sharp(file).grayscale().raw().toBuffer({ resolveWithObject: true });
  const dark = (x, y) => data[(y + PAD - box.y0) * info.width + (x + PAD - box.x0)] < 128;
  assert.ok(dark(60, 70), 'the glyph body must survive');
  assert.ok(dark(60, 114), 'a detached piece lying wholly inside the box must survive');
  assert.ok(!dark(90, 24), 'a stroke that continues outside the box must be dropped');
  assert.ok(!dark(100, 46), 'an isolated speck must be dropped');
}


Promise.all([koreanTemplateE2E(), koreanFreeformE2E(), koreanMultiLineE2E(), foreignInkE2E()]).then(() => console.log('hangul e2e OK - worksheet, freeform, multi-line and foreign-ink flows work.')).catch((err) => {
  console.error(err);
  process.exit(1);
});
