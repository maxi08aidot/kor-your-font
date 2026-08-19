'use strict';
// Photo -> binary ink mask. Adaptive threshold (local background estimate)
// plus an absolute cap that erases the template's light-grey guide lines.
const sharp = require('sharp');

const MAX_SIDE = 4200;

/**
 * @param {string|Buffer} file photo (jpg/png/heic-converted)
 * @param {{delta?: number, cap?: number, normalise?: boolean}} opts
 *   delta: how much darker than local background a pixel must be to count as ink
 *   cap:   absolute grey ceiling for ink (after normalise) - kills printed grey guides
 * @returns {{ink: Uint8Array, width: number, height: number, gray: Buffer}} ink: 1 = ink
 */
async function binarize(file, { delta = 40, cap = 165, normalise = true } = {}) {
  const dims = await sharp(file, { limitInputPixels: 1e9 }).metadata();
  if ((dims.width || 0) < 16 || (dims.height || 0) < 16) {
    throw new Error(`Image is too small to process (${dims.width}x${dims.height}) - need at least 16x16 px.`);
  }
  let pipeline = sharp(file, { limitInputPixels: 1e9 })
    .rotate() // honour EXIF orientation
    .grayscale();
  // Normalisation is useful for scanned worksheets, but can amplify the
  // pixel grid of a photographed screen into apparent "ink". Freeform notes
  // deliberately retain their natural luminance instead.
  if (normalise) pipeline = pipeline.normalise();
  const { data, info } = await pipeline
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .median(3) // stabilizes JPEG edge noise so stroke edges don't shed speck components
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  // Local background = heavy downscale + blur + upscale. Robust to shadows.
  const bg = await sharp(data, { raw: { width, height, channels: 1 } })
    .resize(Math.max(1, Math.round(width / 32)), Math.max(1, Math.round(height / 32)), { fit: 'fill' })
    .blur(2)
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer();

  let ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) {
    if (data[i] < cap && data[i] < bg[i] - delta) ink[i] = 1;
  }
  // Morphological closing: seals the 1px gaps and pinholes that threshold
  // flicker leaves along stroke edges (they'd become dozens of bogus contours).
  ink = morph(morph(ink, width, height, true), width, height, false);
  return { ink, width, height, gray: data };
}

// Freehand notes often arrive as phone screenshots or photos of a tablet. A
// local-background threshold is counterproductive there: the screen's pixel
// texture becomes connected foreground. Keep only the darkest ≈1.2% instead.
async function binarizeFreeform(file, { cap } = {}) {
  const { data, info } = await sharp(file, { limitInputPixels: 1e9 })
    .rotate().grayscale()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .median(3).raw().toBuffer({ resolveWithObject: true });
  const histogram = new Uint32Array(256);
  for (const value of data) histogram[value]++;
  const inkFraction = (t) => {
    let seen = 0;
    for (let value = 0; value < t; value++) seen += histogram[value];
    return seen / data.length;
  };
  // Otsu: split the histogram where paper and ink separate best. A fixed
  // "darkest N%" rule cannot do this - it assumes how much of the page is
  // inked. Thin-pen notes cover ~1% but brush calligraphy covers 10% or more,
  // and there the quantile lands inside the stroke body, so the threshold
  // shaves the edges off every stroke and punches holes through the middle.
  let sum = 0;
  for (let value = 0; value < 256; value++) sum += value * histogram[value];
  let sumB = 0, weightB = 0, best = 0, bestVariance = -1;
  for (let value = 0; value < 256; value++) {
    weightB += histogram[value];
    if (!weightB) continue;
    const weightF = data.length - weightB;
    if (!weightF) break;
    sumB += value * histogram[value];
    const between = weightB * weightF * (sumB / weightB - (sum - sumB) / weightF) ** 2;
    if (between > bestVariance) { bestVariance = between; best = value; }
  }
  let threshold = Math.max(50, Math.min(200, best));
  // A photographed screen turns its pixel grid into foreground, and a heavy
  // shadow can look like a second mode; both make Otsu claim most of the page.
  // Fall back to the conservative quantile when the split is clearly not ink.
  if (inkFraction(threshold) > 0.35) {
    const target = Math.ceil(data.length * 0.012);
    let seen = 0, quantile = 255;
    for (let value = 0; value < 256; value++) {
      seen += histogram[value];
      if (seen >= target) { quantile = value; break; }
    }
    threshold = Math.max(55, Math.min(90, quantile));
  }
  if (cap !== undefined) threshold = cap;
  let ink = new Uint8Array(data.length);
  for (let i = 0; i < ink.length; i++) if (data[i] < threshold) ink[i] = 1;
  // Seal the pinholes that threshold flicker leaves inside a dry brush stroke.
  // binarize() already does this; the freeform path was missing it, so every
  // speckled stroke shed bogus contours and traced as a moth-eaten glyph.
  ink = morph(morph(ink, info.width, info.height, true), info.width, info.height, false);
  // A second, deliberately thin mask. Full-weight ink reproduces the stroke
  // faithfully but lets neighbouring lines touch, which fuses their components
  // and ruins segmentation. Callers segment on `lean` and render from `ink`.
  // An explicit --cap is the caller overriding our judgement; thinning it
  // further would silently undo their choice.
  const leanThreshold = cap !== undefined ? threshold : Math.max(40, Math.round(threshold * 0.55));
  const lean = leanThreshold === threshold ? ink : new Uint8Array(data.length);
  if (lean !== ink) for (let i = 0; i < data.length; i++) if (data[i] < leanThreshold) lean[i] = 1;
  return { ink, lean, width: info.width, height: info.height, gray: data, threshold, leanThreshold };
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

module.exports = { binarize, binarizeFreeform, MAX_SIDE };
