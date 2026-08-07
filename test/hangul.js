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
} = require('../src/hangul');

assert.equal(requiredComponents().length, 67, 'modern Hangul needs 67 base components');
assert.deepEqual(decomposeSyllable('한'.codePointAt(0)), { lead: 'ㅎ', vowel: 'ㅏ', final: 'ㄴ' });

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

const out = path.join(os.tmpdir(), 'draw-your-font-hangul-test.ttf');
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
  const dir = path.join(os.tmpdir(), 'draw-your-font-hangul-e2e');
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
  execFileSync(process.execPath, [path.join(root, 'src/cli.js'), 'segment-korean', ...photos, '-d', work], { encoding: 'utf8' });
  const output = execFileSync(process.execPath, [path.join(root, 'src/cli.js'), 'build-korean', '-d', work, '--labels', path.join(work, 'korean-labels.json'), '--name', 'Hangul Hand'], { encoding: 'utf8' });
  assert.match(output, /Built 11172 Hangul syllables/);
  assert.ok(fs.existsSync(path.join(work, 'HangulHand.ttf')));
  assert.ok(fs.existsSync(path.join(work, 'korean-preview.png')));
}

koreanTemplateE2E().then(() => console.log('hangul e2e OK - two worksheet pages became a complete Hangul font.')).catch((err) => {
  console.error(err);
  process.exit(1);
});
