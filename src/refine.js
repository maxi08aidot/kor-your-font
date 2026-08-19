'use strict';
// Build -> audit -> correct -> rebuild, until the objective defects stop
// improving. This replaces eyeballing a glyph sheet and guessing what went
// wrong: the loop closes every severed stroke it can, so human judgement is
// needed only where it genuinely is - the handful of syllables that share a
// brush stroke with their neighbour.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { audit, proposeBoxes, CLIPPED_LIMIT } = require('./audit');

const MAX_ROUNDS = 8;

function build(photos, text, dir, boxesFile, name) {
  const args = [path.join(__dirname, 'cli.js'), 'make-korean', ...photos,
    '--chars', text, '-d', dir, '--name', name, '--formats', 'ttf'];
  if (fs.existsSync(boxesFile) && Object.keys(JSON.parse(fs.readFileSync(boxesFile, 'utf8'))).length) {
    args.push('--boxes', boxesFile);
  }
  execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe' });
}

function score(rows) {
  return rows.reduce((sum, r) => sum + r.missing, 0);
}

async function refine({ photos, text, dir, boxesFile, name = 'Refined', rounds = MAX_ROUNDS, log = console.log }) {
  const chars = [...text.normalize('NFC').replace(/[\/\n\r\s]/g, '')];
  let boxes = fs.existsSync(boxesFile) ? JSON.parse(fs.readFileSync(boxesFile, 'utf8')) : {};
  // Whatever was already in the file was decided by a person. The loop widens
  // boxes to stop strokes being severed, which would silently undo a manual
  // decision to cut a neighbour's stroke away - so leave those alone.
  const pinned = new Set(Object.keys(boxes));
  let best = null;

  for (let round = 1; round <= rounds; round++) {
    fs.rmSync(dir, { recursive: true, force: true });
    build(photos, text, dir, boxesFile, name);
    const result = await audit(dir, chars, { pinned });
    const clipped = result.rows.filter((r) => r.clipped > CLIPPED_LIMIT);
    const missing = score(result.rows);
    log(`round ${round}: ${clipped.length} clipped | ${missing}px of owned ink outside its box | ${result.orphan}px orphan`);

    if (best === null || missing < best.missing) best = { missing, boxes: { ...boxes } };
    if (!clipped.length) { log('converged: nothing clipped'); break; }

    const proposed = proposeBoxes(result);
    const next = { ...boxes };
    let changed = 0;
    for (const r of result.rows) {
      if (r.pinned) continue;
      const p = proposed[r.id];
      if (!p) continue;
      const cur = next[r.id];
      if (cur && cur.every((v, k) => v === p[k])) continue;
      next[r.id] = p;
      changed++;
    }
    if (!changed) { log('converged: no further correction to propose'); break; }
    boxes = next;
    fs.writeFileSync(boxesFile, JSON.stringify(boxes, null, 2) + '\n');
  }

  // Never leave the run worse than the best round we saw.
  if (best) fs.writeFileSync(boxesFile, JSON.stringify(best.boxes, null, 2) + '\n');
  fs.rmSync(dir, { recursive: true, force: true });
  build(photos, text, dir, boxesFile, name);
  return audit(dir, chars, { pinned });
}

module.exports = { refine };
