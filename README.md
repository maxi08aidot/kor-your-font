# kor-your-font

> ### 이 프로젝트에 대하여 / About this project
>
> kor-your-font는 [Danilo Znamerovszkij](https://github.com/danilo-znamerovszkij)의
> [**draw-your-font**](https://github.com/danilo-znamerovszkij/draw-your-font)에서 갈라져 나온 파생 프로젝트입니다.
> 사진 이진화·윤곽 추적·글리프 조립 등 폰트 생성 코어는 원저작물의 코드이며, MIT 라이선스에 따라 사용합니다.
> 이 저장소가 새로 더한 것은 **한글 지원**입니다 — 초·중·종성 조합을 통한 현대 한글 완성형 11,172자 생성,
> 한글 워크시트, 자유 필기 부분 폰트, 한국어 웹 데모.
>
> *kor-your-font is a derivative of [draw-your-font](https://github.com/danilo-znamerovszkij/draw-your-font)
> by Danilo Znamerovszkij, used under the MIT License. The font-generation core is the original author's work.
> This fork adds Hangul support: composing 11,172 modern Korean syllables from jamo components,
> a Hangul worksheet, freeform partial fonts, and a Korean web demo.*

**Turn a photo of your handwriting into a real font (TTF/WOFF/WOFF2) - free, open source, no uploads, no credits.**

Draw your alphabet on paper. Take a photo. Get your font.

**한국어도 지원합니다.** 한글 템플릿에 초성·중성·종성 67개를 한 번씩 쓰면,
도구가 이를 조합해 현대 한글 완성형 11,172자(`가`–`힣`)를 갖춘 폰트를 만듭니다.

웹 데모에서는 **Korean quick font**를 선택해 사진과 실제 쓴 문구를 넣으면,
그 문구에 필요한 한글·영문만 담은 부분 폰트를 바로 내려받을 수 있습니다.
사진만으로 더 유연하게 판독·검수하려면 Claude/Codex 스킬을 사용합니다.

![A photo of a handwritten alphabet in a spiral notebook becoming an installable font](assets/hero.png)

*This is a real one-shot result: dim light, spiral binding, page shadow. One photo in, installable font out.*

## Use it as a Claude Code skill (the fun way)

```bash
npx skills add jogwangjae/kor-your-font
```

Then in Claude Code, invoke the skill and hand it your photo:

> */kor-your-font* *"here's a photo of my handwriting - make my font"* (drag the photo into the terminal)

Claude finds your letters in the photo, labels them with vision, builds the
font, shows you a preview, and critiques its own work. Iterate by talking:

- *"make it rounder"* / *"a bit bolder"*
- *"the g looks bad"* - it shows you the crop and fixes or asks for a re-shoot
- *"give me woff2 + css for my website"*
- *"how readable is it?"* - a legibility score and the two worst letter pairs

No photo yet? Say *"give me a font template"* and you get a printable PDF grid:
write your alphabet with a dark pen, photograph the pages, and hand them back.
Messy freeform photos work too. Napkins, notebooks, spiral binding, bad
lighting: that's what the vision step is for.

Everything runs locally on your machine. Your handwriting never leaves it.

## Use it as a CLI (no AI at all)

The skill is a thin layer over a deterministic npm CLI. It works on its own
when you can tell it what you wrote:

```bash
# freeform photo, you know the order you wrote in:
npx kor-your-font make photo.jpg --chars "ABCabc" --name "My Hand"
# → MyHand.ttf - double-click, install, done.

# best quality: print a template, fill it, photograph:
npx kor-your-font template -o template.pdf --charset minimal   # or: spanish
npx kor-your-font make page1.jpg page2.jpg --charset minimal --name "My Hand"

# Korean, freeform: write only the syllables/English letters you need, in this
# exact order and with a clear one-syllable gap between blocks.
npx kor-your-font make-korean note.jpg --chars "오늘의기록Hello" --name "My Note"

# Korean, complete: write 67 jamo over two worksheet pages, then build all
# 11,172 syllables. When a Korean font is available, each cell shows its jamo.
npx kor-your-font template-korean -o korean-template.pdf
npx kor-your-font segment-korean korean-page-1.jpg korean-page-2.jpg -d korean-work
npx kor-your-font build-korean -d korean-work --labels korean-work/korean-labels.json \
  --name "My Hangul Hand" --formats ttf,woff,woff2,css

# Same complete-Korean flow, as one command:
npx kor-your-font make-korean-full korean-page-1.jpg korean-page-2.jpg -d korean-work \
  --name "My Hangul Hand" --formats ttf,woff,woff2,css
```

Pure npm, zero system dependencies: no FontForge, no ImageMagick, no potrace
binary. Works on macOS / Linux / Windows wherever Node ≥ 18 runs.

### CLI reference

| Command | What it does |
|---|---|
| `template` | printable A4 PDF grid (`--charset minimal\|spanish`) |
| `template-korean` | two-page worksheet for the 67 modern Hangul components, plus a UTF-8 cell map |
| `segment <photos…>` | find letters → crops + numbered contact sheet + `blobs.json` |
| `make-korean <photos…> --chars "…"` | group clearly separated handwritten syllable blocks and build a partial Korean/Latin font |
| `make-korean-full <page photos…>` | capture the two Korean worksheets and build all 11,172 modern Hangul syllables |
| `segment-korean <page photos…>` | capture each known worksheet cell intact; writes `korean-labels.json` automatically |
| `build` | labeled crops → font (`--labels` / `--chars` / `--charset`) |
| `build-korean` | 67 traced components → every modern Hangul syllable (`가`–`힣`) |
| `make <photos…>` | segment + build in one shot |
| `preview` | render any text with the built font |

Refinement flags: `--smooth 0..2` (rounder curves), `--weight=-2..2`
(thinner/bolder), `--formats ttf,woff,woff2,css` (web-ready + `@font-face`
snippet). Run `kor-your-font --help` for everything.

### Korean handwriting flow

There are two Korean flows, mirroring the original tool's freeform-photo and
template options.

**Freeform / small character set.** Write only the Hangul syllables and Latin
characters you need, left to right, with a gap at least as wide as one syllable
block. Pass that exact sequence to `make-korean`. It makes a *partial font*:
the written characters work, while unwritten Korean syllables are absent. This
is ideal for a note, title, sticker, or a known set of UI strings. It does not
claim to infer jamo from an arbitrary completed syllable and generate unseen
ones.

**Complete Korean.** The two-page worksheet collects all 67 role-specific
modern jamo and builds `가`–`힣`. On macOS the generated template labels every
cell directly with its jamo. On a system without an available Korean font, use
`--label-font /path/to/korean-font.ttf`, or consult the companion map file.

Korean syllables are made from a leading consonant, vowel, and optional final
consonant. Freeform blob detection is the wrong input model because the parts
of a syllable may not touch. The Korean worksheet solves this by assigning one
cell to each component: 19 leading consonants, 21 vowels, and 27 final
consonants. `segment-korean` crops the cells, not connected ink blobs, so a
component with separate strokes stays together.

`build-korean` fits each traced component into a neutral design cell and lays
it out in left/right or top/bottom syllable slots depending on the vowel. It
then emits the 11,172 standard precomposed Unicode syllables. The result works
in ordinary Korean text fields without requiring application-specific OpenType
shaping support.

For the clearest result, use a dark pen, write each component large and
centered, keep both worksheet pages flat, and photograph the complete page
from directly above. The initial layout is intentionally conservative; it is a
handwriting-font generator, not a replacement for hand-tuned professional
Korean type design.

## How it works

```
photo ──► adaptive threshold ──► blob detection ──► label (Claude / you / template order)
      ──► potrace vectorize ──► shared em-square metrics ──► TTF/WOFF/WOFF2 + preview
```

The craft is in the metrics step: every character has a vertical band in a
shared 1000-unit em square (cap height, x-height, descender depth), so your
`g` hangs below the line and your `o` stays small. That's what makes it feel
like a font instead of a ransom note. Vectorization is potrace, the same
engine inside FontForge and Inkscape. AI never draws your letters; it only
finds, labels, and judges them.

## FAQ

**Who owns the font?** You. 100%, commercial use included. It's your
handwriting.

**Why is this free when Calligraphr charges $8/month?** Their cost is
servers and a browser editor. Here your machine does the work and the agent
is the editor.

**Kerning, ligatures, letter randomization?** v2. The pipeline (fonttools
`calt`) is planned; the current output is a clean single-variant font.

## License

MIT. Draw something.
