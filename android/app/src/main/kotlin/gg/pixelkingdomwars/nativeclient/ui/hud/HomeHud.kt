package gg.pixelkingdomwars.nativeclient.ui.hud

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.layoutId
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.HeraldBanner
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.ResourceStack
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.drawChunky
import gg.pixelkingdomwars.nativeclient.ui.kit.drawPlate
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.ChipTone
import gg.pixelkingdomwars.nativeclient.ui.model.ChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.ContextChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.DeckButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.DeckToolUi
import gg.pixelkingdomwars.nativeclient.ui.model.EdgeButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.HeraldUi
import gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi
import gg.pixelkingdomwars.nativeclient.ui.model.ProfileMedallionUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceDrawerUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt

/**
 * Design component: the Home HUD (DESIGN-SYSTEM §6 HUD; `design/final/home.png`, `selected.png`; UX-ARCHITECTURE §2
 * zones TL / TR / LE / RE / HB / BD; owner addenda 5 and 6).
 *
 * - TL: the 40 dp blue level badge (Profile) and one 30 dp status chip (league + trophies → Leagues, builders → Builders,
 *   shield → Defence log). No name, no XP on Home.
 * - TR: the kit [ResourceStack]: at most 4 readouts (SHARDS, GEMS, KEEP when a wallet is linked, SKR + drawer caret), one
 *   hit region that opens the resource drawer at the tapped row.
 * - RE: edge buttons, only while they carry a badge, as many as the 12 % budget allows (the rest fold into the top one
 *   as "+n"); LE: edge tabs (MAIL while unread, CHAT), flush with the left edge, no caption.
 * - HB: the one transient herald banner, under the left cluster.
 * - BD: the deck in the two bottom corners (ATTACK + ARMY left, MAP + BUILD right; mirrored for the left-handed
 *   setting) with the transient context chip between them. With [HomeHudUi.tools], a long-press on BUILD toggles the
 *   transient tools shelf (LAYOUT · EXPAND · FIT) over BUILD's corner; it is not permanent chrome (HudBudget).
 * - A selection ([HomeHudUi.deckVisible] false) slides the deck down (160 ms) and fades the left cluster and both edges
 *   out; the resource stack stays because costs are compared against it. While the drawer is open the deck hides too.
 *
 * What shows is decided by [homeHudPlan] and positioned with [HudGeometry], the same numbers [homeHudCoverage] measures,
 * so the drawn HUD is the measured HUD (≤ 12 % of a 412 × 915 phone at rest; HudBudgetTest).
 *
 * Pointer rule: the base scene is a lower sibling of the navigation host and Compose stops at the first sibling with a
 * pointer hit, so this root and every zone container are plain layouts (`Box`, `Row`, `Column`, `AnimatedVisibility`)
 * with no `clickable`, `pointerInput`, `draggable` or scrim. Only the painted pieces (badge, status segments, stack,
 * edge buttons and tabs, deck buttons, context chip, herald) take touches, and each registers itself with
 * `sceneInputRegion()`; empty HUD space lets pan, tap, carry and wall strokes fall through to the kingdom. The only
 * scrim belongs to the open [ResourceDrawer] and exists only while the drawer is shown.
 *
 * Kit successor (design ruling 092decf3): a readout tap dispatches [HomeHudActions.openDrawerAt] with the row's id as
 * the focus (the registry row is always `hud.resources`); the "+n" of folded edge buttons is its own 48 dp door to
 * [HomeHudUi.rightEdgeOverflow] (the hub row's notices); the first edge button keeps its own id.
 *
 * @param drawer the resource drawer to show over the HUD, or null when it is closed (it animates out by itself).
 * @param sealShown true while a money Seal is shown: the resource stack stays drawn and readable but is not tappable,
 *   so the drawer cannot open during consent.
 * @param stackLifted true when the host draws the stack itself above the sheet and Seal scrims with [HomeResourceStack]
 *   at `PkwTokens.Z.RESOURCE_STACK`; this HUD then leaves it out so it is never drawn twice.
 */
@Composable fun HomeHud(ui: HomeHudUi, on: HomeHudActions, modifier: Modifier = Modifier, drawer: ResourceDrawerUi? = null,
    sealShown: Boolean = false, stackLifted: Boolean = false) {
    val reduced = LocalReducedMotion.current
    // Planned as if at rest so the zones that hide on a selection keep their content while they animate out.
    val rest = homeHudPlan(ui.copy(deckVisible = true))
    val atRest = ui.deckVisible
    val g = HudGeometry
    Box(modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            // TL: the 48 dp badge target starts 4 dp before the 40 dp badge; the status chip's 48 dp row centres its 30 dp veil.
            AnimatedVisibility(atRest, Modifier.align(Alignment.TopStart), enter = hudEnter(reduced), exit = hudExit(reduced)) {
                Box(Modifier.padding(start = (g.LEVEL_X - 4).dp, top = (g.LEVEL_Y - 4).dp)) {
                    StatusChip(statusSegments(ui), on.openFeature,
                        Modifier.padding(start = (g.STATUS_X - g.LEVEL_X + 4).dp, top = (g.STATUS_Y - STATUS_TOUCH_INSET - g.LEVEL_Y + 4).dp))
                    LevelBadge(ui.profile, on.openFeature)
                }
            }
            // TR: always shown, also while something is selected (unless the host lifted it above the scrims).
            if (!stackLifted) ResourceStack(rest.resources, { on.openDrawerAt(it) },
                Modifier.align(Alignment.TopEnd).padding(top = g.STACK_TOP.dp, end = g.GUTTER.dp), enabled = !sealShown)
            // RE
            AnimatedVisibility(atRest && rest.rightEdge.isNotEmpty(), Modifier.align(Alignment.TopEnd), enter = hudEnter(reduced), exit = hudExit(reduced)) {
                val overflow = edgeOverflowTarget(rest, ui)
                Column(Modifier.padding(top = g.EDGE_TOP.dp, end = g.EDGE_RIGHT.dp), horizontalAlignment = Alignment.End,
                    verticalArrangement = Arrangement.spacedBy(g.EDGE_SPACING.dp)) {
                    rest.rightEdge.forEachIndexed { index, button ->
                        key(button.id.value) {
                            if (index == 0 && overflow != null) Row(verticalAlignment = Alignment.Top) {
                                OverflowDoor(rest.rightEdgeFolded, overflow, on.openFeature)
                                EdgeButton(button, 0, on.openFeature)
                            } else EdgeButton(button, if (index == 0) rest.rightEdgeFolded else 0, on.openFeature)
                        }
                    }
                }
            }
            // LE
            AnimatedVisibility(atRest && rest.leftEdge.isNotEmpty(), Modifier.align(Alignment.BottomStart), enter = hudEnter(reduced), exit = hudExit(reduced)) {
                Column(Modifier.padding(bottom = g.TABS_BOTTOM.dp), verticalArrangement = Arrangement.spacedBy(g.TAB_GAP.dp)) {
                    rest.leftEdge.forEach { tab -> key(tab.id.value) { EdgeTab(tab, on.openFeature) } }
                }
            }
            // BD
            AnimatedVisibility(atRest && drawer == null, Modifier.align(Alignment.BottomCenter).fillMaxWidth(),
                enter = deckEnter(reduced), exit = deckExit(reduced)) {
                Deck(rest.deck, ui.context, on.openFeature, buildLongPress = if (hasDeckTools(ui)) ({ on.toggleTools(!ui.toolsOpen) }) else null)
            }
            // BD tools shelf (the folded LAYOUT · EXPAND · FIT dock row): transient, over BUILD's corner, only after a
            // long-press on BUILD. Planned as if open so it keeps its buttons while it fades out.
            val shelf = homeHudPlan(ui.copy(deckVisible = true, toolsOpen = true))
            AnimatedVisibility(atRest && drawer == null && ui.toolsOpen && shelf.tools.isNotEmpty(),
                Modifier.align(if (shelf.toolsLeft) Alignment.BottomStart else Alignment.BottomEnd), enter = hudEnter(reduced), exit = hudExit(reduced)) {
                ToolsShelf(shelf.tools, on.openFeature)
            }
            // HB: transient, under the top bar and the resource stack, clear of the QUESTS edge button (hub SPEC §3.1). It steps
            // aside with the top-left cluster while a building is selected or placed (buildings/SPEC.md §1.2 item 5, §4.1): it
            // sat on the placement hint and beside the name plate (owner screenshots 3 and 4, 2026-10-06).
            HeraldBanner(homeHeraldShown(ui), on.openFeature,
                Modifier.align(Alignment.TopStart).padding(start = g.GUTTER.dp, top = g.HERALD_TOP.dp, end = g.HERALD_END.dp)
                    .fillMaxWidth().widthIn(max = g.HERALD_W_MAX.dp))
        }
        ResourceDrawer(drawer, on)
    }
}

/**
 * The Home resource stack alone, positioned exactly as [HomeHud] draws it (top-right, inside the safe-drawing insets),
 * for a host that lifts it above the sheet and Seal scrims (design ruling 092decf3 item 4): mount it at
 * `PkwTokens.Z.RESOURCE_STACK` and pass `stackLifted = true` to [HomeHud]. With [sealShown] it is readable but not
 * tappable.
 *
 * Pointer rule: the root is a plain full-size layout with no pointer handling and no scrim; only the painted stack is a
 * hit region (and none at all while [sealShown]), so every other touch reaches the layers below.
 */
@Composable fun HomeResourceStack(ui: HomeHudUi, on: HomeHudActions, modifier: Modifier = Modifier, sealShown: Boolean = false) {
    Box(modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
        ResourceStack(homeHudPlan(ui.copy(deckVisible = true)).resources, { on.openDrawerAt(it) },
            Modifier.align(Alignment.TopEnd).padding(top = HudGeometry.STACK_TOP.dp, end = HudGeometry.GUTTER.dp), enabled = !sealShown)
    }
}

/**
 * The "+n" door (design ruling 092decf3 item 6): the blue +n badge beside the top edge button's top-left corner, inside
 * its own 48 × 48 target that never overlaps the button's, opening [target] (the hub row at its notices, where every
 * folded candidate is listed). Only the 24 dp badge is painted; it is transient (excluded from the HUD budget like
 * every badge).
 */
@Composable private fun OverflowDoor(folded: Int, target: FeatureId, onOpen: (FeatureId) -> Unit) {
    val spoken = "$folded more notices"
    Box(Modifier.size(PkwTokens.Dims.minTap).sceneInputRegion()
        .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; onClick(label = null, action = { onOpen(target); true }) }
        .clickable(role = Role.Button) { onOpen(target) }) {
        Badge(BadgeUi("+$folded", BadgeTone.INFO, spoken), Modifier.align(Alignment.TopEnd).offset(y = (-6).dp))
    }
}

/** The status chip's 48 dp touch row extends this far above and below its 30 dp veil. */
private const val STATUS_TOUCH_INSET = 9

/** DESIGN-SYSTEM §7 "Select building … exit: reverse 120 ms" (TOKENS.json has no key for it; the cluster, edges and
 *  deck come back in this). */
private const val DESELECT_MS = 120

private fun hudEnter(reduced: Boolean): EnterTransition =
    fadeIn(tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else DESELECT_MS, easing = PkwTokens.Motion.Out))

private fun hudExit(reduced: Boolean): ExitTransition =
    fadeOut(tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.DECK_SWAP, easing = PkwTokens.Motion.In))

/** The deck comes back up in 120 ms and slides down in 160 ms (DESIGN-SYSTEM §6 BottomDeck, §7); reduced motion
 *  cross-fades only. */
private fun deckEnter(reduced: Boolean): EnterTransition =
    if (reduced) fadeIn(tween(PkwTokens.Motion.REDUCED_CROSSFADE))
    else slideInVertically(tween(DESELECT_MS, easing = PkwTokens.Motion.Out)) { it } + fadeIn(tween(DESELECT_MS))

private fun deckExit(reduced: Boolean): ExitTransition =
    if (reduced) fadeOut(tween(PkwTokens.Motion.REDUCED_CROSSFADE))
    else slideOutVertically(tween(PkwTokens.Motion.DECK_SWAP, easing = PkwTokens.Motion.In)) { it } + fadeOut(tween(PkwTokens.Motion.DECK_SWAP))

/** Press progress 0 (up) → 1 (down): 60 ms linear down, 90 ms `pop` back (DESIGN-SYSTEM §7 "Any button"). */
@Composable private fun pressProgress(interaction: MutableInteractionSource): Float {
    val pressed by interaction.collectIsPressedAsState()
    val reduced = LocalReducedMotion.current
    val press by animateFloatAsState(if (pressed) 1f else 0f,
        tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE,
            easing = if (pressed) PkwTokens.Motion.Linear else PkwTokens.Motion.Pop), label = "press")
    return press
}

/** "Hours above 1 h, m:ss below" etc. arrive formatted; a blank value is unknown, never zero. */
private fun shown(value: String): String = value.ifBlank { UNKNOWN }

/** The level badge: a 40 × 40 blue chunky face (PS 14 numeral, outlined) inside a 48 dp target; opens Profile. */
@Composable private fun LevelBadge(ui: ProfileMedallionUi, onOpen: (FeatureId) -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val press = pressProgress(interaction)
    val spoken = listOfNotNull(ui.description, ui.badge?.description).joinToString(". ")
    Box(Modifier.size(PkwTokens.Dims.minTap).sceneInputRegion()
        .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; onClick(label = null, action = { onOpen(ui.id); true }) }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button) { onOpen(ui.id) },
        contentAlignment = Alignment.Center) {
        Box(Modifier.size(PkwTokens.Dims.levelBadge).drawBehind { drawChunky(PkwTokens.Colors.blue, press, 5f) },
            contentAlignment = Alignment.Center) {
            PkwText(shown(ui.level), PkwTokens.Type.primary,
                Modifier.padding(bottom = 4.dp).offset { IntOffset(0, (3.dp.toPx() * press).roundToInt()) },
                color = PkwTokens.Colors.label, outline = 2.dp)
        }
        ui.badge?.let { Badge(it, Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp)) }
    }
}

/** One status-chip segment with its design icon size and type; the icon's layout box is [bleedDp] narrower on each side
 *  than its art, so the art overhangs its neighbours (home.html builder `margin: … -4px`). */
private data class Segment(val chip: ChipUi, val iconDp: Int, val style: TextStyle, val color: Color, val bleedDp: Int = 0)

/** League + trophies (crest 20, gold-hi PS 11), builders (sprite 30 in a 22 dp box, PS 11), shield (24, VT 20), in that order. */
private fun statusSegments(ui: HomeHudUi): List<Segment> = listOfNotNull(
    ui.trophies?.let { Segment(it, 20, PkwTokens.Type.caption, PkwTokens.Colors.gold.hi) },
    Segment(ui.builders, 30, PkwTokens.Type.caption, PkwTokens.Colors.text, bleedDp = 4),
    Segment(ui.shield, 24, PkwTokens.Type.body, PkwTokens.Colors.text),
)

/**
 * The status chip (DESIGN-SYSTEM §6 TopBar / BuilderChip): one 30 dp veil, at most 238 wide, holding 2-3 segments split
 * by 2 dp dividers. Each segment is its own ≥ 48 × 48 target (the touch row is 48 tall around the 30 dp veil) that opens
 * its sheet. A builders segment with [ChipUi.dot] carries the 6 dp gold dot.
 */
@Composable private fun StatusChip(segments: List<Segment>, onOpen: (FeatureId) -> Unit, modifier: Modifier) {
    Box(modifier.height(PkwTokens.Dims.minTap).widthIn(max = HudGeometry.STATUS_W_MAX.dp).sceneInputRegion()) {
        Box(Modifier.matchParentSize().padding(vertical = STATUS_TOUCH_INSET.dp).drawBehind { drawPlate(PlateKind.VEIL) })
        // home.html `.mchip`: the first icon starts 12 dp in (2 dp rim + 10), the last value ends 10 dp short (2 + 8), and
        // a 2 × 16 divider with 3 dp margins sits between segments (each segment adds its own 4 dp either side).
        Row(Modifier.fillMaxHeight().padding(start = 8.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            segments.forEachIndexed { index, segment ->
                if (index > 0) Box(Modifier.padding(horizontal = 3.dp).size(2.dp, 16.dp).background(PkwTokens.Colors.border))
                // No weights: segments take what they need in order, and only the last is shortened (ellipsis) when
                // a long value would push the chip past 238 dp.
                StatusSegment(segment, onOpen, Modifier)
            }
        }
    }
}

@Composable private fun StatusSegment(segment: Segment, onOpen: (FeatureId) -> Unit, modifier: Modifier) {
    val chip = segment.chip
    val interaction = remember { MutableInteractionSource() }
    val press = pressProgress(interaction)
    val color = when (chip.tone) {
        ChipTone.NORMAL -> segment.color
        ChipTone.ALERT -> PkwTokens.Colors.gold.hi
        ChipTone.DANGER -> PkwTokens.Colors.danger
        ChipTone.QUIET -> PkwTokens.Colors.muted
    }
    Row(modifier.fillMaxHeight().widthIn(min = PkwTokens.Dims.minTap)
        .clearAndSetSemantics { contentDescription = chip.description; role = Role.Button; onClick(label = null, action = { onOpen(chip.id); true }) }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button) { onOpen(chip.id) }
        .drawBehind {
            if (press > 0f) {
                val inset = STATUS_TOUCH_INSET.dp.toPx() + 2.dp.toPx()
                drawRect(PkwTokens.Colors.veilHi.copy(alpha = 0.7f * press), Offset(0f, inset), Size(size.width, size.height - 2 * inset))
            }
        }.padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally)) {
        // A blank icon draws none (the free camp label stands alone, onboard-first-home.png).
        if (chip.icon.isNotBlank()) Box(if (segment.bleedDp > 0) Modifier.bleedX(segment.bleedDp.dp) else Modifier) {
            PkwIcon(chip.icon, segment.iconDp.dp)
            if (chip.dot) Box(Modifier.align(Alignment.TopEnd).size(6.dp).background(PkwTokens.Colors.gold.face))
        }
        PkwText(shown(chip.value), segment.style, color = color, outline = if (segment.style == PkwTokens.Type.body) 0.dp else 1.dp)
    }
}

/**
 * A right edge button (DESIGN-SYSTEM §6 EdgeButton): a 48 × 48 charcoal chunky face, icon 36 (24 px art) or 32 (64 px
 * art), the outlined caption on an ink pill 2 dp below, the corner badge at −6 / −6, and a "+n" when [folded] other
 * badged buttons were stacked into it. It pops in (scale 0.8 → 1 + fade, 160 ms) when its badge first appears; a live
 * event ([EdgeButtonUi.glow]) pulses a gold rim (no loop with reduced motion).
 */
@Composable private fun EdgeButton(ui: EdgeButtonUi, folded: Int, onOpen: (FeatureId) -> Unit) {
    val still = LocalReducedMotion.current || LocalInspectionMode.current
    val enter = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) { enter.animateTo(1f, tween(PkwTokens.Motion.PLATE_IN, easing = PkwTokens.Motion.Out)) }
    // The pulse is read in drawBehind only (draw phase): reading it here recomposed the whole button every frame it glowed.
    val pulse = if (!ui.glow || still) null else rememberInfiniteTransition(label = "glow").animateFloat(0.35f, 1f,
        infiniteRepeatable(tween(PkwTokens.Motion.READY_BOUNCE_LOOP, easing = PkwTokens.Motion.Linear), RepeatMode.Reverse), label = "glowAlpha")
    val steadyGlow = if (!ui.glow) 0f else 0.8f
    val spoken = listOfNotNull(ui.label, ui.badge?.description, if (folded > 0) "and $folded more" else null).joinToString(". ")
    Column(Modifier.width(HudGeometry.EDGE.dp).graphicsLayer {
        alpha = enter.value
        val s = 0.8f + 0.2f * enter.value
        scaleX = s; scaleY = s
    }, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.drawBehind {
            val glow = pulse?.value ?: steadyGlow
            if (glow > 0f) {
                val w = 2.dp.toPx()
                drawRect(PkwTokens.Colors.gold.hi.copy(alpha = glow), Offset(-w, -w), Size(size.width + 2 * w, size.height + 2 * w), style = Stroke(w))
            }
        }) {
            ChunkyBox(PkwTokens.Colors.charcoalRamp, { onOpen(ui.id) }, spoken, Modifier.size(HudGeometry.EDGE.dp)) {
                PkwIcon(ui.icon, hudIconDp(ui.icon, large = true).dp, tint = PkwTokens.Colors.text)
            }
            ui.badge?.let { Badge(it, Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp)) }
            if (folded > 0) Badge(BadgeUi("+$folded", BadgeTone.INFO, "$folded more"), Modifier.align(Alignment.TopStart).offset(x = (-6).dp, y = (-6).dp))
        }
        Spacer(Modifier.height(HudGeometry.EDGE_LABEL_GAP.dp))
        Box(Modifier.wrapContentWidth(Alignment.CenterHorizontally, unbounded = true).widthIn(max = HudGeometry.EDGE_LABEL_W_MAX.dp)
            .heightIn(min = HudGeometry.EDGE_LABEL_H.dp).clearAndSetSemantics { }
            .drawBehind { fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink) }
            .padding(horizontal = 4.dp), contentAlignment = Alignment.Center) {
            PkwText(ui.label, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
        }
    }
}

/**
 * A left edge tab (DESIGN-SYSTEM §6 EdgeTab, home.html `.chat`), drawn as the design draws it: a 44 × 48 ink shell flush
 * with the screen edge, square on that side and stepped 4 dp on the right, padded 3 top / 3 right / 5 bottom / 0 left
 * around a charcoal face with its 3 dp `#4A4552` top band and 4 dp `#151218` bottom band. The mark is the design's drawn
 * one ([edgeTabMark]: MAIL the cream envelope with its tan flap and red seal, CHAT the cream pill with three ink dots), no
 * caption ([EdgeButtonUi.label] is the screen-reader name), and the unread badge with its left edge 30 dp in and 10 dp
 * above the tab. The target is 48 × 48 (4 dp past the painted 44). A press drops the face 2 dp (lip 5 → 3).
 *
 * (Before 2026-10-06 the tab was a chunky button pushed 8 dp off-screen, so its right corners were the 8 dp button steps
 * with a 55 % mid band, and the marks were the white 12-cell glyphs: the owner's "chat and email buttons still do not
 * look as originally intended".)
 */
@Composable private fun EdgeTab(ui: EdgeButtonUi, onOpen: (FeatureId) -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val press = pressProgress(interaction)
    val spoken = listOfNotNull(ui.label, ui.badge?.description).joinToString(". ")
    val g = HudGeometry
    Box(Modifier.size(PkwTokens.Dims.minTap, g.TAB_H.dp).sceneInputRegion()
        .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; onClick(label = null, action = { onOpen(ui.id); true }) }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button) { onOpen(ui.id) }
        .drawBehind { drawEdgeTab(press) }) {
        // Centred on the face (x 0..41, y 3..43), riding the press down with it.
        Box(Modifier.size((g.TAB_W - TAB_RIM).dp, g.TAB_H.dp).padding(top = TAB_RIM.dp, bottom = TAB_LIP.dp)
            .offset { IntOffset(0, (TAB_PRESS.dp.toPx() * press).roundToInt()) }, contentAlignment = Alignment.Center) {
            when (edgeTabMark(ui.icon)) {
                EdgeTabMark.MAIL -> Box(Modifier.size(TAB_MARK_W.dp, TAB_MARK_H.dp).drawBehind { drawMailMark() })
                EdgeTabMark.CHAT -> Box(Modifier.size(TAB_MARK_W.dp, TAB_MARK_H.dp).drawBehind { drawChatMark() })
                null -> PkwIcon(ui.icon, hudIconDp(ui.icon, large = false).dp, tint = PkwTokens.Colors.text)
            }
        }
        ui.badge?.let { Badge(it, Modifier.offset(x = g.TAB_BADGE_X.dp, y = g.TAB_BADGE_Y.dp)) }
    }
}

/** home.html `.chat`: the shell's top / right rim, its bottom lip, and how far a press drops the face (lip 5 → 3). */
private const val TAB_RIM = 3
private const val TAB_LIP = 5
private const val TAB_PRESS = 2

/** The drawn tab marks' box (home.html: the envelope and `.bubble-ic` are both 26 × 20). */
private const val TAB_MARK_W = 26
private const val TAB_MARK_H = 20

/** A box square on the left with two-stair corners on the right ([step] px per stair: home.html's 2 px + 2 px). */
private fun tabPath(l: Float, t: Float, r: Float, b: Float, step: Float): Path = Path().apply {
    moveTo(l, t)
    lineTo(r - 2 * step, t); lineTo(r - 2 * step, t + step); lineTo(r - step, t + step); lineTo(r - step, t + 2 * step); lineTo(r, t + 2 * step)
    lineTo(r, b - 2 * step); lineTo(r - step, b - 2 * step); lineTo(r - step, b - step); lineTo(r - 2 * step, b - step); lineTo(r - 2 * step, b)
    lineTo(l, b)
    close()
}

/** The edge tab's shell and face (see [EdgeTab]), on whole device pixels, [HudGeometry.TAB_W] wide from the left edge. */
private fun DrawScope.drawEdgeTab(press: Float) {
    val p = press.coerceIn(0f, 1f)
    val ramp = PkwTokens.Colors.charcoalRamp
    val w = HudGeometry.TAB_W.dp.roundToPx().toFloat()
    val step = 2.dp.roundToPx().coerceAtLeast(1).toFloat()
    val travel = (TAB_PRESS.dp.toPx() * p).roundToInt().toFloat()
    val h = size.height
    drawPath(tabPath(0f, travel, w, h, step), PkwTokens.Colors.ink)
    val r = w - TAB_RIM.dp.roundToPx(); val t = travel + TAB_RIM.dp.roundToPx(); val b = h - TAB_LIP.dp.roundToPx() + travel
    val band = 3.dp.roundToPx().toFloat(); val lip = 4.dp.roundToPx().toFloat()
    clipPath(tabPath(0f, t, r, b, step)) {
        drawRect(ramp.face, Offset(0f, t), Size(r, b - t))
        drawRect(ramp.hi, Offset(0f, t), Size(r, band))
        drawRect(ramp.lo, Offset(0f, b - lip), Size(r, lip))
        if (p > 0f) drawRect(Color.Black.copy(alpha = 0.18f * p), Offset(0f, t), Size(r, band))
    }
}

/** A filled rect in whole dp from (x, y), its edges on whole device pixels. */
private fun DrawScope.markRect(color: Color, x: Int, y: Int, w: Int, h: Int) {
    val l = x.dp.roundToPx().toFloat(); val t = y.dp.roundToPx().toFloat()
    drawRect(color, Offset(l, t), Size((x + w).dp.roundToPx() - l, (y + h).dp.roundToPx() - t))
}

/** home.html MAIL mark (26 × 20): a cream envelope with a 3 dp tan bottom band, a tan flap from both top corners down to
 *  (13, 11) in 1 dp stairs, and a 6 dp red seal at (10, 7) on the flap's point. */
private fun DrawScope.drawMailMark() {
    val c = PkwTokens.Colors
    markRect(c.cream, 0, 0, TAB_MARK_W, TAB_MARK_H)
    markRect(c.parchmentLo, 0, TAB_MARK_H - 3, TAB_MARK_W, 3)
    val half = TAB_MARK_W / 2f
    for (row in 0 until FLAP_ROWS) {
        val reach = half * (1f - (row + 0.5f) / FLAP_ROWS)
        val l = ((half - reach) * density).roundToInt().toFloat(); val r = ((half + reach) * density).roundToInt().toFloat()
        val t = row.dp.roundToPx().toFloat()
        if (r > l) drawRect(c.parchmentLo, Offset(l, t), Size(r - l, (row + 1).dp.roundToPx() - t))
    }
    markRect(c.red.face, 10, 7, 6, 6)
}

/** The MAIL flap's height in dp (home.html: 11 of the envelope's 20). */
private const val FLAP_ROWS = 11

/** home.html CHAT mark (`.bubble-ic`, 26 × 20): a cream pill with 4 dp stepped corners and three 4 dp ink dots at y 8. */
private fun DrawScope.drawChatMark() {
    val c = PkwTokens.Colors
    fillStepped(0f, 0f, TAB_MARK_W.dp.roundToPx().toFloat(), TAB_MARK_H.dp.roundToPx().toFloat(), CornerProfiles.S, c.text)
    for (x in listOf(5, 11, 17)) markRect(c.ink, x, 8, 4, 4)
}

/** Lays the content out [bleed] narrower on each side, so its art overhangs its neighbours (the content is unchanged). */
private fun Modifier.bleedX(bleed: Dp): Modifier = layout { measurable, constraints ->
    val k = bleed.roundToPx()
    val placeable = measurable.measure(constraints.copy(minWidth = 0))
    layout((placeable.width - 2 * k).coerceAtLeast(0), placeable.height) { placeable.place(-k, 0) }
}

/**
 * The bottom deck (DESIGN-SYSTEM §6 BottomDeck): two corner groups 4 dp apart on one baseline 14 dp above the bottom,
 * 8 dp gutters, and the transient context chip in the gap between them, placed by [contextChipRect] on this screen's
 * width (the same numbers HudBudget measures). The container is a plain layout.
 */
@Composable private fun Deck(slots: List<DeckSlot>, context: ContextChipUi?, onOpen: (FeatureId) -> Unit, buildLongPress: (() -> Unit)? = null) {
    val longPress: (DeckSlot) -> (() -> Unit)? = { slot -> buildLongPress?.takeIf { slot.button.id == HudIds.BUILD } }
    BoxWithConstraints(Modifier.fillMaxWidth().padding(start = HudGeometry.GUTTER.dp, end = HudGeometry.GUTTER.dp, bottom = HudGeometry.DECK_BOTTOM.dp)) {
        val place = contextChipRect(slots, screenW = maxWidth.value.roundToInt() + 2 * HudGeometry.GUTTER)
        Row(Modifier.align(Alignment.BottomStart), horizontalArrangement = Arrangement.spacedBy(HudGeometry.DECK_GAP.dp), verticalAlignment = Alignment.Bottom) {
            slots.filter { it.leftCorner }.forEach { key(it.button.id.value) { DeckButton(it, onOpen, longPress(it)) } }
        }
        Presence(context, PkwTokens.Motion.TOAST_IN, PkwTokens.Motion.TOAST_OUT) { chip, progress, active, reduced ->
            // The chip's left edge and its lift above the deck baseline (non-zero only on a phone too narrow for the gap).
            val at = if (place == null) Modifier.align(Alignment.BottomCenter) else Modifier.align(Alignment.BottomStart)
                .offset(x = (place.left - HudGeometry.GUTTER).dp, y = (place.bottom - (HudGeometry.SCREEN_H - HudGeometry.DECK_BOTTOM)).dp)
            ContextChip(chip, active, onOpen, at.graphicsLayer {
                alpha = progress()
                translationY = if (reduced) 0f else PkwTokens.Motion.TOAST_SLIDE_DP * density * (1f - progress())
            })
        }
        Row(Modifier.align(Alignment.BottomEnd), horizontalArrangement = Arrangement.spacedBy(HudGeometry.DECK_GAP.dp), verticalAlignment = Alignment.Bottom) {
            slots.filter { !it.leftCorner }.forEach { key(it.button.id.value) { DeckButton(it, onOpen, longPress(it)) } }
        }
    }
}

/** What a screen reader says for a deck button: its label, its fill ("14 of 20") and its badge. */
private fun deckDescription(ui: DeckButtonUi): String = listOfNotNull(ui.label,
    ui.pips?.let { (current, capacity) -> "$current of $capacity" }, ui.badge?.description).joinToString(". ")

/**
 * One deck button: a [DeckButtonUi.verb] chunky face of the slot's size, its icon (36 on the corner buttons, a 28 dp
 * portrait or 24 dp icon on the 52 dp ones), an optional 4 dp fill meter ([DeckButtonUi.pips]) and the outlined caption
 * inside; the corner badge at −6 / −6.
 */
@Composable private fun DeckButton(slot: DeckSlot, onOpen: (FeatureId) -> Unit, onLongPress: (() -> Unit)? = null) {
    val ui = slot.button
    Box {
        ChunkyBox(PkwTokens.ramp(ui.verb), { onOpen(ui.id) }, deckDescription(ui), Modifier.size(slot.width.dp, slot.height.dp),
            onLongClick = onLongPress, longClickLabel = if (onLongPress != null) TOOLS_LONG_PRESS_LABEL else null,
            stateDescription = ui.stateDescription) {
            DeckFace(ui)
        }
        // home.html: BUILD at (332, 829) carries its gold NEW at (356, 817), 46 wide: the badge ends 2 dp inside the button's
        // right edge and stands 12 dp above its top.
        ui.badge?.let { Badge(it, Modifier.align(Alignment.TopEnd).offset(x = (-2).dp, y = (-12).dp)) }
    }
}

/**
 * A deck face's content, bounded to the face between its rim and its lip (the ChunkyBox content box) and stacked by
 * [deckStack]: the icon, the optional fill meter and the outlined caption, centred. The display-face fallback (VT323 20 sp)
 * is taller than the design's PS 11 (DESIGN-SYSTEM §11 risk 2), so rather than squeeze the caption the icon gives way:
 * on the 52 dp ARMY face the portrait takes what the face has left above its meter and caption, and keeps its lift into
 * the top band only when that still fits. Nothing is drawn above the button or into its lip (owner 2026-10-06,
 * K-night-A10: the portrait sat above the button, the old column being unbounded).
 */
@Composable private fun DeckFace(ui: DeckButtonUi) {
    val pips = ui.pips?.takeIf { it.second > 0 }
    val iconDp = deckIconDp(ui.icon, large = ui.primary, meter = pips != null)
    // home.html ARMY: the portrait sits 4 dp up into the face's top band (`margin-top:-4px`) when the face holds it.
    val liftDp = if (ui.icon.contains("portrait")) PORTRAIT_LIFT else 0
    Layout(content = {
        // Measured at the square deckStack fits; the icon's own size modifier yields to those fixed constraints.
        PkwIcon(ui.icon, iconDp.dp, Modifier.layoutId(DeckPart.ICON), tint = PkwTokens.Colors.label)
        if (pips != null) {
            val fill = (pips.first.toFloat() / pips.second).coerceIn(0f, 1f)
            Box(Modifier.layoutId(DeckPart.METER).padding(top = 1.dp).size(36.dp, 5.dp).background(PkwTokens.Colors.ink).padding(1.dp)) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(fill).background(PkwTokens.Colors.green.hi))
            }
        }
        PkwText(ui.label, if (ui.primary) PkwTokens.Type.caption else SMALL_DECK_CAPTION, Modifier.layoutId(DeckPart.CAPTION),
            color = PkwTokens.Colors.label, outline = 1.dp)
    }, modifier = Modifier.fillMaxSize()) { measurables, constraints ->
        fun part(id: DeckPart) = measurables.firstOrNull { it.layoutId == id }
        val loose = Constraints(maxWidth = constraints.maxWidth)
        val caption = part(DeckPart.CAPTION)!!.measure(loose)
        val meter = part(DeckPart.METER)?.measure(loose)
        val meterH = meter?.height ?: 0
        val wanted = iconDp.dp.roundToPx()
        val room = if (constraints.hasBoundedHeight) constraints.maxHeight else wanted + meterH + caption.height
        val stack = deckStack(room, wanted, liftDp.dp.roundToPx(), meterH, caption.height)
        val side = stack.icon.coerceAtMost(constraints.maxWidth)
        val icon = part(DeckPart.ICON)!!.measure(Constraints.fixed(side, side))
        val width = if (constraints.hasBoundedWidth) constraints.maxWidth else maxOf(icon.width, meter?.width ?: 0, caption.width)
        layout(width, room) {
            icon.place((width - icon.width) / 2, stack.iconTop)
            if (meter != null) meter.place((width - meter.width) / 2, stack.meterTop)
            caption.place((width - caption.width) / 2, stack.captionTop)
        }
    }
}

/** The parts [DeckFace] stacks. */
private enum class DeckPart { ICON, METER, CAPTION }

/** How far a deck portrait rises into its face's top band (home.html ARMY `margin-top:-4px`), when the face holds it. */
private const val PORTRAIT_LIFT = 4

/** What a screen reader offers as BUILD's long-press action while the deck carries tools. */
internal const val TOOLS_LONG_PRESS_LABEL = "Base tools: layout, expand, fit"

/**
 * The deck's tools shelf (the folded LAYOUT · EXPAND · FIT dock row): one row of 52 × 52 stone deck faces 8 dp above
 * BUILD's corner ([HudGeometry.TOOL], [homeHudToolRects]). A disabled tool draws the OFF face, does nothing on tap and
 * says why in its screen-reader label. The row is a plain layout (pointer rule); only the faces take touches.
 */
@Composable private fun ToolsShelf(tools: List<DeckToolUi>, onOpen: (FeatureId) -> Unit) {
    val g = HudGeometry
    Row(Modifier.padding(start = g.GUTTER.dp, end = g.GUTTER.dp, bottom = (g.DECK_BOTTOM + g.DECK_PRIMARY + g.TOOLS_GAP_ABOVE_DECK).dp),
        horizontalArrangement = Arrangement.spacedBy(g.DECK_GAP.dp), verticalAlignment = Alignment.Bottom) {
        tools.forEach { tool ->
            key(tool.id.value) {
                ChunkyBox(PkwTokens.ramp(if (tool.enabled) Verb.STONE else Verb.OFF), { onOpen(tool.id) }, tool.description,
                    Modifier.size(g.TOOL.dp), enabled = tool.enabled) {
                    Column(Modifier.wrapContentHeight(unbounded = true), horizontalAlignment = Alignment.CenterHorizontally) {
                        PkwIcon(tool.icon, hudIconDp(tool.icon, large = false).dp, tint = PkwTokens.Colors.label)
                        PkwText(tool.label, SMALL_DECK_CAPTION, color = PkwTokens.Colors.label, outline = 1.dp)
                    }
                }
            }
        }
    }
}

/**
 * The caption at its token size with a tighter line box, so it fits a 52 dp face. The type size is unchanged. The box
 * hugs the capitals: VT323's caps stand 0.56 em (11.2 dp at 20 sp) on the baseline, 13.2 dp with the 1 dp outline, so a
 * centred 14 sp line holds them whole. [LineHeightStyle.Trim.None] is what makes the box apply at all: Compose's default
 * trim keeps a one-line text at the font's full 20 dp em box (Compose 1.7 LineHeightStyleSpan), which is how an
 * 18 sp box here left the ARMY face 7 dp too short (K-night-A10).
 */
private val SMALL_DECK_CAPTION: TextStyle = PkwTokens.Type.caption.copy(lineHeight = 14.sp,
    lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None))

/**
 * The transient context chip (DESIGN-SYSTEM §6 ContextChip): a 108 × 48 cream card with a 32 dp icon poking out at the
 * top-left and two VT lines, what ("Auction") and where ("Seeker ▸"). A tap flies the camera there; while it animates
 * out ([active] false) it is no longer a button.
 *
 * home.html `.next`: the lines start 32 dp in (2 dp rim + 30, clear of the icon) and end 8 dp short (2 + 6); the icon
 * box sits at ([HudGeometry.CONTEXT_ICON_X], [HudGeometry.CONTEXT_ICON_Y]). Art is drawn at a whole-number scale of
 * its own pixels inside that box (64 px Phase E art at 32, 24 px art at 36), centred, so it may overhang the box.
 */
@Composable private fun ContextChip(ui: ContextChipUi, active: Boolean, onOpen: (FeatureId) -> Unit, modifier: Modifier) {
    val spoken = "${ui.what}, ${ui.where.removeSuffix("▸").trim()}"
    val tap = if (active) Modifier
        .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; onClick(label = null, action = { onOpen(ui.id); true }) }
        .clickable(role = Role.Button) { onOpen(ui.id) }
    else Modifier.clearAndSetSemantics { }
    val g = HudGeometry
    Box(modifier.size(g.CONTEXT_W.dp, g.CONTEXT_H.dp)) {
        Plate(PlateKind.CREAM, Modifier.matchParentSize().then(tap), contentPadding = PaddingValues(start = 32.dp, top = 4.dp, end = 8.dp, bottom = 2.dp)) {
            Column(Modifier.align(Alignment.CenterStart)) {
                PkwText(ui.what, PkwTokens.Type.small.copy(lineHeight = 19.sp), color = PkwTokens.Colors.textOnParch)
                PkwText(ui.where, PkwTokens.Type.small.copy(lineHeight = 19.sp), color = PkwTokens.Colors.gold.lo)
            }
        }
        Box(Modifier.offset(x = g.CONTEXT_ICON_X.dp, y = g.CONTEXT_ICON_Y.dp).size(g.CONTEXT_ICON.dp).clearAndSetSemantics { },
            contentAlignment = Alignment.Center) {
            PkwIcon(ui.icon, hudIconDp(ui.icon, large = true).dp, Modifier.wrapContentSize(unbounded = true))
        }
    }
}

// ---- Previews (realistic sample data; the backdrop stands in for the kingdom) ----

private val previewHud = HomeHudUi(
    profile = ProfileMedallionUi(FeatureId("hud.profile"), "12", null, "Profile, Keep level 12"),
    builders = ChipUi(FeatureId("hud.builders"), "builder", "1/2", "Builders: 1 of 2 free", dot = true),
    shield = ChipUi(FeatureId("hud.shield"), "shield", "4h", "Shield: 4 hours left. Opens the defence log"),
    resources = listOf(
        ResourceChipUi(FeatureId("hud.shards"), "shards", "40,943", 0.68f, false, null, name = "Shards", accent = ResourceAccent.SHARDS),
        ResourceChipUi(FeatureId("hud.gems"), "gem", "1,250", null, false, null, name = "Gems", accent = ResourceAccent.GEMS),
        ResourceChipUi(FeatureId("hud.keep"), "keep", "312.5", null, false, null, name = "KEEP", accent = ResourceAccent.KEEP),
        // SKR has no own registry row: the readout's id is only the drawer focus naming the SKR row (MOUNT-HUD.md).
        ResourceChipUi(FeatureId("hud.skr"), "skr", "240", null, false, null, name = "SKR", accent = ResourceAccent.SKR, drawerHandle = true,
            exactDescription = "SKR 240.000001"),
    ),
    rightEdge = listOf(
        EdgeButtonUi(FeatureId("hud.quests"), "quest", "QUESTS", BadgeUi("3", BadgeTone.COUNT, "3 quests ready to claim"), glow = false),
        EdgeButtonUi(HudIds.DAILY_CACHE, "shape:chest", "DAILY", BadgeUi("!", BadgeTone.READY, "Daily cache ready"), glow = false),
    ),
    leftEdge = listOf(
        EdgeButtonUi(HudIds.MAIL, "shape:envelope", "Mail", BadgeUi("2", BadgeTone.COUNT, "2 unread letters"), glow = false),
        EdgeButtonUi(HudIds.CHAT, "shape:speech", "Chat", BadgeUi("5", BadgeTone.COUNT, "5 unread messages"), glow = false),
    ),
    herald = null,
    deck = listOf(
        DeckButtonUi(FeatureId("hud.attack"), "attack", "ATTACK", true, null, null, verb = Verb.RED),
        DeckButtonUi(FeatureId("hud.army"), "ui_portrait_highlander_t2", "ARMY", false, null, 14 to 20, verb = Verb.CHARCOAL),
        DeckButtonUi(FeatureId("hud.map"), "map", "MAP", false, null, null, verb = Verb.BLUE),
        DeckButtonUi(FeatureId("hud.build"), "itm_hammer", "BUILD", true, BadgeUi("NEW", BadgeTone.REWARD, "A new building unlocked"), null, verb = Verb.GREEN),
    ),
    deckVisible = true,
    trophies = ChipUi(FeatureId("hud.leagues"), "league-gold", "1,284", "Gold league, 1,284 trophies"),
    context = ContextChipUi(FeatureId("island.seeker"), "ui:seeker-navigation", "Auction", "Seeker ▸"),
)

/** A grass-green stand-in for the kingdom so the HUD reads as it does over the world. */
private val PREVIEW_WORLD = Color(0xFF3F6A35)

@Preview(name = "Home HUD at rest", widthDp = 412, heightDp = 915)
@Composable private fun HomeHudRestPreview() {
    Box(Modifier.fillMaxSize().background(PREVIEW_WORLD)) {
        HomeHud(previewHud.copy(herald = HeraldUi("builder", "builder", "Builder finished: Workshop Lv 3", FeatureId("hud.builders"))), HomeHudActions.None)
    }
}

@Preview(name = "Home HUD, building selected", widthDp = 412, heightDp = 915)
@Composable private fun HomeHudSelectedPreview() {
    Box(Modifier.fillMaxSize().background(PREVIEW_WORLD)) { HomeHud(previewHud.copy(deckVisible = false), HomeHudActions.None) }
}

@Preview(name = "Home HUD, unknown values, no wallet, mirrored", widthDp = 412, heightDp = 915)
@Composable private fun HomeHudUnknownPreview() {
    val unknown = previewHud.copy(
        profile = previewHud.profile.copy(level = UNKNOWN),
        builders = previewHud.builders.copy(value = "2h 14m", dot = false, description = "Builders: all busy, next free in 2 hours 14 minutes"),
        shield = previewHud.shield.copy(value = "RAIDED ×2", tone = ChipTone.DANGER, description = "Raided twice. Opens the defence log"),
        resources = listOf(previewHud.resources[0].copy(value = UNKNOWN, fill = null), previewHud.resources[1].copy(value = UNKNOWN),
            previewHud.resources[3].copy(value = UNKNOWN)),
        rightEdge = emptyList(), leftEdge = previewHud.leftEdge.drop(1), context = null, mirrored = true,
    )
    Box(Modifier.fillMaxSize().background(PREVIEW_WORLD)) { HomeHud(unknown, HomeHudActions.None) }
}

@Preview(name = "Home HUD, three badged edges: +1 door to the hub notices", widthDp = 412, heightDp = 915)
@Composable private fun HomeHudOverflowPreview() {
    val crowded = previewHud.copy(
        rightEdge = previewHud.rightEdge + EdgeButtonUi(HudIds.EVENT, "ui_banner_event", "EVENT", BadgeUi("!", BadgeTone.READY, "Event live"), glow = true),
        rightEdgeOverflow = FeatureId("hud.profile"))
    Box(Modifier.fillMaxSize().background(PREVIEW_WORLD)) { HomeHud(crowded, HomeHudActions.None) }
}

@Preview(name = "Home HUD while a Seal shows (stack readable, not tappable)", widthDp = 412, heightDp = 915)
@Composable private fun HomeHudSealPreview() {
    Box(Modifier.fillMaxSize().background(PREVIEW_WORLD)) {
        HomeHud(previewHud, HomeHudActions.None, stackLifted = true)
        Box(Modifier.fillMaxSize().background(PkwTokens.Colors.scrim.copy(alpha = PkwTokens.Scrim.SEAL)))
        HomeResourceStack(previewHud, HomeHudActions.None, sealShown = true)
    }
}

@Preview(name = "Home HUD with the resource drawer", widthDp = 412, heightDp = 915)
@Composable private fun HomeHudDrawerPreview() {
    Box(Modifier.fillMaxSize().background(PREVIEW_WORLD)) { HomeHud(previewHud, HomeHudActions.None, drawer = previewDrawer) }
}
