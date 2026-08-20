---
name: kor-your-font
description: Turn a photo of handwriting into a real installable font (TTF/WOFF/WOFF2), with full Hangul support. Use when the user shares a photo of handwritten letters and wants a font, asks to "make my font", "handwriting font", "turn my handwriting into a font", "font from this photo/image", asks for a handwriting font template, or wants to refine a font made earlier (smoother, thicker, fix a letter). Also for Korean: 손글씨 폰트, 내 손글씨로 폰트 만들기, 한글 폰트 만들기, 캘리그라피 폰트, 손글씨 사진으로 폰트. Not for choosing, recommending, or identifying existing fonts - only for creating a font from the user's own handwriting.
---

# kor-your-font

Photo of handwritten letters in → installable font out. The CLI does all
geometry (trace, metrics, font assembly) and all defect *measurement*; you
supply the text, its line structure, and judgement on the few glyphs geometry
cannot decide. Never edit SVG paths or coordinates yourself.

## Setup (once per session)

Run `node <skill-dir>/scripts/resolve-cli.js` once. It prints the CLI
invocation to use (e.g. `node /abs/path/src/cli.js`). Substitute that printed
command wherever the examples below show `$DYF` - shell variables do not
persist between tool calls, so paste the real command each time.

If it errors, run `npm install` where it tells you (or `npm i -g
kor-your-font`) and retry. Requires Node ≥ 18. Everything runs locally;
nothing is uploaded.

## Decide the flow

- **User has no photo yet** → offer the template: print, write, photograph.
- **User wants a Korean/Hangul handwriting font** → if they need only a known
  set of syllables, use the Freeform Korean flow below (measured loop:
  `make-korean` → `refine` → `review` → `audit`). Use the worksheet only when
  they need `가`–`힣` coverage.
- **User shares photo(s) of handwriting** → main flow below.
- **User pasted an image but there is no file path** → you can see it, but the
  CLI needs a file. Ask them to drag the image file into the terminal (that
  inserts its path) or give the path directly. Do not proceed from memory.
- **User wants changes to a font built this session** → Refine section.

## Template flow (best quality)

```bash
$DYF template -o template.pdf --charset minimal   # or: spanish
```

Tell the user: print it, write one character per box with a dark pen
(0.5 mm+), keep the letter sitting on the solid line, then photograph each
page from above in good light and share the file paths. The grid prints in
light grey and vanishes during processing - only their ink survives.

## Main flow: photo(s) → font

**1. Segment.** Works for template pages and freeform photos alike:

```bash
$DYF segment photo1.jpg photo2.jpg -d work
```

**2. Look, then label.** Read `work/contact-1.png` (one per photo): every
detected blob is numbered. This is the step where your eyes matter - check:

- Did every written character get exactly one box? A letter drawn with
  separate strokes may appear as two boxes (relabel handles it: give the main
  box the character and mark the fragment `""`), and two touching letters may
  share one box (ask the user to re-shoot just those, or accept the gap).
- Junk boxes (shadows, ruled lines, smudges, page edges) → label them `""`.

Then write `work/labels.json` mapping blob id → character, e.g.
`{"0": "A", "1": "B", "7": "", "8": "a"}`:

- Template page: order is the charset order printed on the template - verify
  against the sheet instead of trusting it blindly. minimal order: A–Z, a–z,
  0–9, then `.,;:!?'"-()@#&+/$`; spanish appends `ÑñÁÉÍÓÚáéíóúü¿¡`.
- Freeform: identify each letter from the contact sheet. Uppercase vs
  lowercase for shape-twins (S/s, O/o, C/c, X/x…) is decided by relative size
  and position - compare against neighbors you're sure of. Note that crops are
  size-normalised, so the contact sheet has thrown away the very cue you need.
- **Check the mapping arithmetically, not by eye.** `work/blobs.json` gives
  every blob a `row` and a `box`. If the user said they wrote five rows of
  13/13/13/13/10, count the blobs per row and confirm x increases across each
  one. That turns a judgement call into a proof, and it catches the failure
  that matters most here - one extra or missing blob early on, which shifts
  every character after it.
- The user told you what they wrote (e.g. "ABC then abc")? Trust it, map in
  reading order (top row first, left to right), and verify visually.
- Same letter appears twice → label the better-drawn one, `""` the other.

**3. Build.**

```bash
$DYF build -d work --labels work/labels.json --name "Dan's Hand"
```

Name the font after the user (ask if unclear - one short question max).

**4. Judge one glyph at a time, against its own source.** Do **not** critique
a grid of small glyphs in `glyphs.png` and call that a review. That method is
unreliable in both directions: it passes glyphs that are badly broken, and it
"finds" defects in glyphs that are fine. Two rules, always:

- Compare each glyph with **its own source region**. `$DYF review -d work`
  builds exactly those sheets - the source ink above what the font draws - for
  any workdir, Latin included. Use it rather than opening `work/crops/<id>.png`
  one at a time and comparing from memory. Count the panels: one per character.

Of the three checking commands, only `review` is safe everywhere:

| | Latin / template | Korean worksheet | Korean freeform |
|---|---|---|---|
| `review` | yes | yes | yes |
| `audit` | yes | yes | yes |
| `refine` | **no** | **no** | yes |

`refine` rebuilds the workdir from the photo with `make-korean` on every round.
Pointed at a workdir built any other way it would destroy it, so it refuses -
if you want to try it, give it a new directory.
- Never judge against your memory of how the character *should* look. The
  question is only whether the glyph matches the ink the user actually wrote.

Then fix by cause:

- Broken or blotchy letters (bad trace) → often a faint pen stroke; try
  `--weight 1`, or ask for a re-shoot of just that letter.
- Everything too thin/thick → rebuild with `--weight 1` / `--weight -1`.
- Jagged edges → rebuild with `--smooth 1.5` (up to 2).
- A letter placed wrong (e.g. a `g` not descending) → usually a mislabel;
  fix labels.json and rebuild.
- Filled-in bowls (b, o, g look solid): should never happen - if it does,
  the crop is smudged; ask for a re-shoot.

Rebuilds are cheap and safe to iterate. Fix what you can yourself first;
only bother the user for re-shoots when the source ink is the problem.

**5. Deliver.** The font lands at `<workdir>/<NameWithoutSpaces>.ttf` (the
build output prints the exact path). Give that path and how to install:
macOS - double-click → "Install Font"; Windows - right-click → "Install".
Mention what's missing (the build prints uncovered letters) and offer,
without pushing:

- Web formats + CSS: rebuild with `--formats ttf,woff,woff2,css`.
- A legibility read (below).
- Their next photo to fill missing characters: re-run segment with ALL
  photos (old and new) into a fresh workdir - `$DYF segment p1.jpg p2.jpg -d
  work2` - then relabel from the new contact sheets (blob ids renumber; the
  old labels.json does not carry over) and build from the new workdir.

## Korean worksheet flow

Modern Hangul is produced from 67 handwritten components: 19 leading
consonants, 21 vowels, and 27 final consonants. The CLI composes all 11,172
modern syllables after tracing them. The user writes components, not every
syllable.

```bash
$DYF template-korean -o korean-template.pdf
# After the user photographs both complete pages:
$DYF make-korean-full korean-page-1.jpg korean-page-2.jpg -d korean-work \
  --name "User's Hangul Hand" --formats ttf,woff,woff2,css
```

Tell the user to use a dark pen and photograph the *full* flat worksheet from
above. `make-korean-full` uses known cell positions, so disconnected strokes in
one jamo remain one source glyph. It creates role labels automatically; do not
replace them with ordinary one-character labels. Inspect
`korean-work/korean-preview.png` before delivery, and check the components
themselves - a syllable can only be as good as the jamo it is built from:

```bash
$DYF review -d korean-work -o korean-work/review.png   # each jamo vs its crop
$DYF preview -d korean-work --text "값 닭 흙 과 뭐"      # any text you like
```

Both recompose from the stored components on demand, so they work here even
though the worksheet build writes no `manifest.json` - 11,172 outlines will not
fit in one file. Pick text that exercises finals and horizontal vowels, not
just 가나다: those are the placements that go wrong. If a component is faint or
missing, re-shoot the relevant complete worksheet page and rerun the command
in a fresh work directory.

## Freeform Korean partial-font flow

For a title, note, or known UI strings, the user does not need to write 67
jamo - only the syllables and Latin characters they need. This is a **partial
font**: it contains only what was written. Never say it generates other Hangul
syllables.

Run the loop below in order. It is measured, not eyeballed: `refine` and
`audit` settle everything geometry can settle, so your judgement is spent on
only the couple of glyphs it cannot.

**1. Get the text - including its line structure.** Ask for the exact written
sequence *and how it breaks across lines*. In `--chars`, separate the lines of
writing with `/` or a real newline:

```bash
--chars "노력한다고 항상/성공할순 없지만/알아둬"
```

Without separators the lines fuse into one run and a multi-line photo can
collapse into one or two glyph candidates.

**2. First pass.**

```bash
$DYF make-korean note.jpg --chars "노력한다고 항상/성공할순 없지만/알아둬" \
  -d korean-work --name "My Note"
```

**3. `refine` - close severed strokes automatically.**

```bash
$DYF refine note.jpg --chars "노력한다고 항상/성공할순 없지만/알아둬" \
  -d korean-work --name "My Note"
```

It loops build → audit → widen the boxes that are clipping strokes → rebuild,
until nothing is clipped or no further correction is proposed, and writes the
result to `korean-work/box-fixes.json` (override the path with `--boxes`). On
a real five-line brush photo this cut missing ink from 5,289 px to 75 px in
two rounds. Run it before looking at anything.

**4. `review` - then read the sheets.**

```bash
$DYF review -d korean-work -o korean-work/review.png
```

It takes no `--chars`; it reads the text from the workdir. For every unique
character it writes the region of the source photo on top and the glyph the
font actually draws below, split across several images so each glyph is large
enough to judge honestly. Judge each glyph **against its own source region in
the same image** - never against your memory of the character, and never by
scanning a grid of small glyphs.

**Count the panels before you read them.** One per unique character, no
exceptions. A blob whose crop traces to nothing is dropped from the font
silently, and that character then has no panel at all - the worst defect
there is, and the easiest to miss, because nothing looks wrong on the sheet in
front of you. `audit` reports it too (`MISSING FROM FONT: …`), but notice it
here first.

**5. Hand-correct only the glyphs still wrong.** `--boxes` takes hand-corrected
glyph boxes, keyed by the id drawn on the contact sheet, in contact-sheet
pixels:

```json
{"7": [x0, y0, x1, y1]}
```

An override replaces one box in place - the count and order of glyphs never
change. To place an edge, look at the ink profile and cut at a **valley**
rather than guessing a coordinate. Edit `korean-work/box-fixes.json` (the file
`refine` already wrote) and rebuild:

```bash
$DYF make-korean note.jpg --chars "…" -d korean-work \
  --boxes korean-work/box-fixes.json --name "My Note"
```

**Hand-supplied boxes are pinned.** Every box present in that file when a
command starts is treated as a human decision: `audit` will not fail it, and
prints `(pinned by hand)` where it would otherwise print `<- clipped`;
`refine` will not widen or overwrite it. This is what lets you deliberately
*tighten* a box to cut a neighbour's stroke away - without pinning, that reads
as a clipped glyph and the next `refine` would silently undo it. So keep your
edits in the file you pass to `refine` and `audit`, and re-run `refine` freely
afterwards.

**6. `audit` - the delivery gate.**

```bash
$DYF audit -d korean-work --chars "노력한다고 항상/…"
```

It prints an objective defect report and exits non-zero while defects remain:

- `clipped` - the share of the ink a glyph owns that fell outside its own box.
  A severed stroke: the glyph is missing part of itself. Any unpinned glyph
  over 2% fails.
- `orphan` - ink that no glyph claims at all, as a share of all ink on the
  page. Those strokes are missing from the font entirely. Over 2% fails.
- `foreign` - **not a defect gate.** In cursive Korean two syllables genuinely
  share brush strokes, so high `foreign` values are normal. Rules that
  minimised `foreign` were tried and made the output worse - one deleted a
  syllable's main stroke outright. Report the number; never tune against it.
- `MISSING FROM FONT` - the character never reached the font at all. Always a
  failure. Its box is capturing ink too faint or too small to trace; widen it
  to cover the whole syllable and rebuild.

**When `clipped` will not come down.** Widening a box helps only when the ink
it is missing lies just outside it. Where the missing ink belongs to a stroke
the syllable *shares* with its neighbour, the crop filter drops it however
large the box gets, and the number stays put no matter how you edit - that is
not your edit failing. Check the review sheet: if the glyph reads correctly
against its source, pin the box and move on. This is what pinning is for.

Deliver when `clipped` and `orphan` are clean **and** the review sheets are
clean.

**On hard cursive or brush input, full automation is not achievable.** When
two syllables share a physical brush stroke, which ink belongs to which
syllable is genuinely absent from the geometry - no threshold recovers it, and
no re-shoot fixes it either, because the strokes are shared on paper. The
loop's job is to remove every defect that *is* objectively decidable, so that
human/agent judgement is needed for only a couple of glyphs. Say this plainly
to the user instead of promising a clean automatic result.

Capture advice for a *new* photo (not a remedy for one you already have):
write blocks left-to-right with a gap at least as wide as one syllable between
them, and keep the lines clearly separated.

## Refine (conversational iteration)

| User says | Do |
|---|---|
| "smoother / rounder" | `build … --smooth 1.5` (max 2) |
| "thicker / bolder" | `build … --weight 1` (max 2) |
| "thinner / lighter" | `build … --weight=-1` (negative needs the `=` form) |
| "the g looks bad" | show them `work/crops/<id>.png` for that letter; offer re-shoot or smooth |
| "wrong letter" / swap | edit labels.json, rebuild |
| "this Korean syllable is wrong" | `$DYF review` that workdir, then correct just that box in `box-fixes.json` and rebuild with `--boxes` |
| "give me woff2 / web" | `build … --formats ttf,woff,woff2,css` |
| custom preview text | `$DYF preview -d work --text "…"` (after a build) |

All refine commands rebuild from the stored crops - no re-photographing
needed unless the ink itself is the problem.

## Legibility report (offer after delivering)

```bash
$DYF preview -d work --text "minimum mill rn m cl d I l 1 O 0 quick brown fox" -o work/legibility.png
```

Read it and give an honest, kind read: a score out of 10 for body-text use,
the 2–3 letter pairs most likely to confuse (rn→m, cl→d, I/l/1, O/0), and one
or two concrete fixes (rewrite those letters larger, more spacing). Note that
display use (headings, notes) is more forgiving than paragraphs. Never gate
delivery on this - it's advice, not a blocker.

## Troubleshooting

Segmentation found far too many / too few blobs, a multi-line photo collapsing
to one glyph, strokes eaten away, a glyph carrying a neighbour's stroke or
missing a jamo, grey guide lines surviving, faint ballpoint strokes → see
[references/troubleshooting.md](references/troubleshooting.md).
