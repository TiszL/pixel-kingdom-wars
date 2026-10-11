package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.CollapsingSheetColumn
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.ResourceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFitBox
import gg.pixelkingdomwars.nativeclient.ui.kit.TabStrip
import gg.pixelkingdomwars.nativeclient.ui.kit.TimerChip
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.TimerUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.cos
import kotlin.math.sin

/**
 * Design component: the hub's FullCard frame and its two headers (design/final/hub/SPEC.md §1 FullCard, LivingHeader,
 * CompactHeader, Tabs, Body, Footer, RewardReadouts), built from kit plates (WOOD, PARCHMENT, CHARCOAL), the kit
 * TabStrip, CloseSquare, IconSquare, TimerChip and ResourceChip.
 *
 * Why not the kit SheetFrame: SheetFrame draws its own title plate on every living header (the hub headers are the
 * subject's portrait and name, not a title), scrolls its body itself (Ladder pins the player's row and Chat anchors to
 * the bottom) and puts the footer inside the parchment (the hub footer sits on the wood under it). Everything here is
 * composed from the same kit parts, so the look matches.
 *
 * Pointer rule: [HubCard] is a plain Column. Only the WOOD plate (a kit scene-input region) and the buttons on it take
 * touches; the readout row above it is paint only. The 60 % FULL-card scrim belongs to the SheetHost, under this card,
 * and only while it is shown.
 */

/** Literal colours the hub SPEC names that are not kit tokens (SPEC §1, §2, §3). */
internal object HubColors {
    val wellDark = Color(0xFF2A2430)
    val wellLight = Color(0xFFE9D7A6)
    val wellLightBorder = Color(0xFFB89A5A)
    val rowReady = Color(0xFFEEF7D8)
    val rowDim = Color(0xFFE9DCB8)
    val stageTop = Color(0xFF2B1D12)
    val stageBottom = Color(0xFF1A120E)
    val toggleOff = Color(0xFF403C48)
    val toggleDisabled = Color(0xFFB9AE95)
    val fieldFace = Color(0xFFFFFAF0)
    val fieldInset = Color(0xFFE6D6AE)
    val placeholder = Color(0xFFA08C6A)
    val medalSilverFace = Color(0xFFE4E4EC)
    val medalSilverLip = Color(0xFFA6A1B0)
    val medalBronzeFace = Color(0xFFF0B27A)
    val medalBronzeLip = Color(0xFFB06A2C)
    val skeleton = Color(0xFFDCCAA0)
    val skeletonDark = Color(0xFFCDB98B)
    val pipHi = Color(0xFFFBE7A8)
    val errorFace = Color(0xFFFDE3D8)
    val lime = Color(0xFFC9F29A)
    val limeHi = Color(0xFFE4FBC8)
    val dayDivider = Color(0xFF9A8058)
    val mention = Color(0xFF8A5A12)
    val glowInner = Color(0xFF5A3416)
    val glowMid = Color(0xFF3A2210)
    val glowOuter = Color(0xFF24160C)
}

/** How tall the readout row plus its gap is: the readouts sit 46 dp above the card's frame (SPEC: readouts y 14, card y 60). */
internal const val READOUT_RESERVE_DP = 46
internal val READOUT_RESERVE: Dp = READOUT_RESERVE_DP.dp

/** Where a hub FULL card paints, in dp from the screen top, for a card modifier whose top is [modifierTopDp]. */
internal data class HubCardGeometry(val readoutTopDp: Int, val frameTopDp: Int)

/**
 * The HubCard modifier chain (MS-M2 fix): the incoming modifier is the FRAME's box, exactly what the SheetHost's FULL
 * edges give ([gg.pixelkingdomwars.nativeclient.ui.kit.sheetEdgesDp] top 60), so the wood starts at the modifier's top
 * and the RewardReadouts are drawn in the [READOUT_RESERVE] above it. Before the fix the reserve was laid out INSIDE the
 * modifier, so a y 60 FULL modifier painted the wood at 106.
 */
internal fun hubCardGeometry(modifierTopDp: Int): HubCardGeometry = HubCardGeometry(modifierTopDp - READOUT_RESERVE_DP, modifierTopDp)

/** Lays the readout row out [READOUT_RESERVE] above the frame's top and takes no height, so the frame keeps the
 *  modifier's top (paint only: the row sits outside the card's bounds and takes no touches). */
private fun Modifier.inReadoutReserve(): Modifier = layout { measurable, constraints ->
    val placeable = measurable.measure(constraints.copy(minHeight = 0))
    val top = hubCardGeometry(0).readoutTopDp.dp.roundToPx()
    layout(placeable.width, 0) { placeable.place(0, top) }
}

/**
 * A hub FullCard (SPEC §1): the RewardReadouts row (only the currencies this card pays out), then the WoodFrame with the
 * [header], the kit tab strip, the scrolling-or-not parchment [body] (the body decides: it gets a bounded height) and the
 * pinned [footer] on the wood.
 *
 * Mount: give [modifier] the FULL sheet edges, x 8..404 and y from 60 dp (`sheetEdgesDp(FULL)`) to 14 dp above the
 * gesture inset: the wood frame starts at the modifier's top and the RewardReadouts row is drawn in the 46 dp reserve
 * above it (y 14..40, [hubCardGeometry]). Tab changes cross-fade the body for 120 ms.
 *
 * Pointer rule: a plain Column with no pointer handling; the readout row is paint only and the wood frame (a kit
 * scene-input region) plus its buttons are the only touch targets. The FULL-card scrim is the SheetHost's.
 */
@Composable fun HubCard(
    modifier: Modifier = Modifier,
    readouts: List<ResourceChipUi> = emptyList(),
    tabs: List<TabUi> = emptyList(),
    selectedTab: String? = null,
    onTab: (String) -> Unit = {},
    footer: (@Composable RowScope.() -> Unit)? = null,
    header: @Composable () -> Unit,
    /** More tabs than fit with icon + label (Leagues' four at 412 dp truncated "REWAR…", owner screenshot 8): the kit's
     *  compact strip, the active tab wide with icon + label and the others icon only (their label stays their name). */
    compactTabs: Boolean = false,
    body: @Composable ColumnScope.() -> Unit,
) {
    val reduced = LocalReducedMotion.current
    val fade = remember { Animatable(1f) }
    var lastTab by remember { mutableStateOf(selectedTab) }
    LaunchedEffect(selectedTab) {
        if (lastTab != selectedTab) {
            lastTab = selectedTab
            fade.snapTo(0f)
            fade.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TAB_SWITCH))
        }
    }
    Column(modifier) {
        // RewardReadouts (SPEC §1): coin-fly targets, paint only, in the reserve ABOVE the frame (no height here).
        if (readouts.isNotEmpty()) Row(Modifier.inReadoutReserve().fillMaxWidth().height(PkwTokens.Dims.resourceRowH),
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
            readouts.forEach { ResourceChip(it) }
        }
        Plate(PlateKind.WOOD, Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 6.dp, bottom = 8.dp)) {
            val headerAndTabs: @Composable ColumnScope.() -> Unit = {
                header()
                if (tabs.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    TabStrip(tabs, selectedTab, onTab, Modifier.padding(horizontal = 2.dp), compact = compactTabs)
                } else Spacer(Modifier.height(4.dp))
            }
            val parchment: @Composable (Modifier) -> Unit = { placed ->
                Plate(PlateKind.PARCHMENT, placed, blocksScene = false,
                    contentPadding = PaddingValues(start = 8.dp, top = 8.dp, end = 8.dp, bottom = 8.dp)) {
                    Column(Modifier.fillMaxSize().graphicsLayer { alpha = fade.value }, content = body)
                }
            }
            // An if-expression types the branch as the composable slot (a lambda returned through let would not be).
            val foot: (@Composable ColumnScope.() -> Unit)? = if (footer == null) null else ({
                Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.Bottom,
                    horizontalArrangement = Arrangement.spacedBy(8.dp), content = footer)
            })
            // K-night-A11 (owner, Clan cut-offs in landscape): a card under SheetFit.FRAMED_MIN_DP (a phone in landscape)
            // scrolls its header and tabs away with the body and keeps the footer (CREATE YOUR OWN, LEAVE + CHAT) pinned.
            SheetFitBox(Modifier.fillMaxWidth()) { compact ->
                if (!compact) Column(Modifier.fillMaxSize()) {
                    headerAndTabs()
                    parchment(Modifier.fillMaxWidth().weight(1f))
                    foot?.invoke(this)
                } else CollapsingSheetColumn(Modifier.fillMaxSize(), collapsing = headerAndTabs, footer = foot, page = parchment)
            }
        }
    }
}

/** The LivingHeader's backdrop (SPEC §1, §2.2, §2.5, §3.7). */
enum class HeaderStage {
    /** The caller paints its own art (Profile: the parked-world snapshot). */
    NONE,
    /** Dark stage `#2B1D12 → #1A120E` with stepped gold sunrays (Leagues, Clan, update gate). */
    SUNRAYS,
    /** The maintenance forge: stepped radial glow `#5A3416 / #3A2210 / #24160C` plus sunrays. */
    FORGE_GLOW,
}

/**
 * The 136 dp LivingHeader (SPEC §1): full bleed with a 3 dp ink rule at the bottom, the card's own subject in [content],
 * red Close at the top-right (8 / 6), an optional stone 48 [onGear] beside it (Profile: Settings) and an optional
 * [timer] chip at the bottom-right (8 / 8). [onClose] null draws no Close (gates).
 */
@Composable fun LivingHeader(
    onClose: (() -> Unit)?,
    modifier: Modifier = Modifier,
    stage: HeaderStage = HeaderStage.SUNRAYS,
    rayCentre: Offset = Offset(0.18f, 0.5f),
    height: Dp = PkwTokens.Dims.sheetHeaderH,
    onGear: (() -> Unit)? = null,
    timer: TimerUi? = null,
    content: @Composable BoxScope.() -> Unit,
) {
    Box(modifier.fillMaxWidth().height(height).clipToBounds().drawBehind {
        when (stage) {
            HeaderStage.NONE -> drawRect(PkwTokens.Colors.card)
            HeaderStage.SUNRAYS -> drawSunrayStage(Offset(size.width * rayCentre.x, size.height * rayCentre.y), 0f)
            HeaderStage.FORGE_GLOW -> drawForgeGlow(Offset(size.width * rayCentre.x, size.height * rayCentre.y))
        }
    }) {
        content()
        // SPEC §1: the optional stone 48 sits at x −62 (hub.html / event.html `right: 62px`), 6 dp left of the Close.
        Row(Modifier.align(Alignment.TopEnd).padding(top = 6.dp, end = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (onGear != null) IconSquare("settings", Verb.STONE, onGear, "Settings")
            if (onClose != null) CloseSquare(onClose)
        }
        timer?.let { TimerChip(it, Modifier.align(Alignment.BottomEnd).padding(end = 8.dp, bottom = 11.dp)) }
        // The 3 dp ink rule under the header.
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(3.dp).background(PkwTokens.Colors.ink))
    }
}

/**
 * The 60 dp CompactHeader (SPEC §1): optional stone Back 48 (drawn chevron), the charcoal title plate 44 tall (24 / 32 dp
 * [icon] or a drawn [iconContent], PS 13 gold-hi title), a flexible gap and the red Close 48.
 */
@Composable fun CompactHeader(
    title: String,
    icon: String?,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    iconContent: (@Composable () -> Unit)? = null,
) {
    Row(modifier.fillMaxWidth().heightIn(min = 60.dp).padding(6.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (onBack != null) BackSquare(onBack)
        Plate(PlateKind.CHARCOAL, Modifier.heightIn(min = 44.dp).semantics(mergeDescendants = true) { heading() }, blocksScene = false,
            contentPadding = PaddingValues(start = 10.dp, top = 6.dp, end = 12.dp, bottom = 8.dp)) {
            Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when {
                    iconContent != null -> iconContent()
                    icon != null -> PkwIcon(icon, if (icon.startsWith("ui:")) 32.dp else 24.dp)
                }
                PkwText(title, PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
            }
        }
        Spacer(Modifier.weight(1f))
        CloseSquare(onClose)
    }
}

/**
 * The dark sunray stage (SPEC §1 RewardStage, LivingHeader on Leagues / Clan / update): a 4-step vertical ramp
 * `#2B1D12 → #1A120E` (hard steps, no blur) and 18 gold-hi rays of 10° every 20° at 17 %, turned by [degrees].
 */
internal fun DrawScope.drawSunrayStage(centre: Offset, degrees: Float, top: Color = HubColors.stageTop, bottom: Color = HubColors.stageBottom) {
    val steps = 4
    val bandH = size.height / steps
    for (i in 0 until steps) {
        drawRect(lerp(top, bottom, i / (steps - 1f)), Offset(0f, bandH * i), Size(size.width, bandH + 1f))
    }
    drawRays(centre, degrees, PkwTokens.Colors.gold.hi.copy(alpha = 0.17f))
}

/** The maintenance forge stage (SPEC §3.7): `#24160C` ground, sunrays, then two hard-stop glow discs. */
internal fun DrawScope.drawForgeGlow(centre: Offset) {
    drawRect(HubColors.glowOuter)
    drawRays(centre, 0f, PkwTokens.Colors.gold.hi.copy(alpha = 0.12f))
    val r = size.height * 0.46f
    drawCircle(HubColors.glowMid.copy(alpha = 0.85f), r, centre)
    drawCircle(HubColors.glowInner.copy(alpha = 0.75f), r * 0.62f, centre)
}

/** 18 wedges of 10° (every other 10° band) from [centre], long enough to reach every corner. */
internal fun DrawScope.drawRays(centre: Offset, degrees: Float, color: Color) {
    val reach = (size.width + size.height) * 1.5f
    // One path and one draw call for all 18 wedges (the turning stages redraw this every frame; it allocated 18 paths
    // and issued 18 draws per frame before).
    val wedges = Path()
    for (k in 0 until 36 step 2) {
        val a0 = Math.toRadians((k * 10f + degrees).toDouble())
        val a1 = Math.toRadians((k * 10f + 10f + degrees).toDouble())
        wedges.moveTo(centre.x, centre.y)
        wedges.lineTo(centre.x + (reach * cos(a0)).toFloat(), centre.y + (reach * sin(a0)).toFloat())
        wedges.lineTo(centre.x + (reach * cos(a1)).toFloat(), centre.y + (reach * sin(a1)).toFloat())
        wedges.close()
    }
    drawPath(wedges, color)
}

@Preview(name = "Hub card frame: compact header", widthDp = 412, heightDp = 600)
@Composable private fun HubCardCompactPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF2F4A2A)).padding(start = 8.dp, top = PkwTokens.Dims.fullSheetTop, end = 8.dp, bottom = 14.dp)) {
        HubCard(Modifier.fillMaxSize(), readouts = sampleReadouts,
            tabs = listOf(TabUi("DAILY", "timer", "DAILY", null, false), TabUi("KINGDOM", "ui_portrait_keep_t3", "KINGDOM", null, false)),
            selectedTab = "DAILY", header = { CompactHeader("QUESTS", "quest", onClose = {}) }) {
            SectionHeader("TODAY", note = "a sample body")
        }
    }
}

@Preview(name = "Hub card frame: living header", widthDp = 412, heightDp = 400)
@Composable private fun HubCardLivingPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF2F4A2A)).padding(start = 8.dp, top = PkwTokens.Dims.fullSheetTop, end = 8.dp, bottom = 14.dp)) {
        HubCard(Modifier.fillMaxSize(), header = {
            LivingHeader(onClose = {}, timer = TimerUi("Week ends 4d 6h", "Week ends in 4 days 6 hours")) {
                HubArt("league-gold", 80.dp, Modifier.align(Alignment.CenterStart).padding(start = 24.dp))
            }
        }) { Box(Modifier.size(10.dp)) }
    }
}
