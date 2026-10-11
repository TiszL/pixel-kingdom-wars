package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontSynthesis
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput

/**
 * The world HUD kit (HUD-STYLE §4–§10) in Compose: forged plates with the token bevel rows, the glass panel with gold pips
 * and the accent-lit edge, square wells, tools, pills, tags and the map labels. Everything is square, every figure is
 * VT323, gold is the one primary action, and the accent only lights things (never fills a button).
 *
 * Native differences, each deliberate: no backdrop blur and no large panel drop shadows (see [hudShadows]: the small
 * glows are drawn, the multi-megapixel panel shadows are not; D-167.2 puts smoothness first); Silkscreen falls back to
 * VT323 exactly as the web's `--hud-font-display` stack does when Silkscreen is absent (the font file is not bundled
 * yet: its OFL download waits for the owner); text sizes are dp, not sp, so the approved layout's widths hold (the web
 * ignores OS text zoom the same way).
 */
internal val HudVt323 = FontFamily(Font(R.font.pkw_vt323, FontWeight.Normal))
/** `--hud-font-display`: Silkscreen, then VT323. Silkscreen is not bundled, so this is VT323 (see the kit note). */
internal val HudDisplayFont = HudVt323

/** The type scale for the current screen, provided by the world HUD root. */
val LocalHudType = staticCompositionLocalOf { HudType.of(2f, landscape = false, heightDp = 800f) }
/** The realm accent lighting the current surface (`--hud-acc`). */
val LocalHudAccent = compositionLocalOf { HudAccent(HudStyle.accentDefault) }

/** `--hud-acc` and its derived tokens (hud.js ACCENT HOSTS: color-mix in sRGB). */
@Immutable data class HudAccent(val acc: Color) {
    val hi: Color = mix(acc, Color.White, 0.55f)
    val ink: Color = mix(acc, HudStyle.text, 0.70f)
    val a: Color = acc.copy(alpha = 0.45f)
    val b: Color = acc.copy(alpha = 0.24f)
    private fun mix(p: Color, q: Color, k: Float) = Color(p.red * k + q.red * (1 - k), p.green * k + q.green * (1 - k), p.blue * k + q.blue * (1 - k))
}

/** dp-sized text: the HUD's widths are computed from VT323's 0.4 em advance, so OS text zoom must not resize it. */
@Composable internal fun hudSp(dp: Float): TextUnit = (dp / LocalDensity.current.fontScale).sp
@Composable internal fun hudTextStyle(size: Float, color: Color = HudStyle.text, spacing: Float = 0f, line: Float = 1.15f,
    family: FontFamily = HudVt323): TextStyle = TextStyle(fontFamily = family, fontWeight = FontWeight.Normal, fontSynthesis = FontSynthesis.None,
    fontSize = hudSp(size), lineHeight = hudSp(size * line), letterSpacing = hudSp(spacing), color = color)

@Composable internal fun HudText(text: String, size: Float, modifier: Modifier = Modifier, color: Color = LocalContentColor.current,
    spacing: Float = 0f, caps: Boolean = false, maxLines: Int = 1, line: Float = 1.15f, family: FontFamily = HudVt323) {
    Text(if (caps) text.uppercase() else text, modifier, style = hudTextStyle(size, color, spacing, line, family), maxLines = maxLines,
        softWrap = maxLines > 1, overflow = TextOverflow.Ellipsis)
}

// ---- plates -----------------------------------------------------------------------------------------------------------

/** Paint [rows] (first-listed on top, the CSS order) inside the rect (l, t, r, b), 1 dp per row step. */
internal fun DrawScope.bevelRows(rows: List<BevelRow>, l: Float, t: Float, r: Float, b: Float) {
    val px = 1.dp.toPx()
    for (i in rows.indices.reversed()) {
        val row = rows[i]; val w = r - l; val h = b - t
        if (row.dy > 0) drawRect(row.color, Offset(l, t), Size(w, row.dy * px))
        if (row.dy < 0) drawRect(row.color, Offset(l, b + row.dy * px), Size(w, -row.dy * px))
        if (row.dx > 0) drawRect(row.color, Offset(l, t), Size(row.dx * px, h))
        if (row.dx < 0) drawRect(row.color, Offset(r + row.dx * px, t), Size(-row.dx * px, h))
    }
}
/** A forged plate: [border] (1 dp ink by default), the [fill], then the bevel rows inside the border. */
internal fun Modifier.hudPlate(fill: Color, bevel: List<BevelRow>, border: Color? = HudStyle.ink, borderDp: Float = 1f): Modifier = drawBehind {
    val bw = if (border != null) borderDp.dp.toPx() else 0f
    if (border != null) drawRect(border)
    drawRect(fill, Offset(bw, bw), Size(size.width - 2 * bw, size.height - 2 * bw))
    bevelRows(bevel, bw, bw, size.width - bw, size.height - bw)
}
private val DISABLED_MATRIX = ColorMatrix().apply { setToSaturation(0f); timesAssign(ColorMatrix().apply { setToScale(.78f, .78f, .78f, 1f) }) }
/** HUD-STYLE §5 "disabled means refused": grayscale(1) brightness(.78) at .7 opacity. */
internal fun Modifier.hudRefused(refused: Boolean): Modifier = if (!refused) this else drawWithContent {
    drawIntoCanvas { canvas ->
        canvas.saveLayer(Rect(Offset.Zero, size), Paint().apply { colorFilter = ColorFilter.colorMatrix(DISABLED_MATRIX); alpha = .7f })
        drawContent(); canvas.restore()
    }
}

enum class HudButtonKind { STONE, GOLD, GHOST }

/** `.hud-btn`: stone (secondary), gold (THE primary action of a surface), ghost (tertiary). Pressed plates sink and the
 *  label drops exactly 1 dp; the box never moves. ≥ 48 dp wide, 48 dp tall (44 dp for [small]). */
@Composable internal fun HudButton(onClick: () -> Unit, modifier: Modifier = Modifier, kind: HudButtonKind = HudButtonKind.STONE,
    small: Boolean = false, enabled: Boolean = true, description: String? = null, content: @Composable RowScope.() -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val sunk = pressed && enabled
    val (fill, bevel, border) = when (kind) {
        HudButtonKind.STONE -> Triple(if (sunk) HudStyle.seat else HudStyle.stone, if (sunk) HudStyle.bevelStoneSunk else HudStyle.bevelStone, HudStyle.ink)
        HudButtonKind.GOLD -> Triple(if (sunk) HudStyle.goldDp else HudStyle.gold, if (sunk) HudStyle.bevelGoldSunk else HudStyle.bevelGold, HudStyle.ink)
        HudButtonKind.GHOST -> Triple(Color(20, 18, 26, if (sunk) 153 else 89), emptyList(), HudStyle.border)
    }
    val t = LocalHudType.current
    val h = if (small) 12.dp else 16.dp
    // `.hud-btn--gold` glows (`--hud-gold-glow`) except when disabled; a refused button greys as a whole, plate included.
    Row(modifier.defaultMinSize(minWidth = HudStyle.tap.dp, minHeight = (if (small) HudStyle.tapMin else HudStyle.tap).dp)
        .hudShadows(HudStyle.goldGlow.takeIf { kind == HudButtonKind.GOLD && enabled })
        .hudRefused(!enabled).hudPlate(fill, bevel, border, if (kind == HudButtonKind.GHOST) 2f else 1f).blockSceneInput()
        .semantics { description?.let { contentDescription = it }; if (!enabled) disabled() }
        .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
        .padding(start = h, end = h, top = if (sunk) 2.dp else 1.dp, bottom = if (sunk) 1.dp else 2.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        CompositionLocalProvider(LocalContentColor provides if (kind == HudButtonKind.GOLD) HudStyle.ink else HudStyle.textDim,
            LocalTextStyle provides hudTextStyle(if (small) t.body else t.ui, if (kind == HudButtonKind.GOLD) HudStyle.ink else HudStyle.textDim, 1f, 1f)) { content() }
    }
}

/** `.hud-tool`: a square stone tool, icon over a caps label (or icon only, 48×48). A toggle that is on is sunk with a
 *  gold label; `.hud-hot` is not used here. [badge] is the Your-bases count (F15). */
@Composable internal fun HudTool(icon: String, label: String?, onClick: () -> Unit, modifier: Modifier = Modifier, on: Boolean? = null,
    enabled: Boolean = true, description: String? = null, badge: String? = null) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val sunk = (pressed && enabled) || on == true
    val t = LocalHudType.current
    Box(modifier.then(if (label == null) Modifier.size(48.dp) else Modifier.defaultMinSize(64.dp, 56.dp))
        .hudRefused(!enabled).hudPlate(if (sunk) HudStyle.seat else HudStyle.stone, if (sunk) HudStyle.bevelStoneSunk else HudStyle.bevelStone)
        .blockSceneInput()
        .semantics { (description ?: label)?.let { contentDescription = it }; on?.let { selected = it }; if (!enabled) disabled() }
        .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center) {
        Column(Modifier.offset(y = if (sunk) 1.dp else 0.dp).padding(horizontal = 6.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            HudIcon(icon)
            if (label != null) HudText(label, t.cap, color = if (on == true) HudStyle.goldHi else HudStyle.textDim, spacing = 1f, caps = true, line = 1f)
        }
        badge?.let { HudText(it, t.cap, Modifier.align(Alignment.TopEnd).drawBehind { drawRect(HudStyle.gold) }.padding(horizontal = 3.dp),
            color = HudStyle.ink, line = 1f) }
    }
}

/** `.hud-filter` (a recessed well in a top bar) and `.hud-dest` (a rail destination with its accent pip). On: the KEEP
 *  well (filters) or the accent border and glow with a white label (destinations). 44 dp tall. [mine] draws a 2 dp gold
 *  rule inside the well's foot (a destination holding your bases, F14); it takes no space. */
@Composable internal fun HudFilter(label: String, on: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, dest: HudAccent? = null,
    mapIcon: Boolean = false, compact: Boolean = false, description: String? = null, expanded: Boolean? = null, mine: Boolean = false) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val t = LocalHudType.current
    val fill = if (on && dest == null) HudStyle.keepFill else HudStyle.wellFill
    val bevel = if (on && dest == null) HudStyle.bevelKeep else HudStyle.bevelWell
    val border = if (on && dest != null) dest.acc else HudStyle.ink
    Row(modifier.height(44.dp).defaultMinSize(minWidth = 44.dp)
        .hudShadows(when { !on -> null; dest != null -> HudShadow(0f, 0f, 18f, -2f, dest.a); else -> HudStyle.filterOnGlow })
        .hudPlate(fill, bevel, border)
        .then(if (pressed) Modifier.drawBehind { drawRect(Color(26, 23, 30, 204), Offset(1.dp.toPx(), 1.dp.toPx()), Size(size.width - 2.dp.toPx(), 2.dp.toPx())) } else Modifier)
        .then(if (mine) Modifier.drawBehind { drawRect(HudStyle.gold, Offset(3.dp.toPx(), size.height - 5.dp.toPx()), Size(size.width - 6.dp.toPx(), 2.dp.toPx())) } else Modifier)
        .blockSceneInput()
        .semantics { selected = on; description?.let { contentDescription = it }; expanded?.let { if (it) expand { true } else collapse { true } } }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
        .padding(start = if (compact) 7.dp else 12.dp, end = if (compact) 7.dp else 12.dp, top = if (pressed) 2.dp else 1.dp, bottom = if (pressed) 1.dp else 2.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        if (dest != null) Box(Modifier.size(6.dp).hudShadows(HudShadow(0f, 0f, 8f, 0f, dest.a))
            .drawBehind { drawRect(HudStyle.ink, Offset(-1.dp.toPx(), -1.dp.toPx()), Size(size.width + 2.dp.toPx(), size.height + 2.dp.toPx())); drawRect(dest.acc) })
        if (mapIcon) HudIcon("map", 18.dp)
        HudText(label, t.body, color = when { dest != null && on -> Color.White; on -> HudStyle.goldHi; else -> HudStyle.textDim }, spacing = 1f, caps = true, line = 1f)
    }
}

/** `.hud-panel`: the glass frame (2 dp stone border in a 2 dp ink ring), two 6 dp gold pips, the accent wash top-left
 *  and the accent-lit top edge. [sheet] is the portrait bottom sheet: no side border, the game's forged gold rim on top. */
@Composable internal fun HudPanel(modifier: Modifier = Modifier, sheet: Boolean = false, inert: Boolean = false, content: @Composable BoxScope.() -> Unit) {
    val accent = LocalHudAccent.current
    Box(modifier.then(if (inert) Modifier else Modifier.blockSceneInput()).drawWithCache {
        // `.hud-panel::before{box-shadow:0 0 14px 1px var(--hud-acc-a)}`: the lit edge's glow, inside the panel's clip.
        val edge = listOf(HudShadow(0f, 0f, 14f, 1f, accent.a))
        val paints = edge.map { shadowPaint(it, cssBlurToSkiaRadius(it.blur * density)) }
        onDrawBehind { drawPanelFrame(accent, sheet, edge, paints) }
    }, content = content)
}
internal fun DrawScope.drawPanelFrame(accent: HudAccent, sheet: Boolean, edgeGlow: List<HudShadow> = emptyList(), edgePaints: List<android.graphics.Paint> = emptyList()) {
    val px = 1.dp.toPx(); val w = size.width; val h = size.height
    val inset = if (sheet) 0f else 4 * px
    if (!sheet) { drawRect(HudStyle.ink); drawRect(HudStyle.borderLt, Offset(2 * px, 2 * px), Size(w - 4 * px, h - 4 * px)) }
    val inner = Rect(inset, inset, w - inset, h - inset)
    drawRect(Brush.verticalGradient(listOf(HudStyle.glassHi, HudStyle.glass), inner.top, inner.bottom), inner.topLeft, inner.size)
    val r = maxOf(1.1f * inner.width, 0.8f * inner.height) * 0.6f
    drawRect(Brush.radialGradient(listOf(accent.b, Color.Transparent), Offset(inner.left, inner.top), r), inner.topLeft, inner.size)
    if (sheet) bevelRows(HudStyle.rim, 0f, 0f, w, h) else drawRect(HudStyle.panelHighlight, inner.topLeft, Size(inner.width, px))
    val pipY = if (sheet) 11 * px else inset + 6 * px; val pipX = if (sheet) 8 * px else 6 * px
    drawRect(HudStyle.gold, Offset(inner.left + pipX, pipY), Size(6 * px, 6 * px))
    drawRect(HudStyle.gold, Offset(inner.right - pipX - 6 * px, pipY), Size(6 * px, 6 * px))
    val lineY = if (sheet) 5 * px else inset
    if (edgeGlow.isNotEmpty()) drawShadowRects(edgeGlow, edgePaints, Rect(inner.left, lineY, inner.right, lineY + 2 * px), clipOutside = false, clip = inner)
    drawRect(Brush.verticalGradient(listOf(accent.a, Color.Transparent), lineY, lineY + 10 * px), Offset(inner.left, lineY), Size(inner.width, 10 * px))
    drawRect(Brush.horizontalGradient(0f to Color.Transparent, .22f to accent.acc, .5f to accent.hi, .78f to accent.acc, 1f to Color.Transparent,
        startX = inner.left, endX = inner.right), Offset(inner.left, lineY), Size(inner.width, 2 * px))
}

/** `.hud-pill`: the game's Pill (hint line, scale bar, title plate, counts); [gold] marks "yours". */
@Composable internal fun HudPill(modifier: Modifier = Modifier, gold: Boolean = false, content: @Composable RowScope.() -> Unit) {
    Row(modifier.defaultMinSize(minHeight = 32.dp).drawBehind {
        val px = 1.dp.toPx()
        drawRect(HudStyle.ink); drawRect(if (gold) HudStyle.goldDp else HudStyle.border, Offset(px, px), Size(size.width - 2 * px, size.height - 2 * px))
        drawRect(HudStyle.pillFill, Offset(3 * px, 3 * px), Size(size.width - 6 * px, size.height - 6 * px))
        drawRect(Color(244, 215, 123, 36), Offset(3 * px, 3 * px), Size(size.width - 6 * px, px))
        drawRect(Color(0, 0, 0, 115), Offset(3 * px, size.height - 4 * px), Size(size.width - 6 * px, px))
    }.padding(start = 11.dp, end = 13.dp, top = 5.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        CompositionLocalProvider(LocalContentColor provides if (gold) HudStyle.goldHi else HudStyle.text) { content() }
    }
}

enum class HudTagTone { PLAIN, GOLD, BLUE, RED, GREEN }
/** `.hud-tag`: a small square status label. */
@Composable internal fun HudTag(text: String, tone: HudTagTone = HudTagTone.PLAIN) {
    val (fg, bd) = when (tone) {
        HudTagTone.PLAIN -> HudStyle.textDim to HudStyle.borderLt; HudTagTone.GOLD -> HudStyle.goldHi to HudStyle.goldDp
        HudTagTone.BLUE -> HudStyle.link to HudStyle.tagBlueBorder; HudTagTone.RED -> HudStyle.tagRed to HudStyle.danger
        HudTagTone.GREEN -> HudStyle.success to HudStyle.pine
    }
    HudText(text, LocalHudType.current.cap, Modifier.defaultMinSize(minHeight = 22.dp).drawBehind {
        drawRect(bd); drawRect(HudStyle.tagFill, Offset(1.dp.toPx(), 1.dp.toPx()), Size(size.width - 2.dp.toPx(), size.height - 2.dp.toPx()))
    }.padding(start = 6.dp, end = 6.dp, top = 3.dp, bottom = 2.dp), color = fg, spacing = 1f, caps = true, line = 1f)
}

/** `.hud-stat`: a recessed stat, a large VT323 value over a caps label; [mine] is the KEEP well. */
@Composable internal fun HudStat(value: String, label: String, modifier: Modifier = Modifier, mine: Boolean = false) {
    val t = LocalHudType.current
    Column(modifier.hudPlate(if (mine) HudStyle.keepFill else HudStyle.wellFill, if (mine) HudStyle.bevelKeep else HudStyle.bevelWell)
        .padding(start = 10.dp, end = 10.dp, top = 8.dp, bottom = 7.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        HudText(value, t.numLg, color = HudStyle.text, line = 1f)
        HudText(label, t.cap, color = HudStyle.textFaint, spacing = 1f, caps = true, line = 1.1f)
    }
}

/** `.hud-meter`: a 6 dp ink track with the gold fill (the loading bar and the keep-level rail). */
@Composable internal fun HudMeter(progress: Float, modifier: Modifier = Modifier) {
    Canvas(modifier.height(6.dp).semantics { progressBarRangeInfo = ProgressBarRangeInfo(progress.coerceIn(0f, 1f), 0f..1f) }) {
        val px = 1.dp.toPx()
        drawRect(HudStyle.ink); bevelRows(listOf(BevelRow(1, 1, HudStyle.field), BevelRow(-1, -1, HudStyle.field)), 0f, 0f, size.width, size.height)
        val w = size.width * progress.coerceIn(0f, 1f)
        if (w > 0f) { drawRect(HudStyle.gold, Offset.Zero, Size(w, size.height)); drawRect(HudStyle.goldHi, Offset.Zero, Size(w, px)) }
    }
}

/** `.hud-x`: the close button, a 44 dp square showing the game's close icon. */
@Composable internal fun HudX(onClick: () -> Unit, modifier: Modifier = Modifier, description: String = "Close") {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(modifier.size(44.dp).then(if (pressed) Modifier.drawBehind { drawRect(HudStyle.border); drawRect(Color(0, 0, 0, 89), Offset(1.dp.toPx(), 1.dp.toPx()), Size(size.width - 2.dp.toPx(), size.height - 2.dp.toPx())) } else Modifier)
        .blockSceneInput().semantics { contentDescription = description }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick), contentAlignment = Alignment.Center) { HudIcon("close") }
}

/** `.hud-grip`: the 40×4 drag handle of the portrait sheet. */
@Composable internal fun HudGrip(modifier: Modifier = Modifier) {
    Box(modifier.size(40.dp, 4.dp).drawBehind { drawRect(HudStyle.ink, Offset(-1.dp.toPx(), -1.dp.toPx()), Size(size.width + 2.dp.toPx(), size.height + 2.dp.toPx())); drawRect(HudStyle.borderLt) })
}

// ---- icons: the game's masters at 24 or 48 dp only (HUD-STYLE §10) ------------------------------------------------------
private val CHEVRON = listOf("............", "............", ".......##...", "......###...", ".....####...", "....#####...",
    "....#####...", ".....####...", "......###...", ".......##...", "............", "............")

/** A game icon: plus, minus (the plus master cropped to its bar), close, locate, map, attack, scout, shield, trophy,
 *  star, info; prev/next are the web's generated pixel chevrons (the game has no master for them). */
@Composable internal fun HudIcon(name: String, size: Dp = 24.dp) {
    when (name) {
        "prev", "next" -> Canvas(Modifier.size(size)) { drawChevron(name == "next") }
        "minus" -> Box(Modifier.size(size).drawWithContent { clipRect(top = this.size.height * .3334f, bottom = this.size.height * (1 - .3334f)) { this@drawWithContent.drawContent() } }) {
            GameArt("plus", Modifier.size(size))
        }
        else -> GameArt(name, Modifier.size(size))
    }
}
private fun DrawScope.drawChevron(next: Boolean) {
    val cell = size.width / 12f
    fun on(x: Int, y: Int): Boolean { val row = CHEVRON.getOrNull(y) ?: return false; val c = if (next) row.getOrNull(11 - x) else row.getOrNull(x); return c == '#' }
    for (y in 0 until 12) for (x in 0 until 12) {
        val colour = when { on(x, y) -> HudStyle.text; (-1..1).any { dy -> (-1..1).any { dx -> on(x + dx, y + dy) } } -> HudStyle.ink; else -> null } ?: continue
        drawRect(colour, Offset(x * cell, y * cell), Size(cell, cell))
    }
}

// ---- on the map (HUD-STYLE §9) --------------------------------------------------------------------------------------------

/** `.hud-count`: a FAR cluster counter with its pin tail; [mine] is the KEEP well. Never takes touches (a pinch that
 *  lands on one must still reach the map); the map's tap asks [RealmHudModel.hitCluster] instead. */
@Composable internal fun HudCount(n: Int, mine: Boolean, modifier: Modifier = Modifier) {
    val t = LocalHudType.current
    Box(modifier.size(RealmHudModel.counterW(n).toFloat().dp, 28.dp).hudShadows(HudStyle.countDrop).drawBehind {
        val px = 1.dp.toPx()
        drawRect(HudStyle.ink)
        drawRect(if (mine) HudStyle.keepFill else HudStyle.countFill, Offset(px, px), Size(size.width - 2 * px, size.height - 2 * px))
        if (mine) bevelRows(HudStyle.bevelKeep, px, px, size.width - px, size.height - px)
        else { drawRect(HudStyle.borderLt, Offset(px, px), Size(size.width - 2 * px, px)); drawRect(HudStyle.stoneLo, Offset(px, size.height - 2 * px), Size(size.width - 2 * px, px)) }
        val cx = size.width / 2f; val tail = Path().apply { moveTo(cx - 6 * px, size.height); lineTo(cx + 6 * px, size.height); lineTo(cx, size.height + 7 * px); close() }
        drawPath(tail, if (mine) HudStyle.goldDp else HudStyle.ink)
        val inner = Path().apply { moveTo(cx - 4 * px, size.height); lineTo(cx + 4 * px, size.height); lineTo(cx, size.height + 5 * px); close() }
        drawPath(inner, if (mine) Color(61, 56, 51) else Color(20, 18, 26, 242))
    }.clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
        HudText(n.toString(), t.ui, Modifier.padding(top = 1.dp), color = if (mine) HudStyle.goldHi else HudStyle.text, line = 1f)
    }
}

/** `.hud-nametag`: square avatar flush left, the name in VT323, the level in gold; `.is-mine` gold ring, `.is-sel` 36 dp.
 *  A null [level] is the compact map-range tag (D-NEXT): the avatar and the name only. The avatar is the player's profile
 *  image ([avatarUrl] through [avatars]) or, without one, the game's default profile portrait (the profile hub's "army"),
 *  never a castle: the owner's code 31 asked for "only player profile picture and name" at map zoom. */
@Composable internal fun HudNametag(name: String, level: Int?, mine: Boolean, selected: Boolean, modifier: Modifier = Modifier,
    avatarUrl: String? = null, avatars: RealmAvatars<ImageBitmap>? = null) {
    val t = LocalHudType.current; val accent = LocalHudAccent.current
    val h = if (selected) 36.dp else 24.dp; val av = if (selected) 34.dp else 22.dp
    Row(modifier.height(h).hudShadows(HudStyle.nametagDrop, if (selected) HudShadow(0f, 0f, 16f, -2f, accent.a) else null).drawBehind {
        val px = 1.dp.toPx()
        drawRect(HudStyle.ink); drawRect(if (selected) HudStyle.text else if (mine) HudStyle.gold else HudStyle.border, Offset(px, px), Size(size.width - 2 * px, size.height - 2 * px))
        drawRect(HudStyle.nametagFill, Offset(2 * px, 2 * px), Size(size.width - 4 * px, size.height - 4 * px))
    }.clearAndSetSemantics { }.padding(end = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        Box(Modifier.padding(1.dp).size(av).drawBehind { drawRect(HudStyle.seat); drawRect(HudStyle.ink, Offset(size.width - 1.dp.toPx(), 0f), Size(1.dp.toPx(), size.height)) }) {
            val picture = avatars?.image(avatarUrl)
            // one ask per tag and map visit: load() waits for a slot and retries a transient failure itself
            if (picture == null && avatars != null && avatarUrl != null) LaunchedEffect(avatarUrl, avatars.visit) { avatars.load(avatarUrl) }
            if (picture != null) androidx.compose.foundation.Image(picture, null, Modifier.fillMaxSize(), filterQuality = FilterQuality.Low)
            else GameArt("army", Modifier.fillMaxSize())
        }
        HudText(name, if (selected) t.body else t.cap, color = HudStyle.text, line = 1f)
        if (level != null) HudText(level.toString(), t.body, color = HudStyle.goldHi, line = 1f)
    }
}

/** `.hud-place`: a curated place name over art, Silkscreen caps with a hard 8-way 1 dp ink outline (never a soft blur);
 *  [selected] adds the accent glow, [dim] is 60 %. Drawn as text layers, not shadows, so the outline is pixel-hard. */
@Composable internal fun HudPlaceText(name: String, selected: Boolean, dim: Boolean, modifier: Modifier = Modifier) {
    val t = LocalHudType.current; val accent = LocalHudAccent.current
    val style = hudTextStyle(t.place, family = HudDisplayFont, spacing = t.place * 0.08f, line = 1f)
    Box(modifier.then(if (dim) Modifier.drawWithContent { drawIntoCanvas { c -> c.saveLayer(Rect(Offset.Zero, size), Paint().apply { alpha = .6f }); drawContent(); c.restore() } } else Modifier)
        .clearAndSetSemantics { }) {
        val text = name.uppercase()
        for ((dx, dy) in OUTLINE) Text(text, Modifier.offset(dx.dp, dy.dp), style = style.copy(color = HudStyle.ink), maxLines = 1, softWrap = false)
        if (selected) Text(text, Modifier.offset(0.dp, 0.dp), style = style.copy(color = accent.acc, shadow = Shadow(accent.acc, Offset.Zero, 10f)), maxLines = 1, softWrap = false)
        Text(text, style = style.copy(color = if (selected) Color.White else HudStyle.text), maxLines = 1, softWrap = false)
    }
}
private val OUTLINE = listOf(1 to 0, -1 to 0, 0 to 1, 0 to -1, 1 to 1, -1 to 1, 1 to -1, -1 to -1, 0 to 2)

/** `.hud-display`: display caps in white, `text-shadow: 0 2px 0 INK, 0 0 18px var(--hud-acc-a), 0 0 42px var(--hud-acc-b)`.
 *  Compose draws one shadow per text, so the 18 px accent glow and the hard ink drop are text layers under the white
 *  one (only the white layer carries semantics). The faint 42 px `--hud-acc-b` halo is left out: it is the largest text
 *  blur on screen (≈ 94 px at 2.625 dppx) for a 24 % tint, and the HUD redraws with every moving GL frame (D-167.2). */
@Composable internal fun HudDisplayText(text: String, size: Float, modifier: Modifier = Modifier, maxLines: Int = 1, line: Float = 1.08f,
    spacing: Float = size * .04f) {
    val accent = LocalHudAccent.current
    val density = LocalDensity.current.density
    val caps = text.uppercase()
    val style = hudTextStyle(size, Color.White, spacing, line, HudDisplayFont)
    val glow = remember(accent, density, style) { style.copy(color = accent.a, shadow = Shadow(accent.a, Offset.Zero, cssBlurToSkiaRadius(18f * density))) }
    val drop = remember(style) { style.copy(color = HudStyle.ink) }
    Box(modifier) {
        Text(caps, Modifier.clearAndSetSemantics { }, style = glow, maxLines = maxLines, softWrap = maxLines > 1, overflow = TextOverflow.Ellipsis)
        Text(caps, Modifier.offset(0.dp, 2.dp).clearAndSetSemantics { }, style = drop, maxLines = maxLines, softWrap = maxLines > 1, overflow = TextOverflow.Ellipsis)
        Text(caps, style = style, maxLines = maxLines, softWrap = maxLines > 1, overflow = TextOverflow.Ellipsis)
    }
}

/** `.hud-avatar` (32 dp; `--lg` 56 dp, 40 dp in a short landscape): the art on the seat inside a 2 dp frame, gold when it
 *  is yours, with the 1 dp ink ring outside. */
@Composable internal fun HudAvatar(size: Dp, mine: Boolean, modifier: Modifier = Modifier, art: String = "profile", description: String? = null) {
    Box(modifier.size(size).drawBehind {
        val px = 1.dp.toPx()
        drawRect(HudStyle.ink, Offset(-px, -px), Size(this.size.width + 2 * px, this.size.height + 2 * px))
        drawRect(if (mine) HudStyle.gold else HudStyle.borderLt)
        drawRect(HudStyle.seat, Offset(2 * px, 2 * px), Size(this.size.width - 4 * px, this.size.height - 4 * px))
    }.padding(2.dp)) { GameArt(art, Modifier.fillMaxSize(), contentDescription = description) }
}

// ---- inputs ---------------------------------------------------------------------------------------------------------------

/** `.hud-input` search well with the scout icon, the field and the close button (search-on-IME, 96-char cap). */
@Composable internal fun HudSearchField(query: String, onChange: (String) -> Unit, onSubmit: () -> Unit, onClose: () -> Unit, placeholder: String,
    modifier: Modifier = Modifier, autoFocus: Boolean = true) {
    val t = LocalHudType.current
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    LaunchedEffect(autoFocus) { if (autoFocus) { androidx.compose.runtime.withFrameNanos { }; runCatching { focus.requestFocus() } } }
    Row(modifier.hudPlate(HudStyle.seat, HudStyle.bevelWell).blockSceneInput().padding(start = 9.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        HudIcon("scout")
        androidx.compose.foundation.text.BasicTextField(query, { if (it.length <= 96) onChange(it) },
            Modifier.weight(1f).focusRequester(focus).semantics { contentDescription = placeholder },
            textStyle = hudTextStyle(t.ui, HudStyle.text, line = 1f), singleLine = true, cursorBrush = SolidColor(HudStyle.gold),
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = { onSubmit() }),
            decorationBox = { inner -> Box(contentAlignment = Alignment.CenterStart) { if (query.isEmpty()) HudText(placeholder, t.ui, color = HudStyle.textFaint); inner() } })
        HudX(onClose, description = "Close search")
    }
}

/** `.hud-range`: a 44 dp tall track (6 dp ink) with the square gold-plate thumb; integer steps [min]..[max]. */
@Composable internal fun HudRange(value: Int, min: Int, max: Int, onChange: (Int) -> Unit, description: String, modifier: Modifier = Modifier) {
    var width by remember { mutableFloatStateOf(1f) }
    fun at(x: Float) = (min + ((x / width).coerceIn(0f, 1f) * (max - min) + 0.5f).toInt()).coerceIn(min, max)
    Canvas(modifier.height(44.dp).onSizeChangedPx { width = it.toFloat().coerceAtLeast(1f) }.blockSceneInput()
        .semantics {
            contentDescription = description
            progressBarRangeInfo = ProgressBarRangeInfo(value.toFloat(), min.toFloat()..max.toFloat(), max - min - 1)
            setProgress { v -> onChange(v.toInt().coerceIn(min, max)); true }
        }
        .pointerInputDrag { x -> onChange(at(x)) }) {
        val px = 1.dp.toPx(); val cy = size.height / 2
        drawRect(HudStyle.ink, Offset(0f, cy - 3 * px), Size(size.width, 6 * px))
        drawRect(HudStyle.field, Offset(px, cy - 2 * px), Size(size.width - 2 * px, px))
        val k = (value - min).toFloat() / (max - min).coerceAtLeast(1)
        val tx = (k * (size.width - 16 * px)); val thumbTop = cy - 14 * px
        drawRect(HudStyle.ink, Offset(tx, thumbTop), Size(16 * px, 28 * px))
        drawRect(HudStyle.gold, Offset(tx + px, thumbTop + px), Size(14 * px, 26 * px))
        bevelRows(HudStyle.bevelGold, tx + px, thumbTop + px, tx + 15 * px, thumbTop + 27 * px)
    }
}
private fun Modifier.onSizeChangedPx(block: (Int) -> Unit) = this.onSizeChanged { block(it.width) }
private fun Modifier.pointerInputDrag(onX: (Float) -> Unit) = this.pointerInput(Unit) {
    awaitEachGesture {
        val down = awaitFirstDown(); onX(down.position.x); down.consume()
        while (true) { val e = awaitPointerEvent(); val c = e.changes.firstOrNull() ?: break; if (!c.pressed) break; onX(c.position.x); c.consume() }
    }
}
