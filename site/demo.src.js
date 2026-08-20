// Browser demo: photo -> TTF, entirely client-side.
// Reuses the repo's own pure modules (blob-core, metrics, winding, assemble);
// only capture is re-implemented on Canvas because sharp is Node-only.
// Build: npm run build:demo
import { potrace, init as initPotrace } from 'esm-potrace-wasm';
import svgpathLib from 'svgpath';
const { connectedComponents, mergeParts, orderBlobs } = require('../src/blob-core');
const { placeGlyph } = require('../src/metrics');
const { buildTTF } = require('../src/assemble');

// assemble.js wraps its result in Buffer.from(); give the browser a minimal stand-in
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = { from: (u8) => new Uint8Array(u8) };
}

const MAX_SIDE = 2800;
const PAD = 8;

const $ = (id) => document.getElementById(id);

// ---------- capture (Canvas port of src/capture.js) ----------

function toGray(imgData) {
  const { data, width, height } = imgData;
  const g = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return g;
}

function normalise(g) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const total = g.length;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.01) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  const out = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(((g[i] - lo) * 255) / range)));
  }
  return out;
}

function grayToCanvas(g, width, height) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(width, height);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    img.data[p] = img.data[p + 1] = img.data[p + 2] = g[i];
    img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// local background estimate: heavy downscale then upscale (canvas bilinear)
function localBackground(grayCanvas, width, height) {
  const sw = Math.max(1, Math.round(width / 32));
  const sh = Math.max(1, Math.round(height / 32));
  const small = document.createElement('canvas');
  small.width = sw; small.height = sh;
  small.getContext('2d').drawImage(grayCanvas, 0, 0, sw, sh);
  const big = document.createElement('canvas');
  big.width = width; big.height = height;
  const bctx = big.getContext('2d');
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, width, height);
  return toGray(bctx.getImageData(0, 0, width, height));
}

function morph(ink, width, height, grow) {
  const out = new Uint8Array(ink);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const l = x > 0 && ink[p - 1], r = x < width - 1 && ink[p + 1];
      const u = y > 0 && ink[p - width], d = y < height - 1 && ink[p + width];
      if (grow && !ink[p] && (l || r || u || d)) out[p] = 1;
      if (!grow && ink[p] && !(l && r && u && d)) out[p] = 0;
    }
  }
  return out;
}

function binarize(imgData, { delta = 40, cap = 165 } = {}) {
  const { width, height } = imgData;
  const gray = normalise(toGray(imgData));
  const bg = localBackground(grayToCanvas(gray, width, height), width, height);
  let ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) {
    if (gray[i] < cap && gray[i] < bg[i] - delta) ink[i] = 1;
  }
  ink = morph(morph(ink, width, height, true), width, height, false);
  return ink;
}

// Otsu: split the grey histogram where paper and ink separate best. A fixed
// "darkest N%" rule cannot do this - it assumes how much of the page is inked.
// Thin-pen notes cover ~1% but brush writing covers 10% or more, and there the
// quantile lands inside the stroke body, so the threshold shaves the edges off
// every stroke and punches holes through the middle.
function otsuThreshold(hist, total) {
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, weightB = 0, best = 0, bestVariance = -1;
  for (let v = 0; v < 256; v++) {
    weightB += hist[v];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += v * hist[v];
    const between = weightB * weightF * (sumB / weightB - (sum - sumB) / weightF) ** 2;
    if (between > bestVariance) { bestVariance = between; best = v; }
  }
  return best;
}

// Korean syllables often consist of disconnected jamo. Screenshots also have
// a pixel texture that defeats the local-background detector, so the Korean
// quick-font path thresholds globally (Otsu). Two masks come back: `lean` is a
// deliberately thin mask used for segmentation - full-weight ink lets
// neighbouring lines touch, which fuses their components and ruins the cut -
// while `ink` is the full-weight mask that gets cropped and traced.
function binarizeKorean(imgData, bias = 0) {
  const { width, height } = imgData;
  const gray = toGray(imgData);
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const inkFraction = (t) => {
    let seen = 0;
    for (let v = 0; v < t; v++) seen += hist[v];
    return seen / gray.length;
  };
  let threshold = Math.max(50, Math.min(200, otsuThreshold(hist, gray.length)));
  // A photographed screen turns its pixel grid into foreground, and a heavy
  // shadow can look like a second mode; both make Otsu claim most of the page.
  // Fall back to the conservative quantile when the split is clearly not ink.
  if (inkFraction(threshold) > 0.35) {
    const target = Math.ceil(gray.length * 0.012);
    let seen = 0, quantile = 255;
    for (let v = 0; v < 256; v++) { seen += hist[v]; if (seen >= target) { quantile = v; break; } }
    threshold = Math.max(55, Math.min(90, quantile));
  }
  // Otsu decides on its own; the slider only nudges what it decided, so the
  // control means the same thing on every photo instead of a raw grey level.
  if (bias) threshold = Math.max(40, Math.min(220, threshold + bias));
  let ink = new Uint8Array(gray.length);
  for (let i = 0; i < ink.length; i++) if (gray[i] < threshold) ink[i] = 1;
  // Seal the pinholes that threshold flicker leaves inside a dry brush stroke;
  // without this every speckled stroke sheds bogus contours and traces as a
  // moth-eaten glyph.
  ink = morph(morph(ink, width, height, true), width, height, false);
  const leanThreshold = Math.max(40, Math.round(threshold * 0.55));
  let lean = ink;
  if (leanThreshold !== threshold) {
    lean = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) if (gray[i] < leanThreshold) lean[i] = 1;
  }
  return { ink, lean };
}

function isHangul(char) { return /^[가-힣]$/.test(char); }

// The user already tells us what they wrote, so asking again for the script is
// asking a question we can answer ourselves - and one they can answer wrongly.
// Syllables and compatibility jamo both mean the Korean path.
function detectMode(chars) {
  return /[\uAC00-\uD7A3\u3131-\u318E]/.test(chars) ? 'korean' : 'latin';
}

// Conservative "chunks": components whose horizontal projections overlap are
// certainly part of the same written unit. This never bridges a real word gap.
function chunksByOverlap(boxes) {
  const chunks = [];
  for (const box of [...boxes].sort((a, b) => a.x0 - b.x0)) {
    const prev = chunks[chunks.length - 1];
    if (prev && box.x0 <= prev.x1) {
      prev.x1 = Math.max(prev.x1, box.x1); prev.y0 = Math.min(prev.y0, box.y0);
      prev.y1 = Math.max(prev.y1, box.y1); prev.area += box.area;
    } else chunks.push({ ...box });
  }
  return chunks;
}

// Split a run into its known number of characters, choosing the partition
// whose cell widths are most even.
function partitionChunks(chunks, count) {
  if (count <= 0 || !chunks.length) return [];
  if (chunks.length <= count) return chunks;
  const target = (chunks[chunks.length - 1].x1 - chunks[0].x0 + 1) / count;
  const dp = Array.from({ length: count + 1 }, () => Array(chunks.length + 1).fill(null));
  dp[0][0] = { cost: 0, start: -1 };
  for (let g = 1; g <= count; g++) for (let end = g; end <= chunks.length; end++) {
    for (let start = g - 1; start < end; start++) {
      const prev = dp[g - 1][start]; if (!prev) continue;
      // A cell more than 2.2x the target is almost always two syllables.
      const ratio = (chunks[end - 1].x1 - chunks[start].x0 + 1) / target;
      const cost = prev.cost + (ratio - 1) ** 2 + (ratio > 2.2 ? 20 : 0);
      if (!dp[g][end] || cost < dp[g][end].cost) dp[g][end] = { cost, start };
    }
  }
  const result = [];
  for (let end = chunks.length, g = count; g > 0; g--) {
    const step = dp[g][end]; if (!step) return chunks;
    const group = chunks.slice(step.start, end);
    result.unshift(group.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), area: a.area + b.area })));
    end = step.start;
  }
  return result;
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

// Cluster parts into `count` text lines. Optimal 1-D k-means via DP: unlike
// largest-gap splitting it tolerates the ragged, slanted baselines of real
// handwriting. Anchor a component near its top rather than at its box centre -
// a sweeping descender belongs to the line it starts on, but its centre can
// sit inside the line below, and one stray component there stretches that
// line's x-range and shifts every cell in it.
function splitIntoLines(parts, count) {
  if (count <= 1 || parts.length <= 1) return [parts];
  const anchor = (b) => b.y0 + 0.3 * (b.y1 - b.y0);
  const items = [...parts].sort((a, b) => anchor(a) - anchor(b));
  if (items.length <= count) return items.map((b) => [b]);
  const c = items.map(anchor);
  const n = c.length;
  // prefix sums -> O(1) within-cluster sum of squared deviations
  const s1 = new Float64Array(n + 1), s2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { s1[i + 1] = s1[i] + c[i]; s2[i + 1] = s2[i] + c[i] * c[i]; }
  const sse = (i, j) => {
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

// Photos carry debris: a paper speck, a JPEG artefact at the frame edge. Each
// would otherwise become its own chunk and steal a character from a real
// syllable, shifting every glyph after it. Compare against the upper quartile,
// not the median: several specks at once drag the median down until they start
// to look normal and the rule stops firing.
function dropDebrisChunks(chunks) {
  if (chunks.length < 3) return chunks;
  const areas = chunks.map((c) => c.area).sort((a, b) => a - b);
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

// Cut a contiguous run at the columns carrying the least ink, searched in a
// window around each evenly-spaced ideal position.
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

// Cut a whole line into `count` cells in one global decision. DP over the
// line's column-ink profile picks the cut columns that carry the least ink
// while keeping cell widths even, so real gaps cost nothing and a cut through
// a connecting brush stroke is only taken when unavoidable.
function cutLineIntoCells(parts, count, ctx) {
  const x0 = Math.min(...parts.map((b) => b.x0)), x1 = Math.max(...parts.map((b) => b.x1));
  const y0 = Math.min(...parts.map((b) => b.y0)), y1 = Math.max(...parts.map((b) => b.y1));
  const width = x1 - x0 + 1, height = y1 - y0 + 1;
  if (count <= 1 || width < count) return null;
  // Lines of real handwriting interleave vertically: a descender from the line
  // above reaches into this line's y-range. Restrict the profile to pixels
  // covered by the components assigned to *this* line. Components come from
  // the thin mask, so pad the ownership window before reading full-weight ink.
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
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (isInk(x, y)) cols[x - x0]++;
  } else {
    // No pixels available: fall back to box coverage as a coarse profile.
    for (const b of parts) for (let x = b.x0; x <= b.x1; x++) cols[x - x0] += 1;
  }
  let peak = 0;
  for (const v of cols) if (v > peak) peak = v;
  const inkCost = (x) => (peak ? (cols[x] / peak) ** 2 : 0);
  const target = width / count;
  const cellCost = (a, b) => { const r = (b - a) / target; return (r - 1) ** 2; };
  let prev = new Float64Array(width + 1).fill(Infinity);
  const cutTable = [];
  prev[0] = 0;
  for (let k = 1; k <= count; k++) {
    const cur = new Float64Array(width + 1).fill(Infinity);
    const back = new Int32Array(width + 1).fill(-1);
    const lastCell = k === count;
    for (let end = k; end <= width; end++) {
      if (lastCell && end !== width) continue;
      let best = Infinity, bestA = -1;
      for (let start = k - 1; start < end; start++) {
        const base = prev[start];
        if (base === Infinity) continue;
        // the cut that opens this cell sits at column `start`
        const c = base + cellCost(start, end) + (start > 0 ? 6 * inkCost(start) : 0);
        if (c < best) { best = c; bestA = start; }
      }
      cur[end] = best; back[end] = bestA;
    }
    cutTable.push(back);
    prev = cur;
  }
  if (prev[width] === Infinity) return null;
  const cuts = [];
  let end = width;
  for (let k = count; k > 0; k--) { const start = cutTable[k - 1][end]; if (start < 0) return null; cuts.unshift(start); end = start; }
  const bounds = [...cuts, width];
  const cells = [];
  for (let i = 0; i < count; i++) {
    const from = x0 + bounds[i], to = x0 + bounds[i + 1] - 1;
    let bx0 = null, by0 = null, bx1 = null, by1 = null, area = 0;
    if (ctx && ctx.ink) {
      for (let y = y0; y <= y1; y++) {
        for (let x = from; x <= to; x++) {
          if (!isRender(x, y)) continue;
          area++;
          if (bx0 === null || x < bx0) bx0 = x;
          if (bx1 === null || x > bx1) bx1 = x;
          if (by0 === null || y < by0) by0 = y;
          if (by1 === null || y > by1) by1 = y;
        }
      }
    }
    if (bx0 === null) { bx0 = from; bx1 = to; by0 = y0; by1 = y1; area = 1; }
    cells.push({ x0: bx0, y0: by0, x1: bx1, y1: by1, area });
  }
  return cells;
}

// A modern Hangul syllable is written into a roughly square space, so its width
// tracks the line height. Latin has no such rule - "i" and "m" differ by a
// factor of five - so this may only judge a line that is actually Hangul.
function chunksLookLikeSyllables(chunks, parts, chars) {
  const hangul = chars.filter(isHangul).length;
  if (hangul < 0.8 * chars.length) return true;
  const y0 = Math.min(...parts.map((b) => b.y0)), y1 = Math.max(...parts.map((b) => b.y1));
  const height = y1 - y0 + 1;
  if (height <= 0) return true;
  return chunks.every((c) => {
    const w = c.x1 - c.x0 + 1;
    return w >= 0.45 * height && w <= 1.6 * height;
  });
}

// Single line of handwriting -> one glyph box per expected character.
function groupLineForChars(parts, chars, ctx) {
  const chunks = dropDebrisChunks(chunksByOverlap(parts));
  // Matching counts are not proof of a matching partition. Where one syllable's
  // vowel is written into the body of the next, the chunk count still comes out
  // right while the split is a syllable off - "알아둬" chunks as [알][ㅇ][ㅏ둬].
  // Only trust the shortcut when every chunk is also syllable-shaped.
  if (chunks.length === chars.length && chunksLookLikeSyllables(chunks, parts, chars)) return chunks;
  // Cut using only the components inside the chunks that survived debris
  // removal - otherwise a speck at the frame edge still stretches the line's
  // x-range and the final cell lands on the speck instead of the last syllable.
  const kept = parts.filter((b) => {
    const cx = (b.x0 + b.x1) / 2;
    return chunks.some((c) => cx >= c.x0 && cx <= c.x1);
  });
  const cells = cutLineIntoCells(kept.length ? kept : parts, chars.length, ctx);
  if (cells) return cells;
  if (chunks.length < chars.length) {
    const counts = allocateCounts(chunks, chars.length);
    return chunks.flatMap((chunk, i) => splitChunkByValleys(chunk, counts[i], ctx));
  }
  // Script changes are excellent word-boundary clues in the common Korean +
  // English case. Allocate chunks either side of the widest physical gap.
  const change = chars.findIndex((char, i) => i && isHangul(char) !== isHangul(chars[i - 1]));
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
// single run and the whole photo collapses into one or two glyph boxes. Split
// the page into lines first - the line count comes from the expected text,
// where "/" or a newline separates lines - then solve each line on its own.
function groupKoreanParts(parts, chars, ctx) {
  const lines = parseExpectedLines(chars);
  if (!lines.length) return chunksByOverlap(parts);
  if (lines.length === 1) return groupLineForChars(parts, lines[0], ctx);
  const bands = splitIntoLines(parts, lines.length);
  return bands.flatMap((band, i) => (lines[i] && band.length ? groupLineForChars(band, lines[i], ctx) : []));
}

// ---------- segmentation (shared blob-core) ----------

function segmentImage(imgData, bias, mode, chars, override) {
  const { width, height } = imgData;
  const korean = mode === 'korean';
  // Korean segments on the thin mask so neighbouring lines cannot touch, then
  // crops and traces from the full-weight one.
  const masks = korean ? binarizeKorean(imgData, bias) : null;
  // `delta` is a margin below the local paper tone, so it runs the other way:
  // a bigger margin admits less ink. Negate the bias to keep + = darker.
  const ink = korean ? masks.ink : binarize(imgData, { delta: Math.max(15, Math.min(70, 40 - bias)) });
  const segMask = korean ? masks.lean : ink;
  // Hand-drawn boxes replace the whole finding step, but still trace from the
  // freshly thresholded ink so the sensitivity slider keeps working under them.
  if (override) return { ink, blobs: orderBlobs(override.map((b) => clampBox(b, width, height))), width };
  const minArea = Math.max(30, Math.round(width * height * 3e-6));
  let boxes = connectedComponents(segMask, width, height, minArea);
  boxes = boxes.filter((b) => b.x1 - b.x0 + 1 >= 4 && b.y1 - b.y0 + 1 >= 4);
  // A dark screen bezel / JPEG edge can be one huge component; it cannot be
  // handwriting, so reject components physically touching the capture border.
  if (korean) boxes = boxes.filter((b) => b.x0 > 1 && b.y0 > 1 && b.x1 < width - 2 && b.y1 < height - 2);
  boxes = korean
    ? groupKoreanParts(boxes, chars, { ink: segMask, render: ink, width })
    : mergeParts(boxes);
  return { ink, blobs: orderBlobs(boxes), width };
}

function cropToImageData(ink, imgWidth, blob) {
  const w = blob.x1 - blob.x0 + 1, h = blob.y1 - blob.y0 + 1;
  const cw = w + 2 * PAD, ch = h + 2 * PAD;
  const img = new ImageData(cw, ch);
  img.data.fill(255);
  for (let y = 0; y < h; y++) {
    const src = (blob.y0 + y) * imgWidth + blob.x0;
    for (let x = 0; x < w; x++) {
      if (ink[src + x]) {
        const p = ((y + PAD) * cw + (x + PAD)) * 4;
        img.data[p] = img.data[p + 1] = img.data[p + 2] = 0;
      }
    }
  }
  return img;
}

// ---------- trace + build ----------

async function traceCrop(img) {
  const svg = await potrace(img, {
    turdsize: 6,
    alphamax: 1.05,
    opticurve: 1,
    opttolerance: 0.2,
    extractcolors: false,
  });
  const m = /d="([^"]+)"/.exec(svg);
  if (!m) return '';
  // potrace SVG uses <g transform="translate(0,H) scale(0.1,-0.1)">; undo it
  return svgpathLib(m[1]).scale(0.1, -0.1).translate(0, img.height).round(1).toString();
}

// "/" and newlines are line separators in Korean mode, not characters.
function wantedChars(chars, mode) {
  return (mode === 'korean'
    ? parseExpectedLines(chars).flat()
    : [...chars.normalize('NFC').replace(/\s+/g, '')]).filter((c) => [...c].length === 1);
}

function clampBox(b, width, height) {
  const x0 = Math.max(0, Math.min(width - 1, Math.round(Math.min(b.x0, b.x1))));
  const x1 = Math.max(0, Math.min(width - 1, Math.round(Math.max(b.x0, b.x1))));
  const y0 = Math.max(0, Math.min(height - 1, Math.round(Math.min(b.y0, b.y1))));
  const y1 = Math.max(0, Math.min(height - 1, Math.round(Math.max(b.y0, b.y1))));
  return { x0, y0, x1, y1 };
}

async function buildFont(imgData, chars, name, bias, mode, onProgress, override) {
  const { ink, blobs, width } = segmentImage(imgData, bias, mode, chars, override);
  const wanted = wantedChars(chars, mode);
  const n = Math.min(blobs.length, wanted.length);
  const glyphs = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const char = wanted[i];
    if (seen.has(char)) continue;
    onProgress(`tracing ${i + 1}/${n}…`);
    const crop = cropToImageData(ink, width, blobs[i]);
    const d = await traceCrop(crop);
    if (!d) continue;
    seen.add(char);
    glyphs.push({ char, ...placeGlyph(d, { width: crop.width, height: crop.height }, PAD, char) });
  }
  if (!glyphs.length) throw new Error('no glyphs traced');
  return { ttf: buildTTF(name, glyphs), glyphCount: glyphs.length, blobCount: blobs.length,
    wantedCount: wanted.length, blobs };
}

// ---------- UI ----------

let lastImage = null;
let busy = false;
let fontSeq = 0;

async function fileToImageData(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

async function run() {
  if (!lastImage || busy) return;
  busy = true;
  const status = $('demo-status');
  const result = $('demo-result');
  try {
    status.textContent = '사진을 읽는 중…';
    await initPotrace();
    const name = ($('demo-name').value.trim() || 'My Hand').slice(0, 40);
    const bias = Number($('demo-delta').value);
    const mode = effectiveMode();
    const { ttf, glyphCount, blobCount, wantedCount, blobs } = await buildFont(
      lastImage, $('demo-chars').value, name, bias, mode, (t) => { status.textContent = t; },
      editBoxes
    );
    // Only an automatic pass may redefine what "automatic" means; a run driven
    // by hand-drawn boxes must not overwrite the state the reset button restores.
    if (!editBoxes) autoBoxes = blobs.map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, id: ++boxSeq }));
    drawEditor();

    const face = new FontFace(`demo-font-${++fontSeq}`, ttf.buffer ? ttf.buffer : ttf);
    await face.load();
    document.fonts.add(face);
    $('demo-preview').style.fontFamily = `'demo-font-${fontSeq}', cursive`;

    const blob = new Blob([ttf], { type: 'font/ttf' });
    const link = $('demo-download');
    link.href = URL.createObjectURL(blob);
    link.download = `${name.replace(/\s+/g, '')}.ttf`;

    result.hidden = false;
    let note = `${blobCount}개 필체 덩어리에서 ${glyphCount}개 글자를 추출했습니다.`;
    if (blobCount !== wantedCount) {
      note += ` 입력한 글자는 ${wantedCount}개입니다. 글자 연결이 어색하면 쓴 순서를 확인하거나 고급 설정에서 잉크 감도를 조절하세요.`;
    }
    status.textContent = note;
  } catch (e) {
    result.hidden = true;
    status.textContent = '이 사진에서는 폰트를 만들 수 없었습니다: ' + e.message +
      '. 더 밝은 곳에서 진한 펜으로 쓰거나 사진을 가깝게 잘라 다시 시도하세요.';
  } finally {
    busy = false;
  }
}

const PREVIEWS = { korean: '오늘의 기록', latin: 'The quick brown fox' };

const MODE_HELP = {
  korean: '한글 완성 음절과 영문을 왼쪽에서 오른쪽으로 쓰세요. 여러 줄로 썼다면 "/" 또는 줄바꿈으로 줄을 구분해 입력하세요(예: 오늘의기록/Hello). 적은 글자만 담은 부분 폰트를 만듭니다.',
  latin: '글자가 서로 닿지 않게 쓴 뒤, 쓴 순서대로 입력하세요.',
};

function effectiveMode() {
  const picked = $('demo-mode').value;
  return picked === 'auto' ? detectMode($('demo-chars').value) : picked;
}

function syncHints() {
  const mode = effectiveMode();
  $('demo-mode-help').textContent = MODE_HELP[mode];
  const bias = Number($('demo-delta').value);
  $('demo-delta-value').textContent = bias === 0 ? '자동' : (bias > 0 ? `자동 +${bias}` : `자동 ${bias}`);
  // Only reseed a preview the reader has not written in themselves.
  const preview = $('demo-preview');
  if (Object.values(PREVIEWS).includes(preview.textContent.trim())) {
    preview.textContent = PREVIEWS[mode];
  }
}

// ---------- box editor ----------
// Segmentation gets the syllable *count* right far more often than it gets the
// *cut* right: on overlapping brush writing a stray fragment becomes its own
// "syllable" while a real stroke is swallowed by its neighbour, and the totals
// still match. No threshold fixes that, because the ink is not what is wrong.
// So the reader gets to push a box onto the strokes they meant. Boxes live in
// image coordinates and are re-sorted into reading order on every edit, which
// is what makes a moved box carry its character with it.

const HANDLE = 10;          // grab radius for corner handles, in css pixels
let autoBoxes = null;       // what segmentation last produced
let editBoxes = null;       // null = follow segmentation
let photoCanvas = null;     // the photo at full size, drawn once
let viewScale = 1;          // css pixels per image pixel
let selected = null;        // a box object from editBoxes, by identity
let drag = null;
let boxSeq = 0;

function editorBoxes() { return editBoxes || autoBoxes || []; }

function resetBoxes({ keepPhoto = true } = {}) {
  editBoxes = null;
  selected = null;
  drag = null;
  if (!keepPhoto) { photoCanvas = null; autoBoxes = null; }
}

function beginEditing() {
  if (editBoxes) return;
  // Copy so the auto result stays intact for "자동으로 되돌리기".
  editBoxes = (autoBoxes || []).map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, id: ++boxSeq }));
}

function boxAt(pt) {
  // Smallest box containing the point, so a box nested in a big one stays reachable.
  let hit = null;
  for (const b of editorBoxes()) {
    if (pt.x < b.x0 || pt.x > b.x1 || pt.y < b.y0 || pt.y > b.y1) continue;
    const area = (b.x1 - b.x0) * (b.y1 - b.y0);
    if (!hit || area < hit.area) hit = { box: b, area };
  }
  return hit && hit.box;
}

function handleAt(box, pt) {
  if (!box) return null;
  const r = HANDLE / viewScale;
  for (const [cx, cy, name] of [[box.x0, box.y0, 'nw'], [box.x1, box.y0, 'ne'],
                                [box.x0, box.y1, 'sw'], [box.x1, box.y1, 'se']]) {
    if (Math.abs(pt.x - cx) <= r && Math.abs(pt.y - cy) <= r) return name;
  }
  return null;
}

function drawEditor() {
  const wrap = $('demo-boxes');
  const canvas = $('demo-canvas');
  if (!lastImage || !autoBoxes) { wrap.hidden = true; return; }
  wrap.hidden = false;

  const cssW = Math.max(240, Math.min(wrap.clientWidth || 640, lastImage.width));
  viewScale = cssW / lastImage.width;
  const cssH = Math.round(lastImage.height * viewScale);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';

  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!photoCanvas) {
    photoCanvas = document.createElement('canvas');
    photoCanvas.width = lastImage.width;
    photoCanvas.height = lastImage.height;
    photoCanvas.getContext('2d').putImageData(lastImage, 0, 0);
  }
  g.drawImage(photoCanvas, 0, 0, cssW, cssH);

  const ordered = orderBlobs(editorBoxes());
  const chars = wantedChars($('demo-chars').value, effectiveMode());
  g.font = '600 13px system-ui, sans-serif';
  g.textBaseline = 'top';
  ordered.forEach((b, i) => {
    const on = selected && b.id === selected.id;
    const x = b.x0 * viewScale, y = b.y0 * viewScale;
    const w = (b.x1 - b.x0) * viewScale, h = (b.y1 - b.y0) * viewScale;
    g.lineWidth = on ? 2.5 : 1.5;
    g.strokeStyle = on ? '#c0392b' : 'rgba(43, 96, 214, 0.85)';
    g.strokeRect(x, y, w, h);
    const ch = chars[i];
    // A box past the end of the typed text builds nothing - say so on the box.
    const tag = ch === undefined ? '·' : ch;
    const tw = g.measureText(tag).width + 8;
    g.fillStyle = ch === undefined ? 'rgba(160,160,160,0.95)' : (on ? '#c0392b' : 'rgba(43, 96, 214, 0.85)');
    g.fillRect(x, Math.max(0, y - 17), tw, 17);
    g.fillStyle = '#fff';
    g.fillText(tag, x + 4, Math.max(0, y - 17) + 2);
    if (on) {
      g.fillStyle = '#c0392b';
      for (const [cx, cy] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) {
        g.fillRect(cx * viewScale - 4, cy * viewScale - 4, 8, 8);
      }
    }
  });
  $('demo-box-count').textContent = `박스 ${ordered.length}개 · 입력한 글자 ${chars.length}개`;
}

function wireEditor() {
  const canvas = $('demo-canvas');
  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / viewScale, y: (e.clientY - r.top) / viewScale };
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (!autoBoxes) return;
    beginEditing();
    const p = pt(e);
    canvas.setPointerCapture(e.pointerId);
    const onHandle = handleAt(selected, p);
    if (onHandle) {
      drag = { kind: 'resize', box: selected, corner: onHandle };
    } else {
      const hit = boxAt(p);
      if (hit) {
        selected = hit;
        drag = { kind: 'move', box: hit, from: p,
                 start: { x0: hit.x0, y0: hit.y0, x1: hit.x1, y1: hit.y1 } };
      } else {
        const box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, id: ++boxSeq };
        editBoxes.push(box);
        selected = box;
        drag = { kind: 'create', box, corner: 'se' };
      }
    }
    drawEditor();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pt(e);
    const b = drag.box;
    if (drag.kind === 'move') {
      const dx = p.x - drag.from.x, dy = p.y - drag.from.y;
      b.x0 = drag.start.x0 + dx; b.x1 = drag.start.x1 + dx;
      b.y0 = drag.start.y0 + dy; b.y1 = drag.start.y1 + dy;
    } else {
      if (drag.corner.includes('n')) b.y0 = p.y; else b.y1 = p.y;
      if (drag.corner.includes('w')) b.x0 = p.x; else b.x1 = p.x;
    }
    drawEditor();
  });

  const finish = () => {
    if (!drag) return;
    const b = drag.box;
    const norm = clampBox(b, lastImage.width, lastImage.height);
    Object.assign(b, norm);
    // A stray click would otherwise leave a 1px box that traces to nothing.
    if (b.x1 - b.x0 < 4 || b.y1 - b.y0 < 4) {
      editBoxes = editBoxes.filter((o) => o !== b);
      if (selected === b) selected = null;
    }
    drag = null;
    drawEditor();
    run();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    beginEditing();
    const r = canvas.getBoundingClientRect();
    const hit = boxAt({ x: (e.clientX - r.left) / viewScale, y: (e.clientY - r.top) / viewScale });
    if (!hit) return;
    editBoxes = editBoxes.filter((o) => o !== hit);
    if (selected === hit) selected = null;
    drawEditor();
    run();
  });

  canvas.setAttribute('tabindex', '0');
  canvas.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (!selected) return;
    e.preventDefault();
    beginEditing();
    editBoxes = editBoxes.filter((o) => o !== selected);
    selected = null;
    drawEditor();
    run();
  });

  $('demo-reset-boxes').addEventListener('click', () => {
    resetBoxes();
    drawEditor();
    run();
  });

  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawEditor, 150); });
}

function wire() {
  const zone = $('demo-drop');
  const input = $('demo-file');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) { lastImage = await fileToImageData(f); resetBoxes({ keepPhoto: false }); run(); }
  });
  input.addEventListener('change', async () => {
    if (input.files[0]) {
      lastImage = await fileToImageData(input.files[0]);
      resetBoxes({ keepPhoto: false });
      run();
    }
  });
  let t = null;
  const rerun = () => { clearTimeout(t); t = setTimeout(run, 350); };
  $('demo-delta').addEventListener('input', () => { syncHints(); rerun(); });
  $('demo-chars').addEventListener('input', () => { syncHints(); drawEditor(); rerun(); });
  $('demo-name').addEventListener('input', rerun);
  $('demo-mode').addEventListener('change', () => { syncHints(); resetBoxes(); rerun(); });
  wireEditor();
  syncHints();

  const chooseFlow = (flow) => {
    const self = flow === 'self';
    $('demo-flow-self').setAttribute('aria-selected', String(self));
    $('demo-flow-ai').setAttribute('aria-selected', String(!self));
    $('demo-self-panel').hidden = !self;
    $('demo-ai-panel').hidden = self;
  };
  $('demo-flow-self').addEventListener('click', () => chooseFlow('self'));
  $('demo-flow-ai').addEventListener('click', () => chooseFlow('ai'));
}

// ---------- self-test (headless verification, #selftest) ----------

async function selftest() {
  const LETTERS = {
    A: 'M15,130 L50,15 L85,130 M30,92 L70,88',
    b: 'M25,10 L26,130 M25,75 C55,60 75,80 73,100 C71,122 45,133 26,118',
    g: 'M78,68 C60,55 30,60 27,90 C25,115 45,125 60,120 C72,116 78,105 78,90 M78,65 L78,150 C76,175 45,180 35,165',
    o: 'M50,70 C25,70 20,95 25,112 C32,132 68,132 75,112 C80,95 75,70 50,70',
  };
  const c = document.createElement('canvas');
  c.width = 900; c.height = 340;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f2eee6'; ctx.fillRect(0, 0, 900, 340);
  ctx.strokeStyle = '#1c1c22'; ctx.lineWidth = 9; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  Object.values(LETTERS).forEach((d, i) => {
    ctx.save();
    ctx.translate(60 + i * 210, 60);
    ctx.stroke(new Path2D(d));
    ctx.restore();
  });
  try {
    await initPotrace();
    const img = ctx.getImageData(0, 0, 900, 340);
    // Fourth argument is the sensitivity bias, so 0 means "leave it automatic".
    const auto = await buildFont(img, 'Abgo', 'Self Test', 0, 'latin', () => {});
    const u8 = new Uint8Array(auto.ttf.buffer ? auto.ttf.buffer : auto.ttf);
    const magicOK = u8[0] === 0 && u8[1] === 1 && u8[2] === 0 && u8[3] === 0;

    // Hand-corrected boxes must be able to drive a build on their own, and to
    // change the result: drop the last letter's box and the font must shrink.
    const trimmed = auto.blobs.slice(0, 3).map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }));
    const edited = await buildFont(img, 'Abgo', 'Self Test', 0, 'latin', () => {}, trimmed);
    const boxesOK = edited.glyphCount === 3 && edited.blobCount === 3;

    // The bias must actually reach the binarizer, not just ride along unused.
    const dark = await buildFont(img, 'Abgo', 'Self Test', 25, 'latin', () => {});
    const biasOK = dark.ttf.length !== auto.ttf.length ||
      !new Uint8Array(dark.ttf).every((v, i) => v === u8[i]);

    $('demo-status').textContent = magicOK && auto.glyphCount === 4 && boxesOK && biasOK
      ? 'SELFTEST-PASS 4 glyphs, valid ttf, box override + bias live'
      : `SELFTEST-FAIL glyphs=${auto.glyphCount} magic=${magicOK} boxes=${boxesOK} bias=${biasOK}`;
  } catch (e) {
    $('demo-status').textContent = 'SELFTEST-FAIL ' + e.message;
  }
}

wire();
if (location.hash === '#selftest') selftest();
