package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.ResourceStack
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.drawChunky
import gg.pixelkingdomwars.nativeclient.ui.kit.drawPlate
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt

/*
 * Design component: the shared frame and parts of the army cluster (design/final/army/SPEC.md §1 `ArmyTallSheet`, §8
 * living header, §9 pixel rules): the tall sheet with its living header, header chip and hero switch, the sheet-mode
 * resource stack, the pinned footer with its parchment fade, the housing meter and legend, cream cards with inner rims,
 * portrait wells with level tags and pips, mini portraits, section lines, skeleton cards, star rows and the blue notice
 * row. Every sheet of the cluster (TRAIN, ARMY, Research, Heroes, Raid chooser) is built from these and the kit; the
 * battle result card reuses the cards and rows.
 *
 * Pointer rule (binding, tonight's no-reload review): the base scene is a lower sibling of the navigation host, and
 * Compose stops at the first sibling with a pointer hit. Nothing in this file is a full-screen clickable, pointerInput,
 * scrim or draggable. The sheet frame, cards and buttons are painted panels (scene-input regions); empty space outside
 * the frame passes touches to the kingdom. The TALL sheet's 40 % scrim belongs to the SheetHost, only while it is shown.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Shared UI state (SPEC §1.1). Numbers arrive formatted; unknown is "…" (UNKNOWN), never "0".
// ---------------------------------------------------------------------------------------------------------------------

/** One piece of pixel art: a GameArt / kit icon name ("ui_portrait_barracks_t3", "hero_vex_idle_f1") and its master
 *  height in art pixels. With frames > 1 the name is the stem and frame i is drawn as "<name>_f<i>" (1-based). */
@Immutable data class SpriteRef(
    /** GameArt / kit icon name, or the frame stem when animated. */
    val name: String,
    /** The master art height in px; the drawn size is `artDp(artPx, scale)`. */
    val artPx: Int,
)

/** The eight facing directions of the troop sheets (row 0 S, 2 E, 6 W, 7 SW in the master sheets). */
enum class Dir8 { S, SW, W, NW, N, NE, E, SE }

/** The colour of the 10 dp status dot in a header chip ("Ready" green). */
enum class DotColor { GREEN, GOLD, RED, BLUE }

/** The veil chip at the header's bottom-left (SPEC §1 `HeaderChip`): icon 24 + VT status, the [emphasis] in gold-hi. */
@Immutable data class HeaderChipUi(
    /** 24 dp icon (timer, warhorn); null draws none. */
    val icon: String?,
    /** The plain part ("All ready in", "Lab is free"). */
    val text: String,
    /** The gold-hi part ("6m 30s", "42/50"); null draws none. */
    val emphasis: String?,
    /** A 10 dp status dot drawn before the text ("Ready"); null draws none. */
    val dot: DotColor? = null,
    /** True draws [emphasis] in green-hi instead of gold-hi (army.png: "Ready to raid · 42/50"). */
    val emphasisGreen: Boolean = false,
)

/** One walker in the living header (SPEC §8). It moves 12 dp/s along its [dir] (W/SW/NW left, E/NE/SE right, S/N stand). */
@Immutable data class WalkerUi(
    /** Its art (frames cycle at the header's fps when the name is a stem, see [HeaderArtUi.walkerFrames]). */
    val sprite: SpriteRef,
    /** Facing; also the walking direction. */
    val dir: Dir8,
    /** Start x / y of the sprite's top-left in the 398 × 136 header, dp. */
    val xDp: Int,
    val yDp: Int,
    /** Device px per art px on the mock's DPR-2 phone (SPEC §8: troops x2, heroes x3, buildings x4). */
    val scale: Int,
)

/** The living header's composition (SPEC §1.1, §8). */
@Immutable data class HeaderArtUi(
    /** The building (its frame stem when [buildingFrames] > 1). */
    val building: SpriteRef?,
    /** How many work / idle frames the building strip has; 1 draws the name as is. */
    val buildingFrames: Int,
    /** Troops / heroes walking or standing in front of it. */
    val walkers: List<WalkerUi>,
    /** Frame rate of every strip (SPEC: 8 fps = 125 ms frames). */
    val fps: Int = 8,
    /** Device px per art px for the building (SPEC §8: x4 Barracks / Camp, x3 Lab / Altar). */
    val buildingScale: Int = 4,
    /** The building's top-left in the header, dp (SPEC §8 table). */
    val buildingXDp: Int = 200,
    val buildingYDp: Int = 0,
    /** Frames per walker strip; 1 draws each walker name as is. */
    val walkerFrames: Int = 1,
)

/** The other hero's switch at the header's bottom-right (SPEC §5 "Hero switch"). */
@Immutable data class HeroSwitchUi(
    /** The other hero's id ("theodor"). */
    val hero: String,
    /** Its 24 dp portrait. */
    val portrait: String,
    /** Its short name ("THEO"). */
    val shortName: String,
    /** True draws a padlock (its building is not built); a tap still calls back so the host can say why. */
    val locked: Boolean,
    /** Screen-reader text ("Switch to Theodor"). */
    val description: String,
)

/** The living header of every army tall sheet (SPEC §1.1). */
@Immutable data class SheetHeaderUi(
    /** PS 13 title ("BARRACKS"). */
    val title: String,
    /** The blue tag ("LV 7"); null draws none (Raid chooser). */
    val levelTag: String?,
    /** The veil chip at the bottom-left; null draws none. */
    val chip: HeaderChipUi?,
    /** The header scene. */
    val art: HeaderArtUi,
    /** Heroes only: the switch to the other hero; null hides it (other hero not recruited). */
    val switchTo: HeroSwitchUi? = null,
)

/** The pinned footer (SPEC §1 `SheetFooter`): an info block and the sheet's one primary. */
@Immutable data class FooterUi(
    /** VT 18 lines of the info block ("+9 pts · 8m 30s", "takes 17h 50m"). */
    val info: List<String>,
    /** Cost pills stacked in the info block (draft total, energy + Shards). A SHORT pill opens Need-more. */
    val price: List<PriceUi>,
    /** The primary. Its [CommandUi.verb] is the face (TRAIN gold, UPGRADE green, ATTACK red), [CommandUi.caption] the
     *  PS label, [CommandUi.sub] the VT line inside, [CommandUi.icon] a 32 dp icon ("" for none), [CommandUi.price] a
     *  cost pill pinned above its top-right (FINISH). States per kit: DISABLED / LOCKED with [CommandUi.reason]. */
    val primary: CommandUi,
)

/** Army camp housing in troop points (SPEC §2 `HousingUi`). */
@Immutable data class HousingUi(
    /** Points of troops ready in the camp. */
    val ready: Int,
    /** Points training in the queue. */
    val training: Int,
    /** Points chosen in the TRAIN draft (0 on the ARMY tab). */
    val draft: Int,
    /** Camp capacity in points. */
    val capacity: Int,
    /** Queue capacity in points (the server's training-queue room). */
    val queueCap: Int,
    /** Camp and queue are full: the grid dims and TRAIN is off. */
    val full: Boolean,
    /** False while the server has not answered: every figure reads "…". */
    val known: Boolean = true,
)

/** One stat line "label  now ▸ next" (research detail, hero next level). [next] null = unchanged (value only). */
@Immutable data class StatDeltaUi(val label: String, val now: String, val next: String?)

/** One troop tile of the camp (ARMY tab, result "army used"): portrait, level tag and count. */
@Immutable data class ArmyTileUi(
    /** Troop id ("highlander"). */
    val troop: String,
    /** 56 px portrait ("ui_portrait_highlander_t3"). */
    val portrait: String,
    /** The level tag ("L3"). */
    val level: String,
    /** The count as shown ("x8", "8", "…"). */
    val count: String,
    /** Screen-reader text ("8 Highlanders, level 3"). */
    val description: String = "",
)

// ---------------------------------------------------------------------------------------------------------------------
// Colours the army SPEC names that are not kit tokens (SPEC §2-§7 literal hexes).
// ---------------------------------------------------------------------------------------------------------------------

internal object ArmyInk {
    /** Portrait well (`#2A2430`). */
    val well = Color(0xFF2A2430)
    /** Locked card body (`#DDD2B4`). */
    val lockedBody = Color(0xFFDDD2B4)
    /** A locked card's portrait well (`#1A171E`, army.css `.tc.lock .por`). */
    val lockedWell = Color(0xFF1A171E)
    /** The empty saved-army row (`#EFE2BB`, army.png slot 3). */
    val savedEmpty = Color(0xFFEFE2BB)
    /** Lab-cap card body (`#EFE5C8`). */
    val labCapBody = Color(0xFFEFE5C8)
    /** Hero showcase / paper-doll well (`#1F2A1C`). */
    val heroWell = Color(0xFF1F2A1C)
    /** Empty gear slot (`#EAD8A6`). */
    val slotEmpty = Color(0xFFEAD8A6)
    /** First-3★ reward pill body (`#E9F5D6`). */
    val rewardBody = Color(0xFFE9F5D6)
    /** "NEXT" under the frontier node (`#8A5A12`). */
    val nextText = Color(0xFF8A5A12)
    /** The header's ground (the grass of the world backdrop). */
    val grass = Color(0xFF3F6A35)
    val grassLo = Color(0xFF355C2D)
    /** The `parch-dk` rule. */
    val parchDk = PkwTokens.Colors.parchmentLo
    /** Green values on parchment (target level, stat gains). */
    val gain = PkwTokens.Colors.green.lo
}

/** Text tone of a delta on parchment. */
internal fun deltaColor(tone: DeltaTone): Color = when (tone) {
    DeltaTone.GAIN -> PkwTokens.Colors.green.lo
    DeltaTone.LOSS -> PkwTokens.Colors.shortText
    DeltaTone.ZERO, DeltaTone.UNKNOWN -> PkwTokens.Colors.textOnParch2
}

/** Draws its content desaturated to [saturation] (0 grey .. 1 full) and dimmed to [brightness]: locked portraits, the
 *  dimmed "no room" / busy grids, unearned stars. One offscreen layer; no shader. */
internal fun Modifier.toned(saturation: Float = 1f, brightness: Float = 1f): Modifier =
    if (saturation >= 1f && brightness >= 1f) this else drawWithContent {
        val matrix = ColorMatrix().apply {
            setToSaturation(saturation.coerceIn(0f, 1f))
            if (brightness < 1f) timesAssign(ColorMatrix().apply { setToScale(brightness, brightness, brightness, 1f) })
        }
        val paint = Paint().apply { colorFilter = ColorFilter.colorMatrix(matrix) }
        drawIntoCanvas { it.saveLayer(Rect(Offset.Zero, size), paint) }
        drawContent()
        drawIntoCanvas { it.restore() }
    }

// ---------------------------------------------------------------------------------------------------------------------
// The tall sheet
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The army tall sheet (SPEC §1): kit [SheetFrame] (wood frame, title plate, History, close, tabs, scrolling parchment,
 * pinned footer) with the cluster's living header: the header art (cross-fades 120 ms when it changes, so the TRAIN ↔
 * ARMY and hero switches fade), the veil chip at the bottom-left and an optional trailing control at the bottom-right
 * (hero switch, campaign MAP). [headerScene] replaces the drawn art (the campaign map renderer crop).
 *
 * Pointer rule: a painted panel inside the SheetHost's bounds; never full-screen, no scrim of its own.
 */
@Composable internal fun ArmyTallSheet(
    header: SheetHeaderUi, tabs: List<TabUi>, selectedTab: String?,
    onClose: () -> Unit, onHistory: () -> Unit, onTab: (String) -> Unit,
    modifier: Modifier = Modifier,
    headerScene: (@Composable BoxScope.() -> Unit)? = null,
    headerChip: (@Composable () -> Unit)? = null,
    headerTrailing: (@Composable () -> Unit)? = null,
    footer: (@Composable ColumnScope.() -> Unit)? = null,
    body: @Composable ColumnScope.() -> Unit,
) {
    val reduced = LocalReducedMotion.current
    SheetFrame(
        SheetFrameUi(header.title, null, SheetSize.TALL, tabs, selectedTab, titleTag = header.levelTag, history = true),
        onClose = onClose, modifier = modifier, onTab = onTab, onHistory = onHistory,
        header = {
            if (headerScene != null) headerScene()
            else Crossfade(header.art, Modifier.fillMaxSize(),
                tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TAB_SWITCH), label = "header-art") { art ->
                LivingHeaderArt(art, Modifier.fillMaxSize())
            }
            Box(Modifier.align(Alignment.BottomStart).padding(6.dp)) {
                if (headerChip != null) headerChip() else header.chip?.let { HeaderChip(it) }
            }
            if (headerTrailing != null) Box(Modifier.align(Alignment.BottomEnd).padding(6.dp)) { headerTrailing() }
        },
        footer = footer, body = body)
}

/** The header's veil chip (SPEC §1 `HeaderChip`): 30 tall, padding 4 / 8, dot or icon 24, VT 20 text, gold-hi part. */
@Composable internal fun HeaderChip(ui: HeaderChipUi, modifier: Modifier = Modifier) {
    val spoken = listOfNotNull(ui.text, ui.emphasis).joinToString(" ")
    Plate(PlateKind.VEIL, modifier.heightIn(min = 30.dp).clearAndSetSemantics { contentDescription = spoken },
        contentPadding = PaddingValues(start = 6.dp, top = 2.dp, end = 8.dp, bottom = 2.dp), blocksScene = false) {
        Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ui.dot?.let { Box(Modifier.size(10.dp).background(dotColor(it))) }
            ui.icon?.let { PkwIcon(it, 24.dp) }
            PkwText(ui.text, PkwTokens.Type.body, color = PkwTokens.Colors.text, outline = 1.dp)
            ui.emphasis?.let { PkwText(it, PkwTokens.Type.body, color = if (ui.emphasisGreen) PkwTokens.Colors.green.hi else PkwTokens.Colors.gold.hi,
                outline = 1.dp) }
        }
    }
}

private fun dotColor(dot: DotColor): Color = when (dot) {
    DotColor.GREEN -> PkwTokens.Colors.green.face
    DotColor.GOLD -> PkwTokens.Colors.gold.face
    DotColor.RED -> PkwTokens.Colors.red.face
    DotColor.BLUE -> PkwTokens.Colors.blue.face
}

/** The header loop: 40 s covers a walker crossing the 398 dp header at 12 dp/s with room to wrap. */
private const val HEADER_LOOP_MS = 40_000

/**
 * The living header art (SPEC §8): the ground, the building's frame strip and the walkers, each walker advancing 12 dp/s
 * along its direction and wrapping off the edge, frames at [HeaderArtUi.fps]. Reduced motion and previews draw frame 1
 * with nobody moving. Decorative: screen readers skip it (the title plate names the sheet).
 */
@Composable internal fun LivingHeaderArt(art: HeaderArtUi, modifier: Modifier = Modifier) {
    val still = LocalReducedMotion.current || LocalInspectionMode.current
    val phase: Float = if (still) 0f else {
        val loop = rememberInfiniteTransition(label = "header")
        val p by loop.animateFloat(0f, 1f, infiniteRepeatable(tween(HEADER_LOOP_MS, easing = LinearEasing)), label = "header-phase")
        p
    }
    val elapsedMs = (phase * HEADER_LOOP_MS).toLong()
    BoxWithConstraints(modifier.clearAndSetSemantics { }.drawBehind {
        drawRect(ArmyInk.grass)
        // A few darker grass rows so the strip reads as ground, not a flat card.
        var y = 18.dp.toPx()
        while (y < size.height) { band(0f, size.width, y, 2.dp.toPx(), ArmyInk.grassLo); y += 26.dp.toPx() }
        band(0f, size.width, size.height - 3.dp.toPx(), 3.dp.toPx(), PkwTokens.Colors.ink)
    }) {
        val widthDp = maxWidth.value
        art.building?.let { b ->
            val sizeDp = artDp(b.artPx, art.buildingScale)
            PkwIcon(frameName(b.name, headerFrame(elapsedMs, art.fps, art.buildingFrames), art.buildingFrames), sizeDp.dp,
                Modifier.offset(art.buildingXDp.dp, art.buildingYDp.dp))
        }
        art.walkers.forEach { w ->
            val sizeDp = artDp(w.sprite.artPx, w.scale)
            val x = walkerX(w.xDp.toFloat(), walkerVelocityDp(w.dir), elapsedMs, widthDp, sizeDp)
            PkwIcon(frameName(w.sprite.name, headerFrame(elapsedMs, art.fps, art.walkerFrames), art.walkerFrames), sizeDp.dp,
                Modifier.offset { IntOffset((x * density).roundToInt(), (w.yDp * density).roundToInt()) })
        }
    }
}

/** The bottom-right hero switch (SPEC §5): charcoal 104 × 48, the other hero's 24 dp portrait, PS 11 short name and a
 *  drawn chevron; a padlock when its building is not built. */
@Composable internal fun HeroSwitchButton(ui: HeroSwitchUi, onClick: () -> Unit) {
    ChunkyBox(PkwTokens.Colors.charcoalRamp, onClick, ui.description, Modifier.widthIn(min = 104.dp).heightIn(min = 48.dp)) {
        Row(Modifier.padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(contentAlignment = Alignment.Center) {
                PkwIcon(ui.portrait, 24.dp, alpha = if (ui.locked) 0.5f else 1f)
                if (ui.locked) PkwIcon("shape:lock", 16.dp, tint = PkwTokens.Colors.gold.face)
            }
            PkwText(ui.shortName, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
            PkwIcon("shape:go", 12.dp, tint = PkwTokens.Colors.label)
        }
    }
}

/**
 * The sheet-mode resource stack (SPEC §1, y 10, right 8): only the currencies this sheet spends ([sheetResourceRows]).
 * The SheetHost draws it over the world strip while the sheet is open; a tap opens the drawer at that row.
 * Pointer rule: the kit [ResourceStack] is one painted hit region; nothing else here takes touches.
 */
@Composable fun ArmySheetResources(rows: List<ResourceChipUi>, kind: ArmySheetKind, onResourceRow: (FeatureId) -> Unit, modifier: Modifier = Modifier) {
    val shown = sheetResourceRows(rows, kind)
    if (shown.isNotEmpty()) ResourceStack(shown, onResourceRow, modifier)
}

// ---------------------------------------------------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The pinned footer (SPEC §1 `SheetFooter`): the 18 dp parchment fade over the scrolling body and the 2 dp parch-dk rule,
 * then the info block ([infoWidth]) and the one primary. A priced primary (FINISH) carries its cost pill pinned 16 dp
 * above its top-right. [onPrimary] runs on ENABLED (including a CHECKING price: it navigates to the review); [onNeedMore]
 * runs for SHORT; [onRefused] for DISABLED / LOCKED (the host shows the reason). BUSY ignores taps.
 *
 * A footer with no info lines and no price has no info block: the primary spans the footer (train-full.png). A
 * [reasonColor] draws an off primary's reason line in that colour (train-full.png: VT 18 `#A3261A`).
 */
@Composable internal fun ArmyFooter(
    footer: FooterUi, onPrimary: () -> Unit, onNeedMore: (PriceUi) -> Unit, onRefused: (CommandUi) -> Unit,
    infoWidth: Dp = 132.dp, infoColor: Color = PkwTokens.Colors.textOnParch2, firstInfoColor: Color = infoColor,
    firstInfoStyle: TextStyle = PkwTokens.Type.small, secondary: (@Composable () -> Unit)? = null,
    reasonColor: Color? = null,
) {
    FooterFade()
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (secondary != null) secondary()
        else if (footer.info.isNotEmpty() || footer.price.isNotEmpty()) Column(Modifier.widthIn(min = 96.dp, max = infoWidth),
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            footer.price.forEach { p -> PriceChip(p, onClick = if (p.status == PriceStatus.SHORT) ({ onNeedMore(p) }) else null) }
            footer.info.forEachIndexed { i, line ->
                PkwText(line, if (i == 0) firstInfoStyle else PkwTokens.Type.small, color = if (i == 0) firstInfoColor else infoColor, maxLines = 2)
            }
        }
        FooterPrimary(footer.primary, onPrimary, onNeedMore, onRefused, Modifier.weight(1f), reasonColor = reasonColor)
    }
}

/** The footer's primary with its floating price; taps routed by [commandTap]. A [reasonColor] draws the DISABLED /
 *  LOCKED reason under it in that colour instead of the kit's parchment ink. */
@Composable internal fun FooterPrimary(cmd: CommandUi, onRun: () -> Unit, onNeedMore: (PriceUi) -> Unit, onRefused: (CommandUi) -> Unit,
    modifier: Modifier = Modifier, reasonColor: Color? = null) {
    val state = effectiveState(cmd)
    val routed = { routeCommand(cmd, onRun, onNeedMore, onRefused) }
    val ownReason = cmd.reason?.takeIf { reasonColor != null && (state == CommandState.DISABLED || state == CommandState.LOCKED) }
    Box(modifier.padding(top = if (cmd.price != null) 14.dp else 0.dp)) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            PrimaryButton(cmd.caption, routed, Modifier.fillMaxWidth(), verb = cmd.verb, sub = cmd.sub, state = state,
                reason = if (ownReason != null) null else cmd.reason, badge = cmd.badge, icon = cmd.icon.takeIf { it.isNotBlank() })
            ownReason?.let {
                PkwText(it, PkwTokens.Type.small, Modifier.padding(top = 4.dp), color = reasonColor ?: PkwTokens.Colors.textOnParch2,
                    textAlign = TextAlign.Center, maxLines = 2)
            }
        }
        cmd.price?.let { price ->
            PriceChip(price, Modifier.align(Alignment.TopEnd).offset(x = (-8).dp, y = (-16).dp))
        }
    }
}

/** Runs the callback [commandTap] picks for [cmd]. */
internal fun routeCommand(cmd: CommandUi, onRun: () -> Unit, onNeedMore: (PriceUi) -> Unit, onRefused: (CommandUi) -> Unit) {
    when (commandTap(cmd)) {
        TapRoute.RUN -> onRun()
        TapRoute.NEED_MORE -> onNeedMore(cmd.price ?: PriceUi(Currency.SHARDS, null, PriceStatus.SHORT))
        TapRoute.EXPLAIN -> onRefused(cmd)
        TapRoute.IGNORE -> Unit
    }
}

/** The 18 dp parchment fade over the body's last row and the 2 dp parch-dk rule (SPEC §1 `fadeb`). Draws upward
 *  outside its 2 dp box, over the scroll content above it. */
@Composable internal fun FooterFade() {
    Box(Modifier.fillMaxWidth().height(2.dp).drawBehind {
        val fade = 18.dp.toPx()
        drawRect(Brush.verticalGradient(listOf(PkwTokens.Colors.parchment.copy(alpha = 0f), PkwTokens.Colors.parchment), startY = -fade, endY = 0f),
            topLeft = Offset(0f, -fade), size = Size(size.width, fade))
        drawRect(ArmyInk.parchDk)
    })
}

/**
 * The green FINISH button with its Gems cost pill floating above its top-right (SPEC §2 `FinishButton`, §9 item 6):
 * 96 × 52 on TRAIN, 96 × 44 beside the hero health meter. Taps routed by [commandTap]; the Seal is the host's. The pill
 * sits 4 dp in from the right edge, 14 dp above the top (train.html `.cost` right 4 / top −14). A paid finish without a
 * pill says its [CommandUi.sub] ("Price shown in review") to screen readers; the review shows the price.
 */
@Composable internal fun FinishButton(cmd: CommandUi, onRun: () -> Unit, onNeedMore: (PriceUi) -> Unit, onRefused: (CommandUi) -> Unit,
    modifier: Modifier = Modifier, height: Dp = 52.dp) {
    val state = effectiveState(cmd)
    val spoken = listOfNotNull(cmd.caption, cmd.price?.let(::priceDescription), cmd.sub,
        cmd.reason?.takeIf { state == CommandState.DISABLED || state == CommandState.LOCKED }).joinToString(". ")
    Box(modifier.padding(top = if (cmd.price != null) 14.dp else 0.dp)) {
        val verb = when (state) { CommandState.DISABLED -> Verb.OFF; CommandState.BUSY -> Verb.STONE; CommandState.LOCKED -> Verb.CHARCOAL; else -> Verb.GREEN }
        ChunkyBox(PkwTokens.ramp(verb), { routeCommand(cmd, onRun, onNeedMore, onRefused) }, spoken,
            Modifier.width(96.dp).heightIn(min = height), enabled = state != CommandState.BUSY) {
            if (state == CommandState.BUSY) BusyDots()
            else PkwText(cmd.caption, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
        }
        cmd.price?.let { PriceChip(it, Modifier.align(Alignment.TopEnd).offset(x = (-4).dp, y = (-14).dp)) }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Housing
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Housing header + meter + legend (SPEC §2 `HousingHeader` / `HousingMeter` / `HousingLegend`): "ARMY CAMP  32+9 / 50"
 * with the draft in gold-mid; a 16 dp meter with ready solid green, training green stripes at 80 % and the draft gold;
 * VT 18 swatch keys. Segment changes grow over 160 ms (`out`). Not a touch target.
 */
@Composable internal fun HousingBlock(h: HousingUi, trainingDoneInSec: Long? = null, showDraft: Boolean = true) {
    val c = PkwTokens.Colors
    val count = housingCount(h, showDraft)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        PkwText("ARMY CAMP", PkwTokens.Type.caption, Modifier.weight(1f), color = c.textOnParch)
        PkwText(count.current, PkwTokens.Type.label, color = c.textOnParch)
        count.draft?.let { PkwText(it, PkwTokens.Type.label, color = c.gold.mid) }
        PkwText(" / ${count.capacity}", PkwTokens.Type.label, color = c.textOnParch)
    }
    HousingMeter(h, showDraft)
    val legend = housingLegend(h, trainingDoneInSec, showDraft)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        LegendKey(c.green.face, legend.ready)
        LegendKey(c.green.hi, legend.training)
        // The gold key names the draft's segment; with nothing chosen there is no segment and no key (train-full.png).
        legend.draft?.takeIf { h.draft > 0 }?.let { LegendKey(c.gold.face, it) }
        legend.fullNote?.let { PkwText(it, PkwTokens.Type.small, color = c.shortText) }
    }
}

@Composable private fun LegendKey(color: Color, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.size(10.dp).background(PkwTokens.Colors.ink).padding(2.dp).background(color))
        PkwText(text, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    }
}

/** The three-segment housing meter (368 × 16, ink S rim 2, track #3A2F28). The draft can never overflow (it stops at
 *  capacity upstream, and [housingFractions] clamps anyway). */
@Composable internal fun HousingMeter(h: HousingUi, showDraft: Boolean = true) {
    val f = housingFractions(h, showDraft)
    val reduced = LocalReducedMotion.current
    val spec = tween<Float>(if (reduced) 0 else PkwTokens.Motion.PLATE_IN, easing = PkwTokens.Motion.Out)
    val ready by androidx.compose.animation.core.animateFloatAsState(f.ready, spec, label = "ready")
    val training by androidx.compose.animation.core.animateFloatAsState(f.training, spec, label = "training")
    val draft by androidx.compose.animation.core.animateFloatAsState(f.draft, spec, label = "draft")
    val legend = housingLegend(h, null, showDraft)
    Box(Modifier.fillMaxWidth().height(16.dp).clearAndSetSemantics {
        contentDescription = listOfNotNull(legend.ready, legend.training, legend.draft, legend.fullNote).joinToString(", ")
    }.drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx(); val l = i; val t = i; val w = size.width - 2 * i; val hh = size.height - 2 * i
        drawRect(PkwTokens.Colors.track, Offset(l, t), Size(w, hh))
        if (!h.known) return@drawBehind
        var x = l
        if (ready > 0f) { drawRect(PkwTokens.Colors.green.face, Offset(x, t), Size(w * ready, hh)); drawRect(PkwTokens.Colors.green.hi, Offset(x, t), Size(w * ready, 2.dp.toPx())); x += w * ready }
        if (training > 0f) {
            val stripe = 4.dp.toPx()
            val brush = Brush.linearGradient(0f to PkwTokens.Colors.green.hi, 0.5f to PkwTokens.Colors.green.hi, 0.5f to PkwTokens.Colors.green.face,
                1f to PkwTokens.Colors.green.face, start = Offset.Zero, end = Offset(stripe * 2, stripe * 2), tileMode = androidx.compose.ui.graphics.TileMode.Repeated)
            drawRect(brush, Offset(x, t), Size(w * training, hh), alpha = 0.8f); x += w * training
        }
        if (draft > 0f) { drawRect(PkwTokens.Colors.gold.face, Offset(x, t), Size(w * draft, hh)); drawRect(PkwTokens.Colors.gold.hi, Offset(x, t), Size(w * draft, 2.dp.toPx())) }
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// Cards, wells, rows
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A cream card (DESIGN-SYSTEM §5 CreamCard) with the cluster's inner rims: [rim] draws a [rimWidth] inner rim (green
 * chosen, gold selected / job, red stage / match), [body] replaces the cream (locked, lab cap, selected tint), [dashed]
 * draws the empty saved-army slot (a dashed parch-dk rim on flat parchment). With [onClick] the card is its own button
 * (≥ 48 dp, labelled [description]); [enabled] false still calls back (the caller explains why) but reads "dimmed".
 */
@Composable internal fun ArmyCard(
    modifier: Modifier = Modifier, body: Color? = null, rim: Color? = null, rimWidth: Dp = 3.dp, dashed: Boolean = false,
    padding: PaddingValues = PaddingValues(start = 6.dp, top = 6.dp, end = 6.dp, bottom = 8.dp),
    onClick: (() -> Unit)? = null, description: String? = null, selected: Boolean = false, pressable: Boolean = true,
    content: @Composable BoxScope.() -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val reduced = LocalReducedMotion.current
    val press by androidx.compose.animation.core.animateFloatAsState(if (pressed && pressable && onClick != null) 1f else 0f,
        tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE), label = "card-press")
    val clickMod = if (onClick == null) (if (description != null) Modifier.clearAndSetSemantics { contentDescription = description } else Modifier)
    else Modifier.heightIn(min = PkwTokens.Dims.minTap)
        .clearAndSetSemantics {
            contentDescription = description ?: ""; role = Role.Button; this.selected = selected
            this.onClick(label = null, action = { onClick(); true })
        }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
    Box(modifier.then(clickMod).sceneInputRegion()
        .graphicsLayer { translationY = 3.dp.toPx() * press }
        .drawBehind {
            if (dashed) {
                drawRect(ArmyInk.savedEmpty)
                val s = 2.dp.toPx()
                drawRect(ArmyInk.parchDk, Offset(s / 2, s / 2), Size(size.width - s, size.height - s),
                    style = Stroke(s, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx()))))
            } else {
                drawPlate(PlateKind.CREAM, body)
                if (rim != null) {
                    val i = 2.dp.toPx(); val r = rimWidth.toPx(); val w = size.width; val h = size.height
                    insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                        drawRect(rim, Offset(i, i), Size(w - 2 * i, r))
                        drawRect(rim, Offset(i, h - i - r), Size(w - 2 * i, r))
                        drawRect(rim, Offset(i, i), Size(r, h - 2 * i))
                        drawRect(rim, Offset(w - i - r, i), Size(r, h - 2 * i))
                    }
                }
            }
        }.padding(padding), content = content)
}

/** A portrait well (SPEC §2 TroopCard): [wellSize] dark box with a 2 dp ink rim and the art at [artSize]; the level tag at
 *  the bottom-left and the housing pip at the top-right as 18 dp ink boxes laid over the rim (army.css `.por .lv` / `.pts`
 *  at −2 / −2). [saturation] / [brightness] / [artAlpha] tone the art only (a locked card: grey, brightness 0.45). */
@Composable internal fun PortraitWell(art: String, modifier: Modifier = Modifier, wellSize: Dp = 60.dp, artSize: Dp = 56.dp,
    level: String? = null, pip: String? = null, saturation: Float = 1f, artAlpha: Float = 1f, well: Color = ArmyInk.well,
    rim: Color = PkwTokens.Colors.ink, brightness: Float = 1f) {
    Box(modifier.size(wellSize).background(rim)) {
        Box(Modifier.matchParentSize().padding(2.dp).background(well), contentAlignment = Alignment.Center) {
            PkwIcon(art, artSize, Modifier.toned(saturation, brightness), alpha = artAlpha)
        }
        level?.let { InkBox(it, PkwTokens.Colors.blue.hi, Modifier.align(Alignment.BottomStart)) }
        pip?.let { InkBox(it, PkwTokens.Colors.label, Modifier.align(Alignment.TopEnd)) }
    }
}

/** The 18 dp ink box with a PS 11 label (level tag "L3", housing pip "2"; at least 18 wide). */
@Composable internal fun InkBox(text: String, color: Color, modifier: Modifier = Modifier) {
    Box(modifier.heightIn(min = 18.dp).widthIn(min = 18.dp).background(PkwTokens.Colors.ink).padding(horizontal = 3.dp), contentAlignment = Alignment.Center) {
        PkwText(text, PkwTokens.Type.caption, color = color)
    }
}

/** A mini portrait (SPEC §9): a 32 dp ink box with the art at 28 dp; heroes get a gold-lo border; an outlined PS 11 count
 *  at the bottom-right when given. */
@Composable internal fun MiniPortrait(art: String, modifier: Modifier = Modifier, count: String? = null, hero: Boolean = false) {
    Box(modifier.size(32.dp)) {
        Box(Modifier.size(32.dp).background(if (hero) PkwTokens.Colors.gold.lo else PkwTokens.Colors.ink).padding(2.dp).background(ArmyInk.well),
            contentAlignment = Alignment.Center) { PkwIcon(art, 28.dp) }
        count?.let { PkwText(it, PkwTokens.Type.caption, Modifier.align(Alignment.BottomEnd).offset(x = 4.dp, y = 6.dp), color = PkwTokens.Colors.label, outline = 1.dp) }
    }
}

/** A section line (SPEC §2 `SectionLine`): PS 11 title, VT 18 hint, a 2 dp parch-dk rule to the end, and an optional
 *  trailing control (LAST ARMY). */
@Composable internal fun SectionLine(title: String, hint: String? = null, hintColor: Color = PkwTokens.Colors.textOnParch2,
    trailing: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PkwText(title, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
        hint?.let { PkwText(it, PkwTokens.Type.small, color = hintColor) }
        Box(Modifier.weight(1f).height(2.dp).background(ArmyInk.parchDk))
        trailing?.invoke()
    }
}

/** A grid of [columns] equal cells, [gap] apart; the last row is padded with spacers so cells keep their width. */
@Composable internal fun <T> CellGrid(items: List<T>, columns: Int, hGap: Dp = 4.dp, vGap: Dp = 6.dp, modifier: Modifier = Modifier,
    cell: @Composable (T, Modifier) -> Unit) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(vGap)) {
        items.chunked(columns).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(hGap)) {
                row.forEach { cell(it, Modifier.weight(1f)) }
                repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** Loading skeletons (SPEC §1 "Never blank the world"): cream at 50 % with "…", never 0. */
@Composable internal fun SkeletonGrid(columns: Int, count: Int, height: Dp) {
    CellGrid((0 until count).toList(), columns) { _, m ->
        Box(m.height(height).alpha(0.5f).drawBehind { drawPlate(PlateKind.CREAM) }.clearAndSetSemantics { contentDescription = "Loading" },
            contentAlignment = Alignment.Center) { PkwText(UNKNOWN, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch2) }
    }
}

/** A row of [total] stars at [size]; unearned ones are grey at 50 % (SPEC §6 RecentRaidRow, §6 StageCard). */
@Composable internal fun StarRow(earned: Int, total: Int = 3, size: Dp = 24.dp, gap: Dp = 2.dp) {
    Row(Modifier.clearAndSetSemantics { contentDescription = "$earned of $total stars" }, horizontalArrangement = Arrangement.spacedBy(gap)) {
        repeat(total) { i -> PkwIcon("star", size, if (i < earned) Modifier else Modifier.toned(0f, 0.9f), alpha = if (i < earned) 1f else 0.5f) }
    }
}

/** The blue notice row above a grid (SPEC §4 "A finish payment is waiting" + CHECK, §6 "A server-saved march is waiting"
 *  + RECOVER): the existing recovery flows, unchanged; only this entry is new. */
@Composable internal fun NoticeRow(text: String, actionLabel: String, onAction: () -> Unit) {
    ArmyCard(Modifier.fillMaxWidth(), body = PkwTokens.Colors.blue.hi.copy(alpha = 0.35f).compositeOverCream(), rim = PkwTokens.Colors.blue.face, rimWidth = 2.dp) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwIcon("shape:info", 24.dp, tint = PkwTokens.Colors.blue.lo)
            PkwText(text, PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 2)
            SecondaryButton(actionLabel, onAction, verb = Verb.BLUE)
        }
    }
}

/** A translucent colour flattened over cream, so a card body stays opaque. */
private fun Color.compositeOverCream(): Color {
    val base = PkwTokens.Colors.cream
    val a = alpha
    return Color(red * a + base.red * (1 - a), green * a + base.green * (1 - a), blue * a + base.blue * (1 - a), 1f)
}

/** A small chunky stepper face drawn at [faceSize] inside a 48 dp hit area (SPEC §2: the "−" is 30 × 30, hit area 48). */
@Composable internal fun SmallStep(icon: String, onClick: () -> Unit, contentDescription: String, modifier: Modifier = Modifier,
    faceSize: Dp = 30.dp, verb: Verb = Verb.STONE) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val reduced = LocalReducedMotion.current
    val press by androidx.compose.animation.core.animateFloatAsState(if (pressed) 1f else 0f,
        tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE), label = "step")
    Box(modifier.size(PkwTokens.Dims.minTap).sceneInputRegion()
        .clearAndSetSemantics { this.contentDescription = contentDescription; role = Role.Button; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick), contentAlignment = Alignment.Center) {
        Box(Modifier.size(faceSize).drawBehind { drawChunky(PkwTokens.ramp(verb), press, 4f) }, contentAlignment = Alignment.Center) {
            PkwIcon(icon, 16.dp, Modifier.offset(y = (-1).dp), tint = PkwTokens.Colors.label)
        }
    }
}

/** A stat row: key in t-ink2, then "now ▸ next" with the new value in green; unchanged stats show the value only. */
@Composable internal fun StatDeltaRow(stat: StatDeltaUi, keyWidth: Dp = 110.dp) {
    Row(Modifier.fillMaxWidth().clearAndSetSemantics {
        contentDescription = if (stat.next == null) "${stat.label} ${stat.now}" else "${stat.label} ${stat.now}, next ${stat.next}"
    }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        PkwText(stat.label, PkwTokens.Type.small, Modifier.width(keyWidth), color = PkwTokens.Colors.textOnParch2)
        PkwText(stat.now, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch)
        stat.next?.let {
            PkwText("▸", PkwTokens.Type.small, color = ArmyInk.gain)
            PkwText(it, PkwTokens.Type.small, color = ArmyInk.gain)
        }
    }
}

/** A dashed 2 dp parch-dk line (stage road, the stage card's rule). */
@Composable internal fun DashedRule(modifier: Modifier = Modifier, thickness: Dp = 2.dp) {
    Box(modifier.height(thickness).drawBehind {
        val dash = 6.dp.toPx(); val gap = 4.dp.toPx()
        var x = 0f
        while (x < size.width) { drawRect(ArmyInk.parchDk, Offset(x, 0f), Size(minOf(dash, size.width - x), size.height)); x += dash + gap }
    })
}

/** "L4 → L5": the from level in ink, a drawn arrow, the target in green (SPEC §4 `ResearchDetail`). */
@Composable internal fun LevelArrow(from: String, to: String) {
    Row(Modifier.clearAndSetSemantics { contentDescription = "$from to $to" }, verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        PkwText(from, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
        PkwIcon("shape:go", 14.dp, tint = PkwTokens.Colors.textOnParch)
        PkwText(to, PkwTokens.Type.caption, color = ArmyInk.gain)
    }
}

/** A thin labelled meter on parchment (hero health, research job, queue head). */
@Composable internal fun ParchMeter(progress: Float?, description: String, modifier: Modifier = Modifier, height: Dp = 10.dp, verb: Verb = Verb.GREEN) {
    ProgressBar(progress, description, modifier, verb = verb, height = height)
}

/** The red/blue/green inline part of a VT line (recent raid loot, defence rows). */
@Composable internal fun ToneText(text: String, tone: DeltaTone) {
    PkwText(text, PkwTokens.Type.small, color = deltaColor(tone))
}

/** Centred VT 18 note (campaign rules line). */
@Composable internal fun CentredNote(text: String) {
    PkwText(text, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center, maxLines = 3)
}

/** Disabled-for-touch wrapper semantics for a dimmed grid (SPEC §2 "no room", §4 busy): content stays readable. */
internal fun Modifier.dimmed(on: Boolean, alpha: Float, saturation: Float): Modifier =
    if (!on) this else this.alpha(alpha).toned(saturation)

// ---------------------------------------------------------------------------------------------------------------------
// Preview samples shared by the cluster's previews
// ---------------------------------------------------------------------------------------------------------------------

internal object ArmySamples {
    fun shards(amount: String?, status: PriceStatus = PriceStatus.OK) = PriceUi(Currency.SHARDS, amount, status)
    fun gems(amount: String?, status: PriceStatus = PriceStatus.OK) = PriceUi(Currency.GEMS, amount, status)
    fun cmd(id: String, caption: String, verb: Verb, state: CommandState = CommandState.ENABLED, sub: String? = null, reason: String? = null,
        price: PriceUi? = null, icon: String = "") = CommandUi(FeatureId(id), icon, caption, price, true, state, reason, null, verb = verb, sub = sub)
    fun walkers(names: List<String>, dir: Dir8, y: Int, scale: Int = 2, start: Int = 20, step: Int = 30) =
        names.mapIndexed { i, n -> WalkerUi(SpriteRef(n, 56), dir, start + i * step, y, scale) }
    val resources = listOf(
        ResourceChipUi(FeatureId("hud.shards"), "shards", "40,943", 0.62f, false, null, name = "Shards", accent = ResourceAccent.SHARDS),
        ResourceChipUi(FeatureId("hud.gems"), "gem", "1,250", null, false, null, name = "Gems", accent = ResourceAccent.GEMS),
        ResourceChipUi(FeatureId("hud.skr"), "skr", "240", null, false, null, name = "SKR", accent = ResourceAccent.SKR, drawerHandle = true),
    )
}

/** Frames a sheet preview the way the SheetHost does (TALL from y 104 on a 412 × 915 phone over the world). */
@Composable internal fun SheetPreviewFrame(kind: ArmySheetKind, content: @Composable (Modifier) -> Unit) {
    Box(Modifier.fillMaxSize().background(ArmyInk.grass)) {
        Box(Modifier.fillMaxSize().background(PkwTokens.Colors.scrim.copy(alpha = PkwTokens.Scrim.SHEET_TALL)))
        ArmySheetResources(ArmySamples.resources, kind, {}, Modifier.align(Alignment.TopEnd).padding(top = 10.dp, end = 8.dp))
        content(Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp, top = PkwTokens.Dims.tallSheetTop))
    }
}

@Preview(name = "Army parts: housing, cards, header chip", widthDp = 412, heightDp = 420)
@Composable private fun ArmyPartsPreview() {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        HeaderChip(HeaderChipUi("timer", "All ready in", "6m 30s"))
        HeaderChip(HeaderChipUi(null, "Ready", null, DotColor.GREEN))
        HousingBlock(HousingUi(24, 8, 9, 50, 20, full = false))
        HousingBlock(HousingUi(0, 0, 0, 0, 0, full = false, known = false))
        SectionLine("TROOPS", "tap to add")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MiniPortrait("ui_portrait_highlander_t3", count = "8")
            MiniPortrait("hero_vex_portrait", hero = true)
            StarRow(2)
        }
        StatDeltaRow(StatDeltaUi("Hitpoints", "45", "54"))
        LevelArrow("L4", "L5")
    }
}

@Preview(name = "Living header (still frame)", widthDp = 398, heightDp = 136)
@Composable private fun LivingHeaderPreview() {
    LivingHeaderArt(HeaderArtUi(SpriteRef("ui_portrait_barracks_t3", 56), 1,
        ArmySamples.walkers(listOf("ui_portrait_highlander_t3", "ui_portrait_bowman_t1", "ui_portrait_mage_t1"), Dir8.W, 60), buildingScale = 4, buildingXDp = 230,
        buildingYDp = 10), Modifier.size(398.dp, 136.dp))
}
