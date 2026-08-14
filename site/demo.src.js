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

// Korean syllables often consist of disconnected jamo. Screenshots also have
// a pixel texture that defeats the normal local-background detector, so use a
// conservative global ink threshold for the Korean quick-font path.
function binarizeKorean(imgData) {
  const gray = toGray(imgData);
  const hist = new Uint32Array(256);
  for (const value of gray) hist[value]++;
  const target = Math.ceil(gray.length * 0.012);
  let seen = 0, cap = 90;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= target) { cap = Math.max(55, Math.min(90, i)); break; }
  }
  const ink = new Uint8Array(gray.length);
  for (let i = 0; i < ink.length; i++) if (gray[i] < cap) ink[i] = 1;
  return ink;
}

function isHangul(char) { return /^[\uAC00-\uD7A3]$/.test(char); }

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

function partitionChunks(chunks, count) {
  if (chunks.length <= count) return chunks;
  const target = (chunks[chunks.length - 1].x1 - chunks[0].x0 + 1) / count;
  const dp = Array.from({ length: count + 1 }, () => Array(chunks.length + 1).fill(null));
  dp[0][0] = { cost: 0, start: -1 };
  for (let g = 1; g <= count; g++) for (let end = g; end <= chunks.length; end++) {
    for (let start = g - 1; start < end; start++) {
      const prev = dp[g - 1][start]; if (!prev) continue;
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

function groupKoreanParts(parts, chars) {
  const wanted = [...chars.normalize('NFC').replace(/\s+/g, '')];
  const chunks = chunksByOverlap(parts);
  if (chunks.length <= wanted.length) return chunks;
  const change = wanted.findIndex((char, i) => i && isHangul(char) !== isHangul(wanted[i - 1]));
  if (change > 0 && change < wanted.length) {
    let split = 1, largest = -Infinity;
    for (let i = 1; i < chunks.length; i++) {
      const gap = chunks[i].x0 - chunks[i - 1].x1;
      if (gap > largest) { largest = gap; split = i; }
    }
    return [...partitionChunks(chunks.slice(0, split), change), ...partitionChunks(chunks.slice(split), wanted.length - change)];
  }
  return partitionChunks(chunks, wanted.length);
}

// ---------- segmentation (shared blob-core) ----------

function segmentImage(imgData, delta, mode, chars) {
  const { width, height } = imgData;
  const ink = mode === 'korean' ? binarizeKorean(imgData) : binarize(imgData, { delta });
  const minArea = Math.max(30, Math.round(width * height * 3e-6));
  let boxes = connectedComponents(ink, width, height, minArea);
  boxes = boxes.filter((b) => b.x1 - b.x0 + 1 >= 4 && b.y1 - b.y0 + 1 >= 4);
  boxes = mode === 'korean' ? groupKoreanParts(boxes, chars) : mergeParts(boxes);
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

async function buildFont(imgData, chars, name, delta, mode, onProgress) {
  const { ink, blobs, width } = segmentImage(imgData, delta, mode, chars);
  const wanted = [...chars.normalize('NFC').replace(/\s+/g, '')].filter((c) => [...c].length === 1);
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
  return { ttf: buildTTF(name, glyphs), glyphCount: glyphs.length, blobCount: blobs.length, wantedCount: wanted.length };
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
    const delta = Number($('demo-delta').value);
    const mode = $('demo-mode').value;
    const { ttf, glyphCount, blobCount, wantedCount } = await buildFont(
      lastImage, $('demo-chars').value, name, delta, mode, (t) => { status.textContent = t; }
    );

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
      note += ` 입력한 글자는 ${wantedCount}개입니다. 글자 연결이 어색하면 잉크 감도를 조절하거나 쓴 순서를 확인하세요.`;
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
    if (f) { lastImage = await fileToImageData(f); run(); }
  });
  input.addEventListener('change', async () => {
    if (input.files[0]) { lastImage = await fileToImageData(input.files[0]); run(); }
  });
  let t = null;
  const rerun = () => { clearTimeout(t); t = setTimeout(run, 350); };
  $('demo-delta').addEventListener('input', rerun);
  $('demo-chars').addEventListener('input', rerun);
  $('demo-name').addEventListener('input', rerun);
  $('demo-mode').addEventListener('change', () => {
    const korean = $('demo-mode').value === 'korean';
    $('demo-chars').value = korean ? '오늘의기록Hello' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    $('demo-preview').textContent = korean ? '오늘의 기록 Hello' : 'The quick brown fox jumps over the lazy dog';
    $('demo-mode-help').textContent = korean
      ? '한글 완성 음절과 영문을 왼쪽에서 오른쪽으로 쓰세요. 적은 글자만 담은 부분 폰트를 만듭니다.'
      : '글자가 닿지 않게 쓴 뒤, 쓴 순서대로 입력하세요.';
    rerun();
  });
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
    const { ttf, glyphCount } = await buildFont(
      ctx.getImageData(0, 0, 900, 340), 'Abgo', 'Self Test', 40, 'latin', () => {}
    );
    const u8 = new Uint8Array(ttf.buffer ? ttf.buffer : ttf);
    const magicOK = u8[0] === 0 && u8[1] === 1 && u8[2] === 0 && u8[3] === 0;
    $('demo-status').textContent = magicOK && glyphCount === 4
      ? 'SELFTEST-PASS 4 glyphs, valid ttf'
      : `SELFTEST-FAIL glyphs=${glyphCount} magic=${magicOK}`;
  } catch (e) {
    $('demo-status').textContent = 'SELFTEST-FAIL ' + e.message;
  }
}

wire();
if (location.hash === '#selftest') selftest();
