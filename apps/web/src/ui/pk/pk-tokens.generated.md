# pk-tokens.generated.css v2 repository adaptation: rule, mappings and integration obligations

Version 2 adapted for the repository under review 419baf51 R1–R5, e9c1eb73 W8/W10 and 90845456 F5. The immutable review ledger is retained; explicit lead bindings supersede its Seal material and entrance proposals. Generation is not source integration, test execution or runtime acceptance.

| Input | sha256 |
|---|---|
| TOKENS.json ("PKW Bright Command, forged (final, colour pass 2)", 2026-10-02) | `eb7b454cc66453474d4b1f95b557ce20c5fab3b33d3a6abe6455b93e9f84e2bc` |
| ALIAS-PROPOSALS.json (MS-F2a, 46 names, status REVIEW_PROPOSAL_ONLY_NOT_SOURCE_OR_ACCEPTANCE) | `ea3a266a41b4a6642625b4ae645a128788cdacb387b106e1108936c3446cf2bf` |

Generator: `apps/web/scripts/pk-tokens.mjs`. Inputs: `apps/web/src/ui/pk/TOKENS.source.json` and `ALIAS-PROPOSALS.source.json`. Generate into a separate metadata directory, then place only production CSS and this mapping document under `src/ui/pk/`; keep QA CSS outside production source.

    node apps/web/scripts/pk-tokens.mjs <TOKENS.source.json> <ALIAS-PROPOSALS.source.json> <metadata-output-directory>

It writes `pk-tokens.generated.css`, `pk-tokens.qa.css` and this file. It runs the checks in §8 first and writes nothing if one fails. Output carries no timestamp, so a re-run on the same inputs is byte-identical.

## 0. Changes from v1

v1 is the reviewed object: `pk-tokens.generated.css` sha256 `fb7b9e6f…`, `.md` `26686394…`.

- **F04, six directly read names missing.** Now declared: `--pk-t-disclose` = 160ms (`motion.durationMs.toastIn`), and `--pk-aura`, `--pk-dialog-max`, `--pk-lift`, `--pk-lift-sm`, `--pk-light-edge` with their M48 values (no design source, §6a).
- **Legacy compatibility.** All 46 legacy names are declared exactly once, including all 18 MOTION_MS mirrors. Toast hold is 4000ms; snapHint is 120ms; glass-flat and beat retain their legacy fallback. review 419baf51 R4 binds Seal entrance to 160ms from DESIGN-SYSTEM.md:521; review 419baf51 R4 / 90845456 F5, superseding the ledger's relayed 180ms proposal. Arming remains a separate 450ms guard.
- **F06, two z vocabularies.** The `--pk-z-*` ordinals 1–9 and the stale "P0 wins" comment are gone. The bridge declares the 14 existing `--z-*` names (§5) with their M48 values, except `--z-consent` 1500 → 3100 and `--z-celebrate` 1700 → 3200: toast (3000) < Seal < celebration < worker error (3500).
- **F07, reduced motion.** One recipe, two triggers: `@media (prefers-reduced-motion: reduce)` and `html[data-motion="reduce"]`, which motion.ts `useMotion()` sets to the OS preference OR the in-game toggle. v1's `--pk-stagger: 0ms` override is removed. It re-declared a legacy name, and tokens.test.ts `customProperties()` keeps the last declaration, so the MOTION_MS.stagger pin would have read 0ms. Legacy names are never re-declared; see §7 item 2 for the one reduced-mode consumer this affects.
- **F08, `--pk-seal`.** `--pk-seal` is the Seal's dialog material again (pk.css:38 `background`), with the design value parchment `#F4E3BC` (ca622d60 §2; DESIGN-SYSTEM.md:422). The gold action is the new `--pk-seal-primary` = `#E3AE3C` (`color.gold.hex`). **Read §7 item 1 before applying.**
- **QA selectors.** The `[data-pk-qa]` block moved to `pk-tokens.qa.css`, which is dev-only (REVIEW "remaining seams"; ca622d60 §2).
- **Generator.** Moved beside the artifacts. It now reads ALIAS-PROPOSALS.json, writes all three files and checks itself.
- **Repository amendments:** Seal visual in/out durations, five literal VT323 display steps (90845456 F5), and root viewport attribute selectors (e9c1eb73 W10). No layout media query remains; the host must classify dimensions before mounting the kit.

## 1. Generator rule

1. **Prefix and case.** Every design property is `--pk-<name>`, and camelCase keys become kebab-case (`borderLt` → `border-lt`). The only other names are the 14 `--z-*` layers (§5).
2. **Units.** 1 dp = 1 sp = 1 CSS px. Numbers become `Npx`, except 0, which stays `0`. Durations become `Nms`. Colours are copied verbatim.
3. **Colours.** `color.<k>.hex` → `--pk-<k>`, and sub-keys `hi`/`lo`/`mid`/`seam` → `--pk-<k>-<sub>`. Renames: `muted`/`faint` → `text-*`, `parchment` → `parch`, `textOnParch` → `ink-text`/`ink-text-2`, `shortPill` → `short-bg`/`short-text`, `selectedTint` → `selected`. `resource.<k>` → `--pk-res-<k>`. `scrim.<k>` → `--pk-scrim-{half,tall,full,shelf,seal}`. `budgetOverlay.*` → `--pk-qa-*`, in `pk-tokens.qa.css` only. `use` strings are not emitted; the verb ramps carry the first clause as a comment.
4. **Type.** `type.scale[i].token` → `--pk-type-<token>` remains unchanged. Display uses VT323 until a DECISIONS entry admits Press Start 2P. The five `--pk-k-type-*` fallback tokens are literal 30/26/24/22/20px, sourced to the delivered kit citing Android PkwTokens.Type (90845456 F5). Remove the five equivalent calc declarations from the repository copy of kitBase.css so the generator owns these values. Other kit constants remain sourced `--pk-k-*` declarations at the top of kitBase.css (W8); no TOKENS.json additions.
5. **Spacing.** `space.unit` → `--pk-unit`. Each `space.scale` value n → `--pk-s<n>`. `screenGutter` → `--pk-gutter`, `sheetGutter` → `--pk-sheet-gutter`. `gridPhone` is prose and is not emitted.
6. **Shape.** `radius` → `--pk-radius: 0`. `outline.<k>` → `--pk-outline-<k>`, `lip.<k>` → `--pk-lip-<k>`, `highlightBand` → `--pk-hi-band`. `stepS` → `--pk-step-s-cut` plus the size-independent polygon `--pk-clip-s`. `stepM` → `--pk-step-m-cut` only. `elevation.*` are kit classes, not variables.
7. **Sizes.** `size.<k>` → `--pk-size-<k>`. The `topBar.*` children drop the segment; the `deck.*` children keep `deck-`. A two-value array with different values → `-w`/`-h`; a square pair or a single value → one name. Nested objects append the sub-key. `bidStepper` → `bid`. `minTap` → `--pk-min-tap`.
8. **Motion.** `easing.<k>` → `--pk-ease-<k>`; `durationMs.<k>` → `--pk-dur-<k>`. Added design values: half-sheet in/out, drawer-row stagger and crossfade. Seal in/out use the exact `motion.durationMs.sealIn`/`sealOut` keys when present; the pinned input lacks them, so DESIGN-SYSTEM.md:521 supplies 160/120ms. No unrelated duration is used as a surrogate.
9. **Reduced motion.** One override list, written twice with identical bodies: inside `@media (prefers-reduced-motion: reduce) { :root {…} }`, which applies before JS runs, and as `html[data-motion="reduce"] {…}`, the attribute motion.ts keeps equal to OS OR in-game toggle (specificity 0,1,1 beats `:root`). Loops, fly-ins, staggers and the shake → `0ms`. Slides and pops → `var(--pk-dur-crossfade)` (120 ms). Holds and guards (toastHold, bannerHold, sealArm, tapThroughLock, celebrate) are untouched. Only `--pk-dur-*` names appear there.
10. **Legacy names.** Each of the 46 ALIAS-PROPOSALS names is declared exactly once with a literal value. Mapped TOKENS values must agree with the ledger; unsourced names retain their documented fallback. Two lead bindings supersede ledger proposals: `--pk-seal` is parchment (ca622d60 §2), and `--pk-t-seal` is the sourced Seal entrance (419baf51 R4). The overlapping canonical `--pk-scrim-seal` is declared only in the legacy block after value agreement is checked.
11. **Added name.** `--pk-seal-primary` ← `color.gold.hex` (ca622d60 §2).
12. **Z-order.** The 14 `--z-*` names of M48 tokens.css:55-58, with the §5 values. There is no other z vocabulary.
13. **Viewport classes.** The five exact `html[data-pk-vp="<class>"]` selectors mirror host classification into custom properties. Default is phone-portrait until the host stamps a class. `html[data-pk-vp-height="short"]` sets the sheet-only short sub-class independently of class. The host chooses short only for landscape height ≤359px. No CSS layout media query is emitted.
14. **Not emitted.** `budget.*` and `pixelArt.*` go to TS (MAP §2.6). `sea`, `numeralXL` and `icon24Celebration` are excluded (LANE §5 amendment 2). `--pk-clip-m` needs KIT `CornerProfiles.M`.

## 2. Key → name table (TOKENS.json and design docs → CSS)

| Source | Name | Value |
|---|---|---|
| color.ink.hex | `--pk-ink` | `#140F17` |
| color.bg.hex | `--pk-bg` | `#100E14` |
| color.surface.hex | `--pk-surface` | `#1A171E` |
| color.card.hex | `--pk-card` | `#14121A` |
| color.charcoal.hex | `--pk-charcoal` | `#29262E` |
| color.veil.hex | `--pk-veil` | `#221D27` |
| color.veilHi.hex | `--pk-veil-hi` | `#4A4152` |
| color.border.hex | `--pk-border` | `#3D3833` |
| color.borderLt.hex | `--pk-border-lt` | `#6B6354` |
| color.text.hex | `--pk-text` | `#EFE8D6` |
| color.muted.hex | `--pk-text-muted` | `#C4BBA4` |
| color.faint.hex | `--pk-text-faint` | `#9C937F` |
| color.gold.hex | `--pk-gold` | `#E3AE3C` |
| color.gold.hi | `--pk-gold-hi` | `#FFE38A` |
| color.gold.lo | `--pk-gold-lo` | `#8F5A12` |
| color.gold.mid | `--pk-gold-mid` | `#D3962A` |
| color.green.hex | `--pk-green` | `#45B23E` |
| color.green.hi | `--pk-green-hi` | `#A6EA7E` |
| color.green.lo | `--pk-green-lo` | `#22701E` |
| color.green.mid | `--pk-green-mid` | `#3A9E35` |
| color.blue.hex | `--pk-blue` | `#3A74DA` |
| color.blue.hi | `--pk-blue-hi` | `#95C3FF` |
| color.blue.lo | `--pk-blue-lo` | `#1A3F8A` |
| color.blue.mid | `--pk-blue-mid` | `#2E62C4` |
| color.red.hex | `--pk-red` | `#D23A3A` |
| color.red.hi | `--pk-red-hi` | `#FF8C7A` |
| color.red.lo | `--pk-red-lo` | `#771821` |
| color.red.mid | `--pk-red-mid` | `#BA2E32` |
| color.stone.hex | `--pk-stone` | `#7E7266` |
| color.stone.hi | `--pk-stone-hi` | `#B3A797` |
| color.stone.lo | `--pk-stone-lo` | `#463D34` |
| color.stone.mid | `--pk-stone-mid` | `#716659` |
| color.off.hex | `--pk-off` | `#A3A09A` |
| color.off.hi | `--pk-off-hi` | `#C6C3BC` |
| color.off.lo | `--pk-off-lo` | `#6E6B66` |
| color.moss.hex | `--pk-moss` | `#5D8A3C` |
| color.moss.hi | `--pk-moss-hi` | `#9CC47A` |
| color.moss.lo | `--pk-moss-lo` | `#34501F` |
| color.parchment.hex | `--pk-parch` | `#F4E3BC` |
| color.parchment.hi | `--pk-parch-hi` | `#FFF8E6` |
| color.parchment.lo | `--pk-parch-lo` | `#C9A86A` |
| color.cream.hex | `--pk-cream` | `#FCF3DC` |
| color.cream.lo | `--pk-cream-lo` | `#E8D3A0` |
| color.wood.hex | `--pk-wood` | `#7A4526` |
| color.wood.hi | `--pk-wood-hi` | `#A5663A` |
| color.wood.lo | `--pk-wood-lo` | `#431F0E` |
| color.wood.seam | `--pk-wood-seam` | `#6A3B1F` |
| color.textOnParch.hex | `--pk-ink-text` | `#3B2614` |
| color.textOnParch.secondary | `--pk-ink-text-2` | `#6E5034` |
| color.danger.hex — reason text on dark | `--pk-danger` | `#EE7A50` |
| color.blood.hex — error toast body | `--pk-blood` | `#8F2C2C` |
| color.shortPill.hex | `--pk-short-bg` | `#FFD9CC` |
| color.shortPill.text | `--pk-short-text` | `#A3261A` |
| color.selectedTint.hex | `--pk-selected` | `#FFF3C8` |
| color.resource.shards | `--pk-res-shards` | `#E8A530` |
| color.resource.gems | `--pk-res-gems` | `#2FB879` |
| color.resource.keep | `--pk-res-keep` | `#E3AE3C` |
| color.resource.skr | `--pk-res-skr` | `#C9F29A` |
| color.resource.divine | `--pk-res-divine` | `#ECE1F6` |
| color.scrim.sheetHalf | `--pk-scrim-half` | `rgba(14,9,20,0)` |
| color.scrim.sheetTall | `--pk-scrim-tall` | `rgba(14,9,20,0.40)` |
| color.scrim.fullCard | `--pk-scrim-full` | `rgba(14,9,20,0.60)` |
| color.scrim.commandShelf | `--pk-scrim-shelf` | `rgba(16,14,20,0.36)` |
| color.scrim.seal | `--pk-scrim-seal` (declared in the legacy block) | `rgba(14,9,20,0.55)` |
| stand-in; TOKENS type.families.display.name = "Press Start 2P" | `--pk-font-display` | `"VT323", monospace` |
| LANE-WEB-UI-REHAUL.md §5 amendment 3 | `--pk-font-display-standin-size` | `22px` |
| type.families.body.name | `--pk-font-body` | `"VT323", monospace` |
| Android PkwTokens.Type; kit/p0/kitBase.css:29-37; review 90845456 F5 | `--pk-k-type-numeral-l` | `30px` |
| Android PkwTokens.Type; kit/p0/kitBase.css:29-37; review 90845456 F5 | `--pk-k-type-primary` | `26px` |
| Android PkwTokens.Type; kit/p0/kitBase.css:29-37; review 90845456 F5 | `--pk-k-type-title` | `24px` |
| Android PkwTokens.Type; kit/p0/kitBase.css:29-37; review 90845456 F5 | `--pk-k-type-label` | `22px` |
| Android PkwTokens.Type; kit/p0/kitBase.css:29-37; review 90845456 F5 | `--pk-k-type-caption` | `20px` |
| type.scale[numeralL] display | `--pk-type-numeral-l` | `16px` |
| type.scale[primary] display | `--pk-type-primary` | `14px` |
| type.scale[title] display | `--pk-type-title` | `13px` |
| type.scale[label] display | `--pk-type-label` | `12px` |
| type.scale[caption] display — FLOOR | `--pk-type-caption` | `11px` |
| type.scale[lead] body | `--pk-type-lead` | `24px` |
| type.scale[body] body | `--pk-type-body` | `20px` |
| type.scale[small] body — FLOOR | `--pk-type-small` | `18px` |
| type.scale outline "1 dp ink" | `--pk-text-outline-1` | `1px` |
| type.scale outline "2 dp ink" | `--pk-text-outline-2` | `2px` |
| space.unit | `--pk-unit` | `2px` |
| space.scale | `--pk-s2` | `2px` |
| space.scale | `--pk-s4` | `4px` |
| space.scale | `--pk-s6` | `6px` |
| space.scale | `--pk-s8` | `8px` |
| space.scale | `--pk-s12` | `12px` |
| space.scale | `--pk-s16` | `16px` |
| space.scale | `--pk-s24` | `24px` |
| space.scale | `--pk-s32` | `32px` |
| space.screenGutter | `--pk-gutter` | `8px` |
| space.sheetGutter | `--pk-sheet-gutter` | `8px` |
| shape.radius — the only radius, ever | `--pk-radius` | `0` |
| shape.stepS "2 steps of 2 dp (corner cut 4 dp)" | `--pk-step-s-cut` | `4px` |
| shape.stepM "3 steps (corner cut 8 dp)" | `--pk-step-m-cut` | `8px` |
| derived from shape.stepS | `--pk-clip-s` | `polygon(0 4px, 2px 4px, 2px 2px, 4px 2px, 4px 0, calc(100% - 4px) 0, calc(100% - 4px) 2px, calc(100% - 2px) 2px, calc(100% - 2px) 4px, 100% 4px, 100% calc(100% - 4px), calc(100% - 2px) calc(100% - 4px), calc(100% - 2px) calc(100% - 2px), calc(100% - 4px) calc(100% - 2px), calc(100% - 4px) 100%, 4px 100%, 4px calc(100% - 2px), 2px calc(100% - 2px), 2px calc(100% - 4px), 0 calc(100% - 4px))` |
| shape.outline.chip | `--pk-outline-chip` | `2px` |
| shape.outline.button | `--pk-outline-button` | `3px` |
| shape.outline.plate | `--pk-outline-plate` | `3px` |
| shape.outline.card | `--pk-outline-card` | `2px` |
| shape.lip.button | `--pk-lip-button` | `6px` |
| shape.lip.buttonPressed | `--pk-lip-button-pressed` | `3px` |
| shape.lip.plate | `--pk-lip-plate` | `4px` |
| shape.highlightBand | `--pk-hi-band` | `3px` |
| size.minTap | `--pk-min-tap` | `48px` |
| size.topBar.levelBadge | `--pk-size-level-badge` | `40px` |
| size.topBar.statusChip | `--pk-size-status-chip-w` | `238px` |
| size.topBar.statusChip | `--pk-size-status-chip-h` | `30px` |
| size.topBar.resourceRow | `--pk-size-resource-row-w` | `108px` |
| size.topBar.resourceRow | `--pk-size-resource-row-h` | `26px` |
| size.topBar.resourceGap | `--pk-size-resource-gap` | `2px` |
| size.topBar.drawerRow | `--pk-size-drawer-row-w` | `108px` |
| size.topBar.drawerRow | `--pk-size-drawer-row-h` | `26px` |
| size.deck.attack | `--pk-size-deck-attack-w` | `80px` |
| size.deck.attack | `--pk-size-deck-attack-h` | `72px` |
| size.deck.army | `--pk-size-deck-army` | `52px` |
| size.deck.map | `--pk-size-deck-map` | `52px` |
| size.deck.build | `--pk-size-deck-build` | `72px` |
| size.deck.bottomInset | `--pk-size-deck-bottom-inset` | `14px` |
| size.edgeButton | `--pk-size-edge-button` | `48px` |
| size.edgeTab | `--pk-size-edge-tab-w` | `44px` |
| size.edgeTab | `--pk-size-edge-tab-h` | `48px` |
| size.contextChip | `--pk-size-context-chip-w` | `108px` |
| size.contextChip | `--pk-size-context-chip-h` | `48px` |
| size.command | `--pk-size-command` | `68px` |
| size.commandPrimary | `--pk-size-command-primary-w` | `120px` |
| size.commandPrimary | `--pk-size-command-primary-h` | `92px` |
| size.costPill.h | `--pk-size-cost-pill-h` | `26px` |
| size.costPill.icon | `--pk-size-cost-pill-icon` | `24px` |
| size.namePlate.h | `--pk-size-name-plate-h` | `58px` |
| size.namePlate.minW | `--pk-size-name-plate-min-w` | `160px` |
| size.namePlate.maxW | `--pk-size-name-plate-max-w` | `280px` |
| size.namePlate.stem | `--pk-size-name-plate-stem-w` | `4px` |
| size.namePlate.stem | `--pk-size-name-plate-stem-h` | `20px` |
| size.badge.h | `--pk-size-badge-h` | `24px` |
| size.badge.minW | `--pk-size-badge-min-w` | `24px` |
| size.worldBubble | `--pk-size-world-bubble` | `48px` |
| size.timerPlate | `--pk-size-timer-plate-w` | `114px` |
| size.timerPlate | `--pk-size-timer-plate-h` | `34px` |
| size.sheetPrimary.h | `--pk-size-sheet-primary-h` | `60px` |
| size.secondary.h | `--pk-size-secondary-h` | `52px` |
| size.tab.h | `--pk-size-tab-h` | `48px` |
| size.troopCard | `--pk-size-troop-card-w` | `89px` |
| size.troopCard | `--pk-size-troop-card-h` | `128px` |
| size.itemTile | `--pk-size-item-tile-w` | `72px` |
| size.itemTile | `--pk-size-item-tile-h` | `80px` |
| size.drawerTile | `--pk-size-drawer-tile-w` | `48px` |
| size.drawerTile | `--pk-size-drawer-tile-h` | `56px` |
| size.ingredientRow.h | `--pk-size-ingredient-row-h` | `52px` |
| size.bidStepper.minus | `--pk-size-bid-minus-w` | `48px` |
| size.bidStepper.minus | `--pk-size-bid-minus-h` | `60px` |
| size.bidStepper.value | `--pk-size-bid-value-w` | `76px` |
| size.bidStepper.value | `--pk-size-bid-value-h` | `60px` |
| size.bidStepper.plus | `--pk-size-bid-plus-w` | `48px` |
| size.bidStepper.plus | `--pk-size-bid-plus-h` | `60px` |
| size.toast.h | `--pk-size-toast-h` | `58px` |
| size.banner.h | `--pk-size-banner-h` | `44px` |
| size.troopCardMinus | `--pk-size-troop-card-minus-w` | `89px` |
| size.troopCardMinus | `--pk-size-troop-card-minus-h` | `48px` |
| DESIGN-SYSTEM.md:330 | `--pk-size-tall-sheet-top` | `104px` |
| DESIGN-SYSTEM.md:335 | `--pk-size-sheet-header-h` | `136px` |
| MAP-DESIGN-FOR-WEB.md §2.5 ← goldforge/SPEC:68 | `--pk-size-goldforge-hero-h` | `204px` |
| MAP-DESIGN-FOR-WEB.md §2.5 ← account/SPEC:14 | `--pk-size-tab-stacked-h` | `56px` |
| MAP-DESIGN-FOR-WEB.md §2.5 ← buildings/SPEC:65 | `--pk-size-command-pitch` | `88px` |
| motion.easing.out | `--pk-ease-out` | `cubic-bezier(0.2,0,0,1)` |
| motion.easing.in | `--pk-ease-in` | `cubic-bezier(0.4,0,1,1)` |
| motion.easing.pop | `--pk-ease-pop` | `cubic-bezier(0.34,1.56,0.64,1)` |
| motion.easing.linear | `--pk-ease-linear` | `linear` |
| motion.durationMs.press | `--pk-dur-press` | `60ms` |
| motion.durationMs.release | `--pk-dur-release` | `90ms` |
| motion.durationMs.select | `--pk-dur-select` | `140ms` |
| motion.durationMs.plateIn | `--pk-dur-plate-in` | `160ms` |
| motion.durationMs.commandStagger | `--pk-dur-command-stagger` | `30ms` |
| motion.durationMs.deckSwap | `--pk-dur-deck-swap` | `160ms` |
| motion.durationMs.sheetIn | `--pk-dur-sheet-in` | `220ms` |
| motion.durationMs.sheetOut | `--pk-dur-sheet-out` | `160ms` |
| motion.durationMs.drawerIn | `--pk-dur-drawer-in` | `200ms` |
| motion.durationMs.drawerOut | `--pk-dur-drawer-out` | `140ms` |
| motion.durationMs.tabSwitch | `--pk-dur-tab-switch` | `120ms` |
| motion.durationMs.badgePop | `--pk-dur-badge-pop` | `180ms` |
| motion.durationMs.toastIn | `--pk-dur-toast-in` | `160ms` |
| motion.durationMs.toastHold | `--pk-dur-toast-hold` | `4000ms` |
| motion.durationMs.bannerHold | `--pk-dur-banner-hold` | `4000ms` |
| motion.durationMs.sealArm | `--pk-dur-seal-arm` | `450ms` |
| motion.durationMs.tapThroughLock | `--pk-dur-tap-through-lock` | `300ms` |
| motion.durationMs.countUp | `--pk-dur-count-up` | `600ms` |
| motion.durationMs.coinFly | `--pk-dur-coin-fly` | `450ms` |
| motion.durationMs.celebrate | `--pk-dur-celebrate` | `900ms` |
| motion.durationMs.paintTile | `--pk-dur-paint-tile` | `60ms` |
| motion.durationMs.snapHint | `--pk-dur-snap-hint` | `120ms` |
| motion.durationMs.invalidShake | `--pk-dur-invalid-shake` | `160ms` |
| motion.durationMs.editorEnter | `--pk-dur-editor-enter` | `220ms` |
| motion.durationMs.islandZoom | `--pk-dur-island-zoom` | `280ms` |
| motion.durationMs.readyBounceLoop | `--pk-dur-ready-bounce-loop` | `900ms` |
| motion.durationMs.readyBouncePause | `--pk-dur-ready-bounce-pause` | `2000ms` |
| DESIGN-SYSTEM.md:521; review 419baf51 R4 / 90845456 F5 | `--pk-dur-seal-in` | `160ms` |
| DESIGN-SYSTEM.md:521; review 419baf51 R4 / 90845456 F5 | `--pk-dur-seal-out` | `120ms` |
| DESIGN-SYSTEM.md:516 | `--pk-dur-half-sheet-in` | `180ms` |
| DESIGN-SYSTEM.md:516 | `--pk-dur-half-sheet-out` | `140ms` |
| DESIGN-SYSTEM.md:517 | `--pk-dur-drawer-row-stagger` | `20ms` |
| motion.reducedMotion "cross-fade 120 ms" | `--pk-dur-crossfade` | `120ms` |
| pre-host fallback; LANE §10.1 | `--pk-vp-class` | `phone-portrait` |
| review e9c1eb73 W10; sheet-only landscape short-height sub-class | `--pk-vp-height` | `regular` |
| phone: space.screenGutter | `--pk-hud-edge` | `max(var(--pk-gutter), env(safe-area-inset-left), env(safe-area-inset-right))` |
| color.gold.hex | `--pk-seal-primary` | `#E3AE3C` |

## 3. The 46 legacy M48 names

46 names, each declared once. 16 take a design value and 30 take a fallback (§6a). "M48" is tokens.css @ 92ba5d3f. "v1" is the reviewed candidate, where — means v1 did not declare the name.

| # | Name | M48 | v1 | v2 | Source |
|---|---|---|---|---|---|
| 1 | `--pk-edge` | `8px` | — | `8px` | space.screenGutter |
| 2 | `--pk-gap` | `8px` | `8px` | `8px` | space.sheetGutter |
| 3 | `--pk-tap` | `48px` | — | `48px` | size.minTap |
| 4 | `--pk-medal` | `64px` | — | `64px` | **no design source** |
| 5 | `--pk-medal-desk` | `72px` | — | `72px` | **no design source** |
| 6 | `--pk-medal-land` | `56px` | — | `56px` | **no design source** |
| 7 | `--pk-medal-icon` | `48px` | — | `48px` | **no design source** |
| 8 | `--pk-cmd-title` | `48px` | — | `48px` | **no design source** |
| 9 | `--pk-cmd-line` | `20px` | — | `20px` | **no design source** |
| 10 | `--pk-deck-w` | `64px` | — | `64px` | **no design source** |
| 11 | `--pk-deck-w-compact` | `56px` | — | `56px` | **no design source** |
| 12 | `--pk-deck-h` | `56px` | — | `56px` | **no design source** |
| 13 | `--pk-sheet-peek` | `144px` | — | `144px` | **no design source** |
| 14 | `--pk-side` | `440px` | — | `440px` | **no design source** |
| 15 | `--pk-side-wide` | `560px` | — | `560px` | **no design source** |
| 16 | `--pk-dialog-max` | `520px` | — | `520px` | **no design source** |
| 17 | `--pk-page-max` | `560px` | — | `560px` | **no design source** |
| 18 | `--pk-glass-flat` | `rgba(29,26,36,.94)` | `#221D27` | `rgba(29,26,36,.94)` | **no design source** |
| 19 | `--pk-page` | `rgba(20,18,26,.94)` | `#100E14` | `#100E14` | color.bg.hex |
| 20 | `--pk-seal` | `rgba(29,26,36,.97)` | `#E3AE3C` | `#F4E3BC` | color.parchment.hex (review ca622d60 §2: --pk-seal keeps its dialog-material meaning (parchment); DESIGN-SYSTEM.md:422 "Centred WoodFrame + parchment") |
| 21 | `--pk-scrim-seal` | `linear-gradient(180deg,rgba(16,14,20,.62),rgba(16,14,20,.38))` | `rgba(14,9,20,0.55)` | `rgba(14,9,20,0.55)` | color.scrim.seal |
| 22 | `--pk-scrim-menu` | `rgba(16,14,20,.25)` | — | `rgba(16,14,20,.25)` | **no design source** |
| 23 | `--pk-light-edge` | `linear-gradient(90deg,transparent,var(--hud-acc) 22%,var(--hud-acc-hi) 50%,var(--hud-acc) 78%,transparent)` | — | `linear-gradient(90deg,transparent,var(--hud-acc) 22%,var(--hud-acc-hi) 50%,var(--hud-acc) 78%,transparent)` | **no design source** |
| 24 | `--pk-aura` | `0 0 48px -10px var(--hud-acc-a)` | — | `0 0 48px -10px var(--hud-acc-a)` | **no design source** |
| 25 | `--pk-lift` | `0 18px 48px rgba(0,0,0,.55)` | — | `0 18px 48px rgba(0,0,0,.55)` | **no design source** |
| 26 | `--pk-lift-sm` | `0 6px 18px rgba(0,0,0,.5)` | — | `0 6px 18px rgba(0,0,0,.5)` | **no design source** |
| 27 | `--pk-step` | `steps(4,end)` | — | `steps(4,end)` | **no design source** |
| 28 | `--pk-t-press` | `90ms` | — | `60ms` | motion.durationMs.press |
| 29 | `--pk-t-swap` | `80ms` | — | `80ms` | **no design source** |
| 30 | `--pk-t-disclose` | `120ms` | — | `160ms` | motion.durationMs.toastIn |
| 31 | `--pk-t-pop` | `160ms` | — | `160ms` | **no design source** |
| 32 | `--pk-stagger` | `30ms` | `30ms` | `30ms` | motion.durationMs.commandStagger |
| 33 | `--pk-stagger-section` | `50ms` | — | `50ms` | **no design source** |
| 34 | `--pk-t-sheet` | `240ms` | `220ms` | `220ms` | motion.durationMs.sheetIn |
| 35 | `--pk-t-snap` | `200ms` | `220ms` | `120ms` | motion.durationMs.snapHint |
| 36 | `--pk-t-close` | `160ms` | — | `160ms` | motion.durationMs.sheetOut |
| 37 | `--pk-t-seal` | `180ms` | `160ms` | `160ms` | DESIGN-SYSTEM.md:521; review 419baf51 R4 / 90845456 F5 (review 419baf51 R4 supersedes the relayed 180ms proposal; visual entrance only, arming stays 450ms) |
| 38 | `--pk-t-fly` | `480ms` | — | `450ms` | motion.durationMs.coinFly |
| 39 | `--pk-t-glint` | `320ms` | — | `320ms` | **no design source** |
| 40 | `--pk-beat` | `2400ms` | `120ms` | `2400ms` | **no design source** |
| 41 | `--pk-t-celebrate` | `1600ms` | — | `900ms` | motion.durationMs.celebrate |
| 42 | `--pk-t-ribbon` | `2400ms` | — | `2400ms` | **no design source** |
| 43 | `--pk-t-toast` | `4000ms` | `160ms` | `4000ms` | motion.durationMs.toastHold |
| 44 | `--pk-rise-quick` | `280ms` | — | `280ms` | **no design source** |
| 45 | `--pk-stagger-quick` | `24ms` | — | `24ms` | **no design source** |
| 46 | `--pk-phase` | `0` | — | `0` | **no design source** |

## 4. The 18 JS motion mirrors (MOTION_MS ↔ CSS)

The pairs pinned by M48 ui/ds/tokens.test.ts:115-121. All 18 are legacy names from §3, so each is declared once. 10 take a design duration; 8 have no design duration and carry the ALIAS-PROPOSALS fallback.

| JS key | CSS name | M48 | v2 | Source |
|---|---|---|---|---|
| press | `--pk-t-press` | 90ms | 60ms | motion.durationMs.press |
| swap | `--pk-t-swap` | 80ms | 80ms | **no design source**: M48 legacy value |
| disclose | `--pk-t-disclose` | 120ms | 160ms | motion.durationMs.toastIn |
| pop | `--pk-t-pop` | 160ms | 160ms | **no design source**: M48 legacy value |
| stagger | `--pk-stagger` | 30ms | 30ms | motion.durationMs.commandStagger |
| staggerSection | `--pk-stagger-section` | 50ms | 50ms | **no design source**: M48 legacy value |
| sheet | `--pk-t-sheet` | 240ms | 220ms | motion.durationMs.sheetIn |
| snap | `--pk-t-snap` | 200ms | 120ms | motion.durationMs.snapHint |
| close | `--pk-t-close` | 160ms | 160ms | motion.durationMs.sheetOut |
| seal | `--pk-t-seal` | 180ms | 160ms | DESIGN-SYSTEM.md:521; review 419baf51 R4 / 90845456 F5 |
| fly | `--pk-t-fly` | 480ms | 450ms | motion.durationMs.coinFly |
| glint | `--pk-t-glint` | 320ms | 320ms | **no design source**: M48 legacy value |
| beat | `--pk-beat` | 2400ms | 2400ms | **no design source**: M48 legacy value |
| celebrate | `--pk-t-celebrate` | 1600ms | 900ms | motion.durationMs.celebrate |
| ribbon | `--pk-t-ribbon` | 2400ms | 2400ms | **no design source**: M48 legacy value |
| toast | `--pk-t-toast` | 4000ms | 4000ms | motion.durationMs.toastHold |
| riseQuick | `--pk-rise-quick` | 280ms | 280ms | **no design source**: M48 legacy value |
| staggerQuick | `--pk-stagger-quick` | 24ms | 24ms | **no design source**: M48 legacy value |

motion.ts `MOTION_MS` must equal these values in the same admitted change:

```ts
export const MOTION_MS = {
  press: 60, swap: 80, disclose: 160, pop: 160, stagger: 30, staggerSection: 50,
  sheet: 220, snap: 120, close: 160, seal: 160, fly: 450, glint: 320,
  beat: 2400, celebrate: 900, ribbon: 2400, toast: 4000, riseQuick: 280, staggerQuick: 24,
} as const;
```

## 5. Z-order

| Name | M48 | v2 | Note |
|---|---|---|---|
| `--z-anchor` | 900 | 900 | kept |
| `--z-hud` | 1000 | 1000 | kept |
| `--z-tapaway` | 1001 | 1001 | kept |
| `--z-menu` | 1002 | 1002 | kept |
| `--z-chat` | 1010 | 1010 | kept |
| `--z-tutorial` | 1020 | 1020 | kept |
| `--z-cmd` | 1045 | 1045 | kept |
| `--z-sheet` | 1050 | 1050 | kept |
| `--z-tray` | 1100 | 1100 | kept |
| `--z-page` | 1200 | 1200 | kept |
| `--z-scout` | 1400 | 1400 | kept |
| `--z-toast` | 3000 | 3000 | kept |
| `--z-consent` | 1500 | 3100 | raised (d6013820 §2b; slot per REVIEW F06) |
| `--z-celebrate` | 1700 | 3200 | raised (d6013820 §2b; slot per REVIEW F06) |

Design order (MAP §2.6, citing KIT:52) and its home in this scale: hud → `--z-hud`, command bar → `--z-cmd`, sheet → `--z-sheet`, toast → `--z-toast`, seal → `--z-consent`, celebration → `--z-celebrate`. Layers outside #overlay-root (worker error 3500, boundaries 5000, loading shell 99999, renderer dialog 100000) are not tokens. ui/ds/z.ts must equal:

```ts
export const Z = {
  anchor: 900,
  hud: 1000,
  tapaway: 1001,
  menu: 1002,
  chat: 1010,
  tutorial: 1020,
  cmd: 1045,
  sheet: 1050,
  tray: 1100,
  page: 1200,
  scout: 1400,
  toast: 3000,
  consent: 3100,
  celebrate: 3200,
} as const;
```

## 6. No design source

### 6a. Legacy fallbacks (30)

Each value is the ALIAS-PROPOSALS `proposed_normal_value`, kept until a design counterpart is named. A fallback is a compatibility value, not an approved design mapping.

| Name | Value | Origin |
|---|---|---|
| `--pk-medal` | `64px` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-medal-desk` | `72px` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-medal-land` | `56px` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-medal-icon` | `48px` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-cmd-title` | `48px` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-cmd-line` | `20px` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-deck-w` | `64px` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-deck-w-compact` | `56px` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-deck-h` | `56px` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-sheet-peek` | `144px` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-side` | `440px` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-side-wide` | `560px` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-dialog-max` | `520px` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-page-max` | `560px` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-glass-flat` | `rgba(29,26,36,.94)` | directive_bound_legacy_fallback; M48 tokens.css legacy value. d601 section2d explicitly permits unsourced glass; reject candidate veil guess. |
| `--pk-scrim-menu` | `rgba(16,14,20,.25)` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain token compatibility in P0; remove nonmodal legacy scrim uses when consumer is re-hosted in P2. |
| `--pk-light-edge` | `linear-gradient(90deg,transparent,var(--hud-acc) 22%,var(--hud-acc-hi) 50%,var(--hud-acc) 78%,transparent)` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-aura` | `0 0 48px -10px var(--hud-acc-a)` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-lift` | `0 18px 48px rgba(0,0,0,.55)` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-lift-sm` | `0 6px 18px rgba(0,0,0,.5)` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-step` | `steps(4,end)` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-t-swap` | `80ms` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-t-pop` | `160ms` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-stagger-section` | `50ms` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-t-glint` | `320ms` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-beat` | `2400ms` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Normal timing has no established counterpart; reject reduced crossfade120ms as normal beat source. |
| `--pk-t-ribbon` | `2400ms` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-rise-quick` | `280ms` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-stagger-quick` | `24ms` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |
| `--pk-phase` | `0` | proposed_legacy_fallback_no_design_source; M48 tokens.css legacy value. Retain exact legacy compatibility value unless a design source supplies a semantic counterpart; no rename/removal in P0. |

### 6b. Other values not taken directly from TOKENS.json

| Name | Value | Origin | Confidence |
|---|---|---|---|
| `--pk-font-display` | `"VT323", monospace` | stand-in; TOKENS type.families.display.name = "Press Start 2P" | contract: LANE-WEB-UI-REHAUL.md §5 amendment 3 |
| `--pk-font-display-standin-size` | `22px` | LANE-WEB-UI-REHAUL.md §5 amendment 3 | contract |
| `--pk-k-type-numeral-l` | `30px` | Android PkwTokens.Type; kit/p0/kitBase.css:29-37; review 90845456 F5 | sourced kit fallback, not a TOKENS.json addition |
| `--pk-k-type-primary` | `26px` | Android PkwTokens.Type; kit/p0/kitBase.css:29-37; review 90845456 F5 | sourced kit fallback, not a TOKENS.json addition |
| `--pk-k-type-title` | `24px` | Android PkwTokens.Type; kit/p0/kitBase.css:29-37; review 90845456 F5 | sourced kit fallback, not a TOKENS.json addition |
| `--pk-k-type-label` | `22px` | Android PkwTokens.Type; kit/p0/kitBase.css:29-37; review 90845456 F5 | sourced kit fallback, not a TOKENS.json addition |
| `--pk-k-type-caption` | `20px` | Android PkwTokens.Type; kit/p0/kitBase.css:29-37; review 90845456 F5 | sourced kit fallback, not a TOKENS.json addition |
| `--pk-clip-s` | `polygon(0 4px, 2px 4px, 2px 2px, 4px 2px, 4px 0, calc(100% - 4px) 0, calc(100% - 4px) 2px, calc(100% - 2px) 2px, calc(100% - 2px) 4px, 100% 4px, 100% calc(100% - 4px), calc(100% - 2px) calc(100% - 4px), calc(100% - 2px) calc(100% - 2px), calc(100% - 4px) calc(100% - 2px), calc(100% - 4px) 100%, 4px 100%, 4px calc(100% - 2px), 2px calc(100% - 2px), 2px calc(100% - 4px), 0 calc(100% - 4px))` | derived from shape.stepS | derived from the shape.stepS prose |
| `--pk-size-tall-sheet-top` | `104px` | DESIGN-SYSTEM.md:330 | sourced (DESIGN-SYSTEM.md) |
| `--pk-size-sheet-header-h` | `136px` | DESIGN-SYSTEM.md:335 | sourced (DESIGN-SYSTEM.md) |
| `--pk-size-goldforge-hero-h` | `204px` | MAP-DESIGN-FOR-WEB.md §2.5 ← goldforge/SPEC:68 | second-hand (SPEC not read) |
| `--pk-size-tab-stacked-h` | `56px` | MAP-DESIGN-FOR-WEB.md §2.5 ← account/SPEC:14 | second-hand (SPEC not read) |
| `--pk-size-command-pitch` | `88px` | MAP-DESIGN-FOR-WEB.md §2.5 ← buildings/SPEC:65 | second-hand (SPEC not read) |
| `--pk-dur-seal-in` | `160ms` | DESIGN-SYSTEM.md:521; review 419baf51 R4 / 90845456 F5 | sourced design duration absent from TOKENS |
| `--pk-dur-seal-out` | `120ms` | DESIGN-SYSTEM.md:521; review 419baf51 R4 / 90845456 F5 | sourced design duration absent from TOKENS |
| `--pk-dur-half-sheet-in` | `180ms` | DESIGN-SYSTEM.md:516 | sourced (DESIGN-SYSTEM.md) |
| `--pk-dur-half-sheet-out` | `140ms` | DESIGN-SYSTEM.md:516 | sourced (DESIGN-SYSTEM.md) |
| `--pk-dur-drawer-row-stagger` | `20ms` | DESIGN-SYSTEM.md:517 | sourced (DESIGN-SYSTEM.md) |
| `--pk-dur-crossfade` | `120ms` | motion.reducedMotion "cross-fade 120 ms" | TOKENS prose (motion.reducedMotion), DESIGN-SYSTEM.md:528 |
| `--pk-vp-class` | `phone-portrait` | pre-host fallback; LANE §10.1 | class supplied by the host JS classifier |
| `--pk-vp-height` | `regular` | review e9c1eb73 W10; sheet-only landscape short-height sub-class | host sets data-pk-vp-height; no layout media query |
| `--pk-hud-edge` | `max(var(--pk-gutter), env(safe-area-inset-left), env(safe-area-inset-right))` | phone: space.screenGutter | phone = space.screenGutter; tablet 12 / desktop 16 are v1 defaults from the space scale |
| `--z-*` (14) | §5 | M48 tokens.css:55-58 values; consent and celebrate per d6013820 §2b with REVIEW F06 slots | legacy + ruling |
| viewport classification | JS host: landscape and height ≤480 → phone-landscape; width 768–1199 with portrait or height ≥481 → matching tablet orientation; width ≥1200 and height ≥481 → desktop; otherwise phone-portrait. Short means landscape height ≤359, for sheets only. | v2 edges preserved in JS; review e9c1eb73 W10 | host hunk must be accepted before activation |

## 7. Consumer and test obligations, open items

1. **Seal foreground (blocking for `--pk-seal`).** pk.css:37 gives `.pk-seal` `color:var(--sk-text)`, light text. On the v2 parchment body (`#F4E3BC`) that text is close to invisible. In the same admitted change the Seal's foreground must move to `--pk-ink-text` (`#3B2614`, `color.textOnParch.hex`), and every caller that colours Seal text light must be checked. Do not ship `--pk-seal` v2 without that change. The design's WoodFrame around the parchment is P2 consumer work.
2. **Reduced Seal fade.** 419baf51 R2: pk.css:89 must read `var(--pk-dur-crossfade)` rather than the legacy `--pk-t-seal` entrance value. Other legacy visual consumers are already gated off under reduced motion. Kit Seal consumers should use canonical `--pk-dur-seal-in`/`--pk-dur-seal-out`, which crossfade under both triggers. Legacy aliases remain declared exactly once. These consumer edits are coordinated hunks, not performed by the generator.
3. **JS mirrors and pins (rewrite, never delete).** motion.ts `MOTION_MS` → §4. z.ts `Z.consent`/`Z.celebrate` → 3100/3200, and its header comment about "every Seal (1500)". tokens.test.ts:87-89 (`--pk-scrim-seal`, `--pk-seal`, `--pk-page`) → the §3 v2 values. tokens.test.ts:101-111 → consent 3100, celebrate 3200, and `Z.consent < Z.toast` becomes toast < consent < celebrate < 3500. tokens.test.ts:114-124 → the §4 values. tokens.test.ts parses tokens.css only: if this file ships as its own import, the tests must parse it too.
4. **Motion mirrors without a design duration:** swap, pop, staggerSection, glint, beat, ribbon, riseQuick, staggerQuick. Seal entrance follows DESIGN-SYSTEM.md:521; review 419baf51 R4 / 90845456 F5 (160ms); exit follows DESIGN-SYSTEM.md:521; review 419baf51 R4 / 90845456 F5 (120ms). The 450ms arming guard remains separate (`--pk-dur-seal-arm`).
5. **Viewport host dependency (W10).** The delivered viewport.ts only reads CSS and copies the class back to an attribute. With attribute-only CSS this is circular: the host must classify dimensions and stamp data-pk-vp/data-pk-vp-height before syncViewportClass and before mounting the kit, then update on resize/orientation change. Use the existing layout.ts/useWindowSize seam, not component-specific breakpoints. Replace bridge-amendment.css with a comment-only compatibility import; its old media block must not ship.
6. **Z numbers.** 3100/3200 are REVIEW F06's proposed slots. d6013820 §2b fixes the order only. The numbers are confirmed at composition.
7. **QA import seam.** `pk-tokens.qa.css` may load only behind `import.meta.env.DEV` or an equivalent dev-only gate. A production-bundle check should assert that `--pk-qa-` never appears in dist.
8. **Hoisted-block dependency.** `--pk-light-edge` and `--pk-aura` read `--hud-acc`, `--hud-acc-hi` and `--hud-acc-a` from the hoisted HUD block in tokens.css, so load this file wherever that block is loaded. A last-declaration-wins parser sees the reduced values for the `--pk-dur-*` names in §1 rule 9; no test pins those names.
9. **Instance names.** `--pk-seal-w`, `--pk-vp-top` and `--pk-vp-bottom` are set inline by primitives.tsx and are correctly not declared here.
10. **Unchanged omissions.** `--pk-clip-m`, `sea`, `numeralXL`, `icon24Celebration` (§1 rule 14).

## 8. Checks the generator runs before writing

- ALIAS-PROPOSALS lists 46 unique names. Every design-mapped value equals its TOKENS value, and every lead binding resolves.
- Each of the 46 legacy names and `--pk-seal-primary` occurs exactly once in the CSS, as its one declaration. The match is bounded, so `--pk-stagger` does not count `--pk-stagger-section`.
- The 18 motion mirrors are legacy names with 18 unique JS keys.
- The 14 `--z-*` names are each declared once with unique values, and page < toast < consent < celebrate < 3500.
- The pinned TOKENS has 27 durations; only exact optional sealIn/sealOut additions are admitted without a reduced-motion-list review. Each duration has one normal declaration and, where applicable, one per reduced-motion trigger. Seal in/out each have both reduced-mode overrides; the five literal display steps occur once.
- No `--pk-z-` in either CSS file, no "P0 wins", and no `data-pk-qa`/`--pk-qa-` in the production CSS.
- Braces balance in both CSS files (comments stripped), and both reduce triggers are present.
- The only media query is prefers-reduced-motion; all viewport selectors are root attributes.

Result of this run: 46 legacy names (16 design, 30 fallback), 18 motion mirrors (10 design, 8 fallback), 14 z layers, 21 reduced-motion overrides per trigger, 206 canonical rows in §2.
