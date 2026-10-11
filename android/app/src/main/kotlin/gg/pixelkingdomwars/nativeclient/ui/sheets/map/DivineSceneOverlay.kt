package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.command.CommandBar
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import kotlin.math.roundToInt

/*
 * Design component: the Divine Isle as a scene (design/final/map/SPEC.md Round 2 §C + critic fix; divine-scene.png). It
 * supersedes "§5 no scene tonight": the isle is a place with two doors on the art, WEST the trials ring (Solo Trials) and
 * EAST the citadel (Clan Citadels). Proposed `Destination.DivineIsle` (a scene, like the island layer).
 *
 * The overlay draws: BACK "MAP", the title plate "DIVINE ISLE" / "Trials west · citadels east", the ResourceStack, the
 * CountdownChip "Trial week ends 3d 4h"; on the art the selected door's stepped iso diamond (136 × 68: ink 8 / gold-hi 3 /
 * 10 % gold fill / dashed inner) with its plate (PS 13 name + state tag, VT 20 state line, 4 dp stem: WEST above the
 * temple, EAST below the citadel per the critic fix) and the other door's label (site icon 32, PS 11 name, padlock, its
 * reason tag inside); zoom + / −; the "Tap a door to choose" hint (first 3 visits); and the kit CommandBar (≤ 4, primary
 * last: INFO · FRAGMENTS (gold count) · TRIALS★, or CITADELS★ / locked CITADELS for EAST).
 *
 * The isle art (`Q/world/divine-isle.webp`), its pan / pinch and its camera belong to the isle scene below this overlay.
 * Z0 draws the art at 1 device px per 2 art px ([divineLevelScale]); the critic-fix camera puts it at 600 × 421 dp from
 * y 150. The overlay reads the camera ([IslandCamera]) in the layout / draw phase only.
 */

/** One door (§C `DoorUi`; named apart from the round-1 panel's `DoorUi` in DivinePanel.kt). */
@Immutable data class DivineDoorUi(
    val door: DivineDoor,
    /** "SOLO TRIALS" / "CITADELS". */
    val title: String,
    /** OPEN green / LOCKED stone; null draws none. */
    val stateTag: MapTagUi?,
    /** "2 of 3 tries left this week"; "…" while loading; null draws none. */
    val stateLine: String?,
    val locked: Boolean,
    /** The locked door's reason tag ("JOIN A CLAN", "Opens later on this server"). */
    val reason: String?,
    /** The door's 32 dp site art on its label ("site:divine-solo-active", "site:divine-clan-occupied"). */
    val icon: String = if (door == DivineDoor.WEST) "site:divine-solo-active" else "site:divine-clan-occupied",
)

/** Everything the Divine Isle overlay draws (§C `DivineSceneUi`; fields after `load` were added with defaults). */
@Immutable data class DivineSceneUi(
    /** 0 or 1 (§C: pinch snaps to a level in 220 ms; the scene owns it). */
    val zoom: Int,
    /** The selected door (see [divineSelectedDoor]); null = none. */
    val selected: DivineDoor?,
    val west: DivineDoorUi,
    val east: DivineDoorUi,
    /** "3d 4h"; null reads "…". */
    val countdown: String?,
    /** The selected door's commands (≤ 4, primary last; INFO only while the feature is off). */
    val commands: CommandBarUi,
    /** Fragments waiting (the FRAGMENTS badge, [fragmentsBadge]); the mapper puts it on the command. */
    val fragmentsWaiting: Int?,
    /** "Tap a door to choose" (first 3 visits only). */
    val hint: Boolean,
    /** Loading: art at once, plates "…"; Error: the "Can't reach the isle · RETRY" pill, the art stays. */
    val load: LoadState,
    /** The Home ResourceStack rows, unchanged. */
    val resources: List<ResourceChipUi> = emptyList(),
    val title: String = "DIVINE ISLE",
    val subtitle: String = "Trials west · citadels east",
    val countdownLabel: String = "Trial week ends",
    /** Door anchors in art px of `divine-isle.webp` (§C). */
    val westAt: IslandPoint = DIVINE_WEST_ANCHOR,
    val eastAt: IslandPoint = DIVINE_EAST_ANCHOR,
    /** A Seal shows: the stack is readable, not tappable. */
    val sealShown: Boolean = false,
)

/** Divine Isle overlay callbacks (§C). Pan / pinch are the scene's own gestures (not routed through the overlay). */
@Immutable data class DivineSceneActions(
    /** BACK "MAP": the globe with the isle still selected. */
    val onBack: () -> Unit = {},
    /** A door (from the scene's tap via [divineTap], or a screen reader's click on a plate). */
    val onDoor: (DivineDoor) -> Unit = {},
    /** A command of the bar (route with `commandRoute`; locked CITADELS → toast "Join a clan at the Clan Hall" + GO). */
    val onCommand: (FeatureId) -> Unit = {},
    /** +1 / −1. */
    val onZoom: (Int) -> Unit = {},
    val onResourceRow: (FeatureId) -> Unit = {},
    val onRetry: () -> Unit = {},
)

/** The isle scene's tap → door (the plates are paint; the scene's tap handler calls this). */
fun divineTap(ui: DivineSceneUi, camera: IslandCamera, density: Float, tapXPx: Float, tapYPx: Float): DivineDoor? =
    pickDivineDoor(camera, density, tapXPx, tapYPx, ui.westAt, ui.eastAt)

/**
 * The Divine Isle overlay (§C).
 *
 * Pointer rule: the root and the door layer are plain full-screen boxes with NO clickable, pointerInput, draggable or
 * scrim. The diamond, plates and labels are PAINT ONLY (each carries a screen-reader click action, which takes no pointer
 * hits), so a pan or pinch that starts on a door still reaches the isle scene below; the scene's tap calls [divineTap]
 * (≥ 96 dp around each door). Only BACK, the ResourceStack, zoom, the RETRY pill and the command faces take touches.
 */
@Composable fun DivineSceneOverlay(ui: DivineSceneUi, on: DivineSceneActions, camera: () -> IslandCamera, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current || LocalInspectionMode.current
    Box(modifier.fillMaxSize()) {
        DoorLayer(ui, on, camera, reduced)
        Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            MapTopBar(ui.title, ui.subtitle, back = true, onBackOrHome = on.onBack, homeIcon = "", onSearch = null,
                resources = ui.resources, onResourceRow = on.onResourceRow, sealShown = ui.sealShown)
            Column(Modifier.padding(start = 8.dp, top = 76.dp).widthIn(max = 288.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                IsleCountdown(ui.countdownLabel, ui.countdown)
                if (ui.load is LoadState.Error) MapPill(MapPillUi("retry", "Can't reach the isle", "RETRY"), { on.onRetry() })
            }
            Row(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(start = 8.dp, end = 8.dp, bottom = 160.dp),
                verticalAlignment = Alignment.Top) {
                Spacer(Modifier.weight(1f))
                if (ui.hint) Plate(PlateKind.VEIL, Modifier.padding(top = 4.dp), blocksScene = false) {
                    PkwText("Tap a door to choose", PkwTokens.Type.body, color = PkwTokens.Colors.text)
                }
                Spacer(Modifier.weight(1f))
                ThumbColumn(onZoom = on.onZoom, onMe = {}, me = false)
            }
        }
        CommandBar(ui.commands, on.onCommand, Modifier.fillMaxSize())
    }
}

/** The CountdownChip (veil 280 × 34, timer 24, VT 20 label, PS 12 gold-hi time on the right). Paint only. */
@Composable private fun IsleCountdown(label: String, time: String?) {
    val t = time?.takeIf { it.isNotBlank() } ?: UNKNOWN
    Plate(PlateKind.VEIL, Modifier.widthIn(min = 280.dp).heightIn(min = 34.dp).clearAndSetSemantics { contentDescription = "$label $t" },
        contentPadding = PaddingValues(start = 6.dp, top = 2.dp, end = 10.dp, bottom = 2.dp), blocksScene = false) {
        Row(Modifier.fillMaxWidth().align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwIcon("timer", 24.dp)
            PkwText(label, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.text, outline = 1.dp)
            PkwText(t, PkwTokens.Type.label, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
        }
    }
}

/** Places a piece so its pivot ([px], [py] of its own size) sits on an art point through the camera, plus [dyDp]. */
private fun Modifier.divineAt(p: IslandPoint, camera: () -> IslandCamera, px: Float, py: Float, dyDp: Float = 0f): Modifier =
    layout { measurable, constraints ->
        val placeable = measurable.measure(constraints.copy(minWidth = 0, minHeight = 0))
        layout(placeable.width, placeable.height) {
            val c = camera()
            placeable.place((c.screenX(p.x) - placeable.width * px).roundToInt(),
                (c.screenY(p.y) - placeable.height * py + dyDp.dp.toPx()).roundToInt())
        }
    }

@Composable private fun DoorLayer(ui: DivineSceneUi, on: DivineSceneActions, camera: () -> IslandCamera, reduced: Boolean) {
    val loading = ui.load == LoadState.Loading
    Box(Modifier.fillMaxSize()) {
        listOf(ui.west to ui.westAt, ui.east to ui.eastAt).forEach { (door, at) ->
            val selected = ui.selected == door.door
            val sel by animateFloatAsState(if (selected) 1f else 0f,
                tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else if (selected) PkwTokens.Motion.SELECT else DIVINE_DESELECT_MS,
                    easing = PkwTokens.Motion.Out), label = "door${door.door}")
            // The diamond grows from 0.9 and fades in (140 ms `out`); paint only.
            if (sel > 0f) Canvas(Modifier.divineAt(at, camera, 0.5f, 0.5f).size(136.dp, 68.dp).graphicsLayer {
                alpha = sel; val s = if (reduced) 1f else 0.9f + 0.1f * sel; scaleX = s; scaleY = s
            }) { drawDoorDiamond() }
            // EAST hangs below the citadel with its stem up; WEST stands above the temple with its stem down (critic fix).
            val below = door.door == DivineDoor.EAST
            DoorPlate(door, selected, loading, below, sel, reduced,
                Modifier.divineAt(at, camera, 0.5f, if (below) 0f else 1f, if (below) 40f else -40f)) { on.onDoor(door.door) }
        }
    }
}

/** The selected door's diamond: ink 8, gold-hi 3, 10 % gold fill, dashed gold-hi inner line. */
private fun DrawScope.drawDoorDiamond() {
    fun diamond(inset: Float) = Path().apply {
        val cx = size.width / 2f; val cy = size.height / 2f
        val hw = size.width / 2f - inset; val hh = size.height / 2f - inset / 2f
        moveTo(cx, cy - hh); lineTo(cx + hw, cy); lineTo(cx, cy + hh); lineTo(cx - hw, cy); close()
    }
    val ink = 8.dp.toPx(); val gold = 3.dp.toPx()
    drawPath(diamond(ink), PkwTokens.Colors.gold.face.copy(alpha = 0.10f))
    drawPath(diamond(ink / 2f), PkwTokens.Colors.ink, style = Stroke(ink))
    drawPath(diamond(ink / 2f), PkwTokens.Colors.gold.hi, style = Stroke(gold))
    drawPath(diamond(ink * 2.5f), PkwTokens.Colors.gold.hi.copy(alpha = 0.6f),
        style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 4.dp.toPx()))))
}

/**
 * A door's plate. Selected: charcoal plate, PS 13 gold-hi name + its state tag, VT 20 state line; it drops 8 dp and
 * fades in (160 ms). Not selected: the label (site icon 32, PS 11 name, padlock when locked) with the reason tag inside.
 * A 4 dp ink stem joins it to the door. Paint only (a screen-reader click selects the door).
 */
@Composable private fun DoorPlate(ui: DivineDoorUi, selected: Boolean, loading: Boolean, below: Boolean, sel: Float, reduced: Boolean,
    modifier: Modifier, onSelect: () -> Unit) {
    val line = if (loading) UNKNOWN else ui.stateLine
    val said = listOfNotNull(ui.title, ui.stateTag?.text, line, ui.reason?.takeIf { ui.locked }?.let { "Locked. $it" }).joinToString(". ")
    Column(modifier.clearAndSetSemantics {
        contentDescription = said; role = Role.Button; this.selected = selected
        this.onClick(label = "Choose this door", action = { onSelect(); true })
    }.graphicsLayer {
        // The selected plate drops 8 dp into place and fades in; the plain label never moves.
        if (selected) {
            alpha = sel
            if (!reduced) translationY = -DIVINE_PLATE_DROP_DP.dp.toPx() * (1f - sel)
        }
    }, horizontalAlignment = Alignment.CenterHorizontally) {
        if (below) Stem()
        Plate(PlateKind.CHARCOAL, Modifier.widthIn(min = 160.dp, max = 300.dp), blocksScene = false) {
            if (selected) Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText(ui.title, PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                    ui.stateTag?.let { Tag(it.text, it.verb) }
                }
                line?.let { PkwText(it, PkwTokens.Type.body, color = PkwTokens.Colors.text, maxLines = 2) }
            } else Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    MapIcon(ui.icon, 32.dp, alpha = if (ui.locked) 0.6f else 1f)
                    PkwText(ui.title, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
                    if (ui.locked) PkwIcon("shape:lock", 24.dp, tint = PkwTokens.Colors.gold.face)
                }
                val reason = ui.reason
                if (ui.locked && reason != null) Tag(reason, Verb.STONE)
                else line?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.muted, maxLines = 2) }
            }
        }
        if (!below) Stem()
    }
}

@Composable private fun Stem() { Box(Modifier.size(4.dp, 28.dp).background(PkwTokens.Colors.ink)) }

// ---- Previews (divine-scene.png numbers; every number is a placeholder) ----

private val previewWest = DivineDoorUi(DivineDoor.WEST, "SOLO TRIALS", MapTagUi("OPEN", Verb.GREEN), "2 of 3 tries left this week", false, null)
private val previewEast = DivineDoorUi(DivineDoor.EAST, "CITADELS", MapTagUi("LOCKED", Verb.STONE), "Clan areas", true, "JOIN A CLAN")

private fun cmd(id: String, icon: String, caption: String, primary: Boolean = false, verb: Verb = Verb.STONE, state: CommandState = CommandState.ENABLED,
    badge: BadgeUi? = null, reason: String? = null) = CommandUi(FeatureId(id), icon, caption, null, primary, state, reason, badge, verb = verb)

private val previewCommands = CommandBarUi("divine-west", listOf(
    cmd("island.divine.info", "info", "INFO", verb = Verb.BLUE),
    cmd("island.divine.fragments", "ui:crystal-fragments", "FRAGMENTS", badge = fragmentsBadge(12)),
    cmd("island.divine.trials", "trophy", "TRIALS", primary = true, badge = BadgeUi("!", BadgeTone.READY, "A try is available")),
))

private val previewScene = DivineSceneUi(0, DivineDoor.WEST, previewWest, previewEast, "3d 4h", previewCommands, 12, hint = true, LoadState.Ready,
    resources = PREVIEW_RESOURCES)

@Composable private fun IsleBackdrop(content: @Composable () -> Unit) { Box(Modifier.fillMaxSize().background(MapColors.stage)) { content() } }

@Preview(name = "Divine Isle scene, WEST selected (divine-scene)", widthDp = 412, heightDp = 915)
@Composable private fun DivineScenePreview() {
    IsleBackdrop { DivineSceneOverlay(previewScene, DivineSceneActions(), camera = { IslandCamera(1f / 2.625f, -50f, 394f) }) }
}

@Preview(name = "Divine Isle scene, EAST without a clan (locked CITADELS)", widthDp = 412, heightDp = 915)
@Composable private fun DivineSceneEastPreview() {
    IsleBackdrop {
        DivineSceneOverlay(previewScene.copy(selected = DivineDoor.EAST, hint = false, commands = CommandBarUi("divine-east", listOf(
            cmd("island.divine.info", "info", "INFO", verb = Verb.BLUE),
            cmd("island.divine.citadels", "itm_banner", "CITADELS", primary = true, state = CommandState.LOCKED, reason = "Join a clan at the Clan Hall")))),
            DivineSceneActions(), camera = { IslandCamera(1f / 2.625f, -50f, 394f) })
    }
}

@Preview(name = "Divine Isle scene: loading, error, nothing selected", widthDp = 412, heightDp = 915)
@Composable private fun DivineSceneStatesPreview() {
    IsleBackdrop {
        DivineSceneOverlay(previewScene.copy(selected = null, countdown = null, load = LoadState.Error("Can't reach the isle."),
            commands = CommandBarUi("divine", listOf(cmd("island.divine.info", "info", "INFO", verb = Verb.BLUE)))),
            DivineSceneActions(), camera = { IslandCamera(1f / 2.625f, -50f, 394f) })
    }
}

@Preview(name = "Divine Isle scene: feature off (both doors 'Opens later')", widthDp = 412, heightDp = 915)
@Composable private fun DivineSceneOffPreview() {
    val off = "Opens later on this server"
    IsleBackdrop {
        DivineSceneOverlay(previewScene.copy(selected = null, hint = false,
            west = previewWest.copy(stateTag = null, stateLine = null, locked = true, reason = off),
            east = previewEast.copy(stateTag = null, stateLine = null, reason = off),
            commands = CommandBarUi("divine", listOf(cmd("island.divine.info", "info", "INFO", verb = Verb.BLUE)))),
            DivineSceneActions(), camera = { IslandCamera(1f / 2.625f, -50f, 394f) })
    }
}

@Preview(name = "Door plates on parchment-free stage (sizes)", widthDp = 412, heightDp = 300)
@Composable private fun DoorPlatesPreview() {
    Row(Modifier.background(MapColors.stage).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        DoorPlate(previewWest, true, false, false, 1f, true, Modifier.width(200.dp)) {}
        DoorPlate(previewEast, false, false, true, 0f, true, Modifier.width(190.dp)) {}
    }
}
