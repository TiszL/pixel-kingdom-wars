# HUD style — Realms Globe + realm maps

> **Copied to `main` 2026-09-27 with D-186** from `globe-realms` `8acdf059` (text unchanged below this note).
> The code paths below are the concept's; the web port lives under `apps/web/src/ui/fantasy/worldv2/hud/` (D-186).

Decision of record: **D-166.2** (2026-09-24). Code: `concepts/globe3d-2026-09-23/src/hud.js`
(`HUD_CSS`, `injectHudCss()`, `loadHudFont()`). Font: `concepts/globe3d-2026-09-23/assets/fonts/`
(VT323 v18 Latin, byte-identical to `apps/web/src/assets/fonts/`, with its `OFL.txt`).

The owner asked for this on 2026-09-24:

> "match UX and HUD UI to current game, but in same style as is now — make like mix of 2 because
> this is very much different style but I love it, but should be consistent with game"

This spec covers the globe page (`index.html` + `src/main.js`) and the realm-map UI
(`src/realm/ui.js`, and `src/realmmap.js` while it lives). It is a style contract. Layout,
positions and behaviour stay with each page's owner.

---

## 1. The mix, in one rule

**The game supplies the material. The globe supplies the light.**

| Comes from the **game** (`apps/web`) | Comes from the **globe** (what the owner loves) |
|---|---|
| VT323 for every control, number and line of text | One big **Silkscreen display name** per surface |
| `--sk-*` palette, verbatim | The **realm accent**: a lit top edge, a glow and an aura |
| Square corners. Charcoal plates with an ink outline and **two gold pips** (`Panel9`) | **Glass over the art**: translucent panels with backdrop blur |
| Forged bevels restated from the HUD chrome masters. A pressed plate **sinks** | Surfaces **glide** in with the globe's easing |
| **Gold = the primary action**, always, exactly as RAID is gold | The accent **lights** things. It never fills a button |
| Square icon + label tools with the game's own icons | Staggered content entrance on first open |
| Recessed wells for readouts and top-bar selectors | Soft glow on selection (labels, rail item, outline) |

Anything that is neither (rounded corners, violet/indigo UI chrome, Pixelify Sans, text-glyph
icons such as `✕ ◀ ▶ ＋ －`) is retired.

## 2. Tokens (`:root`, injected by `injectHudCss()`)

- **Game palette, verbatim** from `apps/web/src/styles.css`:
  `--sk-bg #100e14`, `--sk-surface #1a171e`, `--sk-card #14121a`, `--sk-border #3d3833`,
  `--sk-border-lt #6b6354`, `--sk-text #efe8d6`, `--sk-text-dim #c4bba4`, `--sk-text-faint #9c937f`,
  `--sk-gold #e3ae3c`, `--sk-gold-hi #f4d77b`, `--sk-gold-dp #9c6f1e`, `--sk-danger #c75a2e`,
  `--sk-blood #8f2c2c`, `--sk-success #8cb36e`, `--sk-pine #567a4b`, `--sk-link #bbd0d6`.
- **Forged-chrome ramp**, sampled pixel by pixel from `art/game-v4/ui/hudchrome-hud_{tab,plate,bar}_*.png`:
  `--hud-ink #1a171e` (every outline), `--hud-field #2f2c34`, `--hud-seat #29252c`,
  `--hud-stone #554c40`, `--hud-stone-lo #494741`. The bevels are tokens of stacked 1px inset rows:
  `--hud-bevel-stone`, `-stone-sunk`, `-gold`, `-gold-sunk`, `-well`, `-keep`, and `--hud-rim` (the
  game's gold deck rim, `hudDeckRim()`). No art file is copied, and no bevel takes up layout.
- **Accent**: `--hud-acc` (default gold). Set it inline per realm or island:
  `el.style.setProperty('--hud-acc', REALM_INFO[id].accent)`. `--hud-acc-hi`, `--hud-acc-ink`
  (readable accent text), `--hud-acc-a` (glow, 45%) and `--hud-acc-b` (wash, 24%) are derived with
  `color-mix()` and recompute on the element that sets the accent. This replaces `main.js`'s hand-built
  `--acc-a` / `--acc-b`. It needs Chrome/WebView 111+ or Safari 16.2+.
- **Glass**: `--hud-glass rgba(20,18,26,.84)`, `--hud-glass-hi rgba(29,26,36,.9)`, `--hud-blur 10px`.
- **Sizes**: `--hud-tap 48px` (the game's `CHROME.tapRow`), `--hud-tap-min 44px`, `--hud-gap 8px`,
  `--hud-pad 16px`.
- **Motion**: `--hud-ease cubic-bezier(.16,.84,.24,1)` (the globe panel's), `--hud-ease-out`,
  `--hud-t-slide .5s`, `--hud-t-fade .3s`, `--hud-t-light .25s`.

## 3. Type

There are exactly two faces.

| Role | Face | Size | Where |
|---|---|---|---|
| **Display** (curated place names only) | Silkscreen, caps, `.04em` | **32px** landscape panel, **24px** portrait and short landscape (`.hud-display`, `--sm`) | realm / island / Divine name in the panel, the realm-map title |
| **Place labels** on the globe and map | Silkscreen, caps, 12px, hard 1px ink outline | `.hud-place` | realm, island and landmark names over art |
| **Everything else** | **VT323** | see scale | buttons, filters, body, numbers, player names |

**VT323 scale.** VT323 is drawn on a 1/20-em pixel grid, so it is pixel-exact at **20px and 40px** on
a 1× screen. We rendered it on 2026-09-24 at 1×. At 14–16px it merges **M/N**, **2/Z** and **5/S**, and
at 18px S still smears towards B. At 2× and 3× every size from 16px reads cleanly. The tokens follow
that result:

| Token | 1× screens | ≥ 2× screens (`min-resolution: 2dppx`) | Use |
|---|---|---|---|
| `--hud-fs-cap` | 20 | 16 | caps captions, tags, tool labels, player-name tags |
| `--hud-fs-kick` | 20 | 16 | kicker, section heads, level line |
| `--hud-fs-body` | 20 | 18 | prose, filters, pills |
| `--hud-fs-ui` | 20 | 20 | buttons, `.hud-num`, inputs |
| `--hud-fs-title` | 20 | 24 | `.hud-title` (the game's gold `Phead`) |
| `--hud-fs-num-lg` | 40 | 30 (20 in short landscape) | headline stats |

**Numbers must be unambiguous.** The owner misread Pixelify's 2/8 and 5/S. Every figure is VT323
`.hud-num`, at 20px or more. It is monospaced and tabular, with `en-US` thousands commas (the game's
`fmtN`). Silkscreen never carries digits: its 5/S and 1/I collapse too. Pixelify Sans is retired.
Player and kingdom names are user text, so they are always VT323, never Silkscreen.

## 4. Panel frame — `.hud-panel`

- Square corners. A 2px `--sk-border-lt` border inside a 2px ink outline. **Two 6×6 gold pips** sit in
  the top corners, 6px in, like the game's `Panel9` rivets. They are background layers, so a page must
  not override `background` on a panel.
- **Glass**: a charcoal gradient (84–90%) with `backdrop-filter: blur(10px) saturate(1.15)`.
- **Accent light**: a 2px gradient line (accent → accent-hi → accent) runs along the inside top edge
  with a glow. A soft accent wash sits at the top-left, and an accent aura sits outside the frame.
  The line is inside the frame because panels clip their scroll area.
- Inner parts: `.hud-foot` is the CTA bar with a 2px `--sk-border` top rule. `.hud-grip` is the drag
  handle, a 40×4 square stone bar. `.hud-well` / `.hud-stat` are recessed seats, and `.is-mine` or
  `--gold` gives the KEEP plate. `.hud-row` is a list row. `.hud-note` is a callout with a 4px accent
  bar. `.hud-frame` frames the minimap: 2px stone, ink outline, 4px pips.
- **Bottom sheet** (portrait) is `.hud-panel.hud-panel--sheet`. It has no side or bottom border. Its
  world-facing top edge is the game's **forged gold rim** (the same five rows as the game's nav deck),
  with the accent line just under it and pips at 8px/11px. Peek and drag behaviour stays with the page.

## 5. Buttons — `.hud-btn`

| Variant | Look | Use |
|---|---|---|
| `.hud-btn` (stone) | raised stone plate, `--sk-text-dim` caps label | secondary: Scout, Close sheet, Back |
| `.hud-btn--gold` | the game's gold plate, ink label, soft gold glow | **the** primary action of a surface: Enter map, Attack, Enter base. One per surface. |
| `.hud-btn--ghost` | transparent, 2px `--sk-border` | tertiary: Look closer |
| `--sm` / `--block` | 44px tall / full width | |

- **Pressed**: the plate swaps to its sunk ramp (the gold face drops to `#9c6f1e`), and the label drops
  exactly 1px through a padding swap. The box does not move.
- **Disabled** means refused, not dim, as in the game: `grayscale(1) brightness(.78)` at `.7`
  opacity, with no glow and no press. "Realm map coming soon" is a disabled stone or gold button.
- **Hover** applies only under `(hover:hover)`: `brightness(1.14)`.
- **Focus**: a 2px parchment outline, 1px off the ink edge, visible on stone, gold and glass alike.
- Labels are caps, 1–3 words, with an icon first where the game has one (Scout `hud-i--scout`,
  Attack `hud-i--attack`).
- **Attack is gold, not red**, because RAID is gold in the game. `--sk-danger` is for status tags only.

## 6. Selectors — `.hud-filter`, `.hud-dest`

These are **recessed wells**, the game's top-bar resource chips, because they sit in a top bar over the
world. They are 44px tall, VT323 caps, and square.

- `.hud-filter` is a realm-map filter (All / Mine / Clan / Attackable / Unshielded / Level; the host HUD offers
  All / Mine / Unshielded / Level). **D-191 (2026-09-28):** the chip is "Unshielded" (short "No shield"), never
  "Shielded" — the raider's target — and a kingdom that fails any filter is hidden on the map, not dimmed. When on
  (`aria-pressed="true"` or `.is-on`) it becomes the **KEEP well**: gold rim, gold-hi label, gold glow.
- `.hud-dest` (together with `.hud-filter`) is a globe rail destination. It carries a 6×6 square pip in
  its own accent. When pressed it gets a 1px accent border, an accent glow and a white label.
  **Realms, Seeker, Solana and Divine are identical** (D-166.1). The `isle` / `divine` colour classes
  are retired, and identity lives only in the accent.

## 7. Tools — `.hud-tool`

Square raised stone tools, like the game's BUILD / MAP / RAID dock.

- `.hud-tool` is 64×56 or larger, with the icon above a caps label: `MY BASE` (`locate`),
  `WORLD` (`map`), `NIGHT` (`star`).
- `.hud-tool--icon` is 48×48, icon only, with an `aria-label`: zoom in (`plus`), zoom out (`minus`),
  previous and next base (`prev` / `next`), minimap (`map`).
- A toggle that is on (`aria-pressed="true"`) is sunk with a gold label.
- `.hud-tool--gold` is reserved for a surface's single primary tool.
- Placement follows the game where the page can do it: thumb-side (bottom-right) for the main tools,
  and zoom on the right edge. This is a suggestion; layout belongs to the page owners.
- `.hud-hot` makes a tool **breathe** through the gold ramp in `steps()`, the game's "something is
  waiting" signal. With reduced motion it becomes a static gold ring.

## 8. Readouts

- `.hud-pill` is the game `Pill`: a dark plate with a 2px border, bevel rows and a 1px ink outline for
  art backgrounds. Use it for the hint line, the scale bar, the page title plate and counts.
  `--gold` marks "yours".
- `.hud-tag` is a small square status label: `--gold` (your base), `--blue` (shielded), `--red`
  (in range), `--green` (open).
- `.hud-numeral` is the realm numeral: ink on accent, square, ink outline, accent glow.
- `.hud-level` + `.hud-meter` is the game's `HudLevelRail`: `KEEP LEVEL <b>7</b>/20` over a 6px ink
  track with a gold fill. The fill width comes from `--p`. The loading bar uses the same `.hud-meter`.
- `.hud-stat` is a recessed stat: a `.hud-num--lg` value over a `.hud-cap` label.

## 9. On the map — labels, tags and selection

- `.hud-place` is Silkscreen 12px caps with a hard 8-way 1px ink outline, never a soft blur.
  `.is-sel` adds the accent glow and `.is-dim` sets 60% opacity. Islands and Divine use the same class.
- `.hud-count` is a cluster counter: a square dark seat with VT323 20px digits. `.is-mine` is the
  KEEP well. Width is `max(28, 16 + 8 × digits)` px (VT323's advance is 0.4em, measured).
- `.hud-nametag` is a base tag. It has a square pixel avatar flush left, the name in VT323 and the
  level in gold `<em>`. `.is-mine` has a gold inner ring. `.is-sel` is 36px tall with a 34px avatar,
  a parchment ring and an accent glow.
- **One selection language** (D-166.1). Every selectable place on the globe (realm, Seeker, Solana,
  Divine) is marked the same way. The globe shader draws it, not this CSS:
  1. a crisp outline traced along its **true coastline** in the accent;
  2. a soft glow and rim;
  3. a travelling shimmer;
  4. a draw-on entrance.

  Its label goes `.is-sel`, its rail item goes pressed, and the panel takes the same `--hud-acc`.
  The elliptical ring is retired everywhere. On a realm map the selected base takes `.hud-nametag.is-sel`
  and the engine's claim outline (gold for yours).

## 10. Icons — `.hud-i`

The icons are the **game's own masters** (`art/game-v4/ui/legacy-ui_icon_*.png`, read-only), inlined by
the esbuild png→dataurl loader that both builds already configure. The set is `plus`, `minus` (the plus
master cropped to its bar), `close`, `locate`, `map`, `attack`, `scout`, `shield`, `trophy`, `star`,
`info`, and `prev` / `next`. The chevrons are generated pixel grids, because the game has no master for
them. Icons render at 24px (1×) or 48px (`--2x`) only. Never use a fractional scale, and never use a
text glyph as an icon. `.hud-x` is the close button: a 44×44 transparent square showing the game's
close icon.

## 11. Motion

**Light eases. Pixels step.**

- **Surfaces** (panel, sheet, cards) slide and fade on `--hud-ease` over `--hud-t-slide`. This is the
  globe's motion, and the owner likes it. Content rises in once on first open (`.hud-enter` children,
  `--i` stagger). Coming back from a realm map shows the content already in place, with no stagger (the
  existing `.ready` rule).
- **Light** (glows, accent line, label glow, hint `.hud-pulse` opacity, shimmer) may ease smoothly.
- **Pixels** (text, icons, plates) only translate by whole pixels. A press is 1px. The "hot" breathing
  cycles the gold ramp in `steps()`. Never `transform: scale()` text or pixel art, and never
  interpolate a plate's position.
- `prefers-reduced-motion: reduce` turns off slides, stagger, pulse, shimmer and breathing. Surfaces
  fade in 0.2s, and hot becomes a static ring.

## 12. Do / Don't

| Do | Don't |
|---|---|
| Square corners on every plate, panel, tag and avatar | `border-radius` anywhere in HUD chrome |
| Gold for the one primary action per surface | Accent-, red- or violet-filled buttons |
| Accent as light: edge line, glow, aura, pip, label glow | Accent as a fill or as a whole border colour on panels |
| VT323 ≥ 20px for any figure a player must read exactly | Silkscreen or Pixelify digits; VT323 < 20px on 1× screens |
| Silkscreen only for curated place names | Silkscreen for buttons, body or player names |
| Game icons at 24 / 48px | Text glyphs (`✕ ◀ ▶ ＋ －`) or icons at 16/20px |
| Backdrop blur on at most one or two large surfaces | Blur on labels, tags or counters (dozens per frame over WebGL) |
| One selection language for realms and islands | Special rings, colours or classes for islands |
| Hard 1px ink outlines on text over art | Soft blurry text shadows as the only contrast |

## 13. Before → after

### Globe page (`index.html`, `src/main.js`)

| Element | Before | After |
|---|---|---|
| `header` scrim | indigo-black gradient | `.hud-scrim` (the same gradient in `--sk-bg`) |
| `.title` | Silkscreen 13 + Pixelify 12 | `.hud-pill`: VT323 gold-hi caps + `.hud-cap` subtitle |
| `#rail button` | 8px-radius indigo glass, Pixelify 12, round glowing dot | `.hud-filter.hud-dest`: square recessed well, VT323 caps, 6px square accent pip |
| `#rail .isle` / `.divine` | mint / cream border and text | retired: same as realms (D-166.1) |
| `#rail button.sel` | accent border + inner ring + glow on violet | `aria-pressed="true"`: 1px accent border, glow, white label |
| `#tools button` (＋ － My base World Night) | rounded text buttons | `.hud-tool--icon` plus/minus; `.hud-tool` MY BASE (locate), WORLD (map), NIGHT (star) |
| `#tools button.on` | violet border | `aria-pressed`: sunk stone, gold label |
| `#panel` frame | 18px radius, indigo glass, violet hairline | `.hud-panel`: square, stone border, ink outline, gold pips, accent edge and aura, glass kept |
| `#panel::before` accent line | 2px gradient on the outer edge | kept, inside the frame (`.hud-panel::before`) |
| `.p-grab` radial wash | accent at 34% | built into `.hud-panel`, accent at 24% |
| `.p-kick` | Pixelify 11 caps | `.hud-kicker` |
| `.p-num` | Silkscreen 10 on accent, 3px radius | `.hud-numeral` |
| `.p-name` | Silkscreen 26, glow | `.hud-display` Silkscreen 32/24, ink drop + accent glow |
| `.p-tag` | Pixelify 14 accent | `.hud-epithet` |
| `.p-close` | 12px-radius glass, `✕` glyph | `.hud-x` (game close icon) |
| `.p-lore` / `.p-land` | Pixelify 14 / 12 | `.hud-body` / `.hud-cap` |
| `.p-stats div` | 10px-radius translucent boxes, Silkscreen 17 digits | `.hud-stat` wells, `.hud-num--lg`; "Your bases" `.is-mine` (KEEP well) |
| `.p-sec` | Silkscreen 11 | `.hud-sec` (VT323 caps + rule) |
| `.p-top li` | 10px-radius rows | `.hud-row`; yours `.is-mine` (gold-dp border) |
| `.p-top img` | round avatar | `.hud-avatar` (square) |
| `.p-top .tr svg` | inline SVG trophy | `.hud-i--trophy` + `.hud-num` |
| `.p-note` | rounded, accent left bar | `.hud-note` |
| `.p-cta .primary` | accent fill, 12px radius | `.hud-btn--gold` (always gold) |
| `.p-cta button` / `:disabled` | glass / dim text | `.hud-btn` / refused (grayscale) |
| `.p-grip` | 42×5 rounded white | `.hud-grip` |
| portrait sheet | 20px top radius | `.hud-panel--sheet`: square, forged gold rim, accent line |
| `.hint` | 999px-radius pill | `.hud-pill.hud-pulse` |
| `#loading` | Silkscreen, violet→mint bar | VT323 gold-hi caps + `.hud-meter` |
| `.lbl.realm` (+ `.isle`, `.divine`) | Silkscreen 12, soft shadow, mint/cream for islands | `.hud-place` for all, hard ink outline; `.is-sel` accent glow; `.is-dim` |
| island selection ring (shader) | ellipse | coastline outline like realms (D-166.1, globe shader) |

### Realm map (`src/realm/ui.js`, `rmx-*`)

| Element | Before | After |
|---|---|---|
| `.rmx-btn` / `.on` | 12px-radius violet glass, Pixelify | `.hud-btn` or `.hud-tool` / `aria-pressed` sunk |
| exit `◀ Globe` | text glyph | `.hud-btn` + `.hud-i--prev` + `GLOBE` |
| `.rmx-title` | rounded plate, Silkscreen 15 | `.hud-panel` plate: `.hud-display` (16px here, one line, ellipsis) + `.hud-cap` |
| `.rmx-search input` / icon | rounded / drawn SVG | `.hud-input` (20px, so iOS does not zoom) / `.hud-i--scout` |
| `.rmx-results` | rounded list | `.hud-panel` + `.hud-row` |
| `.rmx-chip` / `.on` | 22px-radius pills / brown-gold | `.hud-filter` / KEEP-gold well |
| `.rmx-lvl` slider | round gold thumb | `.hud-panel` + `.hud-range` (square gold-plate thumb) |
| `.rmx-tools` ＋ － My base | text | `.hud-tool--icon` plus/minus, `.hud-tool` MY BASE |
| `.rmx-mini` / `.rmx-mini-t` | 10px radius / text toggle | `.hud-frame` / `.hud-tool--icon` + `.hud-i--map` |
| `.rmx-nav` ◀ ▶ | text glyphs | `.hud-tool--icon` + `.hud-i--prev` / `--next` |
| `.rmx-card` | 16px-radius panel | `.hud-panel` (`--sheet` in portrait) |
| `.rmx-card .av` / `.nm` | round avatar / Pixelify 18 | `.hud-avatar--lg` / VT323 24 (2×) or 20 (1×) gold-hi |
| "Keep level 7" | text line | `.hud-level` + `.hud-meter` |
| `.rmx-chip2.gold/.blue/.red` | 9px-radius chips | `.hud-tag--gold/--blue/--red` |
| `.facts` dl | Pixelify 12.5 | `dt` `.hud-cap`, `dd` body, figures `.hud-num` |
| Attack (`.primary`, red) / Enter base (`.gold`) | red / brown-gold fill | `.hud-btn--gold` + icon, because RAID is gold |
| Scout / Look closer | glass | `.hud-btn` + `.hud-i--scout` / `.hud-btn--ghost` |
| `.rmx-card .x` | `✕` glyph | `.hud-x` |
| `.rmx-l.cl` counters | round violet | `.hud-count` (`.is-mine`) |
| `.rmx-l.tag` | rounded tag, round avatar | `.hud-nametag` (`.is-mine`, `.is-sel`) |
| `.rmx-scale` | rounded | `.hud-pill` |
| `#diag`, `.rmx-stats` | debug | unchanged |

## 14. Adoption

1. `import { injectHudCss, loadHudFont } from './hud.js'` (globe) or `'../hud.js'` (realm UI), then call
   both at startup. `injectHudCss()` is idempotent, so calling it on both surfaces is safe.
   `loadHudFont()` never blocks first paint: it uses the `FontFace` API with `display: swap`, and has no
   `<link>` and no `@import`. It resolves to `true` once the font is ready, and callers that cache text
   metrics re-measure then (`main.js` `lblSize`, `ui.js` counter widths). The font URL resolves
   against `document.baseURI` (the `realmmap.js` convention). The single-file `dist/globe3d.html` share
   therefore falls back to monospace unless it passes an `href`.
2. **Delete the legacy rules, don't layer over them.** These rules outrank `.hud-*` by specificity:
   `index.html` `#rail button,#tools button,.acts button{…}` (l. 25), the other `#rail` / `#tools`
   rules, `#realmUI button{…}` (l. 123) and the `.p-*` / `.rm-*` visual rules. The same goes for
   `ui.js`: its `STYLE` is scoped under the root id, so ID + class beats `.hud-*`. Keep only
   layout rules (position, size, gap).
3. Drop Pixelify Sans from the Google Fonts URL in `main.js` (l. 12). Keep Silkscreen, loaded async
   as it is now.
4. `ui.js` `counterW` changes to `n => Math.max(28, 16 + 8 * String(n).length)` (VT323 20px).
5. Remove `openPanel`'s hand-built `--acc` / `--acc-a` / `--acc-b`. Set `--hud-acc` instead.
6. Publishing: add `assets/fonts/VT323-latin-v18.woff2` and `assets/fonts/OFL.txt` to the files the
   review artifact carries.
7. Size: `HUD_CSS` is about 34 KB raw. Most of it is the ten inlined game icons (6 KB of PNG) and the
   bevel tokens.
8. The class names avoid the game's own `hud-*` names (`hud-tab*`, `hud-chip*`, `hud-face`,
   `hud-badge`, `hud-hot`, `hud-strip`, `hud-overflow`, `hud-queue-card`, `hud-kit`, `hud-chrome`).
   This sheet cannot restyle game chrome if the globe later moves into `apps/web`. There, the
   `--sk-*` tokens and the VT323 `@font-face` already exist and must not be redeclared.

## 15. How it was checked (2026-09-24)

A throwaway specimen (scratchpad, not committed) injected `HUD_CSS` over real globe captures and a
Crownlands in-game capture. It was rendered at 1280×800, 390×844 and 844×390 at 1×, and at 390×844
at 3×, and every capture was read. Results:

- no horizontal overflow at any size;
- VT323 and Silkscreen both loaded;
- the accent edge is visible on both the side panel and the sheet;
- pressed, disabled and toggled states render as specified;
- the 1× type floor was set from the M/N, 2/Z, 5/S and S/B failures described in §3.

This was not checked: the real pages have not adopted the sheet yet, so no capture of
`index.html` or `ui.js` wearing `hud-*` exists. Adoption is the page owners' step, and each owner
re-screenshots its own page.
