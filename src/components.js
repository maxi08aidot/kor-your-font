'use strict';
// Re-read the Hangul components of a finished worksheet workdir.
//
// The worksheet build cannot leave a manifest behind the way the other flows
// do: a manifest holds one outline per glyph, and this flow produces 11,172 of
// them. So `preview` and `review` could not work on a Korean workdir at all.
// The components are only 67 crops, though, and composing a handful of
// syllables from them takes no time - so rebuild those on demand instead of
// storing every syllable that could ever be asked for.
const fs = require('fs');
const path = require('path');
const { trace, adjustWeight } = require('./trace');
const { requiredComponents, extraCharacters, placeComponent, composeSyllable, decomposeSyllable } = require('./hangul');
const { placeGlyph } = require('./metrics');

function isKoreanWorkdir(dir) {
  return fs.existsSync(path.join(dir, 'korean-labels.json'))
    && !fs.existsSync(path.join(dir, 'manifest.json'));
}

// key -> { d, blob } for every component the worksheet captured.
async function loadComponents(dir, { smooth = 1, weight = 0 } = {}) {
  const blobs = JSON.parse(fs.readFileSync(path.join(dir, 'blobs.json'), 'utf8'));
  const labels = JSON.parse(fs.readFileSync(path.join(dir, 'korean-labels.json'), 'utf8'));
  const required = new Set(requiredComponents().map(({ key }) => key));
  // Digits and punctuation are written once and used as themselves, so they
  // have to be re-read here too - otherwise a preview of "2026년" shows the
  // year as blanks while the built font has it.
  const extras = new Map(extraCharacters().map((e) => [e.key, e.char]));
  const parts = {};
  for (const blob of blobs.blobs) {
    const label = labels[blob.id];
    if (!label || parts[label]) continue;
    if (!required.has(label) && !extras.has(label)) continue;
    const png = await adjustWeight(fs.readFileSync(path.join(dir, blob.crop)), weight);
    const d = await trace(png, { smooth });
    if (!d) continue;
    parts[label] = extras.has(label)
      ? { ...placeGlyph(d, blob.cropSize, blobs.pad, extras.get(label)), blob, literal: extras.get(label) }
      : { d: placeComponent(d, blob.cropSize, blobs.pad), blob };
  }
  return parts;
}

// A manifest for just the characters asked for, in the shape the renderers
// already understand.
function manifestFor(name, parts, text) {
  const paths = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.d]));
  const glyphs = {};
  const literal = new Map();
  for (const v of Object.values(parts)) if (v.literal) literal.set(v.literal, v);
  for (const char of new Set([...text])) {
    const written = literal.get(char);
    if (written) {
      glyphs[char] = { d: written.d, advance: written.advance };
      continue;
    }
    const code = char.codePointAt(0);
    let piece;
    try {
      piece = decomposeSyllable(code);
    } catch {
      continue; // not a modern syllable and never written - a space, say
    }
    if (!piece) continue;
    try {
      glyphs[char] = { d: composeSyllable(paths, piece.lead, piece.vowel, piece.final), advance: 1000 };
    } catch {
      // a component this syllable needs never made it off the worksheet
    }
  }
  return { name, unitsPerEm: 1000, glyphs };
}

module.exports = { isKoreanWorkdir, loadComponents, manifestFor };
