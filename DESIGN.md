# DESIGN.md: Braid

Status: implemented in `src/ui/` on 2026-10-04 (uncommitted). Where the build departed from the first proposal, this file was changed to match what is there.

## Sources

Measured on 2026-10-04 from computed styles at 1440px, light mode: vercel.com/home, cloudflare.com, mintlify.com, blacksmith.sh, greptile.com. Values marked *(est.)* are my judgement, not a measurement; check them on screen before treating them as settled.

## Direction

A light, neutral, hairline-ruled tool. Ink does the work colour usually does; the eight intent colours and the three status colours are the only colour on screen. The loom, the session log and command blocks are the one dark surface. Character comes from uppercase mono labels, a visible grid, sharp corners and a hard offset shadow on the few panels that ask for a decision.

| Decision | Choice | Taken from |
|---|---|---|
| Canvas | Light shell and hero; loom stays dark | Vercel, Mintlify |
| Type | Geist + Geist Mono | Vercel |
| Colour | Ink buttons; intents are the colour | Vercel, Mintlify |
| Labels | Uppercase mono | Blacksmith, Greptile |
| Structure | Shared 1px rules, not floating cards | Mintlify, Cloudflare |
| Corners | 4–6px | Mintlify, Vercel |
| Emphasis | Hard offset shadow | Blacksmith |
| Imagery | Inline SVG throughout, drawn from the strand | Mintlify's line waves, Greptile's frames, Braid's own loom |

## Colour

### Light

| Token | Value | Use |
|---|---|---|
| `--bg` | `#fafafa` | Page |
| `--surface` | `#ffffff` | Panels, inputs, shell bar |
| `--sunk` | `#f5f5f5` *(est.)* | Tab strips, code context, hover |
| `--sunk-2` | `#ebebeb` | Pressed, count badges |
| `--ink` | `#171717` | Text, primary buttons, emphasis borders |
| `--muted` | `#4d4d4d` | Secondary text |
| `--faint` | `#666666` | Metadata text (5.7:1 on white) |
| `--ghost` | `#8f8f8f` | Placeholders, disabled, icons only; fails AA for body text |
| `--line` | `#e6e6e6` *(est.; Vercel's `#ebebeb` was too faint on `#fafafa`)* | Default 1px rule |
| `--line-strong` | `#cfcfcf` *(est.)* | Input borders, hovered rules |
| `--focus` | `#2f5bff` | Focus ring only (kept from the current accent) |
| `--good` / `--good-bg` | `#0b7a45` / `#e0f5e9` | Kept |
| `--warn` / `--warn-bg` | `#8f5d00` / `#fdf0cf` | Kept |
| `--bad` / `--bad-bg` | `#c02626` / `#fde6e6` | Kept |
| `--add-bg` / `--del-bg` | `#e3f6ea` / `#fde8e8` | Kept |
| `--i1`…`--i8` | unchanged | Intent identity |

`--accent`, `--accent-hover` and `--accent-soft` are removed. Where they marked a selected or working state, use `--ink` (selected) or `--sunk` (soft fill).

### Night (loom, session log, `.cmd`, verification output; same in both themes)

| Token | Value |
|---|---|
| `--night` | `#0a0a0a` *(est.; was navy `#0b1020`)* |
| `--night-2` | `#171717` *(est.)* |
| `--night-3` | `#1f1f1f` *(est.)* |
| `--night-line` | `#2e2e2e` *(est.)* |
| `--night-ink` | `#ededed` *(est.)* |
| `--night-muted` | `#a1a1a1` *(est.)* |

Bright strand colours for night surfaces are unchanged. They were tuned against navy, so check all eight against `#0a0a0a`.

### Dark theme (`prefers-color-scheme: dark`), all *(est.)*

`--bg #0a0a0a`, `--surface #111111`, `--sunk #171717`, `--sunk-2 #1f1f1f`, `--ink #ededed`, `--muted #a1a1a1`, `--faint #8f8f8f`, `--line #242424`, `--line-strong #333333`, `--focus #7c98ff`. Status and diff colours keep their current dark values. None of the references was measured in dark mode.

## Typography

Geist and Geist Mono (variable), self-hosted through the `@fontsource-variable/geist` and `@fontsource-variable/geist-mono` packages, replacing Instrument Sans and JetBrains Mono. Nothing is loaded from another origin, so Braid's preview of its own interface shows the real fonts. Fallbacks stay as they are.

| Role | Size / line | Weight | Tracking | Notes |
|---|---|---|---|---|
| Display (home hero) | `clamp(36px, 5vw, 56px)` / 1.0 | 500 | −0.05em *(est.; Vercel is −0.06em at 64px)* | Max 14ch |
| h1 (page title) | 28 / 32 | 500 | −0.03em | 22px under 640px |
| h2 (section) | 18 / 24 | 600 | −0.015em | |
| h3 (panel title) | 14 / 20 | 600 | 0 | |
| Lede | 16 / 24 | 400 | 0 | `--muted`, max 60ch |
| Body | 14 / 20 | 400 | 0 | Max 70ch for prose |
| Small | 13 / 18 | 400 | 0 | |
| Label | 12 / 16 Geist Mono | 500 | +0.04em, uppercase | Section labels, column heads, chip text, metadata keys |
| Code | 12.5 / 1.6 Geist Mono | 400 | 0 | Diffs, blame, commands; `tab-size: 2` |

Heading weights drop from 650–700 to 500–600. Uppercase is for labels only, never for sentences, names or button text.

## Spacing and layout

- Scale (px): 4, 8, 12, 16, 24, 32, 48, 64, 96. Off-scale values in the current CSS (9, 10, 14, 18) move to the nearest step.
- Page: max 1392px, 24px gutters (12px under 640px). Narrow page: max 1088px.
- Shell bar: 56px *(est.)*, `--surface`, 1px `--line` bottom rule, sticky.
- Side column 340px; Why explorer `240px / 1fr / 380px`. Both kept.
- Breakpoints kept: 640, 860, 1000, 1100px.
- Grid: sibling panels share rules. A list of rows is one bordered box with 1px dividers, not a stack of separate cards with gaps. Sections on the home page are separated by a full-width 1px rule and 64px of space *(est.)*.

## Shape

| Token | Value | Use |
|---|---|---|
| `--r-sm` | 4px | Buttons, inputs, chips, code, intent IDs, agent marks |
| `--r` | 6px | Panels, loom, dialog, diff boxes |
| pill | 999px | Count badges and the live dot only |

Borders are 1px `--line`. A 1px `--ink` border marks a panel that needs a decision. The reconciliation panel keeps its 2px `--bad` border.

## Elevation

No soft shadows; `--shadow` is removed.

`--offset: 4px 4px 0 var(--ink)` and `--offset-sm: 2px 2px 0 var(--ink)`, always with a 1px `--ink` border. Used on at most one or two things per screen:

- the Needs-you panel
- the open reconciliation panel (offset in `--bad`)
- the sign-in dialog
- the sticky reason card in Why
- confirmation dialogs and the new-project, new-intent and edit-intent forms
- the home hero's outlined button (`--offset-sm`)

An ink offset is invisible behind an ink fill, so solid primary buttons, including Land, carry no shadow. This narrows the "primary buttons" part of the choice. Dark-theme offsets use the light `--ink`; checked on screen and kept.

## Components

- **Button**: 32px high, 0 12px, 14px/500, `--r-sm`. Default: `--surface` with 1px `--line-strong`; hover `--sunk`. Primary: `--ink` fill, `--surface` text; hover `#383838` *(est.)*. Quiet: no border, `--muted`. Danger: `--bad` text, `--bad-bg` on hover. Hero size: 40px high, 0 16px. Disabled: 45% opacity, no hover.
- **Input, select, textarea**: 1px `--line-strong`, `--r-sm`, 8px 10px, `--surface`. Labels use the Label style.
- **Chip**: outlined tag. 1px border in its own colour at 30% *(est.)*, Label type, 3px 6px, `--r-sm`, leading 6px dot. Status fills (`--good-bg` and so on) stay for ready, conflict and overlap; neutral chips have no fill.
- **Tabs**: Label type; selected tab has `--ink` text and a 2px `--ink` underline.
- **Shell nav (Work / Why)**: plain links in the bar; the current one is `--ink` with a 2px `--ink` underline flush with the bar's bottom rule.
- **Intent ID, agent mark**: unchanged apart from `--r-sm`.
- **Loom**: unchanged geometry and strand colours; `--night` surface, `--r`, 1px `--night-line`.
- **Focus**: 2px `--focus` outline, 2px offset, on every interactive element.

## Graphics

SVG is the main visual material, used on every page. All of it is inline, hand-drawn in code, themeable through CSS variables, and built from one vocabulary: the strand. Nothing is a raster image, a stock illustration or an icon font. Sizes and counts below are *(est.)* until seen on screen.

### Vocabulary

| Element | Spec |
|---|---|
| Trunk | Straight horizontal line, `--ink` (or `--night-ink`), 3px, round caps |
| Strand | Intent colour, 2.5px, round caps; leaves and rejoins trunk on a cubic S-curve with a 50px horizontal run, as the loom draws it today |
| Node | Filled circle, 4px radius (landing 6px), in the strand's colour |
| Tie | Vertical 2px line between two strands with a 4px dot at each end; `--bad` solid, `--warn` solid, `--muted` dashed `3 3` |
| Grid | 1px `--line` rules on a 24px module; dots are 1px at 24px pitch |
| Corner mark | 8px L-shaped tick, 1px `--line-strong`, at the corners of framed sections |
| Hatch | 1px lines at 45°, 6px pitch, `--line`; fills empty and disabled areas |

Rules: `fill="none"` unless it is a node; `vector-effect: non-scaling-stroke` on anything that resizes; colours only through `currentColor` or the tokens above; every decorative SVG is `aria-hidden`, every meaningful one has a `<title>` and a text equivalent beside it.

### Icons

One set drawn for Braid: 16px grid, 1.5px stroke, round caps and joins, `currentColor`. It replaces the text glyphs now used as icons (`→`, `¶`, `≈`, `✓`, `×`, `▸`). Needed: land, fork, conflict, overlap, decision, assumption, question, rejected, feedback, check pass, check fail, running, file, folder, copy, external, chevron, close, agent, sandbox, clock.

### Cards on the loom

Anything drawn on the loom (a strand, a landing, a revert, a commit pushed outside Braid, a tie, the start of trunk) opens a card on hover, keyboard focus or tap. The card belongs to the dark surface in both themes: `#161616` fill, 1px `#444444` border, 6px radius, 340px wide, 13/18 text, and the one soft shadow in the product (`0 12px 32px -8px` at 55% black), because it floats over content. Hover opens after 160ms (70ms when moving from one thing to the next) and closes 180ms after the pointer leaves both the thing and the card. It sits 12px below its anchor, or above when there is no room, and never leaves the window. Under 640px it is a sheet pinned to the bottom with a close button. Pointer targets are 16px wide for lines and 26px across for nodes.

### Where graphics go

- **Home hero**: a labelled loom scene on the light canvas beside the headline (seven of twelve columns), replacing the small corner drawing: five attempts at four intents, one predicted conflict, one mergeable overlap, two landings, on a dot grid. Phones get a simpler three-strand version without labels.
- **Home, how it works**: four small diagrams, one per step, each a 160×96 strand drawing in that step's intent colour (a single goal node; parallel strands; a strand landing through a gate; a line of code tied back to its node).
- **Project cards**: a miniature loom per project, 100% × 40px, drawn from that project's real attempts, so each card looks different. Projects without attempts show a bare trunk.
- **Section frames**: home sections and the project page header sit in ruled frames with corner marks, as Greptile and Cloudflare do.
- **Project page**: the loom stays the centrepiece. Each intent row gains a 64×20 strand sparkline of its attempts and their states. Activity items use the icon set.
- **Intent page**: a header strip, 100% × 56px, showing only this intent's strands against trunk with the current attempt emphasised. The reconciliation panel gets a small two-strands-into-one diagram beside its title.
- **Why page**: the blame gutter is a continuous coloured bar per run of lines, labelled once at the top of the run; the selected run is tinted and the reason card wears the same colour along its top edge. Trunk history is drawn as a vertical trunk with nodes instead of a bordered list. Not built: a curve joining the selected lines to the reason card.
- **Empty, loading and error states**: each has its own drawing. Empty: a bare trunk on hatch with the first action beneath. Loading: a strand skeleton in `--line`. Error: a strand that stops at a broken tie.
- **Sign-in dialog**: the mark, plus a two-colour strand rule along the top edge.
- **Favicon and mark**: unchanged.

## Motion

- Home hero only: strands draw on once with `stroke-dashoffset`, 600ms each, staggered 80ms, `cubic-bezier(0.22, 1, 0.36, 1)` *(est.; Mintlify measures 700ms on this curve)*. Removed under reduced motion.
- Hover and state: `background-color, border-color, color` over 120ms `cubic-bezier(0.4, 0, 0.2, 1)` (Vercel measures 100–150ms).
- Press on offset elements: `translate(2px, 2px)` with the shadow reduced to 0, over 80ms *(est.)*.
- The 1.6s pulse on working states is kept.
- Hovering a strand, sparkline or mini loom thickens that strand to 4.5px, as the loom does today.
- No scroll reveals, no other entrance animation, no hover lift (`translateY`) on cards.
- `prefers-reduced-motion: reduce` removes the pulse and the press translate.

## Kept as it is

- Intent colours as identity, the mark, the loom drawing and its legend.
- Routes, the `Link` and `useAction` helpers, all component structure and class names where the style still fits.
- Status vocabulary and colours; diff, blame, session and verification layouts.
- Light and dark themes via `prefers-color-scheme`; the phone layout rules; the `.sr-only` headings.
- Error text beside the control that caused it; the native `<dialog>` for sign-in.

## Changed by this direction

- Shell bar and home hero go from night to light.
- Blue accent removed from buttons, tabs, chips and selection.
- Fonts swapped; heading weights reduced.
- Radii 8–14px become 4–6px; soft shadow and hover lift removed.
- Separate cards become ruled groups on the home list, the intent list and the activity column.
- Night surfaces go from navy to neutral near-black.

## Per-page process

1. Before each page (home, project, intent, Why), find two or three real-product patterns for its main job on Mobbin, 21st.dev or Component Gallery and note which one is followed.
2. After each page, capture 1440px and 390px screenshots in light and dark, compare against this file, then run an Impeccable polish pass.
3. At the end, walk the core journey (create project, state an intent, add an agent, review, resolve a conflict, land, read Why) by mouse and by keyboard alone, covering loading, empty, error, success and disabled states.
