package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.trayLabel
import gg.pixelkingdomwars.nativeclient.renderer.BaseCameraView
import gg.pixelkingdomwars.nativeclient.renderer.BaseScene
import gg.pixelkingdomwars.nativeclient.scene.BuildingRooflines
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.buildingSelectionAnchor
import gg.pixelkingdomwars.nativeclient.ui.kingdom.sheetBuildingPortrait
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildingMarkerActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildingMarkerLayer
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildingMarkerUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildingMarkersUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.MarkerKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import java.io.File

/*
 * Design component: the Home world's ready bubbles (DESIGN-SYSTEM §6 WorldBubble; buildings/SPEC §1.2 "Ready bubbles collect
 * in 1 tap without selecting"; home.png). BuildingMarkerLayer was only ever called from its preview; this feeds it from
 * the server's Home read and anchors it exactly as LiveConstructionWorldLayer anchors its timer plates (measured roof,
 * the drawn camera, nothing while the camera moves or the base is another one).
 * - The Mine: a green READY bubble while the server's `mine/status` buffer holds Shards (above zero; an unread status is
 *   unknown and shows nothing). One tap collects through the existing owner, without selecting.
 * - A spent trap: a cream NOTICE bubble wearing the REARM command's icon and a REARM caption; a tap selects it, where REARM lives.
 * A building with a running job carries its TimerPlate instead, so two markers never stack on one roof.
 */

/** One bubble the Home world may show: which building, READY (tap collects) or NOTICE (tap opens), its 32 dp icon, the
 *  amount for READY (spoken; the 48 dp bubble draws its icon only, as the frames do) and what a screen reader says. */
internal data class ReadyMarkerFact(val buildingId: String, val kind: MarkerKind, val icon: String, val text: String?, val description: String,
    val caption: String? = null)

/** The caption a spent trap's bubble wears: the name of the command its tap leads to. */
internal const val SPENT_TRAP_CAPTION = "REARM"

/** The bubbles for [state]'s own Home (see the file comment). None for another base: a base other than the selected
 *  one, or one the signed-in wallet does not own. */
internal fun liveReadyMarkers(state: KingdomUiState): List<ReadyMarkerFact> {
    val base = state.base ?: return emptyList()
    val selected = state.selectedBaseId
    if (selected != null && !selected.equals(base.baseId, ignoreCase = true)) return emptyList()
    val owner = base.player.wallet
    if (state.wallet != null && owner != null && owner != state.wallet) return emptyList()
    val working = base.jobs.mapNotNullTo(HashSet()) { it.buildingId }
    val markers = mutableListOf<ReadyMarkerFact>()
    val accrued = state.home.mine?.mining?.accrued
    val mine = base.buildings.firstOrNull { it.type == "mine" && !it.underConstruction && it.id !in working }
    if (mine != null && accrued?.toBigDecimalOrNull()?.signum() == 1) {
        val amount = fmtN(accrued)
        markers += ReadyMarkerFact(mine.id, MarkerKind.READY, "shards", "+$amount", "Mine: $amount Shards ready to collect")
    }
    base.buildings.filter { it.trapSpentAt != null && it.id !in working }.forEach { trap ->
        // Owner report 2026-10-11 (Seeker, code 34): the torn-sail `ui:exhausted-status` icon was taken for a Phase E boat. The
        // bubble now wears the REARM command's own icon (BuildingCommandAdapter.rearmCommand: the trap's tier art from the pack,
        // the hammer glyph before the catalogue arrives) and the REARM caption. No art is made.
        val icon = state.catalogue?.let { sheetBuildingPortrait(it, trap.type, trap.level) } ?: "shape:hammer"
        markers += ReadyMarkerFact(trap.id, MarkerKind.NOTICE, icon, null, "${titleCase(trayLabel(trap.type))}: spent, rearm it",
            caption = SPENT_TRAP_CAPTION)
    }
    return markers
}

/** [markers] anchored on the drawn camera: only buildings the scene holds and the camera shows, nothing while [hidden],
 *  while the camera moves or when it draws another base. BuildingMarkerLayer keeps the three nearest the centre. */
internal fun readyMarkersUi(markers: List<ReadyMarkerFact>, scene: BaseScene, roofs: Map<String, Float>, camera: BaseCameraView?,
    hidden: Boolean): BuildingMarkersUi {
    val view = camera?.takeIf { it.baseId == scene.baseId && scene.baseId != null && it.overlayVisible }
    if (hidden || view == null) return BuildingMarkersUi(emptyList(), visible = false)
    val placed = markers.distinctBy { it.buildingId }.mapNotNull { fact ->
        val building = scene.buildings.firstOrNull { it.id == fact.buildingId } ?: return@mapNotNull null
        val anchor = buildingSelectionAnchor(building, roofs[building.id], scene.baseId, scene.tilePixels, view)
            ?.takeIf { it.right > 0 && it.bottom > 0 && it.left < view.width && it.top < view.height } ?: return@mapNotNull null
        BuildingMarkerUi(fact.buildingId, anchor, fact.kind, fact.icon, fact.text, null, fact.description, fact.caption)
    }
    return BuildingMarkersUi(placed, visible = true)
}

/**
 * The ready-bubble layer over the Home kingdom: [markers] from [liveReadyMarkers], drawn by BuildingMarkerLayer (at most
 * three, nearest the centre; bouncing READY bubbles; reduced motion still). [hidden] is the caller's rule, the same one
 * the construction layer uses (a selection, placement, BUILD, the editor, a carry, another base). [onCollect] gets a
 * READY bubble's building id, [onOpen] a NOTICE bubble's. Pointer rule: BuildingMarkerLayer's root takes no touches; only
 * the 48 dp bubbles do.
 */
@Composable internal fun LiveReadyMarkerLayer(markers: List<ReadyMarkerFact>, scene: BaseScene, assets: File, render: JsonObject,
    camera: State<BaseCameraView?>, hidden: Boolean, onCollect: (String) -> Unit, onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    val buildings = scene.buildings.filter { b -> markers.any { it.buildingId == b.id } }
    // A changed base, render generation or moved building immediately drops its former roof observation.
    var roofs by remember(assets, render, scene.baseId, scene.tilePixels, buildings) { mutableStateOf(emptyMap<String, Float>()) }
    LaunchedEffect(assets, render, scene.baseId, scene.tilePixels, buildings) {
        roofs = withContext(Dispatchers.IO) { buildings.mapNotNull { b ->
            BuildingRooflines.measuredRoof(assets, render, b, scene.tilePixels)?.let { b.id to it }
        }.toMap() }
    }
    BuildingMarkerLayer(readyMarkersUi(markers, scene, roofs, camera.value, hidden), BuildingMarkerActions(onCollect, onOpen), modifier.fillMaxSize())
}
