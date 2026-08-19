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
const { binarizeFreeform } = require('./capture');
const { labelComponents, assignComponents } = require('./segment');

async function audit(dir, chars, { pinned = new Set() } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'blobs.json'), 'utf8'));
  const { ink, width, height } = await binarizeFreeform(manifest.photos[0], {});
  const parts = labelComponents(ink, width, height);
  const boxes = manifest.blobs.map((b) => b.box);
  const owner = assignComponents(ink, width, boxes, parts);

  // Foreign ink is judged on what actually reached the crop, not on what the
  // box happened to overlap: in cursive the boxes must overlap, and removing
  // the intruders afterwards is exactly the crop filter's job.
  const sharp = require('sharp');
  const { PAD } = require('./segment');
  const insideOwned = new Int32Array(boxes.length);
  const foreign = new Int32Array(boxes.length);
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const cropFile = path.join(dir, manifest.blobs[i].crop);
    const { data, info } = await sharp(cropFile).grayscale().raw().toBuffer({ resolveWithObject: true });
    for (let y = box.y0; y <= box.y1; y++) {
      const row = y * width;
      for (let x = box.x0; x <= box.x1; x++) {
        if (!ink[row + x]) continue;
        const px = (y - box.y0 + PAD) * info.width + (x - box.x0 + PAD);
        if (data[px] >= 128) continue; // the filter already dropped it
        if (owner.get(parts.labels[row + x]) === i) insideOwned[i]++;
        else foreign[i]++;
      }
    }
  }

  const ownedTotal = new Int32Array(boxes.length);
  let orphan = 0, total = 0;
  for (let id = 1; id < parts.areas.length; id++) {
    total += parts.areas[id];
    const who = owner.get(id);
    if (who === undefined || who < 0) { orphan += parts.areas[id]; continue; }
    ownedTotal[who] += parts.areas[id];
  }

  // Duplicate syllables never reach the font - only the first occurrence does.
  const firstUse = new Set();
  const used = chars.map((c, i) => {
    if (!c || firstUse.has(c)) return false;
    firstUse.add(c);
    return true;
  });
  const rows = boxes.map((box, i) => ({
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
  return { rows: rows.filter((r) => r.used), all: rows, orphan, total, parts, owner, width, height, ink };
}

// A glyph missing part of itself is fixed by growing its box to hold every
// component it owns - nothing else moves, because ownership is decided from
// the boxes of the previous round.
function proposeBoxes(result) {
  const { rows, parts, owner, width, height } = result;
  const extents = new Map();
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const id = parts.labels[row + x];
      if (!id) continue;
      const who = owner.get(id);
      if (who === undefined || who < 0) continue;
      const e = extents.get(who) || { x0: x, y0: y, x1: x, y1: y };
      if (x < e.x0) e.x0 = x;
      if (x > e.x1) e.x1 = x;
      if (y < e.y0) e.y0 = y;
      if (y > e.y1) e.y1 = y;
      extents.set(who, e);
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
  lines.push(`${result.rows.length} glyphs | clipped ${bad.length} | orphan ink ${result.orphan}px (${(orphanShare * 100).toFixed(2)}%)`);
  for (const r of [...result.rows].sort((a, b) => b.clipped - a.clipped)) {
    if (r.clipped < 0.005 && r.foreign < 0.10) continue;
    const flag = r.clipped > CLIPPED_LIMIT ? (r.pinned ? '  (pinned by hand)' : '  <- clipped') : '';
    lines.push(`  ${String(r.id).padStart(2)} '${r.char}'  clipped ${(r.clipped * 100).toFixed(1).padStart(5)}%  foreign ${(r.foreign * 100).toFixed(1).padStart(5)}%${flag}`);
  }
  return { text: lines.join('\n'), clean: bad.length === 0 && orphanShare <= ORPHAN_LIMIT };
}

module.exports = { audit, proposeBoxes, formatReport, CLIPPED_LIMIT, ORPHAN_LIMIT };
