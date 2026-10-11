package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PixelShapes
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.TabStrip
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.chunkyContentPadding
import gg.pixelkingdomwars.nativeclient.ui.kit.countUpText
import gg.pixelkingdomwars.nativeclient.ui.kit.drawChunky
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileState
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/*
 * Design components: the parts every craft-cluster sheet is built from (craft/SPEC.md §1 "CraftSheet" and its content
 * parts; DESIGN-SYSTEM §6), assembled only from kit pieces. The kit has no slot for a stacked tab strip, a grass header,
 * recipe / ingredient rows, steppers or the craft celebration, so they live here (KIT-API "Not in the kit").
 *
 * Pointer rule (every part): only painted panels and buttons take touches. The sheet frame is a painted wood panel, never
 * full-screen. The only scrims are the celebration's (inside the sheet's bounds, only while it shows) — the TALL sheet's
 * 40 % world scrim belongs to the SheetHost. The review half sheet has no scrim.
 */

private val WELL_HI = Color(0xFF5A3A22)
private val WELL_LO = Color(0xFF2A2026)
private val WELL_BAND = Color(0xFF3A3340)
/** Header input well body. */
internal val WELL_DARK = Color(0xFF2A2026)
/** Header output well body (SPEC §2.1 `#3A3020`). */
internal val WELL_OUTPUT = Color(0xFF3A3020)
private val READY_TINT = Color(0xFFEEF7D8)
private val MISSING_TINT = Color(0xFFFDE3D8)
private val INFO_TINT = Color(0xFFE8F1F8)
private val GRASS = Color(0xFF4A7339)
private val GRASS_DARK = Color(0xFF3B5F2E)
private val GRASS_LIGHT = Color(0xFF5E8A47)

// ------------------------------------------------------------------------------------------------------------------ frame

/**
 * The craft sheet frame (SPEC §1): wood frame, the 136 dp grass header (+ 3 dp ink rule) with title plate, History, close
 * and live chip, the tabs (stacked for 4, the kit's side-by-side otherwise), the scrolling parchment body and the pinned
 * footer (one primary row + note; it pads itself above the gesture inset, so the host gives the sheet the full height to
 * the bottom edge). Tab changes cross-fade the body in 120 ms. [panelOverlay] draws over the panel (the review half
 * sheet), [frameOverlay] over the whole frame (the celebration).
 */
@Composable internal fun CraftSheetFrame(frame: CraftFrameUi, onClose: () -> Unit, onTab: (String) -> Unit, onHistory: () -> Unit,
    modifier: Modifier = Modifier, headerArt: @Composable BoxScope.() -> Unit = {}, footer: (@Composable ColumnScope.() -> Unit)? = null,
    panelOverlay: (@Composable BoxScope.() -> Unit)? = null, frameOverlay: (@Composable BoxScope.() -> Unit)? = null,
    body: @Composable ColumnScope.() -> Unit) {
    val reduced = LocalReducedMotion.current
    val fade = remember { Animatable(1f) }
    var lastTab by remember { mutableStateOf(frame.selectedTab) }
    LaunchedEffect(frame.selectedTab) {
        if (lastTab != frame.selectedTab) {
            lastTab = frame.selectedTab
            fade.snapTo(0f)
            fade.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TAB_SWITCH, easing = PkwTokens.Motion.Out))
        }
    }
    Box(modifier) {
        Plate(PlateKind.WOOD, Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 3.dp, top = 3.dp, end = 3.dp, bottom = 4.dp)) {
            Column(Modifier.fillMaxSize()) {
                CraftHeader(frame, onClose, onHistory, headerArt)
                Column(Modifier.fillMaxWidth().weight(1f).padding(start = 8.dp, top = 8.dp, end = 8.dp)) {
                    if (frame.stackedTabs) StackedTabStrip(frame.tabs, frame.selectedTab, onTab)
                    else TabStrip(frame.tabs, frame.selectedTab, onTab)
                    Box(Modifier.fillMaxWidth().weight(1f)) {
                        Plate(PlateKind.PARCHMENT, Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 10.dp, top = 10.dp, end = 10.dp),
                            blocksScene = false) {
                            Column(Modifier.fillMaxSize()) {
                                key(frame.selectedTab) {
                                    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())
                                        .graphicsLayer { alpha = fade.value }, verticalArrangement = Arrangement.spacedBy(8.dp), content = body)
                                }
                                if (footer != null) {
                                    Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(top = 8.dp, bottom = 22.dp),
                                        verticalArrangement = Arrangement.spacedBy(6.dp), content = footer)
                                }
                            }
                        }
                        panelOverlay?.invoke(this)
                    }
                }
            }
        }
        frameOverlay?.invoke(this)
    }
}

/** The 136 dp header: grass, the caller's art, title plate, History + close, live chip; then the 3 dp ink rule. */
@Composable private fun CraftHeader(frame: CraftFrameUi, onClose: () -> Unit, onHistory: () -> Unit, art: @Composable BoxScope.() -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Box(Modifier.fillMaxWidth().height(PkwTokens.Dims.sheetHeaderH).clipToBounds()) {
            // The grass sits in its own layer: the 8 fps working loop and the ticking live chip re-record only their own
            // drawing, never the few hundred grass specks.
            Box(Modifier.matchParentSize().graphicsLayer().drawBehind { drawGrass() })
            art()
            TitlePlate(frame.title, frame.titleTag, Modifier.align(Alignment.TopStart).padding(start = 6.dp, top = 6.dp))
            Row(Modifier.align(Alignment.TopEnd).padding(top = 4.dp, end = 5.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (frame.history) IconSquare("replay", Verb.STONE, onHistory, "History")
                CloseSquare(onClose)
            }
            frame.live?.let { LiveChip(it, Modifier.align(Alignment.BottomStart).padding(start = 6.dp, bottom = 6.dp)) }
        }
        Box(Modifier.fillMaxWidth().height(3.dp).background(PkwTokens.Colors.ink))
    }
}

/** The real game grass stand-in: a flat grass face with a fixed 2 dp speckle repeated every 84 dp (the derived
 *  `pkw_pe_header_grass` crop is not a byte copy, so it was not made; SPEC §6 allows sampling the realm ground instead). */
internal fun DrawScope.drawGrass() {
    drawRect(GRASS)
    val tile = 84.dp.toPx(); val px = 2.dp.toPx(); val cell = tile / 84f
    var ty = 0f
    while (ty < size.height) {
        var tx = 0f
        while (tx < size.width) {
            for (k in 0 until 40) {
                val x = tx + ((k * 37 + 11) % 84) * cell
                val y = ty + ((k * 53 + 29) % 84) * cell
                drawRect(if (k % 3 == 0) GRASS_LIGHT else GRASS_DARK, Offset(x, y), Size(px, px))
            }
            tx += tile
        }
        ty += tile
    }
}

/** The charcoal title plate: PS 13 gold-hi title and the blue level tag. */
@Composable private fun TitlePlate(title: String, tag: String?, modifier: Modifier) {
    Plate(PlateKind.CHARCOAL, modifier.heightIn(min = 40.dp).semantics(mergeDescendants = true) { heading() }, blocksScene = false) {
        Row(Modifier.align(Alignment.CenterStart).padding(horizontal = 2.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwText(title, PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
            if (tag != null) Tag(tag, Verb.BLUE)
        }
    }
}

/** The header's live chip (VeilChip 30): icon + one sentence, the accent in gold-hi, all green when ready. Not a live
 *  region: a ticking countdown would chatter. */
@Composable private fun LiveChip(ui: CraftLiveUi, modifier: Modifier) {
    val big = ui.icon.startsWith("ui:") || ui.icon.startsWith("craft:")
    val c = PkwTokens.Colors
    Plate(PlateKind.VEIL, modifier.heightIn(min = PkwTokens.Dims.timerChipH).clearAndSetSemantics { contentDescription = ui.description },
        contentPadding = PaddingValues(start = 4.dp, top = 1.dp, end = 10.dp, bottom = 1.dp), blocksScene = false) {
        Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            CraftIcon(ui.icon, if (big) 32.dp else 24.dp)
            PkwText(ui.text, PkwTokens.Type.body, color = if (ui.ready) c.green.hi else c.text, outline = 1.dp)
            ui.accent?.let { PkwText(it, PkwTokens.Type.body, color = if (ui.ready) c.green.hi else c.gold.hi, outline = 1.dp) }
        }
    }
}

/**
 * The header's working stage (SPEC 0.3, §2.1): the building sprite (or its working loop) at world density, 168 dp, at
 * ([spriteX], [spriteY]); the input well 44 + white arrow at (116, 52); the output well 44 at right 10, y 78.
 */
@Composable internal fun BoxScope.HeaderStage(header: CraftHeaderUi, input: CraftWellUi?, output: CraftWellUi?, spriteX: Dp, spriteY: Dp,
    spriteDescription: String) {
    // SPEC §2.1 "START accepted": the input well's icon flies into the building (300 ms `in`) as the header swaps to the
    // working loop, and the building gives a small bump when it lands. Only on the idle → working change this sheet saw;
    // reopening on a working bench plays nothing. Reduced motion: no flight. The flight is read in layout/draw lambdas, so
    // its frames never recompose the header.
    val working = header.loop != null
    val reduced = LocalReducedMotion.current
    val fly = remember { Animatable(1f) }
    var flyIcon by remember { mutableStateOf<String?>(null) }
    var wasWorking by remember { mutableStateOf(working) }
    val flyFrom = input?.icon
    LaunchedEffect(working) {
        val started = working && !wasWorking
        wasWorking = working
        if (started && !reduced && flyFrom != null) {
            flyIcon = flyFrom
            try {
                fly.snapTo(0f)
                fly.animateTo(1f, tween(START_FLY_MS, easing = PkwTokens.Motion.In))
            } finally {
                flyIcon = null
            }
        }
    }
    Box(Modifier.offset(x = spriteX, y = spriteY).size(168.dp)
        .graphicsLayer {
            // The landing bump: the last 30 % of the flight lifts the building 4 % and settles it.
            val p = fly.value
            val b = if (flyIcon == null || p >= 1f || p < 0.7f) 0f else sin(((p - 0.7f) / 0.3f) * Math.PI.toFloat()) * 0.04f
            scaleX = 1f + b; scaleY = 1f + b
            transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0.5f, 0.9f)
        }
        .semantics { contentDescription = spriteDescription }) {
        val loop = header.loop
        val still = header.sprite
        if (loop != null) CraftAtlasLoop(loop, header.loopFps, 168.dp, still = still)
        else if (still != null) CraftIcon(still, 168.dp)
    }
    if (input != null) {
        Row(Modifier.offset(x = 116.dp, y = 52.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Well(44.dp, flat = WELL_DARK) { CraftIcon(input.icon, 32.dp, alpha = input.alpha, contentDescription = input.description) }
            PkwIcon("shape:go", 18.dp, tint = PkwTokens.Colors.label)
        }
    }
    if (output != null) {
        Well(44.dp, Modifier.align(Alignment.TopEnd).offset(x = (-10).dp, y = 78.dp), flat = WELL_OUTPUT) {
            CraftIcon(output.icon, 32.dp, alpha = output.alpha, contentDescription = output.description)
        }
    }
    flyIcon?.let { icon ->
        // From the icon's place inside the input well (116 + 6, 52 + 6) to the building's centre, on a small arc.
        val toX = spriteX.value + 84f - 16f
        val toY = spriteY.value + 84f - 16f
        CraftIcon(icon, 32.dp, Modifier
            .offset {
                val p = fly.value
                IntOffset((122f + (toX - 122f) * p).dp.roundToPx(), (58f + (toY - 58f) * p - 28f * sin(p * Math.PI.toFloat())).dp.roundToPx())
            }
            .graphicsLayer {
                val p = fly.value
                alpha = 1f - 0.7f * p
                scaleX = 1f - 0.45f * p; scaleY = 1f - 0.45f * p
            })
    }
}

/** The START flight's length (SPEC §2.1 motion table: 300 ms `in`). */
private const val START_FLY_MS = 300

// ------------------------------------------------------------------------------------------------------------------- tabs

private val STACKED_TAB_H = 56.dp

/**
 * `Tabs.Stacked` (SPEC 0.1): equal tabs, icon 32 above a ≤ 6-glyph label. The active tab is parchment and runs on into
 * the panel; inactive tabs are wood with outlined labels. A badge sits outside the corner; a locked tab shows a padlock
 * and still calls back. Each tab is its own ≥ 48 dp target. 56 dp tall (48 in the design): the display-face fallback
 * (VT323 20 sp) is taller than PS 11.
 */
@Composable internal fun StackedTabStrip(tabs: List<TabUi>, selected: String?, onSelect: (String) -> Unit, modifier: Modifier = Modifier) {
    if (tabs.isEmpty()) return
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        tabs.forEach { tab -> StackedTab(tab, tab.id == selected, { onSelect(tab.id) }, Modifier.weight(1f)) }
    }
}

@Composable private fun StackedTab(tab: TabUi, active: Boolean, onClick: () -> Unit, modifier: Modifier) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val reduced = LocalReducedMotion.current
    val press by animateFloatAsState(if (pressed) 1f else 0f,
        tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE), label = "stackedTab")
    val spoken = listOfNotNull(tab.label, if (tab.locked) "locked" else null, tab.badge?.description).joinToString(", ")
    val c = PkwTokens.Colors
    Box(modifier) {
        Box(Modifier.fillMaxWidth().height(STACKED_TAB_H).sceneInputRegion()
            .clearAndSetSemantics {
                contentDescription = spoken; role = Role.Tab; selected = active
                this.onClick(label = null, action = { onClick(); true })
            }
            .clickable(interactionSource = interaction, indication = null, role = Role.Tab, onClick = onClick)
            .offset { IntOffset(0, (2.dp.toPx() * press).roundToInt()) }
            .drawBehind {
                val w = size.width; val h = size.height; val i = 2.dp.toPx()
                if (active) {
                    fillStepped(0f, 0f, w, h + 8.dp.toPx(), CornerProfiles.S, c.ink)
                    insideStepped(i, i, w - i, h + 8.dp.toPx(), CornerProfiles.S) {
                        drawRect(c.parchment)
                        band(i, w - i, i, 3.dp.toPx(), c.parchmentHi)
                    }
                } else {
                    fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
                    insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                        drawRect(c.wood)
                        band(i, w - i, i, 3.dp.toPx(), c.woodHi)
                        band(i, w - i, h - i - 3.dp.toPx(), 3.dp.toPx(), c.woodLo)
                    }
                }
            }) {
            CraftIcon(tab.icon, 32.dp, Modifier.align(Alignment.TopCenter).padding(top = 2.dp), alpha = if (tab.locked) 0.5f else 1f)
            if (tab.locked) PkwIcon("shape:lock", 16.dp, Modifier.align(Alignment.TopEnd).padding(top = 4.dp, end = 4.dp), tint = c.gold.face)
            if (active) PkwText(tab.label, PkwTokens.Type.caption, Modifier.align(Alignment.BottomCenter).padding(bottom = 1.dp), color = c.textOnParch)
            else PkwText(tab.label, PkwTokens.Type.caption, Modifier.align(Alignment.BottomCenter).padding(bottom = 3.dp), color = c.label, outline = 1.dp)
        }
        tab.badge?.let { Badge(it, Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-8).dp)) }
    }
}

// ----------------------------------------------------------------------------------------------------------- content parts

/** SectionLabel (SPEC §1): PS 12 title, VT 18 sub, optional right VT 18 count. */
@Composable internal fun SectionLabel(title: String, sub: String? = null, right: String? = null, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    Row(modifier.fillMaxWidth().semantics(mergeDescendants = true) { heading() }, verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PkwText(title, PkwTokens.Type.label, color = c.textOnParch)
        PkwText(sub.orEmpty(), PkwTokens.Type.small, Modifier.weight(1f), color = c.textOnParch2)
        if (right != null) PkwText(right, PkwTokens.Type.small, color = c.textOnParch2)
    }
}

/** A cream card's rim: none, selected (gold on #FFF3C8), ready (green on #EEF7D8), missing (blood on #FDE3D8),
 *  info (#E8F1F8, no rim) and note (#FFF3C8, no rim). */
internal enum class CardRim { NONE, SELECTED, READY, MISSING, INFO, NOTE }

/** CreamCard (DESIGN-SYSTEM §5) with an optional state rim. Painted only: make the caller's modifier clickable. */
@Composable internal fun CreamCard(modifier: Modifier = Modifier, rim: CardRim = CardRim.NONE, contentPadding: PaddingValues = PaddingValues(8.dp),
    content: @Composable BoxScope.() -> Unit) {
    val c = PkwTokens.Colors
    val (tint, border) = when (rim) {
        CardRim.NONE -> null to null
        CardRim.SELECTED -> c.selectedTint to c.gold.face
        CardRim.READY -> READY_TINT to c.green.face
        CardRim.MISSING -> MISSING_TINT to c.blood
        CardRim.INFO -> INFO_TINT to null
        CardRim.NOTE -> c.selectedTint to null
    }
    Plate(PlateKind.CREAM, modifier.then(if (border != null) Modifier.border(3.dp, border, PixelShapes.M) else Modifier),
        contentPadding = contentPadding, tint = tint, blocksScene = false, content = content)
}

/** The dark `Well` behind an item (SPEC §1 RecipeCard): radial #5A3A22 → #2A2026, 2 dp ink, 3 dp #3A3340 top band;
 *  [flat] paints one colour instead (header wells). */
@Composable internal fun Well(size: Dp, modifier: Modifier = Modifier, flat: Color? = null, content: @Composable BoxScope.() -> Unit) {
    Box(modifier.size(size).drawBehind {
        val w = this.size.width; val h = this.size.height; val i = 2.dp.toPx()
        fillStepped(0f, 0f, w, h, CornerProfiles.S, PkwTokens.Colors.ink)
        insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
            if (flat != null) drawRect(flat)
            else drawRect(Brush.radialGradient(listOf(WELL_HI, WELL_LO), center = Offset(w / 2f, h / 2f), radius = maxOf(w, h) * 0.6f))
            band(i, w - i, i, 3.dp.toPx(), WELL_BAND)
        }
    }, contentAlignment = Alignment.Center, content = content)
}

/**
 * The craft ItemTile (DESIGN-SYSTEM §6 ItemTile, 72 × 80) drawing `craft:` art. Selected: gold inner rim on #FFF3C8 with
 * a 90 ms rim pop; missing: blood rim, icon 45 %, red count; locked: icon 40 % + padlock. Always its own ≥ 48 dp target.
 */
@Composable internal fun CraftTile(ui: ItemTileUi, onClick: (String) -> Unit, modifier: Modifier = Modifier, locked: Boolean = false) {
    val c = PkwTokens.Colors
    val selected = ui.state == ItemTileState.SELECTED
    val missing = ui.state == ItemTileState.MISSING
    val reduced = LocalReducedMotion.current
    val pop = remember { Animatable(1f) }
    var wasSelected by remember { mutableStateOf(selected) }
    LaunchedEffect(selected) {
        if (selected && !wasSelected && !reduced) {
            pop.snapTo(1.06f)
            pop.animateTo(1f, tween(PkwTokens.Motion.RELEASE, easing = PkwTokens.Motion.Out))
        }
        wasSelected = selected
    }
    val body = when { selected -> c.selectedTint; missing -> MISSING_TINT; ui.divine -> c.divine; else -> c.cream }
    Box(modifier.graphicsLayer { scaleX = pop.value; scaleY = pop.value }) {
        Box(Modifier.size(PkwTokens.Dims.itemTileW, PkwTokens.Dims.itemTileH).sceneInputRegion()
            .clearAndSetSemantics {
                contentDescription = ui.description; role = Role.Button; this.selected = selected
                this.onClick(label = null, action = { onClick(ui.id); true })
            }
            .clickable(role = Role.Button) { onClick(ui.id) }
            .drawBehind {
                val w = size.width; val h = size.height; val i = 2.dp.toPx()
                fillStepped(0f, 0f, w, h, CornerProfiles.M, if (missing) c.blood else c.ink)
                insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                    drawRect(body)
                    band(i, w - i, h - i - 4.dp.toPx(), 4.dp.toPx(), c.creamLo)
                    if (selected) {
                        val r = 3.dp.toPx()
                        drawRect(c.gold.face, Offset(i, i), Size(w - 2 * i, r))
                        drawRect(c.gold.face, Offset(i, h - i - r), Size(w - 2 * i, r))
                        drawRect(c.gold.face, Offset(i, i), Size(r, h - 2 * i))
                        drawRect(c.gold.face, Offset(w - i - r, i), Size(r, h - 2 * i))
                    }
                }
            }, contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                CraftIcon(ui.icon, 32.dp, alpha = when { locked || ui.empty -> 0.4f; missing -> 0.45f; else -> 1f })
                PkwText(ui.count, PkwTokens.Type.caption, color = if (missing || ui.empty) c.shortText else c.textOnParch)
            }
            if (locked) PkwIcon("shape:lock", 16.dp, Modifier.align(Alignment.TopEnd).padding(top = 6.dp, end = 6.dp), tint = c.gold.face)
        }
        if (ui.isNew) Badge(BadgeUi("NEW", BadgeTone.REWARD, "New"), Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-8).dp))
    }
}

/** TileStrip (SPEC §1): a sideways LazyRow, 6 dp apart; five tiles overflow the panel so the fifth peeks. */
@Composable internal fun TileStrip(tiles: List<RecipeTile>, onClick: (String) -> Unit, modifier: Modifier = Modifier) {
    LazyRow(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), contentPadding = PaddingValues(end = 8.dp)) {
        items(tiles, key = { it.tile.id }) { t -> CraftTile(t.tile, onClick, locked = t.locked) }
    }
}

/** The cream timer chip (26 tall): timer 24 + PS 11. */
@Composable internal fun TimerTag(text: String, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    Row(modifier.heightIn(min = 26.dp).drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, c.ink)
        val i = 2.dp.toPx()
        fillStepped(i, i, size.width - i, size.height - i, CornerProfiles.S, c.cream)
    }.padding(start = 3.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        PkwIcon("timer", 24.dp)
        PkwText(text, PkwTokens.Type.caption, color = c.textOnParch)
    }
}

/** RecipeCard (SPEC §1): CreamCard 88 with the output in a 72 dark well, the name + optional stone tag, what it is for,
 *  and the time each. [dim] draws the output at 45 % (locked). */
@Composable internal fun RecipeCard(icon: String, name: String, tag: String?, usedFor: String, time: String, modifier: Modifier = Modifier,
    dim: Boolean = false) {
    val c = PkwTokens.Colors
    CreamCard(modifier.fillMaxWidth().heightIn(min = 88.dp), contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 8.dp, bottom = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Well(72.dp) { CraftIcon(icon, 64.dp, alpha = if (dim) 0.45f else 1f) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PkwText(name.uppercase(Locale.US), PkwTokens.Type.label, Modifier.weight(1f, fill = false), color = c.textOnParch)
                    if (tag != null) Tag(tag, Verb.STONE)
                }
                if (usedFor.isNotBlank()) PkwText(usedFor, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    TimerTag(time)
                    PkwText("each", PkwTokens.Type.small, color = c.textOnParch2)
                }
            }
        }
    }
}

/** IngredientRow (SPEC §1, 52 tall): icon 32, name + source, have/need, then a green OK, or — when short — the blood
 *  style, a red count and a blue GO (58 × 48). An unknown count shows "…" and no tag. */
@Composable internal fun IngredientRow(line: IngredientLine, onGo: (IngredientLine) -> Unit, modifier: Modifier = Modifier, showGo: Boolean = true) {
    val c = PkwTokens.Colors
    CreamCard(modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.ingredientRowH), rim = if (line.short) CardRim.MISSING else CardRim.NONE,
        contentPadding = PaddingValues(start = 8.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
        Row(Modifier.align(Alignment.CenterStart).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            CraftIcon(line.icon, 32.dp)
            Column(Modifier.weight(1f)) {
                PkwText(line.name, PkwTokens.Type.body, color = c.textOnParch)
                if (line.source.isNotBlank()) PkwText(line.source, PkwTokens.Type.small, color = c.textOnParch2)
            }
            PkwText(line.count, PkwTokens.Type.label, Modifier.semantics { contentDescription = "Have ${groupDigits(line.have)} of ${groupDigits(line.need)}" },
                color = if (line.short) c.shortText else c.textOnParch)
            when {
                line.short && showGo -> GoButton({ onGo(line) }, "Get ${groupDigits(line.missing)} more ${line.name}", Modifier.size(58.dp, 48.dp))
                line.ok -> Tag("OK", Verb.GREEN)
            }
        }
    }
}

/** A door row with a blue GO (SPEC §4.1 USED FOR, §2.6 TravelRow when [info]). */
@Composable internal fun DoorRow(ui: DoorRowUi, onGo: (String) -> Unit, modifier: Modifier = Modifier, info: Boolean = false) {
    val c = PkwTokens.Colors
    CreamCard(modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.ingredientRowH), rim = if (info) CardRim.INFO else CardRim.NONE,
        contentPadding = PaddingValues(start = 8.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
        Row(Modifier.align(Alignment.CenterStart).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            CraftIcon(ui.icon, 32.dp)
            Column(Modifier.weight(1f)) {
                PkwText(ui.title, PkwTokens.Type.body, color = c.textOnParch)
                PkwText(ui.line, PkwTokens.Type.small, color = c.textOnParch2)
            }
            GoButton({ onGo(ui.id) }, ui.goDescription, Modifier.size(64.dp, 48.dp))
        }
    }
}

/** A dashed parchment box (empty bench, free slots). */
@Composable internal fun DashedBox(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    val c = PkwTokens.Colors
    Box(modifier.fillMaxWidth().drawBehind {
        val stroke = 3.dp.toPx(); val dash = 8.dp.toPx()
        drawRect(c.parchmentLo, topLeft = Offset(stroke / 2f, stroke / 2f), size = Size(size.width - stroke, size.height - stroke),
            style = Stroke(stroke, pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash * 0.75f))))
    }.padding(12.dp), content = content)
}

// ---------------------------------------------------------------------------------------------------------------- steppers

/**
 * A stone stepper square (SPEC §1 QtyStepper). A tap steps once (on release, so a scroll that starts on it never steps);
 * with [repeat] a hold steps every 80 ms after 400 ms (SPEC §3.3 PRICE EACH). Press moves the face 3 dp in 60 ms.
 */
@Composable internal fun StepSquare(icon: String, onStep: () -> Unit, contentDescription: String, modifier: Modifier = Modifier,
    enabled: Boolean = true, repeat: Boolean = false) {
    val step by rememberUpdatedState(onStep)
    val on by rememberUpdatedState(enabled)
    var pressed by remember { mutableStateOf(false) }
    val reduced = LocalReducedMotion.current
    val press by animateFloatAsState(if (pressed && enabled) 1f else 0f,
        tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE,
            easing = if (pressed) PkwTokens.Motion.Linear else PkwTokens.Motion.Pop), label = "step")
    val ramp = PkwTokens.ramp(if (enabled) Verb.STONE else Verb.OFF)
    Box(modifier.defaultMinSize(PkwTokens.Dims.minTap, PkwTokens.Dims.minTap).sceneInputRegion()
        .clearAndSetSemantics {
            this.contentDescription = contentDescription; role = Role.Button
            if (!enabled) disabled()
            this.onClick(label = null, action = { if (on) step(); on })
        }
        .pointerInput(repeat) {
            coroutineScope {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    if (!on) return@awaitEachGesture
                    pressed = true
                    var repeated = false
                    val ticker = if (repeat) launch {
                        delay(400L)
                        repeated = true
                        while (true) { step(); delay(80L) }
                    } else null
                    val up = waitForUpOrCancellation()
                    ticker?.cancel()
                    pressed = false
                    if (up != null) {
                        up.consume()
                        if (!repeated) step()
                    }
                }
            }
        }
        .drawBehind { drawChunky(ramp, press) }, contentAlignment = Alignment.Center) {
        Box(Modifier.padding(chunkyContentPadding()).offset { IntOffset(0, (3.dp.toPx() * press).roundToInt()) }, contentAlignment = Alignment.Center) {
            PkwIcon(icon, 24.dp, tint = PkwTokens.Colors.label)
        }
    }
}

/** QtyStepper (SPEC §1): stone − 48 × 60, a cream value 76 × 60 (PS 14 + VT 18 "max n"), stone + 48 × 60. */
@Composable internal fun QtyStepper(value: String, sub: String, onMinus: () -> Unit, onPlus: () -> Unit, what: String, modifier: Modifier = Modifier,
    minusEnabled: Boolean = true, plusEnabled: Boolean = true) {
    val c = PkwTokens.Colors
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        StepSquare("shape:minus", onMinus, "One fewer $what", Modifier.size(48.dp, 60.dp), minusEnabled)
        CreamCard(Modifier.size(76.dp, 60.dp).clearAndSetSemantics { contentDescription = "$value $what, $sub" }, contentPadding = PaddingValues(2.dp)) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                PkwText(value, PkwTokens.Type.primary, color = c.textOnParch)
                PkwText(sub, PkwTokens.Type.small, color = c.textOnParch2)
            }
        }
        StepSquare("shape:plus", onPlus, "One more $what", Modifier.size(48.dp, 60.dp), plusEnabled)
    }
}

/** The wide stepper (SPEC §3.3 HOW MANY / PRICE EACH): − 48 × 56, a flex cream value with icon + PS 14 + VT 18 unit, + 48 × 56. */
@Composable internal fun WideStepper(icon: String?, value: String, unit: String, onMinus: () -> Unit, onPlus: () -> Unit, what: String,
    modifier: Modifier = Modifier, minusEnabled: Boolean = true, plusEnabled: Boolean = true, repeat: Boolean = false) {
    val c = PkwTokens.Colors
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        StepSquare("shape:minus", onMinus, "Lower the $what", Modifier.size(48.dp, 56.dp), minusEnabled, repeat)
        CreamCard(Modifier.weight(1f).height(56.dp).clearAndSetSemantics { contentDescription = "$what: $value $unit" }, contentPadding = PaddingValues(2.dp)) {
            Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (icon != null) CraftIcon(icon, 32.dp)
                PkwText(value, PkwTokens.Type.primary, color = c.textOnParch)
                PkwText(unit, PkwTokens.Type.small, color = c.textOnParch2)
            }
        }
        StepSquare("shape:plus", onPlus, "Raise the $what", Modifier.size(48.dp, 56.dp), plusEnabled, repeat)
    }
}

// ----------------------------------------------------------------------------------------------------------------- primary

/**
 * The sheet's one primary (SPEC §1 PrimaryButton + CostPill): the kit [PrimaryButton] with the cost pill centred on its
 * top edge (−20 dp) whenever it spends. A SHORT pill opens Need-more. An off / locked primary (action SHAKE) shakes
 * 2 dp × 2 in 160 ms and never opens a sheet (SPEC §2.2); its reason is already under it.
 */
@Composable internal fun CraftPrimaryButton(primary: CraftPrimaryUi, onAction: (PrimaryAction) -> Unit, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val shake = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    Box(modifier.graphicsLayer { translationX = shake.value * density }) {
        PrimaryButton(primary.label, onClick = {
            if (primary.action == PrimaryAction.SHAKE) {
                if (!reduced) scope.launch {
                    shake.snapTo(0f)
                    shake.animateTo(0f, keyframes {
                        durationMillis = PkwTokens.Motion.INVALID_SHAKE
                        2f at 20; -2f at 60; 2f at 100; -2f at 140
                    })
                }
            } else onAction(primary.action)
        }, Modifier.fillMaxWidth(), verb = primary.verb, sub = primary.sub, state = primary.state, reason = primary.reason, badge = primary.badge)
        primary.price?.let { price ->
            PriceChip(price, Modifier.align(Alignment.TopCenter).offset(y = (-20).dp),
                onClick = if (price.status == PriceStatus.SHORT) ({ onAction(PrimaryAction.NEED_MORE) }) else null)
        }
    }
}

/** The footer's VT 18 note (centred, ≤ 2 lines); [danger] makes it a VT 20 #A3261A line (a refusal or an error). */
@Composable internal fun FooterNote(text: String, modifier: Modifier = Modifier, danger: Boolean = false) {
    val c = PkwTokens.Colors
    PkwText(text, if (danger) PkwTokens.Type.body else PkwTokens.Type.small, modifier.fillMaxWidth(),
        color = if (danger) c.shortText else c.textOnParch2, textAlign = TextAlign.Center, maxLines = 2)
}

/** The recovery row (SPEC §5): "A request from earlier is waiting" + stone CHECK; the archive lives in History. */
@Composable internal fun RecoveryRow(saved: SavedOpUi, onCheck: (String) -> Unit, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    CreamCard(modifier.fillMaxWidth(), rim = CardRim.NOTE, contentPadding = PaddingValues(start = 8.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f)) {
                PkwText(saved.title, PkwTokens.Type.body, color = c.textOnParch, maxLines = 2)
                PkwText(saved.line, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
            }
            SecondaryButton(if (saved.checking) "CHECKING" else "CHECK", { if (!saved.checking) onCheck(saved.opId) }, Modifier.width(104.dp),
                enabled = !saved.checking, contentDescription = "Check the request from earlier")
        }
    }
}

/**
 * BenchCard (SPEC §2.3): "ON THE BENCH" card, 104 tall: the job title + a [tag], the input well, a 14 dp green bar with
 * the rest striped, the time left + "done at", and the output well with its "x6" badge. It drops in over 160 ms when a
 * new job ([appearKey]) appears.
 */
@Composable internal fun BenchCard(title: String, tag: String, tagVerb: Verb, input: @Composable BoxScope.() -> Unit, outputIcon: String,
    outputBadge: String?, progress: Float?, leftText: String, doneLine: String, modifier: Modifier = Modifier, appearKey: Any? = null) {
    val c = PkwTokens.Colors
    val reduced = LocalReducedMotion.current
    val inspection = LocalInspectionMode.current
    val drop = remember(appearKey) { Animatable(if (reduced || inspection) 1f else 0f) }
    LaunchedEffect(appearKey) { drop.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.RIBBON_DROP, easing = PkwTokens.Motion.Out)) }
    CreamCard(modifier.fillMaxWidth().heightIn(min = 104.dp).graphicsLayer {
        alpha = drop.value
        translationY = if (reduced) 0f else -12.dp.toPx() * (1f - drop.value)
    }, contentPadding = PaddingValues(start = 10.dp, top = 8.dp, end = 10.dp, bottom = 10.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText(title, PkwTokens.Type.label, Modifier.weight(1f, fill = false), color = c.textOnParch)
                Tag(tag, tagVerb)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Well(48.dp, flat = WELL_DARK, content = input)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    ProgressBar(progress, "$title: $leftText left", pending = 1f, height = 14.dp)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        PkwText(leftText, PkwTokens.Type.label, color = c.textOnParch)
                        PkwText(doneLine, PkwTokens.Type.small, color = c.textOnParch2)
                    }
                }
                Box {
                    Well(48.dp) { CraftIcon(outputIcon, 32.dp, alpha = 0.5f) }
                    if (outputBadge != null) Badge(BadgeUi(outputBadge, BadgeTone.REWARD, "$outputBadge on the way"),
                        Modifier.align(Alignment.TopEnd).offset(x = 8.dp, y = (-10).dp))
                }
            }
        }
    }
}

// --------------------------------------------------------------------------------------------------------------- overlays

/**
 * The review half sheet (SPEC §2.1): it slides up over the footer in 180 ms (out 140), with the same ingredient [rows],
 * the Shards [price] if any, the consent line, stone BACK 100 and gold confirm. No money moves, so it is not a Seal, and a
 * half sheet has no scrim. Back closes it (the host routes Back here first: SPEC §5).
 */
@Composable internal fun BoxScope.ReviewHalfSheet(review: CraftReviewUi?, rows: List<IngredientLine>, price: PriceUi?, onBack: () -> Unit,
    onConfirm: () -> Unit) {
    val c = PkwTokens.Colors
    Presence(review, PkwTokens.Motion.HALF_SHEET_IN, PkwTokens.Motion.HALF_SHEET_OUT) { shown, progress, active, reduced ->
        Plate(PlateKind.WOOD, Modifier.align(Alignment.BottomCenter).fillMaxWidth()
            .graphicsLayer {
                val p = progress()
                if (reduced) alpha = p else translationY = (1f - p) * size.height
            }
            .semantics { paneTitle = shown.title }) {
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(4.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText(shown.title, PkwTokens.Type.title, Modifier.fillMaxWidth(), color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                    rows.forEach { IngredientRow(it, onGo = {}, showGo = false) }
                    if (price != null) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                            PkwText("Spends", PkwTokens.Type.small, color = c.textOnParch2)
                            PriceChip(price)
                        }
                    }
                    // The confirm tap is the consent, so the whole line must stay readable (it was cut at 3 lines; the
                    // Harvester and Market reviews carry the same multi-sentence terms as the Workshop's own copy).
                    PkwText(shown.line, PkwTokens.Type.body, Modifier.fillMaxWidth(), color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 10)
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SecondaryButton(shown.backLabel, { if (active) onBack() }, Modifier.width(PkwTokens.Dims.sealBackW))
                        PrimaryButton(shown.confirmLabel, { if (active && !shown.sending) onConfirm() }, Modifier.weight(1f),
                            state = if (shown.sending) CommandState.BUSY else CommandState.ENABLED)
                    }
                }
            }
        }
    }
}

/**
 * The craft result celebration (SPEC §2.4, 0.6): a 60 % scrim over the SHEET only, a 356 dp charcoal panel with stepped
 * gold rays turning 8°/s, the title, the craft-success frames (8 f at 12 fps, 128 dp) behind the 64 dp output, the gold
 * ribbon, the line and a green NICE 200 × 52. It dismisses 2 s after the FX, on any tap, or on NICE; [onDone] gets the
 * job id (`markSeen`, idempotent). Reduced motion: no turning rays, no FX play, and it stays until tapped. The scrim exists
 * only while it shows.
 */
@Composable internal fun BoxScope.CraftCelebrationOverlay(ui: CraftCelebrationUi?, onDone: (String) -> Unit) {
    val done by rememberUpdatedState(onDone)
    val c = PkwTokens.Colors
    Presence(ui, PkwTokens.Motion.PLATE_IN, PkwTokens.Motion.SEAL_OUT) { party, progress, active, reduced ->
        val still = reduced || LocalInspectionMode.current
        LaunchedEffect(party.jobId, still) {
            if (!still) {
                delay(8L * 1000L / 12L + 2_000L)
                done(party.jobId)
            }
        }
        // SPEC §2.4 sound / haptic: a firm haptic as the result lands (the bell and clink belong to the sound lane).
        val haptic = LocalHapticFeedback.current
        LaunchedEffect(party.jobId) { haptic.performHapticFeedback(HapticFeedbackType.LongPress) }
        // The output pops in and the ribbon drops in after it (BADGE_POP with the pop overshoot); reduced motion: still.
        val pop = remember(party.jobId) { Animatable(if (still) 1f else 0f) }
        LaunchedEffect(party.jobId, still) {
            if (still) pop.snapTo(1f)
            else { delay(PkwTokens.Motion.RIBBON_DROP.toLong()); pop.animateTo(1f, tween(PkwTokens.Motion.BADGE_POP * 2, easing = PkwTokens.Motion.Pop)) }
        }
        ModalScrim(PkwTokens.Scrim.FULL_CARD * progress(), onTap = { if (active) done(party.jobId) })
        val spin = if (still) null else rememberInfiniteTransition(label = "craftRays").animateFloat(0f, 360f,
            infiniteRepeatable(tween((360f / PkwTokens.Motion.RAYS_DEG_PER_S * 1000).toInt(), easing = LinearEasing), RepeatMode.Restart), label = "spin")
        Plate(PlateKind.CHARCOAL, Modifier.align(Alignment.TopCenter).padding(top = 64.dp, start = 20.dp, end = 20.dp).widthIn(max = 356.dp).fillMaxWidth()
            .graphicsLayer {
                val p = progress()
                alpha = p
                val s = if (reduced) 1f else 0.96f + 0.04f * p
                scaleX = s; scaleY = s
            }
            .semantics { paneTitle = party.title; liveRegion = LiveRegionMode.Polite }
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, role = Role.Button) { if (active) done(party.jobId) }) {
            // The wedges are built once per size; each frame only turns them (no per-frame Path or trig).
            Box(Modifier.matchParentSize().clipToBounds().drawWithCache {
                val center = Offset(size.width / 2f, size.height * 0.42f)
                val wedges = craftRaysPath(center, maxOf(size.width, size.height))
                onDrawBehind { rotate(spin?.value ?: 0f, center) { drawPath(wedges, RAY_COLOR) } }
            })
            Column(Modifier.fillMaxWidth().padding(vertical = 12.dp, horizontal = 10.dp), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp)) {
                PkwText(party.title, PkwTokens.Type.title, color = c.gold.hi, outline = 1.dp)
                Box(Modifier.size(128.dp), contentAlignment = Alignment.Center) {
                    CraftAtlasLoop(CraftAtlases.craftSuccess, 12, 128.dp, once = true)
                    CraftIcon(party.icon, 64.dp, Modifier.graphicsLayer {
                        val p = pop.value
                        scaleX = 0.4f + 0.6f * p; scaleY = 0.4f + 0.6f * p
                    })
                }
                Plate(PlateKind.VEIL, Modifier.fillMaxWidth().heightIn(min = 40.dp).graphicsLayer {
                    val p = pop.value
                    alpha = p.coerceIn(0f, 1f)
                    scaleX = 0.7f + 0.3f * p; scaleY = 0.7f + 0.3f * p
                }, tint = c.gold.face,
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp), blocksScene = false) {
                    PkwText(party.ribbon, PkwTokens.Type.primary, Modifier.align(Alignment.Center), color = c.label, outline = 2.dp)
                }
                PkwText(party.line, PkwTokens.Type.body, color = c.text, textAlign = TextAlign.Center, maxLines = 2)
                SecondaryButton("NICE", { if (active) done(party.jobId) }, Modifier.width(200.dp), verb = Verb.GREEN)
            }
        }
    }
}

/** The rays' colour: gold-hi at 12 %. */
private val RAY_COLOR = PkwTokens.Colors.gold.hi.copy(alpha = 0.12f)

/** 36 ten-degree wedges around [center] out to [r], every other one filled: one Path, built once per size. */
private fun craftRaysPath(center: Offset, r: Float): Path = Path().apply {
    for (k in 0 until 36 step 2) {
        val a0 = Math.toRadians((k * 10).toDouble()); val a1 = Math.toRadians((k * 10 + 10).toDouble())
        moveTo(center.x, center.y)
        lineTo(center.x + (r * cos(a0)).toFloat(), center.y + (r * sin(a0)).toFloat())
        lineTo(center.x + (r * cos(a1)).toFloat(), center.y + (r * sin(a1)).toFloat())
        close()
    }
}

// ----------------------------------------------------------------------------------------------------------------- helpers

/** The wall clock, re-read every [periodMs] (countdowns tick once a second). Previews keep the first reading. */
@Composable internal fun rememberNow(clock: () -> Long, periodMs: Long = 1_000L): Long {
    val now by produceState(clock(), clock, periodMs) {
        while (true) {
            value = clock()
            delay(periodMs)
        }
    }
    return now
}

/** A count that counts up over 600 ms when it changes (SPEC: "the held count counts up"); reduced motion switches. Only
 *  plain or comma-grouped whole numbers count (kit `countUpText`). */
@Composable internal fun CountUpText(value: String, style: androidx.compose.ui.text.TextStyle, modifier: Modifier = Modifier,
    color: Color = PkwTokens.Colors.textOnParch) {
    val reduced = LocalReducedMotion.current
    var from by remember { mutableStateOf(value) }
    val t = remember { Animatable(1f) }
    LaunchedEffect(value) {
        if (!reduced && from != value) {
            t.snapTo(0f)
            t.animateTo(1f, tween(PkwTokens.Motion.COUNT_UP, easing = PkwTokens.Motion.Out))
        }
        from = value
    }
    PkwText(countUpText(from, value, t.value), style, modifier, color = color)
}

// ---------------------------------------------------------------------------------------------------------------- previews

private val previewLines = listOf(
    IngredientLine("heartwood_beams", craftItemIcon("heartwood_beams"), "Heartwood Beams", "Refine here, from logs", 0, 4, 4, "refine_beams"),
    IngredientLine("thornsilk", craftItemIcon("thornsilk"), "Thornsilk", "Refine here, from fibre", 2, 2, 0, null),
    IngredientLine("frost_quartz", craftItemIcon("frost_quartz"), "Frost Quartz", "Frostveil harvester", null, 24, null, null),
)

@Preview(name = "Craft parts", widthDp = 400, heightDp = 760)
@Composable private fun CraftPartsPreview() {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel("REFINE", "raw in, refined out", "8 ▸")
        TileStrip(listOf(
            RecipeTile(ItemTileUi("a", craftItemIcon("frostglass"), "x14", "Frostglass, 14 held", ItemTileState.SELECTED), false),
            RecipeTile(ItemTileUi("b", craftItemIcon("crownsteel"), "x3", "Crownsteel, 3 held"), false),
            RecipeTile(ItemTileUi("c", craftItemIcon("heartwood_beams"), "0", "Heartwood Beams, 0 held", ItemTileState.MISSING), false),
            RecipeTile(ItemTileUi("d", craftItemIcon("embercore"), UNKNOWN_PREVIEW, "Embercore, count unknown"), true),
        ), {})
        RecipeCard(craftItemIcon("frostglass"), "Frostglass", "REFINED", "For Survey Lens and Navigation Kit.", "1m 30s")
        previewLines.forEach { IngredientRow(it, {}) }
        QtyStepper("6", "max 10", {}, {}, "Frostglass")
        CraftPrimaryButton(CraftPrimaryUi("CRAFT 2", "takes 8m 00s", CommandState.DISABLED, Verb.GOLD, "Need 4 more Heartwood Beams. Tap GO.",
            PriceUi(gg.pixelkingdomwars.nativeclient.ui.model.Currency.SHARDS, "1,200", PriceStatus.OK), PrimaryAction.SHAKE), {},
            Modifier.padding(top = 20.dp))
    }
}

private const val UNKNOWN_PREVIEW = "…"
