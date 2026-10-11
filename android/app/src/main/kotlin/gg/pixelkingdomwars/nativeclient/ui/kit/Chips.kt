package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.TimerUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay

/**
 * Design component: the small readouts of DESIGN-SYSTEM §6: ResourceChip (one 26 dp row of the top-right stack) and
 * [ResourceStack] (the stack as one hit region), CostPill ([PriceChip]), [TimerChip], [Badge] and the state [Tag].
 *
 * Pointer rule: a chip draws only its own plate. The resource rows are 26 dp, under the 48 dp minimum, so they are never
 * individual touch targets: [ResourceStack] is one painted hit region (108 × 82-110 dp) that resolves the row from the
 * tap's y, and every row still has its own screen-reader node and click action.
 */

/** The value colour of a resource accent (TOKENS.json `color.resource`). */
internal fun accentColor(accent: ResourceAccent): Color = when (accent) {
    ResourceAccent.PLAIN, ResourceAccent.SHARDS, ResourceAccent.GEMS -> PkwTokens.Colors.text
    ResourceAccent.KEEP -> PkwTokens.Colors.gold.hi
    ResourceAccent.SKR -> PkwTokens.Colors.skr
    ResourceAccent.DIVINE -> PkwTokens.Colors.divine
}

/** What a screen reader says for a resource row. */
internal fun resourceDescription(ui: ResourceChipUi): String {
    val name = ui.name.ifBlank { ui.id.value }
    val full = if ((ui.fill ?: 0f) >= 1f) ", storage full" else ""
    val handle = if (ui.drawerHandle) ". Opens all resources" else ""
    val amount = ui.exactDescription.ifBlank { "$name ${ui.value}" }
    return "$amount$full$handle"
}

/**
 * One resource row (108 × 26 veil): the 24 dp icon at x 3, the value right-aligned, a 3 dp storage bar along the bottom
 * (red when full), the gold drawer caret on the handle row, and a rising "+n" for a confirmed gain followed by a 600 ms
 * count-up. Not clickable on its own: use [ResourceStack], or pass [onClick] for a standalone chip (it then gets a 48 dp
 * target).
 */
@Composable fun ResourceChip(ui: ResourceChipUi, modifier: Modifier = Modifier, onClick: ((FeatureId) -> Unit)? = null) {
    if (onClick != null) {
        Box(modifier.heightIn(min = PkwTokens.Dims.minTap).sceneInputRegion()
            .clearAndSetSemantics { contentDescription = resourceDescription(ui); role = Role.Button; this.onClick(label = null, action = { onClick(ui.id); true }) }
            .clickable(role = Role.Button) { onClick(ui.id) }, contentAlignment = Alignment.Center) { ResourceRow(ui, Modifier) }
    } else ResourceRow(ui, modifier.clearAndSetSemantics { contentDescription = resourceDescription(ui) })
}

@Composable private fun ResourceRow(ui: ResourceChipUi, modifier: Modifier) {
    val reduced = LocalReducedMotion.current
    var from by remember { mutableStateOf(ui.value) }
    val count = remember { Animatable(1f) }
    LaunchedEffect(ui.value) {
        if (reduced || ui.gain == null || from == ui.value) { from = ui.value; count.snapTo(1f) }
        else { count.snapTo(0f); delay(PkwTokens.Motion.GAIN_RISE.toLong()); count.animateTo(1f, tween(PkwTokens.Motion.COUNT_UP, easing = PkwTokens.Motion.Out)); from = ui.value }
    }
    val fill = ui.fill
    val shown = countUpText(from, ui.value, count.value)
    Box(modifier.size(PkwTokens.Dims.resourceRowW, PkwTokens.Dims.resourceRowH).drawBehind {
        drawPlate(PlateKind.VEIL)
        if (fill != null) {
            val l = 30.dp.toPx(); val r = size.width - 4.dp.toPx(); val h = 3.dp.toPx(); val y = size.height - 2.dp.toPx() - h
            drawRect(PkwTokens.Colors.veilHi, Offset(l, y), Size(r - l, h))
            val full = fill >= 1f
            drawRect(if (full) PkwTokens.Colors.red.face else PkwTokens.Colors.shards, Offset(l, y), Size((r - l) * fill.coerceIn(0f, 1f), h))
        }
    }) {
        PkwIcon(ui.icon, 24.dp, Modifier.align(Alignment.CenterStart).offset(x = 3.dp, y = (-1).dp))
        Row(Modifier.align(Alignment.CenterEnd).padding(start = 30.dp, end = if (ui.drawerHandle) 3.dp else 5.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            PkwText(shown, PkwTokens.Type.label, color = accentColor(ui.accent), outline = 1.dp)
            if (ui.drawerHandle) DrawerCaret()
        }
        if (ui.badge != null) Badge(ui.badge, Modifier.align(Alignment.TopStart).offset(x = (-8).dp, y = (-8).dp))
        if (ui.gain != null) GainDelta(ui.gain, Modifier.align(Alignment.CenterEnd).offset(y = 20.dp))
    }
}

/** The gold 22 × 18 drawer caret on the SKR row (hud.css `.caret`). */
@Composable private fun DrawerCaret() {
    Box(Modifier.size(22.dp, 18.dp).drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx()
        insideStepped(i, i, size.width - i, size.height - i, CornerProfiles.S) {
            drawRect(PkwTokens.Colors.gold.face)
            band(i, size.width - i, i, 2.dp.toPx(), PkwTokens.Colors.gold.hi)
        }
    }, contentAlignment = Alignment.Center) { PkwIcon("shape:caret", 12.dp, tint = PkwTokens.Colors.ink) }
}

/** "+200" rising 12 dp and fading over 450 ms (reduced motion: a 120 ms fade in place). Keyed on the text. */
@Composable private fun GainDelta(text: String, modifier: Modifier) {
    val reduced = LocalReducedMotion.current
    val t = remember(text) { Animatable(0f) }
    LaunchedEffect(text) { t.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.GAIN_RISE, easing = PkwTokens.Motion.Out)) }
    PkwText(text, PkwTokens.Type.caption, modifier.graphicsLayer {
        translationY = if (reduced) 0f else -PkwTokens.Motion.GAIN_RISE_DP * density * t.value
        alpha = 1f - t.value
    }.clearAndSetSemantics { }, color = PkwTokens.Colors.green.hi, outline = 1.dp)
}

/**
 * The top-right resource stack (DESIGN-SYSTEM §6 TopBar): up to 4 rows, 2 dp apart, as ONE painted hit region. A tap
 * anywhere on it opens the drawer at the row under the finger ([onOpen] gets that row's id). Screen readers get one
 * button per row.
 *
 * [enabled] false (design ruling 092decf3 item 4: while a Seal is shown) keeps every row drawn and readable, but the
 * stack is then neither a touch target nor a scene-input region, so a tap on it reaches the layer below (the Seal
 * scrim, which cancels) and the drawer cannot open during consent. Screen readers still hear the amounts.
 */
@Composable fun ResourceStack(rows: List<ResourceChipUi>, onOpen: (FeatureId) -> Unit, modifier: Modifier = Modifier,
    enabled: Boolean = true) {
    val shown = rows.take(PkwTokens.Budget.MAX_RESOURCE_ROWS)
    if (shown.isEmpty()) return
    val currentRows by rememberUpdatedState(shown)
    val currentOpen by rememberUpdatedState(onOpen)
    val touch = if (!enabled) Modifier else Modifier.sceneInputRegion().pointerInput(Unit) {
        detectTapGestures { position ->
            val pitch = (PkwTokens.Dims.resourceRowH + PkwTokens.Dims.resourceGap).toPx()
            val index = (position.y / pitch).toInt().coerceIn(0, currentRows.size - 1)
            currentOpen(currentRows[index].id)
        }
    }
    Column(modifier.width(PkwTokens.Dims.resourceRowW).then(touch), verticalArrangement = Arrangement.spacedBy(PkwTokens.Dims.resourceGap)) {
        shown.forEach { row ->
            // Keyed so a row's count-up state stays with its resource when KEEP appears or disappears.
            key(row.id.value) {
                ResourceRow(row, Modifier.semantics {
                    contentDescription = resourceDescription(row)
                    if (enabled) {
                        role = Role.Button
                        onClick(label = null, action = { currentOpen(row.id); true })
                    }
                })
            }
        }
    }
}

/**
 * The cost pill (DESIGN-SYSTEM §6 CostPill; §7.1 calls it PriceChip): 26 tall, ink S rim, cream body, 24 dp currency icon
 * and the amount. SHORT is a #FFD9CC body with #A3261A text; CHECKING is "…"; UNAVAILABLE says "unavailable"; "0" only
 * for a server zero ([priceText]). With [onClick] (a SHORT pill opens the Need-more sheet) it gets a 48 dp target.
 */
@Composable fun PriceChip(ui: PriceUi, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val short = ui.status == PriceStatus.SHORT
    val pill: @Composable (Modifier) -> Unit = { m ->
        Row(m.heightIn(min = PkwTokens.Dims.costPillH).drawBehind {
            fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
            val i = 2.dp.toPx()
            fillStepped(i, i, size.width - i, size.height - i, CornerProfiles.S, if (short) PkwTokens.Colors.shortPill else PkwTokens.Colors.cream)
        }.padding(start = 3.dp, end = 7.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            PkwIcon(currencyIcon(ui.currency, ui.icon), PkwTokens.Dims.costPillIcon)
            if (ui.status == PriceStatus.UNAVAILABLE) PkwText(priceText(ui), PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            else PkwText(priceText(ui), PkwTokens.Type.caption, color = if (short) PkwTokens.Colors.shortText else PkwTokens.Colors.textOnParch)
        }
    }
    if (onClick == null) pill(modifier.clearAndSetSemantics { contentDescription = priceDescription(ui) })
    else Box(modifier.defaultMinSize(PkwTokens.Dims.minTap, PkwTokens.Dims.minTap).sceneInputRegion()
        .clearAndSetSemantics { contentDescription = priceDescription(ui); role = Role.Button; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Button, onClick = onClick), contentAlignment = Alignment.Center) { pill(Modifier) }
}

/** A timer readout (DESIGN-SYSTEM §6 TimerChip): veil 30 tall, 24 dp timer icon, the time, an optional thin meter. */
@Composable fun TimerChip(ui: TimerUi, modifier: Modifier = Modifier) {
    Plate(PlateKind.VEIL, modifier.heightIn(min = PkwTokens.Dims.timerChipH).clearAndSetSemantics { contentDescription = ui.description },
        contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 3.dp, top = 2.dp, end = 8.dp, bottom = 2.dp), blocksScene = false) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                PkwIcon(ui.icon, 24.dp)
                PkwText(ui.text, PkwTokens.Type.caption, color = PkwTokens.Colors.text, outline = 1.dp)
            }
            val progress = ui.progress
            if (progress != null) {
                Box(Modifier.fillMaxWidth().height(3.dp).background(PkwTokens.Colors.veilHi)) {
                    Box(Modifier.fillMaxWidth(progress.coerceIn(0f, 1f)).height(3.dp).background(PkwTokens.Colors.green.face))
                }
            }
        }
    }
}

/** The badge face colours: red count, gold reward / NEW, green "!", blue info (common.css `.badge`). */
internal fun badgeColors(tone: BadgeTone): Triple<Color, Color, Color> = when (tone) {
    BadgeTone.COUNT -> Triple(PkwTokens.Colors.red.hi, PkwTokens.Colors.red.face, PkwTokens.Colors.label)
    BadgeTone.REWARD -> Triple(Color(0xFFFFF0B0), PkwTokens.Colors.gold.face, PkwTokens.Colors.ink)
    BadgeTone.READY -> Triple(Color(0xFFC3F09C), PkwTokens.Colors.green.face, PkwTokens.Colors.label)
    BadgeTone.INFO -> Triple(Color(0xFFC6E6FF), PkwTokens.Colors.blue.face, PkwTokens.Colors.label)
}

/** A corner badge (24 dp tall, ≥ 24 dp wide): it pops in 0 → 1.15 → 1 over 180 ms. Decorative for touch; its
 *  [BadgeUi.description] is announced. */
@Composable fun Badge(ui: BadgeUi, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val still = reduced || LocalInspectionMode.current
    val scale = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (!still) scale.animateTo(1f, keyframes { durationMillis = PkwTokens.Motion.BADGE_POP; 1.15f at 120 using PkwTokens.Motion.Pop })
    }
    val (hi, face, ink) = badgeColors(ui.tone)
    Box(modifier.graphicsLayer { scaleX = scale.value; scaleY = scale.value }
        .defaultMinSize(PkwTokens.Dims.badgeMinW, PkwTokens.Dims.badgeH).height(PkwTokens.Dims.badgeH)
        .clearAndSetSemantics { contentDescription = ui.description }
        .drawBehind {
            fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
            val i = 2.dp.toPx()
            insideStepped(i, i, size.width - i, size.height - i, CornerProfiles.S) {
                drawRect(face)
                band(i, size.width - i, i, 2.dp.toPx(), hi)
            }
        }.padding(horizontal = 5.dp), contentAlignment = Alignment.Center) {
        PkwText(ui.text, PkwTokens.Type.caption, color = ink)
    }
}

/** A square state tag (LIVE, OUTBID, YOU LEAD, KING, TEST DATA, LV n): 22 dp tall, ink S rim, a flat [verb] face
 *  (kit.png name plate `.lv` / common.css `.tag`: no highlight band, unlike a badge), outlined caption. Not clickable. */
@Composable fun Tag(text: String, verb: Verb, modifier: Modifier = Modifier) {
    val ramp = PkwTokens.ramp(verb)
    Box(modifier.heightIn(min = 22.dp).drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx()
        fillStepped(i, i, size.width - i, size.height - i, CornerProfiles.S, ramp.face)
    }.padding(horizontal = 6.dp, vertical = 1.dp), contentAlignment = Alignment.Center) {
        PkwText(text, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
    }
}

private val previewRows = listOf(
    ResourceChipUi(FeatureId("hud.shards"), "shards", "40,943", 0.62f, false, null, name = "Shards", accent = ResourceAccent.SHARDS),
    ResourceChipUi(FeatureId("hud.gems"), "gem", "1,250", null, false, null, name = "Gems", accent = ResourceAccent.GEMS),
    ResourceChipUi(FeatureId("hud.keep"), "keep", "312.5", null, false, null, name = "KEEP", accent = ResourceAccent.KEEP),
    ResourceChipUi(FeatureId("hud.skr"), "skr", "240", null, false, null, name = "SKR", accent = ResourceAccent.SKR, drawerHandle = true),
)

@Preview(name = "Resource stack", widthDp = 200, heightDp = 280)
@Composable private fun ResourceStackPreview() {
    Column(Modifier.background(Color(0xFF3F6A35)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ResourceStack(previewRows, {})
        ResourceChip(previewRows[0].copy(value = "…", fill = null))
        // While a Seal shows: readable, not tappable.
        ResourceStack(previewRows.take(2).map { it.copy(exactDescription = "${it.name} ${it.value} exactly") }, {}, enabled = false)
    }
}

@Preview(name = "Chips", widthDp = 360, heightDp = 200)
@Composable private fun ChipsPreview() {
    Column(Modifier.background(PkwTokens.Colors.bg).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PriceChip(PriceUi(Currency.SHARDS, "52,400", PriceStatus.SHORT))
            PriceChip(PriceUi(Currency.GEMS, null, PriceStatus.CHECKING))
            PriceChip(PriceUi(Currency.SOL, null, PriceStatus.UNAVAILABLE))
        }
        TimerChip(TimerUi("6h 20m", "6 hours 20 minutes left", progress = 0.4f), Modifier.widthIn(min = 100.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Badge(BadgeUi("3", BadgeTone.COUNT, "3 new"))
            Badge(BadgeUi("!", BadgeTone.READY, "Ready"))
            Badge(BadgeUi("NEW", BadgeTone.REWARD, "New building"))
            Spacer(Modifier.width(8.dp))
            Tag("OUTBID", Verb.RED)
            Tag("TEST DATA", Verb.STONE)
        }
    }
}
