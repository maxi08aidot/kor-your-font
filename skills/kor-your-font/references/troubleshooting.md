# Troubleshooting capture & segmentation

Binarization is automatic (Otsu threshold over a local background estimate),
so brush, marker, and thin-pen writing are all handled without tuning. Two
knobs remain on `segment`/`make` for genuinely awkward captures:

- `--delta N` (default 40): how much darker than the local paper a pixel must
  be to count as ink. Lower = more sensitive (catches faint pens, also more
  noise). Raise to 55–70 for photos with heavy shadows misread as ink.
- `--cap N` (default 165): absolute grey ceiling for ink after contrast
  normalization. Anything lighter is never ink - this is what erases the
  template's grey guides. Lower to 140 if printed guides survive into blobs;
  raise to 190 for a very faint pencil (expect more noise).

Reach for these only for shadows, printed guides, or pencil. Do **not** use
them to compensate for thick strokes - Otsu already covers that, and forcing
`--cap` on brush writing eats the ink back out.

Re-running segment rewrites blobs.json and renumbers every blob - discard
any labels.json written earlier and relabel from the fresh contact sheet
(prefer a fresh `-d` workdir).

## Symptoms → fixes

**Hundreds of tiny blobs** - noisy paper texture or aggressive delta. Re-run
segment with `--delta 55`. If the photo is low light, ask for a brighter shot.

**A huge blob spanning the page** - a shadow edge or the page border got
thresholded. Crop the photo to just the paper (or re-shoot from directly
above), or raise `--delta`.

**Letters missing entirely** - pen too faint (pencil, gel on glossy paper).
Try `--delta 25 --cap 190`. If still missing, the honest fix is rewriting
with a darker pen; say so.

**Strokes broken into fragments** - thin ballpoint. Try `--delta 30`, then
`build --weight 1` to fatten what traced. Recommend a 0.5mm+ pen for the
re-shoot.

**Two letters in one box** - they touch on paper. For Latin print-style
writing, ask the user to re-write just those letters with space between them,
segment the new photo, and merge via labels. For cursive or brush writing a
re-shoot does not help - see the Korean section below.

**Template guides appear as blobs** - printer printed the grey too dark.
Re-run with `--cap 140`. If their printer only does solid black, they can
still use the template - the guides will show as long thin blobs; label them
all `""`.

**i/j dots detached as separate blobs** - normally auto-merged; if the dot is
very far from the stem it may not be. Label the stem blob with the letter and
the dot `""` - or better, relabel both after a re-shoot. (A dotless i still
reads fine in most handwriting.)

**Rotated/skewed photo** - mild angles are fine and become part of the font's
character. A strongly rotated photo (>5°) will slant every glyph; ask for a
straighter shot rather than trying to compensate.

## Korean freeform (`make-korean` / `refine` / `review` / `audit`)

**A multi-line photo collapses to one or two glyph candidates** - the line
separators are missing from `--chars`, so every line was treated as one
continuous run of writing and the page fused into a single block. Pass the
line structure: separate the lines with `/` or a real newline, e.g.
`--chars "노력한다고 항상/성공할순 없지만/알아둬"`. Then rerun from
`make-korean`.

**Strokes look eaten away - holes inside them, ragged edges** - this was the
old fixed-quantile binarization, which assumed thin-pen writing and stripped
the interior of thick brush or marker strokes. Otsu now picks the threshold
per photo and handles both. Do **not** force `--cap` (or `--delta`) to
compensate; that reintroduces exactly this damage. If it survives that, the
ink really is patchy on paper.

**A glyph renders with a neighbour's stroke attached in front of it** - its
box reaches back into the previous syllable. Tighten that edge by hand:
`--boxes` with `{"<id>": [x0,y0,x1,y1]}` in contact-sheet pixels, placing the
new edge at an **ink valley** (a column with little or no ink) rather than at
a guessed coordinate. The override replaces that one box in place; glyph count
and order do not change. Because a deliberately tightened box looks like a
clipped glyph to the measurement, boxes you supply by hand are pinned: `audit`
reports them as `(pinned by hand)` instead of failing, and `refine` will not
widen them back. Keep the edit in the boxes file you pass to both.

**A glyph is missing a jamo** - its box is clipping: part of the ink the glyph
owns falls outside the box. Run `refine`, which widens clipping boxes
automatically and is usually enough. If the jamo is still missing, widen that
box yourself with `--boxes`, again cutting at an ink valley, then re-`audit`.

**Trailing marks steal characters from the end of a line** - the writer added
something they did not list (an ellipsis, a flourish, a signature), so the
extra blobs consume the last labels on that line and everything after the mark
shifts. Either include those marks in `--chars` so they get their own slot, or
expect the debris filter to drop them. Verify on the contact sheet which blob
got which id before assuming the text is aligned.

**`foreign` is high in the audit report** - expected, not a defect. In cursive
Korean two syllables genuinely share brush strokes, so ink inside one glyph's
box legitimately belongs to its neighbour too. Report it and move on. Only
`clipped` and `orphan` gate delivery; tuning against `foreign` has been tried
and makes the output worse.
