package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import kotlin.math.roundToInt

/*
 * Design component: a building under construction on the world (design/final/buildings/SPEC.md R2.3,
 * world-construction.png; DS "not mocked" list): from Home, without selecting it, the lot reads "being built": the
 * construction sprite (the scene's: `pkw_ui_<building>_t<n>_construction`, `ware_bld_<type>_t<n>_build`), a builder at
 * 30 dp standing beside it, and a 114 × 34 TimerPlate 4 dp above the sprite's visible top with a GREEN-STRIPED meter
 * (construction), solid green in its last 10 s. It counts against the three world markers and hides while anything is
 * selected. The idle swap, gold ring flash and the herald "Workshop built" on the server event are the scene's / herald's.
 */

/** One construction site (SPEC R2.3 `TimerPlateUi(buildingId, builderIcon, timeLeft, progress, tone = STRIPE)`). */
@Immutable data class TimerPlateUi(
    /** The building's id: what [ConstructionActions.onSelect] hands back. */
    val buildingId: String,
    /** The builder icon on the plate (and the 30 dp builder beside the site): "builder". */
    val builderIcon: String,
    /** Formatted time left ("1h 12m"); "…" (or null) while unknown. The plate keeps the last time while loading. */
    val timeLeft: String?,
    /** 0..1 done; null = unknown (empty meter, never drawn as zero done). */
    val progress: Float?,
    /** STRIPE for construction; [constructionPlateLook] turns it SOLID in the last 10 s. */
    val tone: PlateTone = PlateTone.STRIPE,
    /** The sprite's visible bounds in screen px (the overlay root fills the screen); the plate sits 4 dp above its top. */
    val anchor: PxRect = PxRect(0f, 0f, 0f, 0f),
    /** Whole seconds left, for the "finishing within 10 s" rule ("9s", solid meter); null when unknown. */
    val secondsLeft: Long? = null,
    /** What a screen reader says ("Workshop: being built, 1 hour 12 minutes left"). */
    val description: String = "",
    /** The scene already walks its Builder Workman to this job (renderer `BaseScene.workmanJobs`): the still 30 dp builder
     *  beside the site is then NOT drawn, so the job shows one builder, never two. False keeps the still builder (a Phase E
     *  service build, which the scene draws no Workman for). */
    val workmanInScene: Boolean = false,
)

/** The construction layer's state. */
@Immutable data class ConstructionLayerUi(
    /** Candidate sites; at most three markers show in all (they share the budget with `BuildingMarkerLayer`: the mapper
     *  passes only the sites that won a place, nearest the camera first). */
    val sites: List<TimerPlateUi>,
    /** False while a building is selected, placement or the editor is open: nothing is drawn. */
    val visible: Boolean,
)

/** Construction callbacks. */
class ConstructionActions(
    /** A tap on the TimerPlate: the same as a tap on the sprite, select it → `states.png` row 1 (INFO · FINISH),
     *  NamePlate level "NEW". */
    val onSelect: (String) -> Unit,
)

/** The plate stands this far above the sprite's visible top (SPEC R2.3). */
private val PLATE_GAP = 4.dp
/** Transparent margin above and below the 34 dp plate, making a 48 dp touch target. */
private val HIT_MARGIN = 7.dp
/** The plate drops this far as it fades in when the job starts (SPEC R2.3 motion). */
private const val DROP_DP = 8f

/**
 * The construction-site layer over the Home kingdom.
 *
 * Pointer rule: this root is a full-size, transparent layout with NO clickable, pointerInput, draggable or scrim; the
 * builders beside the sites are paint only. Each TimerPlate is a small painted target (its 34 dp plate inside a 48 dp hit
 * box, a scene-input region) that selects its building; every other pixel falls through to the kingdom.
 */
@Composable fun ConstructionLayer(ui: ConstructionLayerUi, on: ConstructionActions, modifier: Modifier = Modifier) {
    if (!ui.visible || ui.sites.isEmpty()) return
    Box(modifier.fillMaxSize()) {
        ui.sites.take(MAX_WORLD_MARKERS).forEach { site ->
            key(site.buildingId) {
                // One builder per job: the scene's walking Workman when it has one, else this still one.
                if (!site.workmanInScene) SiteBuilder(site)
                ConstructionPlate(site, { on.onSelect(site.buildingId) })
            }
        }
    }
}

/** Places content with its bottom-centre [gapPx] above the anchor's top (hit-testing follows the drawn position). */
private fun Modifier.aboveAnchor(anchor: PxRect, gapPx: Float): Modifier = layout { measurable, _ ->
    val p = measurable.measure(Constraints())
    layout(p.width, p.height) { p.place((anchor.centerX - p.width / 2f).roundToInt(), (anchor.top - gapPx - p.height).roundToInt()) }
}

/** Places content standing on the anchor's floor just right of it (the builder beside the site). */
private fun Modifier.besideAnchor(anchor: PxRect): Modifier = layout { measurable, _ ->
    val p = measurable.measure(Constraints())
    layout(p.width, p.height) { p.place(anchor.right.roundToInt(), (anchor.bottom - p.height).roundToInt()) }
}

/** The builder at 30 dp beside the site (a still sprite: ART ASK for a hammering loop), only for a site the scene draws no
 *  Workman for ([TimerPlateUi.workmanInScene] false). Paint only, unannounced. */
@Composable private fun SiteBuilder(site: TimerPlateUi) {
    PkwIcon(site.builderIcon, 30.dp, Modifier.besideAnchor(site.anchor).clearAndSetSemantics { })
}

/**
 * The 114 × 34 TimerPlate (veil): builder 30, PS 11 time, an 8 dp meter (green stripes while building; solid in the last
 * 10 s). It drops 8 dp and fades in over 160 ms when it first appears (reduced motion: a 120 ms fade). One ≥ 48 dp target.
 *
 * Pointer rule: only this plate's own 48 dp box takes touches (a scene-input region); it is never full-screen, a scrim,
 * a pointerInput root or draggable.
 */
@Composable fun ConstructionPlate(site: TimerPlateUi, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val still = LocalReducedMotion.current || LocalInspectionMode.current
    val reduced = LocalReducedMotion.current
    val enter = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (!still) enter.animateTo(1f, tween(PkwTokens.Motion.PLATE_IN, easing = PkwTokens.Motion.Out))
    }
    val look = constructionPlateLook(site.secondsLeft, site.timeLeft)
    // The 34 dp plate sits in a 48 dp hit box: 7 dp transparent margin above and below (touch target rule), so the box
    // bottom is placed 7 dp lower than the plate's 4 dp gap.
    val gap = with(LocalDensity.current) { (PLATE_GAP - HIT_MARGIN).toPx() }
    Box(modifier.aboveAnchor(site.anchor, gap)
        .graphicsLayer { alpha = enter.value; translationY = if (reduced) 0f else -DROP_DP * density * (1f - enter.value) }
        .sceneInputRegion()
        .clearAndSetSemantics { contentDescription = site.description; role = Role.Button; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Button, onClick = onClick)
        .padding(vertical = HIT_MARGIN)) {
        Plate(PlateKind.VEIL, Modifier.size(PkwTokens.Dims.timerPlateW, PkwTokens.Dims.timerPlateH),
            contentPadding = PaddingValues(start = 2.dp, top = 2.dp, end = 5.dp, bottom = 2.dp), blocksScene = false) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                PkwIcon(site.builderIcon, 30.dp)
                Column(Modifier.weight(1f)) {
                    PkwText(look.text, PkwTokens.Type.caption, color = PkwTokens.Colors.text, outline = 1.dp)
                    JobBar(site.progress, striped = look.tone == PlateTone.STRIPE, height = 8.dp)
                }
            }
        }
    }
}

// ---- Previews (anchors come from the scene) ----

@Composable private fun previewAnchor(leftDp: Float, topDp: Float): PxRect {
    val d = LocalDensity.current.density
    return PxRect(leftDp * d, topDp * d, (leftDp + 84f) * d, (topDp + 84f) * d)
}

@Composable private fun ConstructionPreviewFrame(sites: List<TimerPlateUi>) {
    val density = LocalDensity.current
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        sites.forEach { s ->
            with(density) {
                Box(Modifier.offset(s.anchor.left.toDp(), s.anchor.top.toDp()).size(s.anchor.width.toDp(), s.anchor.height.toDp())) {
                    R2Art("ui:workshop-t2-construction", s.anchor.width.toDp(), s.anchor.height.toDp())
                }
            }
        }
        ConstructionLayer(ConstructionLayerUi(sites, visible = true), ConstructionActions(onSelect = {}))
    }
}

@Preview(name = "Under construction: building, finishing (9s), unknown time (world-construction.png)", widthDp = 412, heightDp = 520)
@Composable private fun ConstructionPreview() {
    ConstructionPreviewFrame(listOf(
        TimerPlateUi("workshop-2", "builder", "1h 12m", 0.4f, anchor = previewAnchor(40f, 300f), secondsLeft = 4_320,
            description = "Workshop: being built, 1 hour 12 minutes left"),
        TimerPlateUi("lodge-1", "builder", "9s", 0.97f, anchor = previewAnchor(250f, 160f), secondsLeft = 9,
            description = "Lodge: being built, 9 seconds left"),
        TimerPlateUi("market-1", "builder", null, null, anchor = previewAnchor(220f, 400f), description = "Market: being built, time unknown"),
    ))
}
