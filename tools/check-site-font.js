#!/usr/bin/env node
'use strict';
// The display face is a partial font: it holds the characters that were
// written on a sheet, and nothing else. Nothing about editing a heading warns
// you of that - the browser silently falls back to system-ui for the one
// character that has no glyph, mid-word. So check it.
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');
const { decompress } = require('wawoff2');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');

// Every string the page sets in the display face. `.hand`, plus the two
// controls that take the same family from CSS. text-transform: uppercase is
// applied, because that is what actually gets rendered.
const strings = [];
const tagged = /<([a-z0-9]+)[^>]*class="[^"]*\bhand\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g;
let m;
while ((m = tagged.exec(html))) strings.push(m[2].replace(/<[^>]+>/g, ''));
for (const control of html.matchAll(/id="(copyBtn|demo-download)"[^>]*>([\s\S]*?)</g)) {
  strings.push(control[2]);
}

const needed = [...new Set(strings.join('').toUpperCase().replace(/\s/g, ''))];

(async () => {
const ttf = await decompress(fs.readFileSync(path.join(root, 'site/SiteHand.woff2')));
const font = opentype.parse(Uint8Array.from(ttf).buffer);
const missing = needed.filter((c) => font.charToGlyph(c).index === 0);

console.log(`display strings need ${needed.length} characters; the face has ${font.numGlyphs} glyphs`);
if (!missing.length) {
  console.log('every one of them is covered');
  return;
}
console.error(`\nnot in the face: ${missing.join(' ')}`);
console.error('These render in system-ui instead, inside a heading set in handwriting.');
console.error('Either reword to characters the sheet already has, or add them:');
console.error(`  kor-your-font template --chars "${missing.join('')}" -o extra.pdf`);
console.error('  # write, photograph, and rebuild the sheet with the new characters appended');
process.exitCode = 1;
})();
