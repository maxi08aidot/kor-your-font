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
  const { worksheetItems } = require('../src/hangul');
  const cells = worksheetItems().length; // 67 jamo + the digits and punctuation
  const photos = [];
  // Synthetic, aligned worksheet pages. Every cell contains two disconnected
  // strokes; this proves cell capture keeps a jamo together rather than
  // treating its parts as separate glyphs.
  for (let page = 0; page < 2; page++) {
    const paths = [];
    for (let i = 0; i < 42 && page * 42 + i < cells; i++) {
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
  // 11,172 composed syllables plus the characters written as themselves.
  assert.match(output, /Built 11189 Hangul syllables/);
  assert.match(output, /17 written character/);
  assert.ok(fs.existsSync(path.join(work, 'HangulHand.ttf')));
  assert.ok(fs.existsSync(path.join(work, 'korean-preview.png')));

  // A Hangul-only font cannot set a date. This is why the spare cells exist.
  const built = opentype.loadSync(path.join(work, 'HangulHand.ttf'));
  for (const c of '2026년 8월 20일. 값은 1,234원 (부가세 포함)'.replace(/\s/g, '')) {
    assert.notEqual(built.charToGlyph(c).index, 0, `${c} must be in a complete Korean font`);
  }
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


// The measurement commands are what keep a Korean run honest, so they must not
// rot: audit reports objective defects, review draws the comparison sheets,
// and refine loops until nothing is clipped.
async function koreanToolingE2E() {
  const root = path.join(__dirname, '..');
  const dir = path.join(os.tmpdir(), 'kor-your-font-tooling-e2e');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const mark = (x, y) => `<path d="M${x} ${y}L${x + 34} ${y + 75} M${x + 70} ${y + 12}L${x + 42} ${y + 87}" fill="none" stroke="#171717" stroke-width="11" stroke-linecap="round"/>`;
  const row = (y) => `${mark(70, y)}${mark(310, y)}${mark(550, y)}`;
  const photo = path.join(dir, 'note.jpg');
  await sharp(Buffer.from(`<svg width="900" height="460" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f8f4eb"/>${row(60)}${row(280)}</svg>`)).jpeg({ quality: 88 }).toFile(photo);
  const work = path.join(dir, 'work');
  const text = '안녕글/하세요';
  const cli = (...args) => execFileSync(process.execPath, [path.join(root, 'src/cli.js'), ...args], { encoding: 'utf8' });

  const boxes = path.join(dir, 'box-fixes.json');
  const refined = cli('refine', photo, '--chars', text, '-d', work, '--boxes', boxes, '--name', 'Tooling');
  assert.match(refined, /converged/, 'refine must terminate on its own');
  assert.ok(fs.existsSync(boxes), 'refine must write its corrections');

  const report = cli('audit', '-d', work, '--chars', text, '--boxes', boxes);
  assert.match(report, /6 glyphs/, 'audit must report every glyph in the font');
  assert.match(report, /clipped 0/, 'a refined run must leave nothing clipped');

  cli('review', '-d', work, '-o', path.join(dir, 'review.png'));
  const sheets = fs.readdirSync(dir).filter((f) => /^review(-\d+)?\.png$/.test(f));
  assert.ok(sheets.length >= 1, 'review must write at least one sheet');

  // A box supplied by hand is a decision, not a defect: audit must not fail on
  // it and refine must not widen it back.
  const pinned = JSON.parse(fs.readFileSync(boxes, 'utf8'));
  pinned['0'] = [80, 70, 150, 140];
  fs.writeFileSync(boxes, JSON.stringify(pinned));
  const again = cli('refine', photo, '--chars', text, '-d', work, '--boxes', boxes, '--name', 'Tooling');
  assert.match(again, /converged/);
  assert.deepEqual(JSON.parse(fs.readFileSync(boxes, 'utf8'))['0'], [80, 70, 150, 140],
    'refine must leave a hand-supplied box untouched');
}


// Composition geometry. Both defects this guards against shipped in a font
// that passed every existing check: the syllable count was right, the TTF was
// valid, and almost nothing was readable.
function composeGeometry() {
  const svgpath = require('svgpath');
  const { requiredComponents, componentKey, composeSyllable } = require('../src/hangul');

  // Hand-built components with known aspect ratios, so the placement can be
  // read straight off the output: leads square, vowels four times as wide.
  const rect = (w, h) => `M0 0L${w} 0L${w} ${h}L0 ${h}Z`;
  const parts = {};
  for (const { role, key } of requiredComponents()) {
    parts[key] = role === 'V' ? rect(400, 100) : rect(200, 200);
  }
  // One subpath per placed component.
  const clusters = (d) => svgpath(d).abs().toString().split(/(?=M)/).filter((p) => p.trim()).map((p) => {
    const xs = [], ys = [];
    svgpath(p).abs().iterate((seg) => {
      for (let i = 1; i + 1 < seg.length + 1; i += 2) {
        if (typeof seg[i + 1] !== 'number') break;
        xs.push(seg[i]); ys.push(seg[i + 1]);
      }
    });
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  });

  // A final consonant belongs at the bottom of the block. The slot table is
  // written with y measured downward; applied as font coordinates it put every
  // final on top of its syllable.
  const withFinal = clusters(composeSyllable(parts, 'ㄱ', 'ㅏ', 'ㄱ')).sort((a, b) => a.y0 - b.y0);
  assert.equal(withFinal.length, 3, 'lead, vowel and final should each be placed');
  assert.ok(withFinal[0].y1 < 320,
    `the final must sit at the bottom of the em square, found it spanning to y=${withFinal[0].y1}`);
  assert.ok(withFinal[1].y0 > withFinal[0].y1,
    'the final must be clear of the lead and vowel above it');

  // With a horizontal vowel the lead sits above it, not below.
  const stacked = clusters(composeSyllable(parts, 'ㄱ', 'ㅗ', ''));
  assert.equal(stacked.length, 2);
  const [lead, vowel] = stacked[0].y1 - stacked[0].y0 > stacked[1].y1 - stacked[1].y0
    ? [stacked[0], stacked[1]] : [stacked[1], stacked[0]];
  assert.ok(lead.y0 > vowel.y1, 'a horizontal vowel goes underneath its lead consonant');

  // Slots have their own aspect ratios. Scaling a component by sx and sy
  // separately stretched every jamo by whatever the slot happened to be - 4x
  // flatter for finals, which turned them into lines. Some stretch is right
  // for Hangul; this much never is.
  for (const c of [...withFinal, ...stacked]) {
    const w = c.x1 - c.x0, h = c.y1 - c.y0;
    const drawn = w / h;
    const source = drawn > 2 ? 4 : 1; // vowels were built 4:1, everything else square
    const stretch = Math.max(drawn / source, source / drawn);
    assert.ok(stretch < 1.6,
      `a component may be adapted to its slot but not deformed; ${source}:1 came out ${drawn.toFixed(2)}:1`);
  }
}


// Every photograph of a worksheet has uneven lighting. Contrast-stretching it
// first turns that shading into ink: a sheet is almost all paper, so the
// stretch takes the paper's own narrow range and ramps it across the full
// scale. A page that read 69% ink this way still produced 67 "components" and
// a valid 11,172-glyph font, so nothing downstream noticed.
async function shadedPageE2E() {
  const { binarize } = require('../src/capture');
  const dir = path.join(os.tmpdir(), 'kor-your-font-shaded');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Proportions that matter: mostly paper, and light falling unevenly across
  // it - which is any worksheet photographed by hand.
  const W = 1400, H = 1900;
  const marks = [];
  for (let i = 0; i < 12; i++) {
    const x = 160 + (i % 4) * 320, y = 300 + Math.floor(i / 4) * 460;
    marks.push(`<path d="M${x} ${y}L${x + 80} ${y}L${x + 80} ${y + 80}" fill="none" stroke="#141414" stroke-width="14"/>`);
  }
  const page = path.join(dir, 'page.jpg');
  await sharp(Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0%" stop-color="#ffffff"/><stop offset="60%" stop-color="#efe9dd"/>`
    + `<stop offset="100%" stop-color="#d8d0c2"/>`
    + `</linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${marks.join('')}</svg>`
  )).jpeg({ quality: 82 }).toFile(page);

  const { ink } = await binarize(page, {});
  let inked = 0;
  for (const v of ink) inked += v;
  const share = inked / ink.length;
  assert.ok(share < 0.10,
    `shading must not be read as ink; ${(share * 100).toFixed(1)}% of a lightly shaded page came back inked`);
  assert.ok(share > 0.005, 'the strokes themselves must still be found');
}


// audit has to measure against the same ink the crops were cut from. It used
// the freeform binariser for every workdir, and the Latin path uses the
// adaptive one; the few percent they disagree by along stroke edges was
// reported as severed strokes. A clean Latin font failed the gate with seven
// glyphs "clipped" by up to 9%, and no box edit could move the number.
async function latinAuditE2E() {
  const root = path.join(__dirname, '..');
  const dir = path.join(os.tmpdir(), 'kor-your-font-latin-audit');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const mark = (x, y) => `<path d="M${x} ${y}L${x + 30} ${y + 70} M${x + 62} ${y + 8}L${x + 38} ${y + 80}" fill="none" stroke="#161616" stroke-width="10" stroke-linecap="round"/>`;
  const photo = path.join(dir, 'note.jpg');
  await sharp(Buffer.from(
    `<svg width="1000" height="300" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f7f3ea"/>`
    + `${mark(80, 90)}${mark(320, 90)}${mark(560, 90)}${mark(800, 90)}</svg>`
  )).jpeg({ quality: 88 }).toFile(photo);

  const work = path.join(dir, 'work');
  const cli = (...args) => execFileSync(process.execPath, [path.join(root, 'src/cli.js'), ...args], { encoding: 'utf8' });
  cli('make', photo, '--chars', 'ABCD', '-d', work, '--name', 'Latin Audit');
  const report = cli('audit', '-d', work, '--chars', 'ABCD');
  assert.match(report, /clipped 0/, `a clean Latin run must audit clean:\n${report}`);

  // refine would rebuild this workdir with make-korean and orphan its labels.
  let refused = false;
  try {
    cli('refine', photo, '--chars', 'ABCD', '-d', work, '--name', 'Latin Audit');
  } catch (err) {
    refused = /would overwrite it/.test(String(err.stderr || err.stdout || err));
  }
  assert.ok(refused, 'refine must refuse a workdir it did not build');
}


// A printed sheet for an arbitrary character set: the cells say where every
// character is, so nothing has to be recognised and nothing can be mis-ordered.
// Two pages, because audit measured every blob against the first photo only -
// page-two characters came back as entirely foreign ink, compared against a
// sheet they were never on.
async function charSheetE2E() {
  const root = path.join(__dirname, '..');
  const { SHEET, A4, PER_PAGE } = require('../src/cells');
  const dir = path.join(os.tmpdir(), 'kor-your-font-charsheet');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const CHARS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwx'];
  assert.ok(CHARS.length > PER_PAGE, 'this test needs to span two pages');
  const S = 3, W = Math.round(A4.w * S), H = Math.round(A4.h * S);
  const cw = (A4.w - 2 * SHEET.margin) / SHEET.cols;
  const ch = (A4.h - SHEET.margin - (SHEET.margin + SHEET.header)) / SHEET.rows;
  const photos = [];
  for (let page = 0; page * PER_PAGE < CHARS.length; page++) {
    let g = '';
    for (let i = 0; i < PER_PAGE && page * PER_PAGE + i < CHARS.length; i++) {
      const x = (SHEET.margin + (i % SHEET.cols) * cw) * S;
      const y = (SHEET.margin + SHEET.header + Math.floor(i / SHEET.cols) * ch) * S;
      const w = cw * S, h = ch * S;
      g += `<rect x="${x}" y="${y}" width="${w - 12}" height="${h - 12}" fill="none" stroke="#c8c8c8" stroke-width="2"/>`;
      // a two-stroke mark, drawn well inside its cell
      const cx = x + w / 2, cy = y + h / 2;
      g += `<path d="M${cx - 22} ${cy - 26}L${cx + 14} ${cy + 24} M${cx + 20} ${cy - 24}L${cx - 8} ${cy + 28}" fill="none" stroke="#151515" stroke-width="7" stroke-linecap="round"/>`;
    }
    const photo = path.join(dir, `page-${page + 1}.jpg`);
    await sharp(Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#faf7f0"/>${g}</svg>`))
      .jpeg({ quality: 88 }).toFile(photo);
    photos.push(photo);
  }

  const work = path.join(dir, 'work');
  const cli = (...args) => execFileSync(process.execPath, [path.join(root, 'src/cli.js'), ...args], { encoding: 'utf8' });
  const built = cli('make-sheet', ...photos, '--chars', CHARS.join(''), '-d', work, '--name', 'Sheet Hand');
  assert.match(built, new RegExp(`Captured ${CHARS.length} cells`));
  assert.doesNotMatch(built, /run past their edge/, 'nothing here touches a cell edge');

  const font = opentype.loadSync(path.join(work, 'SheetHand.ttf'));
  for (const c of CHARS) assert.notEqual(font.charToGlyph(c).index, 0, `${c} must be in the font`);

  const report = cli('audit', '-d', work, '--chars', CHARS.join(''));
  assert.match(report, /clipped 0/, `a clean sheet must audit clean:\n${report}`);
  assert.doesNotMatch(report, /foreign\s+100\.0%/,
    `page two must be measured against page two:\n${report}`);
}


// Images with an alpha channel arrive constantly - PNGs exported from a
// drawing app, a PDF viewer, a screenshot. Their transparent pixels carry
// black in RGB, so converting straight to grey turns the sheet dark: the
// first real submission came through as 90% ink and the build reported no
// ink in a cell that plainly had some.
async function transparentPageE2E() {
  const { binarize, binarizeFreeform } = require('../src/capture');
  const dir = path.join(os.tmpdir(), 'kor-your-font-alpha');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const marks = [];
  for (let i = 0; i < 6; i++) {
    const x = 90 + (i % 3) * 240, y = 110 + Math.floor(i / 3) * 200;
    marks.push(`<path d="M${x} ${y}L${x + 70} ${y + 90}" fill="none" stroke="#141414" stroke-width="14" stroke-linecap="round"/>`);
  }
  // No background rect: everything but the strokes stays transparent.
  const png = path.join(dir, 'page.png');
  await sharp(Buffer.from(`<svg width="800" height="500" xmlns="http://www.w3.org/2000/svg">${marks.join('')}</svg>`))
    .png().toFile(png);
  assert.equal((await sharp(png).metadata()).hasAlpha, true, 'the fixture must actually be transparent');

  for (const [name, fn] of [['binarize', binarize], ['binarizeFreeform', binarizeFreeform]]) {
    const { ink } = await fn(png, {});
    let inked = 0;
    for (const v of ink) inked += v;
    const share = inked / ink.length;
    assert.ok(share < 0.15, `${name}: transparency must read as paper, got ${(share * 100).toFixed(1)}% ink`);
    assert.ok(share > 0.002, `${name}: the strokes themselves must still be found`);
  }
}

composeGeometry();

Promise.all([koreanTemplateE2E(), koreanFreeformE2E(), koreanMultiLineE2E(), foreignInkE2E(), koreanToolingE2E(), shadedPageE2E(), latinAuditE2E(), charSheetE2E(), transparentPageE2E()]).then(() => console.log('hangul e2e OK - worksheet, freeform, multi-line, foreign-ink and audit/review/refine flows work.')).catch((err) => {
  console.error(err);
  process.exit(1);
});
