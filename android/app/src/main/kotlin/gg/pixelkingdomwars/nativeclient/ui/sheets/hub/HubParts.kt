package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.sealAccepts
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay

/**
 * Design component: the hub's row-level parts (design/final/hub/SPEC.md §1): SectionHeader, CardRow (+ variants), Well,
 * Chevron, Tag, FilterChip strip, StatCard, Pips, DoorButton, Toggle + ToggleRow, TextField / TextArea, RankMedal,
 * RewardStage, Skeleton, ErrorRow (§3.6), the drawn back chevron and envelope (§4 drawn shapes) and the destructive
 * ConfirmDialog (§3.3). All are compositions of kit plates, kit stepped-shape drawing and kit buttons ([ChunkyBox]).
 *
 * Pointer rule: every part here draws its own painted shell and is a touch target only where it is a control. None is
 * full-screen; the ConfirmDialog's scrim is composed only while a [ConfirmUi] is shown.
 */

/** A drawn pixel chevron, 5 × 7 cells ("<" pointing left; mirrored for ">"). */
private val CHEVRON_CELLS = listOf("...##", "..##.", ".##..", "##...", ".##..", "..##.", "...##")

private fun DrawScope.drawChevron(color: Color, pointsRight: Boolean, cellPx: Float) {
    val x0 = ((size.width - 5 * cellPx) / 2f).toInt().toFloat()
    val y0 = ((size.height - 7 * cellPx) / 2f).toInt().toFloat()
    CHEVRON_CELLS.forEachIndexed { y, row ->
        row.forEachIndexed { x, cell ->
            if (cell == '#') {
                val cx = if (pointsRight) 4 - x else x
                drawRect(color, Offset(x0 + cx * cellPx, y0 + y * cellPx), Size(cellPx, cellPx))
            }
        }
    }
}

/** The stone Back 48 with the drawn chevron (SPEC §1 CompactHeader). */
@Composable fun BackSquare(onBack: () -> Unit, modifier: Modifier = Modifier, contentDescription: String = "Back") {
    ChunkyBox(PkwTokens.Colors.stone, onBack, contentDescription, modifier.size(PkwTokens.Dims.minTap)) {
        Canvas(Modifier.size(24.dp)) { drawChevron(PkwTokens.Colors.label, pointsRight = false, cellPx = (3.dp.toPx()).toInt().coerceAtLeast(1).toFloat()) }
    }
}

/** The 12 × 16 row Chevron in `#6E5034` (SPEC §1): marks a row that opens a page, not a place. Decorative. */
@Composable fun RowChevron(modifier: Modifier = Modifier) {
    Canvas(modifier.size(12.dp, 16.dp)) { drawChevron(PkwTokens.Colors.textOnParch2, pointsRight = true, cellPx = (2.dp.toPx()).toInt().coerceAtLeast(1).toFloat()) }
}

/**
 * The drawn envelope (SPEC §2.4 title 30 × 22, §3.5 empty state 96 × 68): cream body, `#C4A464` flap, red seal. No
 * authored envelope art exists. [alpha] 0.4 for the empty state.
 */
@Composable fun EnvelopeGlyph(modifier: Modifier = Modifier, alpha: Float = 1f) {
    Canvas(modifier) {
        val w = size.width; val h = size.height
        val rim = (w / 30f).coerceAtLeast(1f)
        drawRect(PkwTokens.Colors.ink, alpha = alpha)
        drawRect(PkwTokens.Colors.cream, Offset(rim, rim), Size(w - 2 * rim, h - 2 * rim), alpha = alpha)
        val flap = Path().apply { moveTo(rim, rim); lineTo(w / 2f, h * 0.55f); lineTo(w - rim, rim); close() }
        drawPath(flap, PkwTokens.Colors.parchmentLo, alpha = alpha)
        val seal = (w * 0.2f).coerceAtLeast(4f)
        drawRect(PkwTokens.Colors.red.face, Offset(w / 2f - seal / 2f, h * 0.55f - seal / 2f), Size(seal, seal), alpha = alpha)
        drawRect(PkwTokens.Colors.creamLo, Offset(rim, h - rim - 3 * rim), Size(w - 2 * rim, 2 * rim), alpha = alpha)
    }
}

/** A SectionHeader (SPEC §1): PS 12 on parchment, a VT 18 note on the baseline, an optional right column label. */
@Composable fun SectionHeader(title: String, modifier: Modifier = Modifier, note: String? = null, right: String? = null,
    titleColor: Color = PkwTokens.Colors.textOnParch) {
    Row(modifier.fillMaxWidth().padding(top = 10.dp, bottom = 4.dp).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PkwText(title, PkwTokens.Type.label, color = titleColor)
        if (note != null) PkwText(note, PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch2)
        else Spacer(Modifier.weight(1f))
        if (right != null) PkwText(right, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    }
}

/**
 * The round-2 "Section line" (SPEC R2.1 YOUR STREAK, R2.2 TODAY; daily-cache.html / event.html `.secline`): the PS 11 ink
 * title, a 2 dp parchment-dark (`#C9A86A`) rule across the free width, and an optional PS 11 `#8F5A12` (gold lip) value at
 * the right ("120 / 300"). Gap 6, margin 8 above and 6 below.
 */
@Composable internal fun HubSectionLine(title: String, modifier: Modifier = Modifier, right: String? = null) {
    Row(modifier.fillMaxWidth().padding(top = 8.dp, bottom = 6.dp).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        PkwText(title, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
        Box(Modifier.weight(1f).height(2.dp).background(PkwTokens.Colors.parchmentLo))
        if (right != null) PkwText(right, PkwTokens.Type.caption, color = PkwTokens.Colors.gold.lo)
    }
}

/** CardRow variants (SPEC §1). */
enum class RowVariant { PLAIN, READY, YOU, UNREAD, DIM, ERROR }

/**
 * A CardRow (SPEC §1): ink S shell with a 2 dp rim, cream body with a 3 dp `#E6CF94` bottom band, padding L6 R10, gap 8.
 * With [onClick] the whole row is the target (then it must hold no other control) and [description] is what a screen
 * reader says; without it the row is paint only and its own controls take the taps.
 */
@Composable fun CardRow(
    modifier: Modifier = Modifier,
    variant: RowVariant = RowVariant.PLAIN,
    height: Dp = 56.dp,
    onClick: (() -> Unit)? = null,
    description: String? = null,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    val c = PkwTokens.Colors
    val face = when (variant) {
        RowVariant.PLAIN -> c.cream
        RowVariant.READY -> HubColors.rowReady
        RowVariant.YOU, RowVariant.UNREAD -> c.selectedTint
        RowVariant.DIM -> HubColors.rowDim
        RowVariant.ERROR -> HubColors.errorFace
    }
    val rim = when (variant) {
        RowVariant.READY -> c.green.face
        RowVariant.YOU -> c.gold.face
        RowVariant.ERROR -> c.blood
        else -> null
    }
    val tap = if (onClick == null) Modifier else Modifier
        .clearAndSetSemantics {
            if (description != null) contentDescription = description
            role = Role.Button
            if (!enabled) disabled()
            this.onClick(label = null, action = { if (enabled) onClick(); enabled })
        }
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
    Row(modifier.fillMaxWidth().heightIn(min = maxOf(height, PkwTokens.Dims.minTap)).then(tap).drawBehind {
        val w = size.width; val h = size.height; val i = 2.dp.toPx()
        fillStepped(0f, 0f, w, h, CornerProfiles.S, if (variant == RowVariant.ERROR) c.blood else c.ink)
        insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
            drawRect(face)
            band(i, w - i, h - i - 3.dp.toPx(), 3.dp.toPx(), c.creamLo)
            if (rim != null && variant != RowVariant.ERROR) {
                val r = 3.dp.toPx()
                drawRect(rim, Offset(i, i), Size(w - 2 * i, r))
                drawRect(rim, Offset(i, h - i - r), Size(w - 2 * i, r))
                drawRect(rim, Offset(i, i), Size(r, h - 2 * i))
                drawRect(rim, Offset(w - i - r, i), Size(r, h - 2 * i))
            }
        }
    }.padding(start = 8.dp, end = 12.dp, top = 6.dp, bottom = 7.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp), content = content)
}

/** The VT 20 title + VT 18 sub-line column of a CardRow (one line each, ellipsis). */
@Composable fun RowScope.RowText(title: String, sub: String?, modifier: Modifier = Modifier, subColor: Color = PkwTokens.Colors.textOnParch2,
    titleColor: Color = PkwTokens.Colors.textOnParch, trailing: (@Composable RowScope.() -> Unit)? = null) {
    Column(modifier.weight(1f)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PkwText(title, PkwTokens.Type.body, Modifier.weight(1f, fill = false), color = titleColor)
            trailing?.invoke(this)
        }
        if (sub != null) PkwText(sub, PkwTokens.Type.small, color = subColor)
    }
}

/**
 * A Well (SPEC §1): a 44 dp square with a 2 dp ink border. Dark `#2A2430` for portraits and objects; [light] `#E9D7A6`
 * with a `#B89A5A` border for icons. Draws [icon] at [iconSize], or [content].
 */
@Composable fun Well(icon: String?, modifier: Modifier = Modifier, size: Dp = 44.dp, light: Boolean = false, iconSize: Dp = 32.dp,
    alpha: Float = 1f, content: (@Composable BoxScope.() -> Unit)? = null) {
    Box(modifier.size(size).background(if (light) HubColors.wellLightBorder else PkwTokens.Colors.ink).padding(2.dp)
        .background(if (light) HubColors.wellLight else HubColors.wellDark), contentAlignment = Alignment.Center) {
        if (content != null) content() else if (icon != null) HubArt(icon, iconSize, alpha = alpha)
    }
}

/**
 * A hub Tag (SPEC §1): 22 tall (30 with [tall], the row-end status), ink S shell, [verb] fill, PS 11 white outlined; ink
 * text on gold and on [lime] (SEEKER #n). [dots] draws the stone busy dots before the word (PENDING, a claiming row);
 * [icon] draws a 24 / 32 dp icon before it (the chat system lines).
 * Not a button. (The kit Tag always outlines in white; the hub SPEC needs ink on gold and lime.)
 */
@Composable fun StatusTag(text: String, verb: Verb, modifier: Modifier = Modifier, tall: Boolean = false, lime: Boolean = false, dots: Boolean = false,
    icon: String? = null) {
    val ramp = PkwTokens.ramp(verb)
    val face = if (lime) HubColors.lime else ramp.face
    val hi = if (lime) HubColors.limeHi else ramp.hi
    val inkText = lime || verb == Verb.GOLD
    Row(modifier.heightIn(min = if (tall) 30.dp else 22.dp).drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx()
        insideStepped(i, i, size.width - i, size.height - i, CornerProfiles.S) {
            drawRect(face)
            band(i, size.width - i, i, 2.dp.toPx(), hi)
        }
    }.padding(horizontal = 7.dp, vertical = 1.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        if (dots) BusyDots()
        if (icon != null) HubArt(icon, if (icon.startsWith("ui:") || icon.startsWith("itm_")) 32.dp else 24.dp)
        if (inkText) PkwText(text, PkwTokens.Type.caption, color = PkwTokens.Colors.ink)
        else PkwText(text, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
    }
}

/**
 * The FilterChip strip (SPEC §1): 48 tall chips, ink S shell, cream face with a 3 dp bottom band; the active chip is gold
 * with ink text. The strip scrolls sideways (the last chip peeks). Each chip is its own ≥ 48 dp target; single select.
 */
@Composable fun FilterChipStrip(chips: List<FilterChipUi>, selected: String?, onSelect: (String) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        chips.forEach { chip -> FilterChip(chip, chip.id == selected) { onSelect(chip.id) } }
    }
}

@Composable private fun FilterChip(ui: FilterChipUi, active: Boolean, onClick: () -> Unit) {
    val c = PkwTokens.Colors
    val spoken = ui.description.ifBlank { listOfNotNull(ui.label, ui.count, ui.badge?.description).joinToString(", ") } +
        if (ui.locked) ", locked" else ""
    Row(Modifier.defaultMinSize(minWidth = PkwTokens.Dims.minTap, minHeight = PkwTokens.Dims.minTap)
        .clearAndSetSemantics { contentDescription = spoken; role = Role.Tab; selected = active; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Tab, onClick = onClick)
        .drawBehind {
            val w = size.width; val h = size.height; val i = 2.dp.toPx()
            fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
            insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                // SPEC §1 Locked tab: face #4E4038 with a #6A5A4C band; it never reads as a live filter.
                drawRect(when { ui.locked -> LOCKED_CHIP_FACE; active -> c.gold.face; else -> c.cream })
                band(i, w - i, h - i - 3.dp.toPx(), 3.dp.toPx(), when { ui.locked -> LOCKED_CHIP_BAND; active -> c.gold.mid; else -> c.creamLo })
            }
        }.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ui.icon?.let { PkwIcon(it, if (it.startsWith("ui:")) 32.dp else 24.dp, alpha = if (ui.locked) 0.5f else 1f) }
        if (ui.locked) PkwIcon("shape:lock", 14.dp, tint = LOCKED_CHIP_TEXT)
        PkwText(ui.label, PkwTokens.Type.caption, color = if (ui.locked) LOCKED_CHIP_TEXT else c.textOnParch)
        val badge = ui.badge
        if (badge != null) Badge(badge) else ui.count?.let { PkwText(it, PkwTokens.Type.caption, color = c.textOnParch) }
    }
}

/** SPEC §1 Locked tab colours (face, band, label), used by a locked FilterChip. */
private val LOCKED_CHIP_FACE = Color(0xFF4E4038)
private val LOCKED_CHIP_BAND = Color(0xFF6A5A4C)
private val LOCKED_CHIP_TEXT = Color(0xFFB9AD9A)

/** A StatCard (SPEC §1): a CreamCard 78 tall, a third of the row. With [onClick] it is a button described by [description]. */
@Composable fun StatCard(modifier: Modifier = Modifier, description: String, onClick: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    val tap = if (onClick == null) Modifier.clearAndSetSemantics { contentDescription = description }
    else Modifier.clearAndSetSemantics { contentDescription = description; role = Role.Button; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Button, onClick = onClick)
    Plate(PlateKind.CREAM, modifier.heightIn(min = 78.dp).then(tap), blocksScene = false) {
        Column(Modifier.align(Alignment.Center).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp), content = content)
    }
}

/**
 * Pips (SPEC §1): a segmented meter, 14 tall (18 in reward cards), 3 dp gaps, ink cells; filled = gold with a 2 dp
 * `#FBE7A8` highlight, empty = `#3A2F28`. [fills] comes from [pipFills]. With [animate] filled cells pop in with a 40 ms
 * stagger (SPEC §2.2); never with reduced motion.
 */
@Composable fun Pips(fills: List<Boolean>, description: String, modifier: Modifier = Modifier, height: Dp = 14.dp, animate: Boolean = false) {
    val reduced = LocalReducedMotion.current
    val still = !animate || reduced || LocalInspectionMode.current
    Row(modifier.fillMaxWidth().height(height).clearAndSetSemantics { contentDescription = description },
        horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        fills.forEachIndexed { index, filled ->
            val pop = remember { Animatable(if (still || !filled) 1f else 0f) }
            if (!still && filled) LaunchedEffect(Unit) {
                delay(index.toLong() * HubMotion.PIP_STAGGER)
                pop.animateTo(1f, tween(PkwTokens.Motion.BADGE_POP, easing = PkwTokens.Motion.Pop))
            }
            Canvas(Modifier.weight(1f).fillMaxHeight()) {
                val i = 2.dp.toPx()
                drawRect(PkwTokens.Colors.ink)
                drawRect(PkwTokens.Colors.track, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
                if (filled) {
                    val s = pop.value.coerceIn(0f, 1.2f)
                    val w = (size.width - 2 * i) * s; val h = (size.height - 2 * i) * s
                    val l = (size.width - w) / 2f; val t = (size.height - h) / 2f
                    drawRect(PkwTokens.Colors.gold.face, Offset(l, t), Size(w, h))
                    drawRect(HubColors.pipHi, Offset(l, t), Size(w, minOf(2.dp.toPx(), h)))
                }
            }
        }
    }
}

/**
 * A DoorButton (SPEC §1): a 68 × 68 chunky face (stone = opens a page, blue = flies to a place, charcoal + padlock =
 * locked), a 36 / 32 dp [icon], and a PS 11 ink caption 5 dp below. A locked door still calls back so the caller can say
 * why.
 */
@Composable fun DoorButton(icon: String, label: String, verb: Verb, onClick: () -> Unit, modifier: Modifier = Modifier,
    locked: Boolean = false, badge: BadgeUi? = null, description: String = label) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box {
            ChunkyBox(PkwTokens.ramp(if (locked) Verb.CHARCOAL else verb), onClick, description, Modifier.size(68.dp)) {
                Box(contentAlignment = Alignment.Center) {
                    HubArt(icon, if (icon.startsWith("ui:") || icon.startsWith("itm_")) 32.dp else 36.dp, alpha = if (locked) 0.45f else 1f)
                    if (locked) PkwIcon("shape:lock", 24.dp, tint = PkwTokens.Colors.gold.face)
                }
            }
            if (badge != null) Badge(badge, Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp))
        }
        PkwText(label, PkwTokens.Type.caption, Modifier.padding(top = 5.dp), color = PkwTokens.Colors.textOnParch)
    }
}

/**
 * The Toggle (SPEC §1): 76 × 36, ink S shell. ON: green face, "ON" left, cream knob right. OFF: `#403C48`, knob left,
 * "OFF" right. Disabled: `#B9AE95`. The knob slides 90 ms `out`, the face cross-fades 90 ms. Paint only: the ToggleRow
 * is the target.
 */
@Composable fun ToggleSwitch(on: Boolean, enabled: Boolean, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val ms = if (reduced) 0 else PkwTokens.Motion.RELEASE
    val face by animateColorAsState(when { !enabled -> HubColors.toggleDisabled; on -> PkwTokens.Colors.green.face; else -> HubColors.toggleOff },
        tween(ms), label = "toggleFace")
    val knobX by animateDpAsState(if (on) 46.dp else 6.dp, tween(ms, easing = PkwTokens.Motion.Out), label = "toggleKnob")
    Box(modifier.size(76.dp, 36.dp).clearAndSetSemantics { }.drawBehind {
        val w = size.width; val h = size.height; val i = 2.dp.toPx()
        fillStepped(0f, 0f, w, h, CornerProfiles.S, PkwTokens.Colors.ink)
        insideStepped(i, i, w - i, h - i, CornerProfiles.S) { drawRect(face); band(i, w - i, i, 2.dp.toPx(), Color.White.copy(alpha = 0.18f)) }
    }) {
        Box(Modifier.offset(x = knobX, y = 6.dp).size(24.dp).background(PkwTokens.Colors.ink).padding(2.dp).background(PkwTokens.Colors.cream))
        val word = if (on) "ON" else "OFF"
        val textColor = if (enabled) PkwTokens.Colors.label else PkwTokens.Colors.textOnParch2
        PkwText(word, PkwTokens.Type.caption, Modifier.align(if (on) Alignment.CenterStart else Alignment.CenterEnd)
            .padding(start = 8.dp, end = 8.dp), color = textColor, outline = if (enabled) 1.dp else 0.dp)
    }
}

/**
 * A ToggleRow (SPEC §1, §2.6): CardRow 60, VT 20 [title] + VT 18 [consequence] and the Toggle. A tap anywhere on the row
 * toggles; the text always states the state. [disabledReason] non-null = DISABLED: the sub-line says why in danger, and
 * a tap calls [onDisabled] (e.g. open the Android settings) instead of flipping.
 */
@Composable fun ToggleRow(title: String, consequence: String?, on: Boolean, onToggle: (Boolean) -> Unit, modifier: Modifier = Modifier,
    disabledReason: String? = null, onDisabled: () -> Unit = {}) {
    val enabled = disabledReason == null
    val sub = disabledReason ?: consequence
    val spoken = listOfNotNull(title, if (on) "on" else "off", sub).joinToString(". ")
    Row(modifier.fillMaxWidth().heightIn(min = 60.dp)
        .clearAndSetSemantics {
            contentDescription = spoken; role = Role.Switch; toggleableState = ToggleableState(on)
            if (!enabled) disabled()
            this.onClick(label = null, action = { if (enabled) onToggle(!on) else onDisabled(); true })
        }
        .clickable(role = Role.Switch) { if (enabled) onToggle(!on) else onDisabled() }) {
        CardRow(height = 60.dp) {
            RowText(title, sub, subColor = if (enabled) PkwTokens.Colors.textOnParch2 else PkwTokens.Colors.danger)
            ToggleSwitch(on, enabled)
        }
    }
}

/**
 * The TextField (52 tall) / TextArea (176 tall) (SPEC §1): ink S shell, `#FFFAF0` face, 3 dp `#E6D6AE` top inset, VT 20
 * ink, placeholder `#A08C6A`, PS 11 counter bottom-right. [label] is what a screen reader calls the field.
 */
@Composable fun HubTextField(value: String, onValueChange: (String) -> Unit, label: String, modifier: Modifier = Modifier,
    placeholder: String = "", counter: String? = null, area: Boolean = false, enabled: Boolean = true) {
    val c = PkwTokens.Colors
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth().height(if (area) 176.dp else 52.dp).semantics { contentDescription = label },
        enabled = enabled,
        singleLine = !area,
        textStyle = PkwTokens.Type.body.copy(color = c.textOnParch),
        cursorBrush = SolidColor(c.ink),
        decorationBox = { inner ->
            Box(Modifier.fillMaxWidth().fillMaxHeight().drawBehind {
                val w = size.width; val h = size.height; val i = 2.dp.toPx()
                fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
                insideStepped(i, i, w - i, h - i, CornerProfiles.S) { drawRect(HubColors.fieldFace); band(i, w - i, i, 3.dp.toPx(), HubColors.fieldInset) }
            }.padding(start = 12.dp, end = 12.dp, top = if (area) 10.dp else 0.dp, bottom = if (area) 26.dp else 0.dp),
                contentAlignment = if (area) Alignment.TopStart else Alignment.CenterStart) {
                if (value.isEmpty() && placeholder.isNotEmpty()) PkwText(placeholder, PkwTokens.Type.body, color = HubColors.placeholder)
                Box(Modifier.fillMaxWidth().padding(end = if (!area && counter != null) 64.dp else 0.dp)) { inner() }
                if (counter != null) PkwText(counter, PkwTokens.Type.caption,
                    Modifier.align(Alignment.BottomEnd).offset(y = if (area) 20.dp else (-12).dp), color = HubColors.placeholder)
            }
        },
    )
}

/** A RankMedal (SPEC §1): 34 dp ink S shell, gold / silver / bronze for 1-3; rank 4+ is PS 12 `#6E5034` text, 40 wide. */
@Composable fun RankMedal(rank: Int?, text: String, modifier: Modifier = Modifier) {
    val tone = medalTone(rank)
    if (tone == MedalTone.NONE) {
        Box(modifier.width(40.dp), contentAlignment = Alignment.Center) { PkwText(text, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch2) }
        return
    }
    val (face, lip) = when (tone) {
        MedalTone.GOLD -> PkwTokens.Colors.gold.face to PkwTokens.Colors.gold.lo
        MedalTone.SILVER -> HubColors.medalSilverFace to HubColors.medalSilverLip
        else -> HubColors.medalBronzeFace to HubColors.medalBronzeLip
    }
    Box(modifier.width(40.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(34.dp).drawBehind {
            val w = size.width; val h = size.height; val i = 2.dp.toPx()
            fillStepped(0f, 0f, w, h, CornerProfiles.S, PkwTokens.Colors.ink)
            insideStepped(i, i, w - i, h - i, CornerProfiles.S) { drawRect(face); band(i, w - i, h - i - 3.dp.toPx(), 3.dp.toPx(), lip) }
        }, contentAlignment = Alignment.Center) { PkwText(text, PkwTokens.Type.caption, color = PkwTokens.Colors.ink) }
    }
}

/**
 * The RewardStage (SPEC §1, §2.4): a dark `#1A120E` well, 3 dp ink border, stepped gold sunrays (turning 8°/s with
 * [turning], never with reduced motion), the PS 11 "INSIDE" label and cream tiles (icon 36 + count) centred. [tileAlpha]
 * 0.45 for an expired reward. Paint only.
 */
@Composable fun RewardStage(tiles: List<ItemTileUi>, modifier: Modifier = Modifier, label: String = "INSIDE", turning: Boolean = true, tileAlpha: Float = 1f) {
    val reduced = LocalReducedMotion.current
    val inspection = LocalInspectionMode.current
    val spinning = turning && !reduced && !inspection
    val degrees by produceState(0f, spinning) {
        if (!spinning) return@produceState
        val start = System.nanoTime()
        while (true) {
            delay(1000L / 15L)
            value = ((System.nanoTime() - start) / 1_000_000_000f * PkwTokens.Motion.RAYS_DEG_PER_S) % 360f
        }
    }
    Box(modifier.fillMaxWidth().heightIn(min = 132.dp).background(PkwTokens.Colors.ink).padding(3.dp)
        .drawBehind { drawSunrayStage(Offset(size.width / 2f, size.height / 2f), degrees, HubColors.stageBottom, HubColors.stageBottom) }
        .clearAndSetSemantics { contentDescription = "$label: " + tiles.joinToString(", ") { it.description } }) {
        PkwText(label, PkwTokens.Type.caption, Modifier.padding(start = 8.dp, top = 4.dp), color = PkwTokens.Colors.gold.hi, outline = 1.dp)
        Row(Modifier.align(Alignment.Center).padding(top = 22.dp, bottom = 10.dp).graphicsLayer { alpha = tileAlpha },
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            tiles.forEach { tile ->
                Plate(PlateKind.CREAM, Modifier.widthIn(min = 72.dp, max = 104.dp).height(84.dp), blocksScene = false) {
                    Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        HubArt(tile.icon, 36.dp)
                        PkwText(tile.count, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
                    }
                }
            }
        }
    }
}

/**
 * A Skeleton block (SPEC §1): a flat `#DCCAA0` (dark `#CDB98B`) block inside the real component shell, with a stepped
 * opacity pulse 1.0 → 0.6 → 1.0 in 600 ms steps (no shimmer; none with reduced motion). Decorative.
 */
@Composable fun SkeletonBlock(modifier: Modifier = Modifier, dark: Boolean = false) {
    val reduced = LocalReducedMotion.current
    val inspection = LocalInspectionMode.current
    val low by produceState(false, reduced, inspection) {
        if (reduced || inspection) return@produceState
        while (true) { delay(HubMotion.SKELETON_STEP.toLong()); value = !value }
    }
    Box(modifier.clearAndSetSemantics { }.graphicsLayer { alpha = if (low) HubMotion.SKELETON_LOW_ALPHA else 1f }
        .background(if (dark) HubColors.skeletonDark else HubColors.skeleton))
}

/** A loading CardRow: a skeleton Well, two text bars and a value bar inside the real row shell (leagues-loading.png). */
@Composable fun SkeletonRow(modifier: Modifier = Modifier, height: Dp = 62.dp) {
    CardRow(modifier, height = height) {
        SkeletonBlock(Modifier.size(44.dp), dark = true)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SkeletonBlock(Modifier.fillMaxWidth(0.7f).height(14.dp))
            SkeletonBlock(Modifier.fillMaxWidth(0.45f).height(12.dp))
        }
        SkeletonBlock(Modifier.width(96.dp).height(26.dp))
    }
}

/** The underlined red "Report" link (SPEC §3.6): VT 18, a 48 dp target. Opens Feedback, prefilled. */
@Composable fun ReportLink(onReport: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.defaultMinSize(PkwTokens.Dims.minTap, PkwTokens.Dims.minTap)
        .clearAndSetSemantics { contentDescription = "Report this problem"; role = Role.Button; this.onClick(label = null, action = { onReport(); true }) }
        .clickable(role = Role.Button, onClick = onReport), contentAlignment = Alignment.CenterStart) {
        PkwText("Report", PkwTokens.Type.small.copy(textDecoration = TextDecoration.Underline), color = PkwTokens.Colors.shortText)
    }
}

/** A stone button that shows busy dots while [busy] (RETRY, CHECK AGAIN). Busy never calls back. */
@Composable fun StoneBusyButton(label: String, busy: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, sub: String? = null) {
    ChunkyBox(PkwTokens.Colors.stone, onClick, if (busy) "$label, working" else listOfNotNull(label, sub).joinToString(". "),
        modifier.heightIn(min = 48.dp), enabled = !busy) {
        if (busy) BusyDots()
        else Column(horizontalAlignment = Alignment.CenterHorizontally) {
            PkwText(label, PkwTokens.Type.label, color = PkwTokens.Colors.label, outline = 1.dp)
            if (sub != null) PkwText(sub, PkwTokens.Type.small, color = PkwTokens.Colors.text)
        }
    }
}

/**
 * The ErrorRow (SPEC §3.6): a CardRow with a blood rim on `#FDE3D8`, `pkw_web_alert` at 32, VT 20 what failed, VT 18 what
 * is kept / safe + the red Report link, and a stone RETRY 96 × 48 (dots while retrying). Kept data stays below it.
 */
@Composable fun ErrorRow(error: LoadState.Error, onRetry: () -> Unit, onReport: () -> Unit, modifier: Modifier = Modifier) {
    val kept = listOfNotNull(error.asOf?.let { "Showing the list from $it." }, error.safeLine).joinToString(" ").ifBlank { null }
    CardRow(modifier, variant = RowVariant.ERROR, height = 72.dp) {
        HubArt("alert", 32.dp)
        Column(Modifier.weight(1f)) {
            PkwText(error.message, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = 2)
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (kept != null) PkwText(kept, PkwTokens.Type.small, Modifier.weight(1f, fill = false), color = PkwTokens.Colors.textOnParch2, maxLines = 2)
                ReportLink(onReport, Modifier.padding(start = 6.dp))
            }
        }
        StoneBusyButton("RETRY", error.retrying, onRetry, Modifier.width(96.dp))
    }
}

/**
 * The destructive ConfirmDialog (SPEC §3.3): a centred WoodFrame (x 24..388) over a 55 % scrim, PS 13 question, the
 * from → to picture, the consequence lines, stone BACK 100 and the [ConfirmUi.tone] primary 56 tall. The primary ignores
 * taps for 300 ms after it opens; Back and a scrim tap are BACK, never confirm. Enter 0.96 → 1 + fade 160 ms, exit 120.
 *
 * Pass the dialog to show, or null (it animates out). Money never uses this: that is the kit `Seal`.
 * Pointer rule: the scrim is composed only while a dialog is shown (it is the modal's own scrim).
 */
@Composable fun HubConfirmDialog(ui: ConfirmUi?, onConfirm: () -> Unit, onBack: () -> Unit, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }) {
    Presence(ui, PkwTokens.Motion.SEAL_IN, PkwTokens.Motion.SEAL_OUT) { shown, progress, active, reduced ->
        val openedAt = remember(shown) { clock() }
        Box(modifier.fillMaxWidth().fillMaxHeight(), contentAlignment = Alignment.Center) {
            ModalScrim(PkwTokens.Scrim.SEAL * progress(), onTap = { if (active) onBack() })
            Plate(PlateKind.WOOD, Modifier.padding(horizontal = 24.dp).widthIn(max = 364.dp).fillMaxWidth()
                .graphicsLayer {
                    val p = progress()
                    alpha = p
                    val s = if (reduced) 1f else 0.96f + 0.04f * p
                    scaleX = s; scaleY = s
                }) {
                Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                    Column(Modifier.fillMaxWidth().padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        PkwText(shown.title, PkwTokens.Type.title, Modifier.semantics { heading() }, color = PkwTokens.Colors.textOnParch,
                            textAlign = TextAlign.Center, maxLines = 2)
                        if (shown.fromIcon != null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Well(shown.fromIcon, size = 64.dp, iconSize = 56.dp)
                            if (shown.toIcon != null) {
                                PkwIcon("shape:go", 24.dp, tint = PkwTokens.Colors.textOnParch)
                                Well(shown.toIcon, size = 64.dp, light = true, iconSize = 56.dp)
                            }
                        }
                        PkwText(shown.line, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center, maxLines = 3)
                        shown.subLine?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center, maxLines = 2) }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            SecondaryButton(shown.backLabel, { if (active) onBack() }, Modifier.width(100.dp))
                            ChunkyBox(PkwTokens.ramp(shown.tone), {
                                if (active && sealAccepts(clock(), openedAt, PkwTokens.Motion.TAP_THROUGH_LOCK)) onConfirm()
                            }, shown.confirmLabel, Modifier.weight(1f).heightIn(min = 56.dp), enabled = active) {
                                PkwText(shown.confirmLabel, PkwTokens.Type.primary, color = PkwTokens.Colors.label, outline = 2.dp)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Preview(name = "Hub parts", widthDp = 412, heightDp = 880)
@Composable private fun HubPartsPreview() {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionHeader("RIGHT NOW", note = "GO flies you there")
        CardRow(variant = RowVariant.READY) { Well("keep", iconSize = 36.dp); RowText("Ready to claim: 1,240 KEEP", "Gold Forge · to your wallet"); StatusTag("CLAIM", Verb.GREEN, tall = true) }
        CardRow(variant = RowVariant.YOU) { Well("league-gold", iconSize = 40.dp); RowText("Gold league", "216 to Sol") { StatusTag("YOU", Verb.GOLD) } }
        CardRow(variant = RowVariant.DIM, onClick = {}, description = "Upgrade any building, done") { Well("ui:workshop-menu", light = true); RowText("Upgrade any building", "1/1"); RowChevron() }
        FilterChipStrip(listOf(FilterChipUi("ALL", "ALL", count = "8"), FilterChipUi("REWARDS", "REWARDS", badge = BadgeUi("2", BadgeTone.REWARD, "2 rewards")),
            FilterChipUi("NEWS", "NEWS")), "ALL", {})
        Pips(pipFills(3, 5) ?: emptyList(), "3 of 5 wins", height = 18.dp)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            DoorButton("trophy", "LEAGUE", Verb.STONE, {})
            DoorButton("itm_banner", "CLAN", Verb.BLUE, {}, badge = BadgeUi("4", BadgeTone.COUNT, "4 unread"))
            DoorButton("itm_banner", "CLAN", Verb.BLUE, {}, locked = true)
            Column { RankMedal(1, "1"); RankMedal(2, "2"); RankMedal(214, "214") }
        }
        ToggleRow("Sound effects", "Taps, building and battle sounds", true, {})
        ToggleRow("Haptics", "Vibration", false, {}, disabledReason = "Off in Android settings")
        HubTextField("Claim button stays grey", {}, "Title", counter = "23/80")
        ErrorRow(LoadState.Error("Can't reach the league board.", asOf = "14:02"), {}, {})
        SkeletonRow()
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusTag("SEEKER #142", Verb.GOLD, lime = true); StatusTag("PENDING", Verb.STONE, tall = true, dots = true)
            EnvelopeGlyph(Modifier.size(30.dp, 22.dp)); BackSquare({})
        }
    }
}

@Preview(name = "Confirm dialog (leave clan)", widthDp = 412, heightDp = 600)
@Composable private fun HubConfirmPreview() {
    Box(Modifier.fillMaxWidth().height(600.dp).background(PkwTokens.Colors.wood)) {
        HubConfirmDialog(ConfirmUi("LEAVE IRON WARDENS?", "ui_portrait_clanhall_t2", "ui_portrait_keep_t3",
            "You lose your share of this week's chest.", "Your kingdom and trophies stay.", "LEAVE CLAN"), {}, {})
    }
}
