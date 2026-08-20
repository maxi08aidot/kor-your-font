#!/usr/bin/env node
'use strict';
// Objective quality report for a freeform run. No human eye required.
//
//   clipped - ink of a component this glyph owns that fell outside its box.
//             This is a severed stroke: the glyph is missing part of itself.
//   foreign - ink kept in the crop that belongs to a different glyph.
//   orphan  - components no glyph claims, i.e. ink that vanished from the font.
const fs = require('fs');
const path = require('path');
const { binarize, binarizeFreeform } = require('./capture');
const { labelComponents, assignComponents } = require('./segment');

async function audit(dir, chars, { pinned = new Set() } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'blobs.json'), 'utf8'));
  // Measure against the same ink the crops were cut from. The freeform path
  // binarises with Otsu; every other path uses the adaptive local-background
  // threshold, and the two disagree by a few percent along stroke edges. Using
  // the wrong one makes that disagreement look like severed strokes: on a
  // clean Latin run it reported seven glyphs "clipped" by up to 9% and failed
  // the gate, and no box edit could ever move the number, because the ink it
  // was counting as missing was never missing.
  const freeform = manifest.mode === 'korean-freeform';
  const sharp = require('sharp');
  const { PAD } = require('./segment');

  const insideOwned = new Int32Array(manifest.blobs.length);
  const foreign = new Int32Array(manifest.blobs.length);
  const ownedTotal = new Int32Array(manifest.blobs.length);
  let orphan = 0, total = 0;
  const pages = [];

  // A worksheet is several photographs, and a blob only exists in its own.
  // Measuring page two against page one's ink reported characters as entirely
  // foreign - the ink they were compared with was a different sheet.
  for (const photo of manifest.photos) {
    const { ink, width, height } = freeform
      ? await binarizeFreeform(photo, {})
      : await binarize(photo, {});
    const parts = labelComponents(ink, width, height);
    const here = manifest.blobs
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => (b.photo || manifest.photos[0]) === photo);
    const owner = assignComponents(ink, width, here.map(({ b }) => b.box), parts);

    for (let k = 0; k < here.length; k++) {
      const { b, i } = here[k];
      const box = b.box;
      const { data, info } = await sharp(path.join(dir, b.crop)).grayscale().raw().toBuffer({ resolveWithObject: true });
      for (let y = box.y0; y <= box.y1; y++) {
        const row = y * width;
        for (let x = box.x0; x <= box.x1; x++) {
          if (!ink[row + x]) continue;
          const px = (y - box.y0 + PAD) * info.width + (x - box.x0 + PAD);
          if (data[px] >= 128) continue; // the crop filter already dropped it
          if (owner.get(parts.labels[row + x]) === k) insideOwned[i]++;
          else foreign[i]++;
        }
      }
    }
    for (let id = 1; id < parts.areas.length; id++) {
      const who = owner.get(id);
      if (who !== undefined && who >= 0) {
        total += parts.areas[id];
        ownedTotal[here[who].i] += parts.areas[id];
        continue;
      }
      // On a printed sheet the page carries ink nobody wrote - the heading,
      // the instructions, the cell rules. It is outside every cell, so it is
      // not a stroke that went missing and must not fail the run.
      if (manifest.mode === 'cells') continue;
      total += parts.areas[id];
      orphan += parts.areas[id];
    }
    pages.push({ parts, owner, width, height, index: here.map(({ i }) => i) });
  }

  // Duplicate syllables never reach the font - only the first occurrence does.
  const firstUse = new Set();
  const used = chars.map((c, i) => {
    if (!c || firstUse.has(c)) return false;
    firstUse.add(c);
    return true;
  });
  const rows = manifest.blobs.map(({ box }, i) => ({
    used: used[i] === true,
    // A box the operator supplied by hand is their decision, not a defect:
    // deliberately cutting a neighbour's stroke away shows up as "clipped".
    pinned: pinned.has(i) || pinned.has(String(i)),
    id: i,
    char: chars[i] || '?',
    clipped: ownedTotal[i] ? (ownedTotal[i] - insideOwned[i]) / ownedTotal[i] : 0,
    foreign: insideOwned[i] + foreign[i] ? foreign[i] / (insideOwned[i] + foreign[i]) : 0,
    ownedTotal: ownedTotal[i],
    missing: ownedTotal[i] - insideOwned[i],
    box,
  }));
  // A blob whose crop traces to nothing is dropped from the font, and every
  // measurement above still scores it as if it were there. That makes the
  // worst possible defect - a character absent from the font entirely -
  // invisible to the gate, so read back what the build actually produced.
  let absent = [];
  const manifestFile = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifestFile)) {
    const built = new Set(Object.keys(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).glyphs || {}));
    absent = rows.filter((r) => r.used && r.char && !built.has(r.char)).map((r) => r.char);
  }
  return { rows: rows.filter((r) => r.used), all: rows, absent, orphan, total, pages };
}

// A glyph missing part of itself is fixed by growing its box to hold every
// component it owns - nothing else moves, because ownership is decided from
// the boxes of the previous round.
function proposeBoxes(result) {
  const { rows, pages } = result;
  // Extents are per page: a blob's coordinates only mean anything in the photo
  // it came from.
  const extents = new Map();
  for (const { parts, owner, width, height, index } of pages) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const id = parts.labels[row + x];
        if (!id) continue;
        const local = owner.get(id);
        if (local === undefined || local < 0) continue;
        const who = index[local];
        const e = extents.get(who) || { x0: x, y0: y, x1: x, y1: y };
        if (x < e.x0) e.x0 = x;
        if (x > e.x1) e.x1 = x;
        if (y < e.y0) e.y0 = y;
        if (y > e.y1) e.y1 = y;
        extents.set(who, e);
      }
    }
  }
  // Grow the box until it holds everything the glyph owns - never shrink it.
  // Shrinking to the owned extent was tried and rejected: ownership is itself
  // approximate where two syllables share a brush stroke, so a tight fit drops
  // whole jamo that were misattributed to the neighbour.
  const out = {};
  for (const r of rows) {
    const e = extents.get(r.id);
    if (!e) continue;
    const box = [Math.min(r.box.x0, e.x0), Math.min(r.box.y0, e.y0),
                 Math.max(r.box.x1, e.x1), Math.max(r.box.y1, e.y1)];
    const same = box[0] === r.box.x0 && box[1] === r.box.y0 && box[2] === r.box.x1 && box[3] === r.box.y1;
    if (!same) out[r.id] = box;
  }
  return out;
}

const CLIPPED_LIMIT = 0.02;
const ORPHAN_LIMIT = 0.02;

// Two defects need no human judgement, and they are the two the loop can fix.
// `foreign` is reported but deliberately not a gate: cursive syllables share
// brush strokes, so a high value is normal, and rules that minimised it made
// the glyphs worse - one deleted a syllable's main stroke outright.
function formatReport(result) {
  const lines = [];
  const orphanShare = result.total ? result.orphan / result.total : 0;
  const bad = result.rows.filter((r) => r.clipped > CLIPPED_LIMIT && !r.pinned);
  const absent = result.absent || [];
  lines.push(`${result.rows.length} glyphs | clipped ${bad.length} | orphan ink ${result.orphan}px (${(orphanShare * 100).toFixed(2)}%)`
    + (absent.length ? ` | MISSING FROM FONT: ${absent.join(' ')}` : ''));
  for (const r of [...result.rows].sort((a, b) => b.clipped - a.clipped)) {
    if (r.clipped < 0.005 && r.foreign < 0.10) continue;
    const flag = r.clipped > CLIPPED_LIMIT ? (r.pinned ? '  (pinned by hand)' : '  <- clipped') : '';
    lines.push(`  ${String(r.id).padStart(2)} '${r.char}'  clipped ${(r.clipped * 100).toFixed(1).padStart(5)}%  foreign ${(r.foreign * 100).toFixed(1).padStart(5)}%${flag}`);
  }
  return { text: lines.join('\n'), clean: bad.length === 0 && orphanShare <= ORPHAN_LIMIT && absent.length === 0 };
}

module.exports = { audit, proposeBoxes, formatReport, CLIPPED_LIMIT, ORPHAN_LIMIT };
