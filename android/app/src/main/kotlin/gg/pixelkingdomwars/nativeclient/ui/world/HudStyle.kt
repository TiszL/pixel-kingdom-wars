package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.ui.graphics.Color

/**
 * The shared world HUD style (D-166.2, `docs/HUD-STYLE.md`): the game's MATERIAL (VT323, the `--sk-*` palette, square
 * charcoal plates with gold pips, forged bevels, gold = the primary action) lit by the globe's LIGHT (the realm accent).
 *
 * Every value is the pinned web `hud.js` HUD_CSS token, verbatim (`tools/world-hud.mjs` exports them;
 * `HudStyleTest` fails on any drift), so a colour here is a colour on the web globe and in the game. Colours and bevel
 * rows are parsed from the token strings, never retyped. CSS px are dp: the web HUD is authored in CSS px and the
 * native HUD in dp, and both are density-independent units of the same size.
 */
object HudTokens {
    /** `:root` of HUD_CSS at the pin, in declaration order. */
    val ROOT: Map<String, String> = linkedMapOf(
        "--sk-bg" to "#100e14", "--sk-surface" to "#1a171e", "--sk-card" to "#14121a", "--sk-border" to "#3d3833",
        "--sk-border-lt" to "#6b6354", "--sk-text" to "#efe8d6", "--sk-text-dim" to "#c4bba4", "--sk-text-faint" to "#9c937f",
        "--sk-gold" to "#e3ae3c", "--sk-gold-hi" to "#f4d77b", "--sk-gold-dp" to "#9c6f1e", "--sk-danger" to "#c75a2e",
        "--sk-blood" to "#8f2c2c", "--sk-success" to "#8cb36e", "--sk-pine" to "#567a4b", "--sk-link" to "#bbd0d6",
        "--hud-ink" to "#1a171e", "--hud-field" to "#2f2c34", "--hud-seat" to "#29252c", "--hud-stone" to "#554c40",
        "--hud-stone-lo" to "#494741",
        "--hud-font" to "'VT323',ui-monospace,Menlo,Consolas,monospace",
        "--hud-font-display" to "'Silkscreen','VT323',ui-monospace,monospace",
        "--hud-fs-cap" to "20px", "--hud-fs-kick" to "20px", "--hud-fs-body" to "20px", "--hud-fs-ui" to "20px",
        "--hud-fs-title" to "20px", "--hud-fs-num-lg" to "40px", "--hud-fs-display" to "32px", "--hud-fs-display-sm" to "24px",
        "--hud-fs-place" to "12px",
        "--hud-glass" to "rgba(20,18,26,.84)", "--hud-glass-hi" to "rgba(29,26,36,.9)", "--hud-blur" to "10px",
        "--hud-tap" to "48px", "--hud-tap-min" to "44px", "--hud-gap" to "8px", "--hud-pad" to "16px",
        "--hud-ease" to "cubic-bezier(.16,.84,.24,1)", "--hud-ease-out" to "cubic-bezier(.2,.8,.2,1)",
        "--hud-t-slide" to ".5s", "--hud-t-fade" to ".3s", "--hud-t-light" to ".25s",
        "--hud-bevel-stone" to "inset 1px 1px 0 #87785f,inset 2px 2px 0 #6b6354,inset -1px -1px 0 #29252c,inset -2px -2px 0 #29252c,inset -3px -3px 0 #494741",
        "--hud-bevel-stone-sunk" to "inset 1px 1px 0 #373443,inset -1px -1px 0 #6b6354,inset -2px -2px 0 #5f5344,inset -3px -3px 0 #373443",
        "--hud-bevel-gold" to "inset 1px 1px 0 #f4d77b,inset 2px 2px 0 #c99238,inset -1px -1px 0 #5c3d09,inset -2px -2px 0 #78541e,inset -3px -3px 0 #9c6f1e",
        "--hud-bevel-gold-sunk" to "inset 1px 1px 0 #5c3d09,inset 2px 2px 0 #78541e,inset -1px -1px 0 #f4d77b,inset -2px -2px 0 #c99238,inset -3px -3px 0 #e3ae3c",
        "--hud-bevel-well" to "inset 0 1px 0 #6b6354,inset 1px 0 0 #554c40,inset -1px 0 0 #494741,inset 0 -1px 0 #494741",
        "--hud-bevel-keep" to "inset 0 1px 0 #e3ae3c,inset 1px 0 0 #c99238,inset 0 2px 0 #86601d,inset 2px 0 0 #6b4d2b,inset 0 -1px 0 #9c6f1e,inset -1px 0 0 #9c6f1e,inset 0 -2px 0 #5c3d09,inset -2px 0 0 #5c3d09",
        "--hud-rim" to "inset 0 1px 0 #1a171e,inset 0 2px 0 #f4d77b,inset 0 3px 0 #e3ae3c,inset 0 4px 0 #9c6f1e,inset 0 5px 0 #1a171e",
        "--hud-gold-glow" to "0 0 18px -4px rgba(227,174,60,.6)",
        "--hud-text-outline" to "1px 0px 0 #1a171e,-1px 0px 0 #1a171e,0px 1px 0 #1a171e,0px -1px 0 #1a171e,1px 1px 0 #1a171e,-1px 1px 0 #1a171e,1px -1px 0 #1a171e,-1px -1px 0 #1a171e,0px 2px 0 #1a171e",
        "--hud-acc" to "#e3ae3c",
    )
    /** The media overrides of HUD_CSS: `min-resolution:2dppx`, `orientation:portrait`, short landscape (≤ 520 tall). */
    val DPPX2: Map<String, String> = linkedMapOf("--hud-fs-cap" to "16px", "--hud-fs-kick" to "16px", "--hud-fs-body" to "18px",
        "--hud-fs-title" to "24px", "--hud-fs-num-lg" to "30px")
    val PORTRAIT: Map<String, String> = linkedMapOf("--hud-fs-display" to "var(--hud-fs-display-sm)")
    val SHORT_LANDSCAPE: Map<String, String> = linkedMapOf("--hud-fs-display" to "var(--hud-fs-display-sm)", "--hud-fs-num-lg" to "var(--hud-fs-ui)")
    /** index.html `@media (orientation:landscape) and (max-height:520px)`. */
    const val SHORT_LANDSCAPE_MAX_H = 520
}

/** One inset bevel row: a band [dx] wide on the left (positive) or right (negative) edge and [dy] tall on the top
 *  (positive) or bottom (negative) edge, exactly the region a CSS `inset dx dy 0 color` shadow paints. */
data class BevelRow(val dx: Int, val dy: Int, val color: Color)

object HudStyle {
    fun color(token: String): Color = parseCssColor(HudTokens.ROOT.getValue(token))
    val bg = color("--sk-bg"); val surface = color("--sk-surface"); val card = color("--sk-card")
    val border = color("--sk-border"); val borderLt = color("--sk-border-lt")
    val text = color("--sk-text"); val textDim = color("--sk-text-dim"); val textFaint = color("--sk-text-faint")
    val gold = color("--sk-gold"); val goldHi = color("--sk-gold-hi"); val goldDp = color("--sk-gold-dp")
    val danger = color("--sk-danger"); val success = color("--sk-success"); val pine = color("--sk-pine"); val link = color("--sk-link")
    val ink = color("--hud-ink"); val field = color("--hud-field"); val seat = color("--hud-seat")
    val stone = color("--hud-stone"); val stoneLo = color("--hud-stone-lo")
    val glass = color("--hud-glass"); val glassHi = color("--hud-glass-hi")
    val accentDefault = color("--hud-acc")
    /** `.hud-filter` well and its KEEP (on) state; `.hud-stat.is-mine`, `.hud-count.is-mine`. */
    val wellFill = parseCssColor("rgba(41,37,44,.92)")
    val keepFill = parseCssColor("rgba(61,56,51,.94)")
    /** `.hud-pill` plate and `.hud-count` seat. */
    val pillFill = parseCssColor("rgba(20,18,26,.92)")
    val countFill = parseCssColor("rgba(20,18,26,.9)")
    val tagFill = parseCssColor("rgba(20,18,26,.7)")
    val nametagFill = parseCssColor("rgba(20,18,26,.88)")
    val rowFill = parseCssColor("rgba(20,18,26,.62)")
    val footFill = parseCssColor("rgba(16,14,20,.55)")
    /** `#1d1a24`: the realm card's opaque action bar (the card scrolls under it). */
    val actsFill = parseCssColor("#1d1a24")
    val scaleInk = parseCssColor("#0b0a10")
    val tagBlueBorder = parseCssColor("#54677a"); val tagRed = parseCssColor("#e8875e")

    val bevelStone = bevel("--hud-bevel-stone"); val bevelStoneSunk = bevel("--hud-bevel-stone-sunk")
    val bevelGold = bevel("--hud-bevel-gold"); val bevelGoldSunk = bevel("--hud-bevel-gold-sunk")
    val bevelWell = bevel("--hud-bevel-well"); val bevelKeep = bevel("--hud-bevel-keep"); val rim = bevel("--hud-rim")

    /** `--hud-gold-glow` (`.hud-btn--gold`, enabled only) and the fixed-colour glows and shadows of the hud.js rules. */
    val goldGlow = parseShadow(HudTokens.ROOT.getValue("--hud-gold-glow"))
    /** `.hud-filter.is-on`. */
    val filterOnGlow = parseShadow("0 0 14px -4px rgba(227,174,60,.7)")
    /** `.hud-frame` (the minimap frame). */
    val frameShadow = parseShadow("0 6px 18px rgba(0,0,0,.5)")
    /** `.hud-count` and `.hud-nametag`: the hard 2 dp drop under a map label. */
    val countDrop = parseShadow("0 2px 0 rgba(0,0,0,.45)")
    val nametagDrop = parseShadow("0 2px 0 rgba(0,0,0,.4)")
    /** `.hud-panel` inner top highlight: `inset 0 1px 0 rgba(244,215,123,.1)`. */
    val panelHighlight = parseCssColor("rgba(244,215,123,.1)")

    /** `--hud-tap`, `--hud-tap-min`, `--hud-gap`, `--hud-pad` (dp). */
    val tap = px("--hud-tap"); val tapMin = px("--hud-tap-min"); val gap = px("--hud-gap"); val pad = px("--hud-pad")
    /** `--hud-t-slide`, `--hud-t-fade`, `--hud-t-light` in ms. */
    val slideMs = seconds("--hud-t-slide"); val fadeMs = seconds("--hud-t-fade"); val lightMs = seconds("--hud-t-light")
    /** `--hud-ease` / `--hud-ease-out` control points (x1, y1, x2, y2). */
    val ease = cubic("--hud-ease"); val easeOut = cubic("--hud-ease-out")

    fun bevel(token: String): List<BevelRow> = parseBevel(HudTokens.ROOT.getValue(token))
    private fun px(token: String): Float = HudTokens.ROOT.getValue(token).removeSuffix("px").toFloat()
    private fun seconds(token: String): Int = (HudTokens.ROOT.getValue(token).removeSuffix("s").toDouble() * 1000).toInt()
    private fun cubic(token: String): FloatArray =
        HudTokens.ROOT.getValue(token).removePrefix("cubic-bezier(").removeSuffix(")").split(',').map { it.trim().toFloat() }.toFloatArray()
}

/**
 * The globe panel's motion at the pin (index.html `#panel` transitions and `pIn`, main.js `countUp`/`closePanel`), pure so
 * the timings are JVM-tested. A fresh open fades and slides in, its children rise in turn and the stats count up; a panel
 * revealed on the way back from a realm map slides in solid with its content in place; a closing panel slides out while
 * it fades. Reduced motion: a 0.2 s fade only, no stagger, no count-up.
 */
object HudMotion {
    /** main.js `countUp`: the figures hold at 0 for 180 ms, then rise over 700 ms on an ease-out cubic. */
    const val COUNT_DELAY_MS = 180
    const val COUNT_MS = 700
    /** `#panel{transition:… opacity .3s ease}`; reduced motion `opacity .2s ease`. */
    const val FADE_MS = 300
    const val REDUCED_FADE_MS = 200
    /** `pIn`: each child rises 10 dp while it fades in. */
    const val RISE_DP = 10f
    /** `.p-cta>*{--i:7}`: the CTA is the last child to rise. */
    const val CTA_INDEX = 7

    fun countUp(value: Long, elapsedMs: Float): Long {
        val e = ((elapsedMs - COUNT_DELAY_MS) / COUNT_MS).coerceIn(0f, 1f)
        val k = 1.0 - Math.pow(1.0 - e, 3.0)
        return Math.round(value * k)
    }
    /** `animation-delay: calc(110ms + var(--i) * 50ms)`. */
    fun staggerDelay(index: Int): Int = 110 + 50 * index
    /** Linear progress (0..1) of child [index]'s `pIn` at [elapsedMs]; the caller applies `--hud-ease-out`. */
    fun stagger(index: Int, elapsedMs: Float): Float = ((elapsedMs - staggerDelay(index)) / HudStyle.slideMs).coerceIn(0f, 1f)
    /** When a fresh open has finished every staggered child and the count-up. */
    val ENTRANCE_MS: Int = maxOf(staggerDelay(CTA_INDEX) + HudStyle.slideMs, COUNT_DELAY_MS + COUNT_MS)
}

/** The HUD type scale in dp for one screen (HUD-STYLE §3): VT323 is pixel-exact at 20/40 on 1× screens, and at two or
 *  more device px per dp every step from 16 reads cleanly, so ≥ 2× screens use the smaller steps. */
data class HudType(val cap: Float, val kick: Float, val body: Float, val ui: Float, val title: Float, val numLg: Float,
    val display: Float, val displaySm: Float, val place: Float) {
    companion object {
        fun of(density: Float, landscape: Boolean, heightDp: Float): HudType {
            val vars = LinkedHashMap(HudTokens.ROOT)
            if (density >= 2f) vars.putAll(HudTokens.DPPX2)
            if (!landscape) vars.putAll(HudTokens.PORTRAIT)
            if (landscape && heightDp <= HudTokens.SHORT_LANDSCAPE_MAX_H) vars.putAll(HudTokens.SHORT_LANDSCAPE)
            fun size(token: String, depth: Int = 0): Float {
                val v = vars.getValue(token)
                if (v.startsWith("var(")) { check(depth < 4) { "Token cycle at $token" }; return size(v.removePrefix("var(").removeSuffix(")"), depth + 1) }
                return v.removeSuffix("px").toFloat()
            }
            return HudType(size("--hud-fs-cap"), size("--hud-fs-kick"), size("--hud-fs-body"), size("--hud-fs-ui"), size("--hud-fs-title"),
                size("--hud-fs-num-lg"), size("--hud-fs-display"), size("--hud-fs-display-sm"), size("--hud-fs-place"))
        }
        /** VT323's advance is 0.4 em (HUD-STYLE §9, measured); letter-spacing adds its px per glyph. */
        fun textWidth(chars: Int, fontSize: Float, letterSpacing: Float = 0f): Float = chars * (0.4f * fontSize + letterSpacing)
    }
}

/** The realm presentation the globe owns (landmarks.js REALM_INFO): the accent is the light a realm casts on the HUD. */
object HudRealms {
    val ACCENT: Map<String, String> = linkedMapOf(
        "frostveil" to "#8fe3ff", "elderwood" to "#86ec6c", "sunscar" to "#ffbf4d", "crownlands" to "#ffd65c",
        "seeker-reach" to "#c99dff", "stormcairn" to "#9dbcff", "thornwake" to "#c6e65a", "cinderfall" to "#ff8a4c",
    )
    fun accent(realmId: String?): Color = realmId?.let(ACCENT::get)?.let(::parseCssColor) ?: HudStyle.accentDefault
}

/** The approved realm-map chips (D-167, D-169; ui.js markup at the pin, but for the shield chip: SHARDKEEP D-191, owner
 *  2026-09-28 on a player's word, turned Shielded into Unshielded, "the purpose of searching is to raid, their target
 *  should be the unshielded"; the pinned reference still carries the old one until the pin moves). [feedField] names
 *  the per-base field a chip filters on that no public feed carries today: such a chip is HIDDEN (not disabled, not
 *  faked) until it does. */
data class HudChip(val id: String, val filter: Boolean, val long: String, val short: String, val aria: String?, val feedField: String?)
object HudChips {
    val ALL = listOf(
        HudChip("all", true, "All", "All", null, null),
        HudChip("mine", true, "Mine", "Mine", null, null),
        HudChip("clan", true, "Clan", "Clan", null, "clan"),
        HudChip("attack", true, "Attackable", "Attack", "Attackable", "attackable"),
        HudChip("unshielded", true, "Unshielded", "No shield", "Unshielded", "shield"),
        HudChip("lvl", false, "Level 1–20", "Lv 1–20", "Level 1–20", null),
    )
    /** The chips a realm map shows for a feed that carries [fields] (D-169). */
    fun shown(fields: Set<String>): List<HudChip> = ALL.filter { it.feedField == null || it.feedField in fields }
    /** The per-base fields the realm feed can carry: `shield`, from every marker's `shielded` (D-NEXT, server PR #147).
     *  Clan and attackable have no feed yet, so their chips stay hidden (D-169). */
    val FEED_FIELDS: Set<String> = setOf("shield")
    /** The realm map's chips: All, Mine, Unshielded, Level once a parcels read has carried `shielded` ([shieldFed],
     *  [gg.pixelkingdomwars.nativeclient.model.FantasyViewport.carriesShielded]); All, Mine, Level against a server
     *  without PR #147, whose rivals carry no shield bit at all: the chip would keep no rival (an absent bit never reads
     *  as unshielded, D-191) and tell players no one is open to a raid, which the feed never said (D-169: hidden, not
     *  faked). */
    fun realm(shieldFed: Boolean): List<HudChip> = if (shieldFed) REALM_FED else REALM_BARE
    private val REALM_FED = shown(FEED_FIELDS)
    private val REALM_BARE = shown(emptySet())
}

/** The zoom-band and base-flag contracts the HUD reads (contracts.js BANDS / FLAG at the pin). `s` values are dp per
 *  deed; `d` values are the engine's device px per deed (buffer px at the engine's dpr). */
object HudBands {
    const val UI_DOTS_S = 24.0
    const val UI_ICONS_S = 48.0
    const val KEEP_MIN_CSS = 28.0
    const val MAP_START_D = 48.0
    const val TRUE_FULL_D = 1100.0
    val IMPOSTOR_D = doubleArrayOf(200.0, 280.0)
    const val SELECT_D = 700.0
    const val MY_BASE_D = 1400.0
}
object HudFlag {
    const val OCCUPIED = 1; const val MINE = 2; const val SHIELD = 4; const val ATTACKABLE = 8
    const val FILTERED_IN = 16; const val SELECTED = 32; const val CLAN = 64; const val HOVERED = 128
}

/** `#rgb`, `#rrggbb` and `rgba(r,g,b,a)` (the forms HUD_CSS uses). */
fun parseCssColor(value: String): Color {
    val v = value.trim()
    if (v.startsWith("#")) {
        val hex = v.substring(1).let { if (it.length == 3) it.map { c -> "$c$c" }.joinToString("") else it }
        require(hex.length == 6) { "Unsupported colour $value" }
        return Color(0xFF000000 or hex.toLong(16))
    }
    require(v.startsWith("rgba(") && v.endsWith(")")) { "Unsupported colour $value" }
    val p = v.removePrefix("rgba(").removeSuffix(")").split(',').map { it.trim() }
    return Color(p[0].toInt(), p[1].toInt(), p[2].toInt(), (p[3].toFloat() * 255 + 0.5f).toInt())
}

/** One outer CSS `box-shadow` layer in dp: offset, blur radius, spread and colour (HUD-STYLE glows and drop shadows). */
data class HudShadow(val dx: Float, val dy: Float, val blur: Float, val spread: Float, val color: Color)

/** `x y [blur [spread]] colour`, the outer form hud.js uses (inset rows are bevels, [parseBevel]). */
fun parseShadow(value: String): HudShadow {
    val parts = value.trim().split(Regex("\\s+"))
    require(parts.size in 3..5 && parts[0] != "inset") { "Not an outer shadow: $value" }
    val n = parts.dropLast(1).map { it.removeSuffix("px").toFloat() }
    return HudShadow(n[0], n[1], n.getOrElse(2) { 0f }, n.getOrElse(3) { 0f }, parseCssColor(parts.last()))
}

/**
 * The Skia blur radius (px) that paints a CSS blur of [cssBlurPx] (px). CSS blurs a shadow with a Gaussian of
 * σ = blur / 2; Android's `BlurMaskFilter` and text shadow layers take a radius and convert it with Skia's
 * σ = 0.57735·r + 0.5. Passing the CSS number straight through would draw every glow about 15 % wider and softer than
 * the approved HUD. 0 means no blur (a hard shadow).
 */
fun cssBlurToSkiaRadius(cssBlurPx: Float): Float = if (cssBlurPx <= 0f) 0f else maxOf(0f, (cssBlurPx / 2f - 0.5f) / 0.57735f)

/** A token of stacked `inset dx dy 0 #colour` rows, first-listed row on top (the CSS paint order). */
fun parseBevel(value: String): List<BevelRow> = value.split(',').map { row ->
    val parts = row.trim().split(Regex("\\s+"))
    require(parts.size == 5 && parts[0] == "inset" && parts[3] == "0") { "Not a bevel row: $row" }
    BevelRow(parts[1].removeSuffix("px").toInt(), parts[2].removeSuffix("px").toInt(), parseCssColor(parts[4]))
}
