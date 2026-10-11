package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldEngine
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrame
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrameExchange
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldTarget

/**
 * The UI-thread link between the Compose world HUD (this lane) and the GL30 world surface (globe + realm map engines).
 * The HUD creates one per World entry and hands it to the surface; the surface fills the engine side. Everything here is
 * read and written on the UI thread only, except [exchange], which is the engines' own lock-free triple buffer.
 *
 * GL → UI:
 *  - per frame: the surface publishes a [WorldFrame] into [exchange] and bumps [frameTick] once per presented frame (the
 *    ArmyChipLayer pattern: the HUD reads the frame only inside `Modifier.layout` placement lambdas, so a pan costs no
 *    recomposition). Anchors are in VIEW px; the realm camera is the engine's deed space (see [realmGrid]).
 *  - discrete: [emit] a [WorldHudEvent] (epoch-guarded by the surface, conflated where the event says so).
 * UI → GL: [controls] (the intent queue plus the few commands `WorldIntent` has no shape for).
 */
class WorldHudBridge {
    /** Set by the surface once its engines exist; null while none is mounted (the HUD then only lays itself out). */
    var controls: WorldEngineControls? = null
    /** The engines' frame buffer; read with [WorldFrameExchange.latest] inside layout lambdas only. */
    var exchange: WorldFrameExchange? = null
    /** Advanced once per published frame; a layout lambda reads it to be re-run for the next frame. */
    val frameTick = mutableLongStateOf(0L)
    /** The engine's dpr: render-target px per dp (`InputScale.dpr`, capped at 2). The realm camera's d ÷ dpr = s. */
    var dpr by mutableFloatStateOf(2f)
    var ready by mutableStateOf(false)
    /** 0..1 while the surface prepares its first frame (content verification, programs), null when unknown. */
    var loading by mutableStateOf<Float?>(null)
    var failure by mutableStateOf<String?>(null)
    /** Realms whose overview map can be entered now (the realm-map engine's `has(id)`). */
    var mapRealms by mutableStateOf<Set<String>>(emptySet())
    /** The open realm's deed grid in catalog columns/rows (x0 may be negative: Cinderfall wraps the dateline). */
    var realmGrid by mutableStateOf<RealmGridInfo?>(null)
    /** Dive readiness of the realm whose panel is open (FAR programs rehearsed, chart resident): 0..1, 1 = ready. */
    var diveReadiness by mutableStateOf<Pair<String, Float>?>(null)
    /** The open realm map's band readiness cue (NM `RealmMapListener.onGate`, web ui.js W1 S2): while the zoom waits at a
     *  band gate, the scale pill adds "detail N%". Null while no gate holds. The host posts it on the UI thread. */
    var bandGate by mutableStateOf<BandGateCue?>(null)
    /** Realms whose detailed MAP/TRUE pack is `ready` (N3), or null while the host does not say: MY PARCEL and "My base"
     *  then ask for TRUE and the engine clamps to what the realm has. A realm outside a known set falls back to the MAP
     *  select distance with the deed selected (F7). */
    var detailRealms by mutableStateOf<Set<String>?>(null)

    /** Globe framing (main.js `homeFrame`/`updateLens`): the header's bottom edge, the HUD obstacles and, with a panel
     *  open, the free rect the camera centres a selection in. VIEW px; the surface converts with its `InputScale`. */
    var globeLayout by mutableStateOf<GlobeHudLayout?>(null)
    /** ui.js `focusOffset()` in dp: where the realm camera centre sits from a selected base so the base shows beside or
     *  above the open card (the engine divides by its s at arrival, as map.js `select` does). (0, 0) with no card. */
    var realmFocusOffset by mutableStateOf(0f to 0f)

    private var listener: ((WorldHudEvent) -> Unit)? = null
    fun listen(block: ((WorldHudEvent) -> Unit)?) { listener = block }
    /** Surface → HUD, UI thread. */
    fun emit(event: WorldHudEvent) { listener?.invoke(event) }
    fun offer(intent: WorldIntent) { controls?.offer(intent) }
    /** Surface: call on the UI thread after [WorldFrameExchange.publish] (conflate to one per vsync). */
    fun framePublished() { frameTick.longValue++ }
    fun latestFrame(): WorldFrame? = exchange?.latest()?.takeIf { it.sequence > 0 }
}

/** [obstacles] are (x, y, w, h) quadruples; [panelFree] is (x, y, w, h) or null with no panel open. */
class GlobeHudLayout(val headerBottom: Float, val obstacles: FloatArray, val count: Int, val panelFree: FloatArray?)

/** A held band gate: [band] 1 = MAP, 2 = TRUE; [progress] 0..1 of that band's rehearsal. */
data class BandGateCue(val held: Boolean, val band: Int, val progress: Double) {
    /** ui.js: `detail ${min(99, floor(progress × 100))}%` while held, else nothing. */
    val label: String? get() = if (!held) null else "detail ${kotlin.math.min(99, kotlin.math.floor(progress.coerceIn(0.0, 1.0) * 100).toInt())}%"
}

/** The open realm's placement in the catalog grid (loader.js `realm.json` grid: x0, y0, cols, rows). */
data class RealmGridInfo(val realmId: String, val x0: Int, val y0: Int, val cols: Int, val rows: Int)

/** UI → GL beyond the intent queue. Implemented by the world surface (NA/NG/NM). */
interface WorldEngineControls {
    fun offer(intent: WorldIntent)
    /** Globe: `cam.zT ± 0.12` per step (main.js tools). Realm: `d × 2.2^steps` over 380 ms around the centre (map.js zoomBy). */
    fun zoom(steps: Int)
    /** Globe "WORLD": deselect and fly to the home frame (main.js `applyHome`). */
    fun home()
    /** A realm-map minimap gesture in minimap-local VIEW px (ui.js hit-div rules: the engine owns toDeed/inBox/freeze). */
    fun minimap(gesture: MinimapGesture)
    /** Where GL draws the minimap, in VIEW px (x, y, w, h), inside the Compose frame; null while it is folded or hidden. */
    fun minimapRect(viewRect: FloatArray?)
    /** OPEN BASE on your own deed (the enter-base seam, D-162.3): fly the realm map to catalog deed ([catalogX],
     *  [catalogY])'s kingdom at the base scene's opening scale, then answer [WorldHudEvent.BaseSeam]. [seam] carries the
     *  catalogue numbers the host's realm numbers lack. */
    fun enterBase(catalogX: Int, catalogY: Int, seam: BaseSeamSpec)
    /** The HUD dropped its OPEN BASE (Back while the seam waits): the wait ends and nothing answers it, since an answer
     *  could match a newer OPEN BASE on the same deed. */
    fun cancelBase()
    /** A new engine under a HUD that the app stopped on a realm map ([WorldHudFlow.engineMounted]): dive straight into
     *  [RealmResume.realmId] and land on that camera. Answered as any dive ([WorldHudEvent.Dived]), or at once with
     *  [WorldHudEvent.DiveFailed] where no dive can start. */
    fun resume(target: RealmResume)
}

/** The enter-base seam's catalogue numbers: [kitConstants] is the constants JSON of the sections `RealmKitRules.read`
 *  needs (a few hundred bytes, never the whole catalogue), [worldTilePixels] the base scene's world tile
 *  (`presentation.tilePixels`) and [fitPadTiles] its claim fit's pad (`BASE_CAMERA.fitPadTiles`). */
class BaseSeamSpec(val kitConstants: String, val worldTilePixels: Double, val fitPadTiles: Double)

/** A base-scene camera: world px at the surface centre (y down) and libGDX zoom (world px per surface px), the
 *  `BaseCameraView` convention the Kingdom scene opens on (`SceneCameraControls.enterAt`). */
data class BaseEntryCamera(val worldX: Float, val worldY: Float, val zoom: Float)

sealed interface MinimapGesture {
    data class Tap(val x: Float, val y: Float) : MinimapGesture
    data object DoubleTap : MinimapGesture
    /** A drag starting at (x, y); the engine decides whether it grabbed the viewport box (inBox) and freezes its camera. */
    data class DragStart(val x: Float, val y: Float) : MinimapGesture
    data class DragTo(val x: Float, val y: Float) : MinimapGesture
    data object DragEnd : MinimapGesture
    data class Pinch(val scale: Float) : MinimapGesture
}

/** GL → UI discrete events (UI thread). */
sealed interface WorldHudEvent {
    /** A globe tap resolved to a realm, an island or nothing (sea/space). The engine never selects on its own; the HUD
     *  answers with Select + FlyTo, so rail taps and globe taps share one path. */
    data class GlobePick(val target: WorldTarget?) : WorldHudEvent
    /** The globe's selection changed (`GlobeEvents.selected`): a realm id, a Phase E island id, or neither. A tap on a
     *  Phase E island is reported by this alone (D-172): the HUD opens its island panel ([WorldHudFlow.globeSelected]). */
    data class GlobeSelected(val realmId: String?, val islandId: String?) : WorldHudEvent
    /** A realm-map tap: the deed under it in catalog columns/rows (null outside the grid) and the tap in view px. */
    data class RealmTap(val deedX: Int?, val deedY: Int?, val viewX: Float, val viewY: Float) : WorldHudEvent
    /** A dive into [realmId] began (Enter map, or a pinch-in past the globe's dive altitude): the globe's controls hide
     *  through the dive, as main.js `enterRealm` does with `rm-diving`. */
    data class Diving(val realmId: String) : WorldHudEvent
    /** The dive into [realmId] finished (the realm frame is up). */
    data class Dived(val realmId: String) : WorldHudEvent
    data class DiveFailed(val realmId: String, val message: String) : WorldHudEvent
    /** The realm map started to leave (◀ Globe, Back, or a pinch-out), before the first frame of the leave fade. The
     *  realm HUD hides at once, as map.js `exit` calls `ui.hide()` before `onExit`. Its minimap frame must never stand
     *  over the GL minimap while that fades out with the realm snapshot (the owner's "transparent minimap"). */
    data class Leaving(val realmId: String) : WorldHudEvent
    /** The realm map left (◀ Globe, Back, or a pinch below sMin·0.7) and the globe is back on [realmId]. */
    data class Left(val realmId: String) : WorldHudEvent
    /** A Leave reached the engine on the globe, with no realm map shown, fading or loading: there is nothing to leave, so
     *  no Leaving or Left will come. The HUD's leave completes at once ([WorldHudFlow.nothingToLeave]). */
    data object NothingToLeave : WorldHudEvent
    /** The globe camera was pushed past the painting floor over a place without a map (main.js `noMapHint`). */
    data class NoMap(val realmId: String?) : WorldHudEvent
    /** The globe's engine changed on its own (legacy fallback after a failed GL30 context, etc.). */
    data class EngineChanged(val engine: WorldEngine) : WorldHudEvent
    /** The answer to [WorldEngineControls.enterBase] for catalog deed ([catalogX], [catalogY]): the camera that continues
     *  the map's TRUE view of it in the base scene, or null when the map could not show it there (no TRUE ground, the
     *  wait bound): the HUD then opens the base at its own fit, as before the seam (F8). */
    data class BaseSeam(val catalogX: Int, val catalogY: Int, val camera: BaseEntryCamera?) : WorldHudEvent
    /** [WorldEngineControls.enterBase]'s wait for catalog deed ([catalogX], [catalogY]) was cancelled: a touch on the map
     *  (the first finger of D-173's pinch-out to the globe among them) or a HUD camera control took the camera. Nothing
     *  opens; OPEN BASE again starts a new seam. */
    data class BaseSeamCancelled(val catalogX: Int, val catalogY: Int) : WorldHudEvent
}
