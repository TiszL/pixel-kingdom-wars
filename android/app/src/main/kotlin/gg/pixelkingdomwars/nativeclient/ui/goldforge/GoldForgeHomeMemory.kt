package gg.pixelkingdomwars.nativeclient.ui.goldforge

import androidx.compose.ui.graphics.ImageBitmap
import androidx.lifecycle.ViewModel
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteIdentity
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GoldForgeSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.HeroStatusKind
import java.io.File

/**
 * What the Home-mounted Gold Forge showed last, kept for the Home route (one per session through `graphViewModel`), so a
 * re-open draws the forge at once (design/final/goldforge SPEC §1 Motion: "Re-opening the sheet does not refetch if the
 * Home-scoped view model already has data. Values cross-fade when fresh data lands. The body never blanks.").
 *
 * Display only. It never grants an action: every SMELT / GEMS action still goes through its owner's own live state, the
 * CLAIM and LEGACY faces are read-only, and each kept value is replaced by the next settled read. It also keeps the
 * decoded foundry art for the content generation it was decoded from, so the 204 dp hero is not re-hashed and re-decoded
 * (eleven layers) on every open.
 */
internal class GoldForgeHomeMemory : ViewModel() {
    private var identity: HomeRouteIdentity? = null
    private var sheet: GoldForgeSheetUi? = null
    private var sceneDirectory: File? = null
    private var sceneManifest: Any? = null
    private var scene: Pair<Map<String, ImageBitmap>, Boolean>? = null

    /** The last settled sheet of [current] (same session, base and selection generation), or null. */
    fun sheetFor(current: HomeRouteIdentity): GoldForgeSheetUi? = sheet.takeIf { identity == current }

    /** Remembers a settled sheet (a finished read pass) for [current], without any Seal: a kept face never re-raises one. */
    fun keep(current: HomeRouteIdentity, settled: GoldForgeSheetUi) {
        identity = current
        sheet = settled.copy(smelt = null, claim = settled.claim?.copy(seal = null), gems = settled.gems?.copy(seal = null))
    }

    /** The decoded foundry for exactly this admitted content root and manifest object, or null. */
    fun sceneFor(directory: File?, manifest: Any?, ready: Boolean): Pair<Map<String, ImageBitmap>, Boolean>? =
        scene.takeIf { ready && directory != null && manifest != null && directory == sceneDirectory && manifest === sceneManifest }

    /** Keeps a complete decode only (a failed layer is tried again on the next open). */
    fun keepScene(directory: File?, manifest: Any?, ready: Boolean, decoded: Pair<Map<String, ImageBitmap>, Boolean>) {
        if (!ready || directory == null || manifest == null || decoded.second || decoded.first.isEmpty()) return
        sceneDirectory = directory; sceneManifest = manifest; scene = decoded
    }

    override fun onCleared() { identity = null; sheet = null; scene = null; sceneManifest = null; sceneDirectory = null }
}

/**
 * The sheet to draw while a read pass is in flight ([reading]): the fresh projection, with every value it does not know yet
 * ("…" level, a still-unknown building's "Reconnecting" hero, "…" stack rows, a null CLAIM or read-only GEMS body) taken
 * from [kept], the last settled sheet of the same identity. Outside a read, or with nothing kept, the fresh sheet as is:
 * a settled null (an unavailable mint, say) is never covered by an old body.
 */
internal fun goldForgeKeptSheet(fresh: GoldForgeSheetUi, kept: GoldForgeSheetUi?, reading: Boolean): GoldForgeSheetUi {
    if (kept == null || !reading) return fresh
    val buildingUnknown = fresh.level == UNKNOWN
    return fresh.copy(
        level = if (buildingUnknown) kept.level else fresh.level,
        heroStatus = if (buildingUnknown && fresh.heroStatus.kind == HeroStatusKind.RECONNECTING) kept.heroStatus else fresh.heroStatus,
        sceneWorking = if (buildingUnknown) kept.sceneWorking else fresh.sceneWorking,
        stack = fresh.stack.map { row -> if (row.value == UNKNOWN) kept.stack.firstOrNull { it.id == row.id } ?: row else row },
        claim = fresh.claim ?: kept.claim,
        gems = fresh.gems ?: kept.gems,
    )
}
