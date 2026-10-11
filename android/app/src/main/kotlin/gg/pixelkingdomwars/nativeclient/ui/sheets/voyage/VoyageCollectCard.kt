package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay
import kotlin.math.cos
import kotlin.math.sin

/**
 * Design component: the expedition collect moment (design/final/voyage/collect.png, SPEC §5b): a 352 dp wood card over a
 * 60 % scrim with the ray panel (EXPEDITION BACK, "Vehicle · Island", the island cutout, the vehicle at k 4), one reward
 * row per resource with its gold ribbon, "Added to your stores.", and OK + SEND AGAIN. It plays ONLY after the server's
 * return receipt ([CollectUi.receiptId] is required). Several trips merge into one card ("3 trips back"); a vehicle that is
 * now worn out swaps SEND AGAIN for a blue GO TO BERTH with "The Cutter needs service".
 *
 * Motion: rays turn 8°/s, rows stagger 60 ms, exit 120 ms (the host's); OK auto-fires after 4 s without input. Reduced
 * motion: no rays turning, no stagger. The reward fly-to-caret and the `pe_fx_return` burst are host / scene work (see
 * MOUNT-VOYAGE.md); [CollectGainPip] is the gain pip the host mounts under the HUD stack.
 *
 * Pointer rule: this is a modal full card, so its root carries the kit [ModalScrim] (60 %) — composed only while the card
 * is shown (the host passes a non-null [CollectUi] only then); a tap on the scrim is OK (never SEND AGAIN). The card is a
 * painted panel; only OK and SEND AGAIN / GO TO BERTH take touches.
 */
@Immutable data class CollectUi(
    /** The trips this receipt returned (the first one's art fills the ray panel). */
    val trips: List<TripUi>,
    /** Rewards merged per resource by the mapper (cargo first, then survey finds). */
    val rewards: List<RewardUi>,
    /** The first trip's vehicle after the return (worn out → GO TO BERTH). */
    val vehicleAfter: VehicleUi,
    /** Added, required: the server's return receipt id. Nothing celebrates without one. */
    val receiptId: String,
)

/** The collect card's callbacks (SPEC §5b). */
@Immutable data class CollectActions(
    /** OK, a scrim tap, or 4 s without input. */
    val onOk: () -> Unit = {},
    /** SEND AGAIN → Lodge › SEND with the same route + vehicle. */
    val onSendAgain: () -> Unit = {},
    /** GO TO BERTH (the vehicle is worn out) → Berth › SERVICE. */
    val onGoBerth: () -> Unit = {},
)

/** SPEC §5b: OK fires by itself after 4 s without input. */
private const val COLLECT_AUTO_OK_MS = 4_000L
/** SPEC §5b: reward rows stagger 60 ms. */
private const val ROW_STAGGER_MS = 60
/** collect.png / SPEC §5b: the card's top on the 412 × 915 phone and its height (WoodFrame 352 × 440). */
private val COLLECT_CARD_TOP = 276.dp
private val COLLECT_CARD_HEIGHT = 440.dp

/** The collect card. Pass it only while it is shown (with a receipt); the host animates it out.
 *  Pointer rule: the root's 60 % ModalScrim exists only while this modal card is composed; a scrim tap is OK. */
@Composable fun VoyageCollectCard(ui: CollectUi, on: CollectActions, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    val ok by rememberUpdatedState(on.onOk)
    LaunchedEffect(ui.receiptId) { delay(COLLECT_AUTO_OK_MS); ok() }
    val first = ui.trips.firstOrNull()
    val worn = isWornOut(ui.vehicleAfter)
    BoxWithConstraints(modifier.fillMaxSize()) {
        // collect.png: the 352 × 440 card sits centred x at top 276 when the screen has room; a shorter screen centres it.
        val tall = maxHeight >= COLLECT_CARD_TOP + COLLECT_CARD_HEIGHT
        ModalScrim(PkwTokens.Scrim.FULL_CARD, onTap = { ok() })
        Plate(PlateKind.WOOD, Modifier.align(if (tall) Alignment.TopCenter else Alignment.Center)
            .padding(top = if (tall) COLLECT_CARD_TOP else 0.dp)
            .padding(horizontal = 30.dp).widthIn(max = 352.dp).fillMaxWidth()
            .semantics { paneTitle = "Expedition back"; liveRegion = LiveRegionMode.Polite }) {
            Column(Modifier.fillMaxWidth()) {
                RayPanel(ui, first)
                Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                    Column(Modifier.fillMaxWidth().padding(4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        ui.rewards.forEachIndexed { i, r -> RewardRow(r, i) }
                        PkwText("Added to your stores.", PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, textAlign = TextAlign.Center)
                        if (worn) PkwText("The ${familyShortName(ui.vehicleAfter.family)} needs service", PkwTokens.Type.small, Modifier.fillMaxWidth(),
                            color = c.danger, textAlign = TextAlign.Center)
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            SecondaryButton("OK", { ok() }, Modifier.width(100.dp).heightIn(min = 56.dp))
                            if (worn) PrimaryButton("GO TO BERTH", on.onGoBerth, Modifier.weight(1f), verb = Verb.BLUE)
                            // A starter trip has no island: its SEND AGAIN repeats the same coast route.
                            else PrimaryButton("SEND AGAIN", on.onSendAgain, Modifier.weight(1f), sub = if (first?.route == null) "same route" else "same island")
                        }
                    }
                }
            }
        }
    }
}

/** The 244 dp ray panel: dark ground, stepped gold rays turning 8°/s, title, line, island cutout, vehicle at k 4. */
@Composable private fun RayPanel(ui: CollectUi, first: TripUi?) {
    val c = PkwTokens.Colors
    val still = LocalReducedMotion.current || LocalInspectionMode.current
    val spin = if (still) null else rememberInfiniteTransition(label = "rays").animateFloat(0f, 360f,
        infiniteRepeatable(tween((360f / PkwTokens.Motion.RAYS_DEG_PER_S * 1000).toInt(), easing = LinearEasing), RepeatMode.Restart), label = "spin")
    val line = when {
        ui.trips.size > 1 -> "${ui.trips.size} trips back"
        first != null -> "${familyName(first.vehicle.family)} · ${first.title.ifBlank { UNKNOWN }}"
        else -> UNKNOWN
    }
    // The 18 ray wedges are one path built once per size (drawWithCache); each frame only rotates it. Before, every frame
    // of the 8°/s spin allocated 18 Paths and 36 trig calls.
    val rayColour = c.gold.hi.copy(alpha = 0.20f)
    Box(Modifier.fillMaxWidth().height(244.dp).clipToBounds().background(RAY_GROUND).drawWithCache {
        val centre = Offset(size.width / 2f, size.height * 0.6f)
        val r = maxOf(size.width, size.height) * 1.2f
        val rays = Path().apply {
            for (k in 0 until 36 step 2) {
                val a0 = Math.toRadians((k * 10).toDouble()); val a1 = Math.toRadians((k * 10 + 10).toDouble())
                moveTo(centre.x, centre.y)
                lineTo(centre.x + (r * cos(a0)).toFloat(), centre.y + (r * sin(a0)).toFloat())
                lineTo(centre.x + (r * cos(a1)).toFloat(), centre.y + (r * sin(a1)).toFloat())
                close()
            }
        }
        onDrawBehind { rotate(spin?.value ?: 0f, centre) { drawPath(rays, rayColour) } }
    }) {
        Column(Modifier.align(Alignment.TopCenter).padding(top = 10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            PkwText("EXPEDITION BACK", PkwTokens.Type.title, color = c.gold.hi, outline = 2.dp)
            PkwText(line, PkwTokens.Type.body, color = c.text, outline = 1.dp)
        }
        first?.route?.let { LocalVoyageArt.current.routeCutout(it, Modifier.align(Alignment.BottomCenter).offset(x = 24.dp, y = (-8).dp).size(160.dp)) }
        first?.let { VehicleSprite(it.vehicle.family, it.vehicle.tier, 4, Modifier.align(Alignment.BottomStart).offset(x = 40.dp, y = (-10).dp).size(128.dp, 120.dp)) }
    }
}

/** The ray panel's ground (SPEC §5b `#1A120E`). */
private val RAY_GROUND = Color(0xFF1A120E)

/** One reward row (IngredientRow geometry, 48 tall): icon 32, name + kind, the gold ribbon with "+n". Staggers in. */
@Composable private fun RewardRow(r: RewardUi, index: Int) {
    val c = PkwTokens.Colors
    val still = LocalReducedMotion.current || LocalInspectionMode.current
    val shown = remember(r.resourceId) { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(r.resourceId) {
        if (!still) { delay((index * ROW_STAGGER_MS).toLong()); shown.animateTo(1f, tween(PkwTokens.Motion.RIBBON_DROP, easing = PkwTokens.Motion.Out)) }
    }
    VoyageRow(Modifier.graphicsLayer { alpha = shown.value; translationY = (1f - shown.value) * -8.dp.toPx() }, minHeight = 48.dp,
        description = "${r.name}, ${if (r.kind == RewardUi.Kind.CARGO) "cargo" else "survey find"}, plus ${r.quantity}") {
        VoyageIcon(r.icon, 32.dp, Modifier.padding(start = 6.dp))
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PkwText(r.name.ifBlank { UNKNOWN }, PkwTokens.Type.body, Modifier.weight(1f, fill = false), color = c.textOnParch)
            PkwText(if (r.kind == RewardUi.Kind.CARGO) "cargo" else "survey find", PkwTokens.Type.small, color = c.textOnParch2)
        }
        Plate(PlateKind.VEIL, Modifier.padding(end = 6.dp).heightIn(min = 30.dp), tint = c.gold.face, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
            blocksScene = false) {
            PkwText("+${r.quantity}", PkwTokens.Type.label, Modifier.align(Alignment.Center), color = c.label, outline = 1.dp)
        }
    }
}

/**
 * The gain pip under the HUD resource stack (SPEC §5b fly-to): a veil chip with each reward's icon and green "+n",
 * rising 12 dp over 450 ms then fading. The raw resources have no Home readout, so this (with the caret pulse the HUD owns)
 * is where they visibly land. Paint only; the host mounts it under the stack while the card plays.
 */
@Composable fun CollectGainPip(rewards: List<RewardUi>, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    val still = LocalReducedMotion.current || LocalInspectionMode.current
    val t = remember(rewards) { Animatable(0f) }
    LaunchedEffect(rewards) {
        if (!still) t.animateTo(1f, tween(PkwTokens.Motion.GAIN_RISE, easing = PkwTokens.Motion.Out))
    }
    Plate(PlateKind.VEIL, modifier.graphicsLayer {
        translationY = -PkwTokens.Motion.GAIN_RISE_DP * density * t.value
        alpha = if (still) 1f else 1f - 0.8f * t.value
    }, blocksScene = false, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            rewards.take(3).forEach { r ->
                VoyageIcon(r.icon, 32.dp, contentDescription = r.name)
                PkwText("+${r.quantity}", PkwTokens.Type.label, color = c.green.hi, outline = 1.dp)
            }
        }
    }
}

private val sampleCollect = CollectUi(
    trips = listOf(TripUi("t-glass", previewCutter, previewRoutes()[1], null, 1f, null, TripState.COLLECTED,
        emptyList(), null)),
    rewards = listOf(RewardUi("heartwood_logs", "108", RewardUi.Kind.CARGO, "voyage:heartwood-logs", "Heartwood Logs"),
        RewardUi("rough_prism", "2", RewardUi.Kind.SURVEY_FIND, "voyage:rough-prism", "Rough Prism")),
    vehicleAfter = previewCutter.copy(tripsLeft = 6), receiptId = "rcpt-preview")

@Preview(name = "Collect moment (collect.png)", widthDp = 412, heightDp = 915)
@Composable private fun VoyageCollectPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        CollectGainPip(sampleCollect.rewards, Modifier.align(Alignment.TopEnd).padding(top = 128.dp, end = 8.dp))
        VoyageCollectCard(sampleCollect, CollectActions())
    }
}

@Preview(name = "Collect moment, several trips + vehicle worn out", widthDp = 412, heightDp = 915)
@Composable private fun VoyageCollectWornPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        VoyageCollectCard(sampleCollect.copy(trips = sampleCollect.trips + sampleCollect.trips + sampleCollect.trips,
            vehicleAfter = previewCutter.copy(tripsLeft = 0, status = VehicleStatus.WORN_OUT)), CollectActions())
    }
}
