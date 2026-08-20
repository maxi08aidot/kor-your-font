#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('node:util');

const USAGE = `kor-your-font - turn a photo of your handwriting into a real font

Usage:
  kor-your-font template [-o template.pdf] (--charset minimal|spanish
                         | --chars "가나다ABC123" [--label-font font.ttf])
  kor-your-font segment-sheet <page photos...> --chars "가나다ABC123" [-d workdir]
  kor-your-font make-sheet    <page photos...> --chars "가나다ABC123" [build options]
  kor-your-font template-korean [-o korean-template.pdf] [--label-font font.ttf]
  kor-your-font segment <photo...> [-d workdir] [--delta N] [--cap N]
  kor-your-font segment-korean <page-photo...> [-d workdir] [--delta N] [--cap N]
  kor-your-font segment-korean-freeform <photo...> [-d workdir] [--delta N] [--cap N]
  kor-your-font build   [-d workdir] (--labels labels.json | --chars "ABC…" | --charset name)
                         [--name "My Handwriting"] [-o font.ttf] [--smooth 0..2]
                         [--weight=-2..2] [--formats ttf,woff,woff2,css]
                         (negative weight needs the = form: --weight=-1)
  kor-your-font make    <photo...> (--chars "ABC…" | --charset name) [build options]
  kor-your-font make-korean <photo...> --chars "안녕하세요Hello"
                         [build options]
                         (multi-line note: separate lines with "/" or a newline,
                          e.g. --chars "노력한다고 항상/성공할순 없지만")
                         [--boxes fixes.json] hand-correct individual glyph
                          boxes: {"7": [x0,y0,x1,y1]} keyed by the id drawn on
                          the contact sheet, in contact-sheet pixels
  kor-your-font make-korean-full <worksheet-page photos...>
                         [build options]
  kor-your-font build-korean [-d workdir] --labels labels.json
                         [--name "My Hangul Hand"] [--formats ttf,woff,woff2,css]
  kor-your-font preview [-d workdir] [--text "…"] [-o preview.png]

Checking a finished font (see flow 8):
  kor-your-font audit  [-d workdir] --chars "…"        objective defect report
  kor-your-font review [-d workdir] [-o review.png]    source vs. what it draws
  kor-your-font refine <photo...> --chars "…" [-d workdir] [--boxes fixes.json]

Typical flows:
  1. Freeform photo, you know the order you wrote in:
       kor-your-font make photo.jpg --chars "ABCabc" --name "My Hand"
  2. Printed template (order is the charset):
       kor-your-font template -o template.pdf --charset minimal
       # print, write, photograph, then:
       kor-your-font make page1.jpg page2.jpg --charset minimal
  3. Agent-assisted (Claude labels the blobs):
       kor-your-font segment photo.jpg -d work
       # inspect work/contact-1.png, write work/labels.json {"0":"A", …}
       kor-your-font build -d work --labels work/labels.json
  4. Korean component template / labelled crops:
       # labels use L:ㄱ, V:ㅏ, T:ㄱ (67 components total)
       kor-your-font build-korean -d work --labels work/korean-labels.json
  5. Freeform Korean partial font (write blocks in the exact order, with a
     clear one-syllable gap):
       kor-your-font make-korean note.jpg --chars "안녕하세요" --name "My Note"
  6. Complete Korean font in one command (two completed worksheet pages):
       kor-your-font make-korean-full page-1.jpg page-2.jpg --name "My Hangul Hand"
  7. Any character set you like, on a printed sheet - one per cell, so nothing
     has to be recognised and nothing can be mis-ordered:
       kor-your-font template --chars "가나다ABC123" -o sheet.pdf
       # print, write one character per cell, photograph, then:
       kor-your-font make-sheet page-1.jpg page-2.jpg --chars "가나다ABC123" \
         --name "My Hand"
  8. Cursive or brush Korean, where syllables share strokes - measure, do not guess:
       kor-your-font refine note.jpg --chars "1행/2행" -d work --boxes work/fixes.json
       kor-your-font review -d work          # then look at every glyph, large
       kor-your-font audit  -d work --chars "1행/2행"
`;

const OPTS = {
  dir: { type: 'string', short: 'd', default: 'work' },
  out: { type: 'string', short: 'o' },
  name: { type: 'string', default: 'My Handwriting' },
  labels: { type: 'string' },
  boxes: { type: 'string' },
  chars: { type: 'string' },
  charset: { type: 'string' },
  smooth: { type: 'string', default: '1' },
  weight: { type: 'string', default: '0' },
  formats: { type: 'string', default: 'ttf' },
  text: { type: 'string' },
  delta: { type: 'string' },
  cap: { type: 'string' },
  'label-font': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  }
  const { values: opt, positionals } = parseArgs({ args: rest, options: OPTS, allowPositionals: true });
  if (opt.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const dir = opt.dir;

  if (cmd === 'template') {
    const { generateTemplate } = require('./template');
    const out = opt.out || 'template.pdf';
    await generateTemplate(out, { charset: opt.charset || 'minimal', chars: opt.chars, labelFont: opt['label-font'] });
    console.log(`Template written to ${out}. Print it, write with a dark pen, photograph each page.`);
    return;
  }

  if (cmd === 'template-korean') {
    const { generateKoreanTemplate, koreanTemplateMapFile } = require('./hangul');
    const out = opt.out || 'korean-template.pdf';
    const result = await generateKoreanTemplate(out, { labelFont: opt['label-font'] });
    console.log(`Korean template written to ${out}.${result.koreanFont ? ' Jamo labels are printed in the cells.' : ` Map: ${koreanTemplateMapFile(out)}`}`);
    return;
  }

  if (cmd === 'segment-korean') {
    if (!positionals.length) fail('No template page photos given.');
    const { segmentKoreanTemplate } = require('./hangul');
    const manifest = await segmentKoreanTemplate(positionals, dir, {
      delta: opt.delta ? Number(opt.delta) : undefined,
      cap: opt.cap ? Number(opt.cap) : undefined,
    });
    console.log(`Captured ${manifest.blobs.length} Korean components. Crops: ${dir}/crops/  Labels: ${dir}/korean-labels.json`);
    return;
  }

  if (cmd === 'make-korean-full') {
    if (!positionals.length) fail('No Korean worksheet page photos given.');
    const { segmentKoreanTemplate } = require('./hangul');
    const manifest = await segmentKoreanTemplate(positionals, dir, {
      delta: opt.delta ? Number(opt.delta) : undefined,
      cap: opt.cap ? Number(opt.cap) : undefined,
    });
    console.log(`Captured ${manifest.blobs.length} Korean components; building all modern Hangul syllables…`);
    opt.labels = path.join(dir, 'korean-labels.json');
    await buildKorean(dir, opt);
    return;
  }

  if (cmd === 'segment-korean-freeform' || cmd === 'make-korean') {
    if (!positionals.length) fail('No Korean handwriting photos given.');
    if (cmd === 'make-korean' && !opt.chars) fail('make-korean requires --chars in the exact written order.');
    const { segmentKoreanFreeform } = require('./hangul');
    const manifest = await segmentKoreanFreeform(positionals, dir, {
      delta: opt.delta ? Number(opt.delta) : undefined,
      cap: opt.cap ? Number(opt.cap) : undefined,
      expectedChars: cmd === 'make-korean' ? opt.chars : undefined,
      boxes: opt.boxes ? JSON.parse(require('fs').readFileSync(opt.boxes, 'utf8')) : undefined,
    });
    console.log(`Found ${manifest.blobs.length} Korean syllable candidates across ${positionals.length} photo(s).`);
    console.log(`Crops: ${dir}/crops/  Contact sheet(s): ${dir}/contact-*.png`);
    if (cmd === 'segment-korean-freeform') return;
  }

  if (cmd === 'segment' || cmd === 'make') {
    if (!positionals.length) fail('No photos given.');
    const { segment } = require('./segment');
    const manifest = await segment(positionals, dir, {
      delta: opt.delta ? Number(opt.delta) : undefined,
      cap: opt.cap ? Number(opt.cap) : undefined,
    });
    console.log(`Found ${manifest.blobs.length} glyph candidates across ${positionals.length} photo(s).`);
    console.log(`Crops: ${dir}/crops/  Contact sheet(s): ${dir}/contact-*.png  Data: ${dir}/blobs.json`);
    if (cmd === 'segment') return;
  }

  if (cmd === 'segment-sheet' || cmd === 'make-sheet') {
    const fsx = require('fs');
    const { captureCells } = require('./cells');
    if (!positionals.length) fail(`${cmd} needs at least one page photo.`);
    if (!opt.chars) fail(`${cmd} requires --chars, in the same order as the printed sheet.`);
    const chars = [...opt.chars.normalize('NFC').replace(/[\s/\n\r]/g, '')];
    const items = chars.map((char) => ({ label: char, name: char }));
    const captured = await captureCells(positionals, dir, items, {
      delta: opt.delta === undefined ? undefined : Number(opt.delta),
      cap: opt.cap === undefined ? undefined : Number(opt.cap),
      pageLabel: 'sheet-page',
    });
    const manifest = { pad: captured.pad, photos: captured.photos, blobs: captured.blobs, clipped: captured.clipped };
    fsx.writeFileSync(path.join(dir, 'blobs.json'), JSON.stringify(manifest, null, 2));
    fsx.writeFileSync(path.join(dir, 'labels.json'), JSON.stringify(captured.labels, null, 2));
    console.log(`Captured ${captured.blobs.length} cells. Crops: ${dir}/crops/  Labels: ${dir}/labels.json`);
    if (cmd === 'segment-sheet') return;
    opt.labels = path.join(dir, 'labels.json');
  }

  if (cmd === 'build' || cmd === 'make' || cmd === 'make-korean' || cmd === 'make-sheet') {
    await build(dir, opt);
    return;
  }

  if (cmd === 'build-korean') {
    await buildKorean(dir, opt);
    return;
  }

  if (cmd === 'preview') {
    const { renderPreview } = require('./preview');
    const { isKoreanWorkdir, loadComponents, manifestFor } = require('./components');
    let manifest;
    if (isKoreanWorkdir(dir)) {
      // The worksheet flow stores components, not syllables; compose the ones
      // this preview actually asks for.
      const text = opt.text || '다람쥐 헌 쳇바퀴에 타고파';
      const parts = await loadComponents(dir, { smooth: Number(opt.smooth), weight: Number(opt.weight) });
      manifest = manifestFor(opt.name, parts, text);
      if (!Object.keys(manifest.glyphs).length) fail('None of that text is modern Hangul this worksheet can compose.');
      opt.text = text;
    } else {
      manifest = readJSON(path.join(dir, 'manifest.json'), 'Run build first.');
    }
    const out = opt.out || path.join(dir, 'preview.png');
    await renderPreview(manifest, out, { text: opt.text });
    console.log(`Preview: ${out}`);
    return;
  }

  if (cmd === 'audit') {
    const { audit, formatReport } = require('./audit');
    if (!opt.chars) fail('audit requires --chars in the exact written order (use "/" between lines).');
    const chars = [...opt.chars.normalize('NFC').replace(/[\/\n\r\s]/g, '')];
    const pinnedFile = opt.boxes || path.join(dir, 'box-fixes.json');
    const pinned = new Set(fs.existsSync(pinnedFile) ? Object.keys(JSON.parse(fs.readFileSync(pinnedFile, 'utf8'))) : []);
    const report = formatReport(await audit(dir, chars, { pinned }));
    console.log(report.text);
    if (!report.clean) {
      console.log('\nA clipped glyph is missing part of a stroke it owns; run "refine", then hand-correct\nwhat is left with --boxes. "foreign" is reported for information and is not a defect:\nin cursive Korean neighbouring syllables genuinely share brush strokes.');
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'review') {
    const { renderReview } = require('./review');
    const { isKoreanWorkdir, loadComponents } = require('./components');
    const out = opt.out || path.join(dir, 'review.png');
    let manifest;
    if (isKoreanWorkdir(dir)) {
      // There is no source image of a syllable to compare against - the writer
      // wrote jamo. Review those instead; a syllable can only be as good as the
      // components it is built from.
      const parts = await loadComponents(dir, { smooth: Number(opt.smooth), weight: Number(opt.weight) });
      manifest = { name: opt.name, unitsPerEm: 1000, glyphs: Object.fromEntries(
        Object.entries(parts).map(([key, v]) => [key.replace(':', ' '), { d: v.d, advance: 1000, source: v.blob.crop }])) };
    }
    const sheets = await renderReview(dir, out, manifest ? { manifest } : {});
    console.log(`Review sheets (source photo above, what the font draws below):\n  ${sheets.join('\n  ')}`);
    console.log('Judge each glyph against the ink directly above it - never against your memory of\nthe character, and never by scanning a grid of small glyphs.');
    return;
  }

  if (cmd === 'refine') {
    const { refine } = require('./refine');
    const { formatReport } = require('./audit');
    if (!positionals.length) fail('refine needs at least one photo.');
    if (!opt.chars) fail('refine requires --chars in the exact written order (use "/" between lines).');
    // Every round rebuilds the workdir from the photo with make-korean. Aimed
    // at a workdir built some other way, that silently destroys it: the crops
    // and blobs are replaced and any labels.json is left describing blobs that
    // no longer exist.
    const existing = fs.existsSync(path.join(dir, 'blobs.json'))
      ? JSON.parse(fs.readFileSync(path.join(dir, 'blobs.json'), 'utf8')) : null;
    if (existing && existing.mode !== 'korean-freeform') {
      fail(`${dir} was not built by make-korean, and refine would overwrite it.\n`
        + 'refine belongs to the freeform Korean flow. Point it at a new directory.');
    }
    const boxesFile = opt.boxes || path.join(dir, 'box-fixes.json');
    const result = await refine({
      photos: positionals, text: opt.chars, dir, boxesFile, name: opt.name,
    });
    const report = formatReport(result);
    console.log(`\n${report.text}`);
    console.log(`\nCorrections written to ${boxesFile}. Now run "review" and look at every glyph.`);
    return;
  }

  fail(`Unknown command "${cmd}".\n\n${USAGE}`);
}

async function buildKorean(dir, opt) {
  if (!opt.labels) fail('build-korean requires --labels. Labels must be L:ㄱ, V:ㅏ, or T:ㄱ.');
  const { trace, adjustWeight } = require('./trace');
  const { buildTTF, toWoff, toWoff2, fontFaceCSS } = require('./assemble');
  const { renderPreview } = require('./preview');
  const { requiredComponents, placeComponent, buildHangulGlyphs } = require('./hangul');
  const blobs = readJSON(path.join(dir, 'blobs.json'), 'Run segment first.');
  const labels = readJSON(opt.labels, '');
  const required = new Set(requiredComponents().map(({ key }) => key));
  const parts = {};
  const weight = Math.max(-2, Math.min(2, Number(opt.weight)));
  const smooth = Number(opt.smooth);

  for (const blob of blobs.blobs) {
    const label = labels[blob.id];
    if (!label) continue;
    if (!required.has(label)) {
      console.warn(`  ! "${label}" (blob ${blob.id}) is not a supported Hangul component, skipped`);
      continue;
    }
    if (parts[label]) {
      console.warn(`  ! duplicate "${label}" (blob ${blob.id}) - keeping the first one`);
      continue;
    }
    let png = fs.readFileSync(path.join(dir, blob.crop));
    png = await adjustWeight(png, weight);
    const d = await trace(png, { smooth });
    if (!d) {
      console.warn(`  ! blob ${blob.id} ("${label}") traced to nothing - skipped`);
      continue;
    }
    parts[label] = placeComponent(d, blob.cropSize, blobs.pad);
  }

  const glyphs = buildHangulGlyphs(parts);
  const name = opt.name;
  const base = opt.out ? opt.out.replace(/\.\w+$/, '') : path.join(dir, name.replace(/\s+/g, ''));
  fs.mkdirSync(path.dirname(path.resolve(base)), { recursive: true });
  const ttf = buildTTF(name, glyphs, { wordSpace: 500 });
  const formats = opt.formats.split(',').map((s) => s.trim().toLowerCase());
  const written = [];
  if (formats.includes('ttf') || opt.out) {
    fs.writeFileSync(`${base}.ttf`, ttf);
    written.push(`${base}.ttf`);
  }
  if (formats.includes('woff')) {
    fs.writeFileSync(`${base}.woff`, toWoff(ttf));
    written.push(`${base}.woff`);
  }
  if (formats.includes('woff2')) {
    fs.writeFileSync(`${base}.woff2`, await toWoff2(ttf));
    written.push(`${base}.woff2`);
  }
  if (formats.includes('css')) {
    fs.writeFileSync(`${base}.css`, fontFaceCSS(name, path.basename(base)));
    written.push(`${base}.css`);
  }

  const sample = '가나다라마바사 아자차카타파하\n한글 손글씨 폰트 미리보기';
  const sampleGlyphs = Object.fromEntries(glyphs.filter((g) => sample.includes(g.char)).map((g) => [g.char, g]));
  await renderPreview({ name, glyphs: sampleGlyphs }, path.join(dir, 'korean-preview.png'), { text: sample });
  fs.writeFileSync(path.join(dir, 'korean-manifest.json'), JSON.stringify({ name, components: Object.keys(parts), glyphCount: glyphs.length }, null, 2));
  console.log(`Built ${glyphs.length} Hangul syllables → ${written.join(', ')}`);
  console.log(`Preview: ${path.join(dir, 'korean-preview.png')}`);
}

async function build(dir, opt) {
  const { trace, adjustWeight } = require('./trace');
  const { placeGlyph } = require('./metrics');
  const { buildTTF, toWoff, toWoff2, fontFaceCSS } = require('./assemble');
  const { renderPreview, renderGlyphSheet } = require('./preview');
  const { CHARSETS } = require('./charsets');

  const blobs = readJSON(path.join(dir, 'blobs.json'), 'Run segment (or make) first.');
  const labels = resolveLabels(blobs, opt, CHARSETS);

  const smooth = Number(opt.smooth);
  const weight = Math.max(-2, Math.min(2, Number(opt.weight)));
  const glyphs = [];
  const seen = new Set();
  for (const blob of blobs.blobs) {
    let char = labels[blob.id];
    if (!char) continue;
    char = char.normalize('NFC');
    if ([...char].length > 1) {
      console.warn(`  ! "${char}" (blob ${blob.id}) is a multi-character sequence - not supported yet, skipped`);
      continue;
    }
    if (seen.has(char)) {
      console.warn(`  ! duplicate "${char}" (blob ${blob.id}) - keeping the first one`);
      continue;
    }
    seen.add(char);
    let png = fs.readFileSync(path.join(dir, blob.crop));
    png = await adjustWeight(png, weight);
    const d = await trace(png, { smooth });
    if (!d) {
      console.warn(`  ! blob ${blob.id} ("${char}") traced to nothing - skipped`);
      continue;
    }
    const placed = placeGlyph(d, blob.cropSize, blobs.pad, char);
    glyphs.push({ char, ...placed, source: blob.crop });
  }
  if (!glyphs.length) fail('No glyphs to build. Check your labels.');

  const name = opt.name;
  const base = (opt.out ? opt.out.replace(/\.\w+$/, '') : path.join(dir, name.replace(/\s+/g, '')));
  fs.mkdirSync(path.dirname(path.resolve(base)), { recursive: true });
  const ttf = buildTTF(name, glyphs);
  const formats = opt.formats.split(',').map((s) => s.trim().toLowerCase());
  const written = [];
  if (formats.includes('ttf') || opt.out) {
    fs.writeFileSync(`${base}.ttf`, ttf);
    written.push(`${base}.ttf`);
  }
  if (formats.includes('woff')) {
    fs.writeFileSync(`${base}.woff`, toWoff(ttf));
    written.push(`${base}.woff`);
  }
  if (formats.includes('woff2')) {
    fs.writeFileSync(`${base}.woff2`, await toWoff2(ttf));
    written.push(`${base}.woff2`);
  }
  if (formats.includes('css')) {
    fs.writeFileSync(`${base}.css`, fontFaceCSS(name, path.basename(base)));
    written.push(`${base}.css`);
  }

  const manifest = {
    name,
    unitsPerEm: 1000,
    smooth,
    weight,
    glyphs: Object.fromEntries(glyphs.map((g) => [g.char, { d: g.d, advance: g.advance, source: g.source }])),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await renderPreview(manifest, path.join(dir, 'preview.png'));
  await renderGlyphSheet(manifest, path.join(dir, 'glyphs.png'));

  console.log(`Built ${glyphs.length} glyphs → ${written.join(', ')}`);
  console.log(`Preview: ${path.join(dir, 'preview.png')}  Glyph sheet: ${path.join(dir, 'glyphs.png')}`);
  const missing = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter((c) => !seen.has(c));
  if (missing.length) console.log(`Letters not in this font yet: ${missing.join(' ')}`);
}

function resolveLabels(blobs, opt, CHARSETS) {
  if (opt.labels) {
    const map = readJSON(opt.labels, '');
    return Object.fromEntries(Object.entries(map).filter(([, v]) => v));
  }
  let chars;
  // '/' and newlines are line separators (see make-korean), never glyphs.
  if (opt.chars) chars = [...opt.chars.normalize('NFC').replace(/[\/\n\r]/g, '').replace(/\s+/g, '')];
  else if (opt.charset) {
    chars = CHARSETS[opt.charset];
    if (!chars) fail(`Unknown charset "${opt.charset}". Available: ${Object.keys(CHARSETS).join(', ')}`);
  } else {
    fail('Provide --labels labels.json, --chars "…", or --charset <name>.');
  }
  const ids = blobs.blobs.map((b) => b.id);
  if (chars.length !== ids.length) {
    console.warn(
      `  ! ${ids.length} blobs found but ${chars.length} characters given - mapping in order, extras ignored.\n` +
      `    If this is unexpected, inspect the contact sheet and use --labels for exact control.`
    );
  }
  return Object.fromEntries(ids.slice(0, chars.length).map((id, i) => [id, chars[i]]));
}

function readJSON(file, hint) {
  if (!fs.existsSync(file)) fail(`${file} not found. ${hint}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

main().catch((err) => fail(err.stack || String(err)));
