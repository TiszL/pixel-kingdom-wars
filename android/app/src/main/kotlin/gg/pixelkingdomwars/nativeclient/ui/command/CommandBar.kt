package gg.pixelkingdomwars.nativeclient.ui.command

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layoutId
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.CommandMedallion
import gg.pixelkingdomwars.nativeclient.ui.kit.PixelShapes
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.kit.orderCommands
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.NamePlateUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.PI
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlinx.coroutines.delay

/*
 * Design component: the building tap surfaces of DESIGN-SYSTEM §6 Selection (NamePlate, CommandBar, CommandButton row,
 * hint pill) as drawn in design/final/selected.png and specified in design/final/buildings/SPEC.md §1.
 *
 * Three public entry points:
 * - [SelectionOverlay]: what HomeShell mounts. Name plate over the sprite + command bar, with select / re-select /
 *   deselect motion and the exit hold (the last selection stays drawn while it animates out).
 * - [CommandBar]: the bar alone (bottom deck area, or flipped under the resource stack when the building stands there).
 * - [NamePlate]: the plate alone (no placement), for a caller that positions it itself.
 *
 * Pointer rule (binding, see KIT-API.md): the base scene is a LOWER SIBLING of these roots and Compose stops at the first
 * sibling with a pointer hit. Every root here is a plain full-size layout with NO clickable, pointerInput, draggable or
 * scrim. The shelf, the hint pill, the reason pill, the name plate and its stem are paint only, so a touch anywhere except
 * a command button falls through to the kingdom (pan, tap another building, carry, wall stroke). The only touch targets
 * are the kit's `CommandMedallion` faces (each ≥ 48 dp, labelled, and registered with `sceneInputRegion`).
 *
 * Geometry is decided by the pure functions in CommandBarLayout.kt (JVM-tested); this file only draws and animates.
 */

/** Deselect is "reverse, 120 ms" (DESIGN-SYSTEM §7 Select building; TOKENS.json has no own key for it). */
private const val DESELECT_MS = 120

/** Re-selecting another building cross-fades the commands in 120 ms, no slide (buildings/SPEC.md §1.7). */
private const val RESELECT_MS = 120

/** How far commands rise (dp) on select (buildings/SPEC.md §1.7), and how far the plate drops (DESIGN-SYSTEM §7). */
private const val COMMAND_RISE_DP = 12f
private const val PLATE_DROP_DP = 8f

/** The shelf's first step is ink at 18 % (DESIGN-SYSTEM §6 CommandBar); the band is [PkwTokens.Scrim.COMMAND_SHELF]. */
private const val SHELF_STEP_ALPHA = 0.18f
private const val SHELF_LINE_ALPHA = 0.5f
private const val HINT_ALPHA = 0.86f

/** The disabled-tap shake: 2 dp, twice, in [PkwTokens.Motion.INVALID_SHAKE] (buildings/SPEC.md §1.7). */
private const val SHAKE_DP = 2f

/**
 * Everything the selection overlay draws for one selected building. [anchor] is the sprite's visible bounds in screen
 * pixels (the same pixel space as the overlay root, which must fill the screen from the window origin); null hides the
 * plate and leaves the bar at the bottom. Update [anchor] when the selection changes and when the camera settles; the bar
 * keeps its side while that side still clears the building, so it does not jump during a pan.
 */
@Immutable data class SelectionUi(val plate: NamePlateUi, val bar: CommandBarUi, val anchor: PxRect?)

/**
 * The selected building's name plate and command bar (DESIGN-SYSTEM §6 Selection, selected.png).
 *
 * Pass the current selection, or null when nothing is selected: the last selection then animates out (commands sink 12 dp,
 * plate lifts 8 dp, both fade, 120 ms) and is dropped. A new selection rises in (plate drops 8 dp + fade 160 ms; commands
 * rise 12 dp + fade over 160 ms with a 30 ms stagger left to right, primary last). Switching to another building
 * cross-fades the commands in 120 ms. Reduced motion: 120 ms fades only. Taps during the exit hold are dropped.
 *
 * [onCommand] gets the tapped command's id in every state but BUSY (the kit rule). The bar already answers a DISABLED tap
 * itself (shake + the reason pill for 4 s), so the caller only needs to route ENABLED (run / open), SHORT (Upgrade or
 * Need-more half sheet: shortfall + "Earned at <place>" + GO; never auto-spend) and LOCKED (the requirement half sheet).
 *
 * Pointer rule: this root is a full-size, transparent layout with NO pointer handling and NO scrim. Only the command
 * faces take touches; empty space, the shelf, the pills and the plate let touches fall through to the kingdom. Needs
 * bounded constraints (mount it full-screen, not inside a scroller).
 */
@Composable fun SelectionOverlay(selection: SelectionUi?, onCommand: (FeatureId) -> Unit, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val retained = remember { mutableStateOf(selection) }
    SideEffect { if (selection != null && retained.value != selection) retained.value = selection }
    val exit = remember { Animatable(0f) }
    LaunchedEffect(selection == null, reduced) {
        if (selection == null) {
            exit.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else DESELECT_MS, easing = PkwTokens.Motion.In))
            retained.value = null
        } else exit.snapTo(0f)
    }
    val shown = selection ?: retained.value ?: return
    val live by rememberUpdatedState(selection != null)
    val currentOnCommand by rememberUpdatedState(onCommand)
    val tap: (FeatureId) -> Unit = remember { { id -> if (live) currentOnCommand(id) } }
    BoxWithConstraints(modifier.fillMaxSize()) {
        val width = constraints.maxWidth.toFloat(); val height = constraints.maxHeight.toFloat()
        val density = LocalDensity.current.density
        val insets = safeInsetsPx()
        val bar = rememberPlacedBar(shown.bar, shown.anchor, width, height, insets)
        CommandBarBody(shown.bar, bar, tap) { exit.value }
        shown.anchor?.let { anchor ->
            AnchoredNamePlate(shown.plate, shown.bar.buildingId, anchor, insets,
                avoid = listOf(resourceStackRect(width, density, insets), bar.placement.footprint)) { exit.value }
        }
    }
}

/**
 * The command bar of a selected building (DESIGN-SYSTEM §6 CommandBar / CommandButton, buildings/SPEC.md §1.3): at most
 * four commands in portrait and five in landscape ([commandBarLimit]; design correction 7) on one row (INFO first, the
 * one primary last under the right thumb, see `orderCommands`), each with its
 * icon, caption, optional cost pill and badge, in the five states ENABLED, DISABLED (+ reason), BUSY, SHORT (red pill),
 * LOCKED (padlock; a locked primary keeps its primary place with its reason). A CHECKING price is enabled navigation,
 * an UNAVAILABLE price draws DISABLED (kit `commandDrawState`). It sits in the bottom deck area over the 2-step shelf; if [anchor] (the selected sprite's bounds in
 * screen px) stands in that band it flips under the resource stack instead, so it never covers the building. Enter
 * motion plays when it first appears; a new [CommandBarUi.buildingId] cross-fades the commands. For the exit motion and
 * the name plate, mount [SelectionOverlay] instead.
 *
 * Pointer rule: this root is a full-size, transparent layout with NO pointer handling and NO scrim; only the command
 * faces take touches. Needs bounded constraints.
 */
@Composable fun CommandBar(ui: CommandBarUi, onCommand: (FeatureId) -> Unit, modifier: Modifier = Modifier, anchor: PxRect? = null) {
    BoxWithConstraints(modifier.fillMaxSize()) {
        val bar = rememberPlacedBar(ui, anchor, constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat(), safeInsetsPx())
        CommandBarBody(ui, bar, onCommand) { 0f }
    }
}

/**
 * The name plate (DESIGN-SYSTEM §6 NamePlate): a charcoal plate 58 dp tall (72 with the job meter), 160-280 dp wide from
 * its content. Line 1: the name (title, gold-hi, 1 dp outline) and the level tag ([NamePlateUi.levelVerb], or by default
 * "NEW" gold and anything else blue: "LV 3", "LV 2>3", "MAX"). Line 2: the live state line, tinted by [stateLineRuns]
 * (muted words, counts in text colour, times in gold as kit.png draws them, "Ready" green, "Spent" danger).
 * [NamePlateUi.progress] adds a 12 dp meter in [NamePlateUi.progressVerb] (green, or blue for a working job), drawn as
 * the kit's green stripes while [NamePlateUi.progressStriped] (under construction, states.png). Unknown values arrive as
 * "…" and are shown as such.
 *
 * Pointer rule: paint only. It is not a touch target and not a scene-input region, so a pan may start on it.
 */
@Composable fun NamePlate(ui: NamePlateUi, modifier: Modifier = Modifier) {
    val progress = ui.progress
    val spoken = listOfNotNull(ui.name, ui.level.takeIf { it.isNotBlank() }, ui.stateLine?.takeIf { it.isNotBlank() },
        progress?.let { "${(it.coerceIn(0f, 1f) * 100).toInt()} percent done" }).joinToString(", ")
    Plate(PlateKind.CHARCOAL,
        modifier.widthIn(min = PkwTokens.Dims.namePlateMinW, max = PkwTokens.Dims.namePlateMaxW)
            .heightIn(min = if (progress != null) PLATE_WITH_METER else PkwTokens.Dims.namePlateH)
            .clearAndSetSemantics { contentDescription = spoken },
        contentPadding = PaddingValues(start = 12.dp, top = 6.dp, end = 10.dp, bottom = 8.dp), blocksScene = false) {
        Column(Modifier.width(IntrinsicSize.Max), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText(ui.name, PkwTokens.Type.title, Modifier.weight(1f, fill = false), color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                if (ui.level.isNotBlank()) Tag(ui.level, ui.levelVerb ?: if (ui.level.trim().equals("NEW", ignoreCase = true)) Verb.GOLD else Verb.BLUE)
            }
            ui.stateLine?.takeIf { it.isNotBlank() }?.let { StateLine(it) }
            if (progress != null) {
                val fill = progress.coerceIn(0f, 1f)
                // The striped fill is the kit ProgressBar's pending band from 0 to the fill (Progress.kt green stripes, 75 %).
                if (ui.progressStriped) ProgressBar(0f, description = "", modifier = Modifier.padding(top = 3.dp), verb = ui.progressVerb, pending = fill)
                else ProgressBar(fill, description = "", modifier = Modifier.padding(top = 3.dp), verb = ui.progressVerb)
            }
        }
    }
}

/** 58 + 3 + 12 (meter) − 1: the plate height with a job meter (buildings/SPEC.md §1.3 "72 with a ProgressBar"). */
private val PLATE_WITH_METER = 72.dp

@Composable private fun StateLine(line: String) {
    val c = PkwTokens.Colors
    val text = remember(line) {
        buildAnnotatedString {
            stateLineRuns(line).forEach { run ->
                withStyle(SpanStyle(color = when (run.tone) {
                    StateTone.MUTED -> c.muted
                    StateTone.VALUE -> c.text
                    StateTone.TIME -> c.gold.hi
                    StateTone.READY -> c.green.hi
                    StateTone.DANGER -> c.danger
                })) { append(run.text) }
            }
        }
    }
    Text(text, color = c.muted, overflow = TextOverflow.Ellipsis, softWrap = false, maxLines = 1, style = PkwTokens.Type.body)
}

/** The ordered commands and their placement for one frame. */
private class PlacedBar(val commands: List<CommandUi>, val placement: CommandBarPlacement)

/** Orders the commands (kit `orderCommands`) and places them (CommandBarLayout.kt), keeping the bar's side sticky per
 *  building so a pan does not make it jump. */
@Composable private fun rememberPlacedBar(ui: CommandBarUi, anchor: PxRect?, width: Float, height: Float, insets: PxInsets): PlacedBar {
    val density = LocalDensity.current.density
    val limit = commandBarLimit(width, height)
    val commands = remember(ui.commands, limit) { orderCommands(ui.commands, limit) }
    val specs = remember(commands) { commands.map { CommandSlotSpec(primary = it.primary, priced = it.price != null) } }
    val sticky = remember(ui.buildingId) { arrayOfNulls<BarSide>(1) }
    val placement = remember(specs, anchor, width, height, density, insets, ui.hint != null, ui.buildingId) {
        commandBarPlacement(width, height, density, insets, specs, anchor, hint = ui.hint != null, previous = sticky[0])
    }
    SideEffect { sticky[0] = placement.side }
    return PlacedBar(commands, placement)
}

/** The safe-drawing insets in px (status bar, gesture bar, cut-outs). Raw values: not affected by consumption upstream. */
@Composable private fun safeInsetsPx(): PxInsets {
    val density = LocalDensity.current
    val direction = LocalLayoutDirection.current
    val safe = WindowInsets.safeDrawing
    return PxInsets(safe.getLeft(density, direction).toFloat(), safe.getTop(density).toFloat(),
        safe.getRight(density, direction).toFloat(), safe.getBottom(density).toFloat())
}

/** Per-selection motion: [enter] runs 0 → 1 linearly once over the stagger timeline; [swap] fades in on a re-select. */
private class SelectionMotion(val enter: Animatable<Float, AnimationVector1D>, val swap: Animatable<Float, AnimationVector1D>)

@Composable private fun rememberSelectionMotion(buildingId: String, totalMs: Int): SelectionMotion {
    val reduced = LocalReducedMotion.current
    val still = LocalInspectionMode.current
    val motion = remember { SelectionMotion(Animatable(if (still) 1f else 0f), Animatable(1f)) }
    LaunchedEffect(Unit) {
        motion.enter.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else totalMs, easing = LinearEasing))
    }
    var last by remember { mutableStateOf(buildingId) }
    LaunchedEffect(buildingId) {
        if (last != buildingId) {
            last = buildingId
            motion.swap.snapTo(0f)
            motion.swap.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else RESELECT_MS, easing = PkwTokens.Motion.Out))
        }
    }
    return motion
}

/** Where item [index] is (0..1, eased) on the enter timeline [t] of [totalMs]: each starts [PkwTokens.Motion.COMMAND_STAGGER]
 *  after the previous and takes [durationMs]. Reduced motion: everything fades together. */
private fun staggered(t: Float, totalMs: Int, index: Int, durationMs: Int, reduced: Boolean): Float {
    if (reduced) return t
    val ms = t * totalMs - index * PkwTokens.Motion.COMMAND_STAGGER
    return PkwTokens.Motion.Out.transform((ms / durationMs).coerceIn(0f, 1f))
}

@Composable private fun CommandBarBody(ui: CommandBarUi, bar: PlacedBar, onCommand: (FeatureId) -> Unit, exit: () -> Float) {
    val reduced = LocalReducedMotion.current
    val placement = bar.placement
    val visible = placement.slots.map { bar.commands[it.index] }
    val totalMs = PkwTokens.Motion.DECK_SWAP + (visible.size - 1).coerceAtLeast(0) * PkwTokens.Motion.COMMAND_STAGGER
    val motion = rememberSelectionMotion(ui.buildingId, totalMs)
    val direction = if (placement.side == BarSide.BOTTOM) 1f else -1f
    val shelfIn: () -> Float = { staggered(motion.enter.value, totalMs, 0, PkwTokens.Motion.DECK_SWAP, reduced) * (1f - exit()) }

    // A DISABLED tap answers itself: the face shakes and the reason pill shows for 4 s (buildings/SPEC.md §1.7).
    // These states are never re-keyed: the remembered tap lambda below writes to exactly these objects.
    var reasonText by remember { mutableStateOf("") }
    var reasonShown by remember { mutableStateOf(false) }
    var shakeId by remember { mutableStateOf<FeatureId?>(null) }
    var reasonTick by remember { mutableIntStateOf(0) }
    val shake = remember { Animatable(0f) }
    LaunchedEffect(ui.buildingId) { reasonShown = false; shakeId = null }
    LaunchedEffect(reasonTick) {
        if (reasonTick == 0) return@LaunchedEffect
        if (!reduced) { shake.snapTo(0f); shake.animateTo(1f, tween(PkwTokens.Motion.INVALID_SHAKE, easing = LinearEasing)) }
        delay(PkwTokens.Motion.TOAST_HOLD.toLong())
        reasonShown = false
    }
    val currentOnCommand by rememberUpdatedState(onCommand)
    val currentCommands by rememberUpdatedState(visible)
    val tap: (FeatureId) -> Unit = remember {
        { id ->
            val command = currentCommands.firstOrNull { it.id == id }
            val why = command?.reason
            if (command != null && commandDrawState(command) == CommandState.DISABLED && !why.isNullOrBlank()) {
                reasonText = why; reasonShown = true; shakeId = id; reasonTick++
            }
            currentOnCommand(id)
        }
    }

    Box(Modifier.fillMaxSize().drawBehind {
        val a = shelfIn()
        if (a <= 0f) return@drawBehind
        val ink = PkwTokens.Colors.scrim
        val step = placement.step; val band = placement.band
        drawRect(ink.copy(alpha = SHELF_STEP_ALPHA * a), Offset(step.left, step.top), Size(step.width, step.height))
        drawRect(ink.copy(alpha = PkwTokens.Scrim.COMMAND_SHELF * a), Offset(band.left, band.top), Size(band.width, band.height))
        val line = 2.dp.toPx()
        val lineTop = if (placement.side == BarSide.BOTTOM) band.top else band.bottom - line
        drawRect(PkwTokens.Colors.ink.copy(alpha = SHELF_LINE_ALPHA * a), Offset(band.left, lineTop), Size(band.width, line))
    }) {
        // The hint (first selections) and the transient reason pill share one slot; the reason wins while it shows.
        val reasonAlpha by animateFloatAsState(if (reasonShown) 1f else 0f,
            tween(if (reasonShown) PkwTokens.Motion.TOAST_IN else PkwTokens.Motion.TOAST_OUT), label = "reason")
        val hint = ui.hint
        val hintTop = placement.hintTop
        if (hint != null && hintTop != null) {
            InfoPill(hint, hintTop, live = false) { shelfIn() * (1f - reasonAlpha) }
        }
        if ((reasonShown || reasonAlpha > 0f) && reasonText.isNotEmpty()) {
            InfoPill(reasonText, placement.pillTop, live = true) { reasonAlpha * (1f - exit()) }
        }
        Layout(content = {
            visible.forEachIndexed { i, command ->
                CommandMedallion(command, tap, Modifier.graphicsLayer {
                    val local = staggered(motion.enter.value, totalMs, i, PkwTokens.Motion.DECK_SWAP, reduced)
                    val out = exit()
                    alpha = local * motion.swap.value * (1f - out)
                    val rise = COMMAND_RISE_DP.dp.toPx()
                    translationY = if (reduced) 0f else direction * rise * ((1f - local) + out)
                    translationX = if (!reduced && command.id == shakeId && shake.value < 1f)
                        SHAKE_DP.dp.toPx() * sin(shake.value * 4f * PI.toFloat()) else 0f
                })
            }
        }, modifier = Modifier.fillMaxSize()) { measurables, constraints ->
            val loose = Constraints(maxWidth = constraints.maxWidth, maxHeight = constraints.maxHeight)
            val placeables = measurables.map { it.measure(loose) }
            layout(constraints.maxWidth, constraints.maxHeight) {
                placement.slots.forEachIndexed { i, slot ->
                    val p = placeables.getOrNull(i) ?: return@forEachIndexed
                    p.place((slot.button.centerX - p.width / 2f).roundToInt(), slot.column.top.roundToInt())
                }
            }
        }
    }
}

/** The hint / reason pill (VT 20 on ink 86 %, stepped S corners), centred at [topPx]. Paint only: touches pass through. */
@Composable private fun InfoPill(text: String, topPx: Float, live: Boolean, alpha: () -> Float) {
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.align(Alignment.TopCenter).offset { IntOffset(0, topPx.roundToInt()) }.padding(horizontal = 16.dp)
            .graphicsLayer { this.alpha = alpha() }
            .then(if (live) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier)
            .background(PkwTokens.Colors.ink.copy(alpha = HINT_ALPHA), PixelShapes.S)
            .padding(start = 12.dp, end = 12.dp, top = 3.dp, bottom = 3.dp)) {
            PkwText(text, PkwTokens.Type.body, color = PkwTokens.Colors.text)
        }
    }
}

/** The plate placed over (or under) [anchor] by [namePlatePlacement], with its 4 dp ink stem. Paint only. */
@Composable private fun AnchoredNamePlate(ui: NamePlateUi, buildingId: String, anchor: PxRect, insets: PxInsets, avoid: List<PxRect>, exit: () -> Float) {
    val reduced = LocalReducedMotion.current
    val motion = rememberSelectionMotion(buildingId, PkwTokens.Motion.PLATE_IN)
    val shown: GraphicsLayerBlock = {
        val t = if (reduced) motion.enter.value else PkwTokens.Motion.Out.transform(motion.enter.value)
        val out = exit()
        alpha = t * motion.swap.value * (1f - out)
        translationY = if (reduced) 0f else -PLATE_DROP_DP.dp.toPx() * ((1f - t) + out)
    }
    Layout(content = {
        Box(Modifier.layoutId("stem").graphicsLayer(shown).background(PkwTokens.Colors.ink))
        NamePlate(ui, Modifier.layoutId("plate").graphicsLayer(shown))
    }, modifier = Modifier.fillMaxSize()) { measurables, constraints ->
        val plate = measurables.first { it.layoutId == "plate" }.measure(Constraints(maxWidth = constraints.maxWidth, maxHeight = constraints.maxHeight))
        val place = namePlatePlacement(constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat(), density, insets, anchor,
            plate.width.toFloat(), plate.height.toFloat(), avoid)
        val stem = measurables.first { it.layoutId == "stem" }.measure(Constraints.fixed(
            place.stem.width.roundToInt().coerceAtLeast(0), place.stem.height.roundToInt().coerceAtLeast(0)))
        layout(constraints.maxWidth, constraints.maxHeight) {
            stem.place(place.stem.left.roundToInt(), place.stem.top.roundToInt())
            plate.place(place.plate.left.roundToInt(), place.plate.top.roundToInt())
        }
    }
}

private typealias GraphicsLayerBlock = androidx.compose.ui.graphics.GraphicsLayerScope.() -> Unit

// ---- Previews (sample data only) ----

private fun previewForge(state: CommandState = CommandState.SHORT) = CommandBarUi("gf-1", listOf(
    CommandUi(FeatureId("goldforge.info"), "info", "INFO", null, false, CommandState.ENABLED, null, null, verb = Verb.BLUE),
    CommandUi(FeatureId("goldforge.upgrade"), "shape:up", "UPGRADE", PriceUi(Currency.SHARDS, "52,400", PriceStatus.SHORT), false,
        state, null, null, verb = Verb.GREEN, sub = "4h"),
    CommandUi(FeatureId("goldforge.forge"), "ui:ready-status", "FORGE", null, true, CommandState.ENABLED, null,
        BadgeUi("!", BadgeTone.READY, "Ready to claim"), iconSecondary = "keep"),
), hint = "Tap the forge again to open it")

private val previewPlate = NamePlateUi("GOLD FORGE", "LV 3", "Smelted 2/3 · pool 6h 20m", null)

@Composable private fun PreviewWorld(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) { content() }
}

/** Draws the preview's stand-in sprite at [anchor] so the placement can be judged. */
@Composable private fun PreviewSprite(anchor: PxRect) {
    val d = LocalDensity.current.density
    Box(Modifier.offset { IntOffset(anchor.left.roundToInt(), anchor.top.roundToInt()) }
        .size((anchor.width / d).dp, (anchor.height / d).dp).background(PkwTokens.Colors.gold.lo))
}

@Preview(name = "Selected: Gold Forge (selected.png)", widthDp = 412, heightDp = 915)
@Composable private fun SelectionOverlayPreview() {
    val d = LocalDensity.current.density
    val anchor = PxRect(246 * d, 288 * d, 330 * d, 372 * d)
    PreviewWorld {
        PreviewSprite(anchor)
        SelectionOverlay(SelectionUi(previewPlate, previewForge(), anchor), onCommand = {})
    }
}

@Preview(name = "Selected low on screen: bar flips under the stack", widthDp = 412, heightDp = 915)
@Composable private fun SelectionOverlayLowPreview() {
    val d = LocalDensity.current.density
    val anchor = PxRect(150 * d, 790 * d, 234 * d, 874 * d)
    PreviewWorld {
        PreviewSprite(anchor)
        SelectionOverlay(SelectionUi(NamePlateUi("BARRACKS", "LV 7", "Training 4 · 0:42", 0.6f), CommandBarUi("b-1", listOf(
            CommandUi(FeatureId("barracks.info"), "info", "INFO", null, false, CommandState.ENABLED, null, null, verb = Verb.BLUE),
            CommandUi(FeatureId("barracks.upgrade"), "shape:up", "UPGRADE", PriceUi(Currency.SHARDS, "18,000", PriceStatus.OK), false,
                CommandState.ENABLED, null, null, verb = Verb.GREEN, sub = "6h"),
            CommandUi(FeatureId("barracks.train"), "ui_portrait_highlander_t3", "TRAIN", null, true, CommandState.ENABLED, null,
                BadgeUi("4", BadgeTone.COUNT, "4 troops queued")),
        )), anchor), onCommand = {})
    }
}

@Preview(name = "Command bar: states (CHECKING navigates, locked primary)", widthDp = 412, heightDp = 400)
@Composable private fun CommandBarStatesPreview() {
    PreviewWorld {
        CommandBar(CommandBarUi("lodge-1", listOf(
            CommandUi(FeatureId("lodge.info"), "info", "INFO", null, false, CommandState.ENABLED, null, null, verb = Verb.BLUE),
            CommandUi(FeatureId("lodge.passport"), "ui:navigation-kit", "PASSPORT", null, false, CommandState.DISABLED,
                "Lodge is upgrading", null, verb = Verb.STONE),
            // A CHECKING price is enabled navigation into the review sheet (design correction 7), never BUSY.
            CommandUi(FeatureId("lodge.upgrade"), "shape:up", "UPGRADE", PriceUi(Currency.SHARDS, null, PriceStatus.CHECKING), false,
                CommandState.ENABLED, null, null, verb = Verb.GREEN),
            CommandUi(FeatureId("lodge.expedition"), "ui:lodge-menu", "EXPLORE", PriceUi(Currency.GEMS, "96", PriceStatus.OK), true,
                CommandState.LOCKED, "Opens 14 Oct", null),
        )), onCommand = {})
    }
}

@Preview(name = "Command bar: short on Shards", widthDp = 412, heightDp = 300)
@Composable private fun CommandBarShortPreview() {
    PreviewWorld { CommandBar(previewForge(CommandState.SHORT).copy(hint = null), onCommand = {}) }
}

@Preview(name = "Name plates", widthDp = 320, heightDp = 360)
@Composable private fun NamePlatePreview() {
    Column(Modifier.fillMaxSize().background(Color(0xFF3F6A35)).padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        NamePlate(previewPlate)
        NamePlate(NamePlateUi("WORKSHOP", "NEW", "Building · 1h 12m", 0.3f, levelVerb = Verb.GOLD, progressStriped = true))
        NamePlate(NamePlateUi("ALCHEMY LAB", "LV 4", "Giant 3 · 2h 10m", 0.6f, progressVerb = Verb.BLUE))
        NamePlate(NamePlateUi("LODGE", "LV 2>3", "Upgrading · 3h 40m", 0.45f))
        NamePlate(NamePlateUi("MINE", "…", "Ready · 8,400 Shards", null))
        NamePlate(NamePlateUi("SPIKE TRAP", "LV 4", "Spent · rearm it", null))
    }
}
