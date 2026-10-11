package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.background
import androidx.compose.foundation.Image
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.ui.home.homeHudState
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEActivity
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.*
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.WorldEntry
import gg.pixelkingdomwars.nativeclient.data.WorldParcelReads
import gg.pixelkingdomwars.nativeclient.data.WorldRealmFeed
import gg.pixelkingdomwars.nativeclient.model.FantasySearchResult
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldEngine
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldTarget
import gg.pixelkingdomwars.nativeclient.scene.LocalSceneHost
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.*
import java.io.File

/** D-NEXT (amends D-173, "overview first, live"): a dive waits for the core FAR set only again (0.7-0.8 s on the Seeker
 *  before D-173), so this backstop is back to the pre-D-173 12 s. It stays above the host's core stall bound
 *  (`WorldEngineHost.DIVE_STALL_MS`, 8 s without core progress), so the engine answers a dive that stops moving (with its
 *  reason) before this backstop does. Counted from the dive's last readiness change (the host posts every change while a
 *  dive waits, `WorldEngineHost.postedReadiness`, never 5 % steps). */
private const val DIVE_TIMEOUT_MS = 12_000L
private const val LEAVE_TIMEOUT_MS = 4_000L
/** map/SPEC §2.1 / §7: "Map open from Home = world cross-fade 220 `out`". */
private const val WORLD_CROSSFADE_MS = 220
/** How far a globe half sheet rises as it opens (dp), with the rail's 160 ms band slide (SPEC §1.6). */
private const val SHEET_RISE_DP = 160f
/** The realm map's ME with no kingdom of yours anywhere on the map. */
private const val NO_KINGDOM_ON_MAP = "No kingdom of yours is on the map yet"
/** Search while the globe is still opening (the bar is the same before and after, so the button is there and answers). */
private const val MAP_STILL_OPENING = "The world map is still opening"
/** map/SPEC §2.1 Error: the globe's read failed; the map stays. */
private const val MAP_UNREACHABLE = "The map can't reach the server. Try again."
/** The Phase E island the archipelago sheet's Public Workshop door selects. */
private const val SOLANA_ISLAND = "solana-island"
/** How long an entry waits for the server's globe read or the engine's map list before it acts on what it has. */
private const val ENTRY_WAIT_MS = 4_000L
private const val GLOBE_HINT = "Drag to spin · pinch to zoom · tap a realm"
/** A sheet's Kingdom door with no Home request queue to carry it (never on the app's World tab, which passes one). */
private const val HOME_UNAVAILABLE = "Open this from your kingdom."

/** The GL30 world surface (globe + realm map, one context) that the integration mounts under the HUD. The surface fills
 *  [bridge] (controls, frame exchange, events) and must never select, dive or leave on its own initiative. */
interface WorldEngineSurface {
    @Composable fun Content(art: File, bridge: WorldHudBridge, modifier: Modifier)
}

/**
 * The World tab on the GL30 engines (N1 globe + N2 realm maps): the surface, the globe HUD mix, the approved realm-map
 * HUD, the map label layers and the back chain, wired to the unchanged `WorldViewModel` reads and actions (select,
 * scout, attack, draftLand, search, warzone). The legacy globe path in [WorldScreen] is untouched by this.
 *
 * N4 (GLOBE-NATIVE-PLAN §1.1): [entry] (from LandGate, the raid chooser, a battle, the inventory) is applied once the
 * HUD is up, then [onEntryApplied]; with no entry a drafted tile reopens its realm map (F6). Every flow goes through the
 * existing reads and actions; none adds server behaviour.
 */
@Composable internal fun WorldHudScreen(model: WorldViewModel, current: WorldUiState?, engine: WorldEngineSurface, selectedBaseId: String?,
    onOpenLand: () -> Unit, onOpenBases: () -> Unit, onOpenShop: (() -> Unit)?, onBack: (() -> Unit)?, onOpenCampaign: (() -> Unit)?,
    ownedBaseCount: Int?, onEngineUnavailable: (String) -> Unit = {}, entry: WorldEntry? = null, onEntryApplied: () -> Unit = {},
    onOpenPhaseE: (PhaseEActivity) -> Unit = {}, onOpenClanHall: () -> Unit = {}, requests: HomeRequests? = null,
    seekerAuction: SeekerIslandSlot? = null, onCraftVehicle: (() -> Unit)? = null) {
    // The designed island and archipelago sheets hand the player to a Kingdom building or the build tray through the app's
    // Home requests (HomeRequest.homeTab switches the scaffold to KINGDOM); without the queue the sheets toast instead.
    val focusBuilding: (String) -> Unit = { id -> requests?.request(HomeRequest.FocusBuilding(id)) ?: Toasts.post(HOME_UNAVAILABLE) }
    val buildMenu: () -> Unit = { requests?.request(HomeRequest.BuildMenu) ?: Toasts.post(HOME_UNAVAILABLE) }
    val art = current?.art
    val bridge = remember(art) { WorldHudBridge() }
    // Never a stuck or black World tab: an engine that reports itself unavailable (no GLES 3, a failed context, missing
    // programs) hands the tab back to the legacy globe; a surface that forgets `ready` is still ready at its first frame.
    val unavailable by rememberUpdatedState(onEngineUnavailable)
    LaunchedEffect(bridge.failure) { bridge.failure?.let { unavailable(it) } }
    val framed by remember(bridge) { derivedStateOf { bridge.frameTick.longValue > 0L } }
    var ui by remember(selectedBaseId) { mutableStateOf(WorldHudUi()) }
    var pendingIsland by remember(selectedBaseId) { mutableStateOf<String?>(null) }
    var pendingRealm by remember(selectedBaseId) { mutableStateOf<String?>(null) }
    val busy by model.busy.collectAsState()
    // map-search RECENT: one list for the globe and the realm map, for as long as this screen lives (process memory only)
    val searchRecent = remember { WorldSearchRecent() }
    val reducedSystem = LocalReducedMotion.current
    val motionActive = ui.motion && !reducedSystem
    fun apply(step: HudStep) { ui = step.ui; step.intents.forEach(bridge::offer) }
    val applyNow by rememberUpdatedState<(HudStep) -> Unit>(::apply)
    val uiNow by rememberUpdatedState(ui)
    LaunchedEffect(ui.mode, pendingIsland, pendingRealm) {
        val island = pendingIsland
        if (ui.mode == WorldHudMode.GLOBE && island != null) {
            pendingIsland = null
            model.select(null)
            applyNow(PhaseEIslands.select(uiNow, island))
        } else if (ui.mode == WorldHudMode.GLOBE) pendingRealm?.let { realm ->
            pendingRealm = null
            model.select(null)
            applyNow(WorldHudFlow.selectRealm(uiNow, realm))
        }
    }
    val currentNow by rememberUpdatedState(current)
    // map/SPEC §2.1 Error (c-gap-map): a first globe read that failed said nothing, so every count sat at "…". Say it once;
    // the map stays and the read's own poll keeps trying (it clears `error` when it lands).
    val globeUnreachable = current != null && current.globe == null && !current.loading && current.error != null
    LaunchedEffect(globeUnreachable) { if (globeUnreachable) Toasts.post(MAP_UNREACHABLE, true) }

    // ---- realms: catalogue presentation + the server's counts (never geography) ----
    val owned = current?.globe?.me?.ownedTiles.orEmpty()
    val realms = remember(model.regions, current?.globe) {
        model.regions.map { r ->
            val id = r.string("id").orEmpty(); val counts = current?.globe?.realms?.firstOrNull { it.realmId == id }
            GlobeRealmInfo(id, r.string("name") ?: id, r.string("numeral"), r.string("nav"), r.string("epithet"), r.string("lore"), r.string("landscape"),
                counts?.total, counts?.occupied, counts?.available, owned.count { it.realmId == id },
                model.constant("FANTASY_WORLD", "genesisTiles"), model.constant("FANTASY_WORLD", "seekerTiles"))
        }
    }
    val (columns, rows) = model.catalogGrid ?: (720 to 360)
    fun myBaseIn(realmId: String?): RealmCard? = owned.firstOrNull { it.realmId == realmId && it.selected }?.let { RealmCard(it.tileId, it.tileId % columns, it.tileId / columns) }
        ?: owned.firstOrNull { it.realmId == realmId }?.let { RealmCard(it.tileId, it.tileId % columns, it.tileId / columns) }
    fun card(tileId: Int) = RealmCard(tileId, tileId % columns, tileId / columns)
    /** F7: your base at TRUE (`BANDS.myBaseD`), or at MAP's select distance where the realm has no ready detail. */
    fun myBaseD(realmId: String?): Double = if (realmId != null && bridge.detailRealms?.contains(realmId) == false) HudBands.SELECT_D else HudBands.MY_BASE_D
    /** Choose mode's open-deed candidate near catalog (x, y), skipping kingdoms in view, your deeds and [skip]. */
    fun openDeed(realmId: String, x: Int, y: Int, skip: Set<Int>): RealmCard? {
        val known = HashSet<Int>(); currentNow?.realmMarkers?.forEach { known += it.tileId }; currentNow?.globe?.me?.ownedTiles?.forEach { known += it.tileId }
        return model.openDeedCandidate(realmId, x, y, known, skip)?.let(::card)
    }
    /** OPEN BASE (F8): select that base, then the base screen (the Kingdom tab); Your Bases where no tab handler exists. */
    val openBaseScreen: () -> Unit = onBack ?: onOpenBases
    // The enter-base seam (D-162.3): in a realm with TRUE ground and a Kingdom tab to open, OPEN BASE first flies the map
    // to the kingdom at the base scene's opening scale, and the base opens on that camera (BaseSeam, below); anywhere
    // else, and whenever the map cannot get there, F8 as before. The pending request: (base id, catalog x, catalog y).
    val homeCamera = LocalSceneHost.current?.homeCamera
    var seamPending by remember { mutableStateOf<Triple<String, Int, Int>?>(null) }
    val openBaseNow by rememberUpdatedState(openBaseScreen)
    LaunchedEffect(ui.mode) { if (ui.mode != WorldHudMode.REALM) seamPending = null } // a leave (◀ Globe, Back) drops it
    val onOpenBase: (String) -> Unit = { baseId ->
        val u = uiNow; val tile = currentNow?.selectedTileId; val controls = bridge.controls
        val spec = if (onBack != null && homeCamera != null && u.mode == WorldHudMode.REALM && bridge.detailRealms?.contains(u.realmId) == true)
            model.baseSeamSpec() else null
        if (spec == null || controls == null || tile == null) model.openBase(baseId, openBaseScreen)
        else { seamPending = Triple(baseId, tile % columns, tile / columns); controls.enterBase(tile % columns, tile / columns, spec) }
    }

    // ---- shield domes: every kingdom's from the feed's `shielded` (D-NEXT); your selected base's timed by its Home read ----
    val home by model.home.collectAsState()
    val chromeHome = home.takeIf { worldChromeBaseIsCurrent(selectedBaseId, it.base?.baseId) } ?: BaseState()
    val resourceRows = worldChromeReadouts(homeHudState(chromeHome, null, 0, false, 0, 0, false).resources)
    val homeIcon = chromeHome.base?.player?.keepLevel?.let(model::keepPortrait) ?: "building-keep"
    val ownShield = remember(home.base) { WorldOwnShield.from(home.base?.baseId, home.base?.raw, System.nanoTime()) }
    var shieldNow by remember { mutableLongStateOf(System.nanoTime()) }
    LaunchedEffect(ownShield) { ownShield?.remainingMs(System.nanoTime())?.let { kotlinx.coroutines.delay(it + 1); shieldNow = System.nanoTime() } }

    // ---- realm-map bases: the bounded viewport read + your own deeds in this realm ----
    val realmBases = remember(current?.realmMarkers, owned, ui.realmId, ui.mode, ownShield, shieldNow) {
        if (ui.mode != WorldHudMode.REALM) emptyList()
        else realmHudBases(ui.realmId, current?.realmMarkers.orEmpty(), owned, { model.tile(it)?.realmId }, columns, ownShield, shieldNow)
    }
    // D-191: the map applies the filter its chips can show (WorldHudFlow.shownFilter): the Unshielded chip waits for a read
    // that carries the shield bit (D-181), and while it is not shown the map applies All, engine and toolbar alike.
    val chips = HudChips.realm(current?.shieldFed == true)
    val chipsNow by rememberUpdatedState(chips)
    val shownFilter = WorldHudFlow.shownFilter(ui.filter, chips)
    val filtered = remember(realmBases, shownFilter) { realmBases.filter { shownFilter.passes(it, null) } }
    val basesEpoch = remember { longArrayOf(0L) }
    LaunchedEffect(realmBases, shownFilter, ui.card, bridge) {
        val realm = ui.realmId
        if (ui.mode == WorldHudMode.REALM && realm != null) bridge.offer(WorldIntent.SetBases(WorldHudFlow.basesSnapshot(++basesEpoch[0], realm, realmBases, shownFilter, ui.card, null)))
    }
    LaunchedEffect(bridge, ui.mode == WorldHudMode.REALM, chips) { applyNow(WorldHudFlow.chipsShown(uiNow, chips)) }

    // ---- engine events ----
    DisposableEffect(bridge) {
        bridge.listen { event ->
            val u = uiNow
            when (event) {
                is WorldHudEvent.GlobePick -> if (u.mode == WorldHudMode.GLOBE) { model.select(null); applyNow(WorldHudFlow.globePick(u, event.target)) }
                is WorldHudEvent.GlobeSelected -> WorldHudFlow.globeSelected(u, event.realmId, event.islandId).let { step ->
                    if (step.ui.panel == GlobePanel.ISLAND && u.panel != GlobePanel.ISLAND) model.select(null)
                    applyNow(step)
                }
                is WorldHudEvent.RealmTap -> if (u.mode == WorldHudMode.REALM) onRealmTap(event, u, model, bridge, applyNow)
                is WorldHudEvent.Dived -> {
                    val realm = event.realmId
                    val suggested = if (u.intent != WorldHudIntent.CHOOSE_LAND || u.pendingTile != null || u.pendingMine || u.resume != null) null else {
                        val g = bridge.realmGrid?.takeIf { it.realmId == realm }
                        val anchor = if (g == null) model.realmAnchorTile(realm) else null
                        val x = g?.let { it.x0 + it.cols / 2 } ?: anchor?.let { it % columns }; val y = g?.let { it.y0 + it.rows / 2 } ?: anchor?.let { it / columns }
                        if (x == null || y == null) null else openDeed(realm, x, y, emptySet())
                    }
                    applyNow(WorldHudFlow.dived(u, realm, myBaseIn(realm), suggested, myBaseD(realm)))
                }
                // only a dive on screen (or its Back) hears it: after the watchdog the HUD is on the globe already. Its
                // notice is the flow's: a failure says so, the player's own Back (LEAVING) does not
                is WorldHudEvent.DiveFailed -> if (u.mode == WorldHudMode.DIVING || u.mode == WorldHudMode.LEAVING) {
                    applyNow(WorldHudFlow.diveFailed(u, event.realmId))
                }
                is WorldHudEvent.Diving -> applyNow(WorldHudFlow.diving(u, event.realmId))
                is WorldHudEvent.Leaving -> applyNow(WorldHudFlow.leaving(u))
                is WorldHudEvent.Left -> { model.realmWindow(null); model.select(null); applyNow(WorldHudFlow.left(u, event.realmId)) }
                is WorldHudEvent.NothingToLeave -> if (u.mode == WorldHudMode.LEAVING) { model.realmWindow(null); model.select(null); applyNow(WorldHudFlow.nothingToLeave(u)) }
                is WorldHudEvent.NoMap -> if (u.panel == GlobePanel.NONE) ui = ui.copy(noMap = (realms.firstOrNull { it.id == event.realmId }?.name
                    ?: PhaseEIslands.byId(event.realmId)?.title)?.let { "No map for $it yet" } ?: "No realm map here")
                is WorldHudEvent.EngineChanged -> if (event.engine == WorldEngine.LEGACY) unavailable("The world engine fell back to the legacy globe")
                // the seam's answer: select and open the base (F8), on the map's camera when it got there
                is WorldHudEvent.BaseSeam -> seamPending?.takeIf { it.second == event.catalogX && it.third == event.catalogY }?.let { (baseId, _, _) ->
                    seamPending = null
                    model.openBase(baseId) { event.camera?.let { c -> homeCamera?.enterAt(baseId, c.worldX, c.worldY, c.zoom) }; openBaseNow() }
                }
                // a touch (a pinch-out's first finger among them) or a HUD camera control took the map: nothing opens
                is WorldHudEvent.BaseSeamCancelled ->
                    if (seamPending?.let { it.second == event.catalogX && it.third == event.catalogY } == true) seamPending = null
            }
        }
        onDispose { bridge.listen(null) }
    }
    // The card follows the selected deed with the dwell rule (GLOBE-PRODUCTION-PLAN §2.6.4: the metered read waits until
    // the card rests; browsing on spends nothing); the globe's parcel panel follows search. Parcel reads are the existing ones.
    LaunchedEffect(ui.mode, ui.card?.tileId) { if (ui.mode == WorldHudMode.REALM) model.select(ui.card?.tileId, dwellMs = WorldParcelReads.CARD_DWELL_MS) }
    LaunchedEffect(ui.panel, ui.mode, ui.warzoneOpen) {
        model.showWarzone((ui.mode == WorldHudMode.GLOBE && ui.panel == GlobePanel.WARZONE) || (ui.mode == WorldHudMode.REALM && ui.warzoneOpen))
    }
    LaunchedEffect(ui.noMap) { if (ui.noMap != null) { kotlinx.coroutines.delay(8_000); ui = ui.copy(noMap = null) } }
    // Watchdogs: a flight that never reports back must not strand the player without a HUD (Back is swallowed while a
    // leave is in flight). The web's dive is 700 ms + a 450 ms fade and its leave 900 ms; these bounds are generous.
    // The dive's watchdog re-arms at every readiness change the host publishes while it waits (each one its own stall
    // bound sees); only an engine that stopped answering reaches it.
    LaunchedEffect(ui.mode, bridge.diveReadiness.takeIf { ui.mode == WorldHudMode.DIVING }) {
        when (uiNow.mode) {
            WorldHudMode.DIVING -> { kotlinx.coroutines.delay(DIVE_TIMEOUT_MS); if (uiNow.mode == WorldHudMode.DIVING) uiNow.realmId?.let { r ->
                applyNow(WorldHudFlow.diveFailed(uiNow, r)); bridge.offer(WorldIntent.Leave) } }
            WorldHudMode.LEAVING -> { kotlinx.coroutines.delay(LEAVE_TIMEOUT_MS); if (uiNow.mode == WorldHudMode.LEAVING) uiNow.realmId?.let { r ->
                model.realmWindow(null); model.select(null); applyNow(WorldHudFlow.left(uiNow, r)) } }
            else -> Unit
        }
    }
    // ---- N4: an entry from another screen once the HUD is up; else F6, a drafted tile reopening its realm map ----
    val hudReady = art != null && (bridge.ready || framed)
    var draftChecked by remember(selectedBaseId) { mutableStateOf(false) }
    val entryApplied by rememberUpdatedState(onEntryApplied)
    LaunchedEffect(hudReady, entry) {
        if (!hudReady) return@LaunchedEffect
        suspend fun mapped(realm: String): Boolean = realm in bridge.mapRealms ||
            withTimeoutOrNull(ENTRY_WAIT_MS) { snapshotFlow { bridge.mapRealms }.first { realm in it } } != null
        val e = entry
        if (e != null) {
            draftChecked = true
            if (e == WorldEntry.MyDeeds) withTimeoutOrNull(ENTRY_WAIT_MS) { snapshotFlow { currentNow?.globe }.first { it != null } }
            val deeds = currentNow?.globe?.me?.ownedTiles.orEmpty()
            val mine = deeds.firstOrNull { it.selected } ?: deeds.firstOrNull { it.active } ?: deeds.firstOrNull()
            val isMapped = mine != null && e == WorldEntry.MyDeeds && mapped(mine.realmId)
            val step = WorldHudFlow.entry(uiNow, e, deeds.size, deeds.mapTo(HashSet()) { it.realmId }.size, mine?.let { card(it.tileId) }, mine?.realmId, isMapped)
            // An island entry clears the engine's selection first, exactly as the rail's chip tap does (SeekerIsland).
            if (step.ui.panel == GlobePanel.PARCEL) model.select(mine?.tileId) else if (step.ui.panel == GlobePanel.REALM || step.ui.panel == GlobePanel.ISLAND) model.select(null)
            applyNow(step); entryApplied()
            return@LaunchedEffect
        }
        if (draftChecked) return@LaunchedEffect
        draftChecked = true
        val tile = model.draftedTile ?: return@LaunchedEffect
        val realm = model.tile(tile)?.realmId ?: return@LaunchedEffect
        val isMapped = mapped(realm)
        val u = uiNow
        if (u.mode != WorldHudMode.GLOBE || u.panel != GlobePanel.NONE || u.globeSearch) return@LaunchedEffect // the player moved on
        val step = WorldHudFlow.reopenDraft(u, realm, card(tile), isMapped)
        if (!isMapped) model.select(tile)
        applyNow(step)
    }
    LaunchedEffect(motionActive, bridge) { bridge.offer(WorldIntent.SetReducedMotion(!motionActive)) }
    LaunchedEffect(ui.night, bridge) { bridge.offer(WorldIntent.SetNight(ui.night)) }

    // ---- a new engine under this HUD: the app stopped (the lock screen, Home) and `art` came back (owner, code 31) ----
    // The realm camera last on screen, for "Same map, same spot": kept off Compose state (a camera move is no recomposition)
    // and written only when it changes. Leaving the World tab drops it with this whole composition, so a tab switch or a
    // process death starts on the globe as before.
    val lastRealm = remember { arrayOfNulls<RealmResume>(1) }
    LaunchedEffect(bridge, ui.mode) {
        if (ui.mode != WorldHudMode.REALM) return@LaunchedEffect
        snapshotFlow { bridge.frameTick.longValue }.collect {
            val f = bridge.latestFrame()?.takeIf { it.engine == WorldEngine.REALM } ?: return@collect
            val realm = uiNow.realmId ?: return@collect
            val was = lastRealm[0]
            if (was == null || was.realmId != realm || was.x != f.cameraX || was.y != f.cameraY || was.d != f.cameraScale)
                lastRealm[0] = RealmResume(realm, f.cameraX, f.cameraY, f.cameraScale)
        }
    }
    // Every bridge with art is a new engine on the globe (key(art) below). From the second on, the HUD follows it: back to
    // the same realm camera, or the clean globe. Its first composition is the loading screen (not ready yet), so no realm
    // chrome is ever composed over the new globe.
    val engines = remember { intArrayOf(0) }
    LaunchedEffect(bridge) { if (art != null && engines[0]++ > 0) ui = WorldHudFlow.engineMounted(uiNow, lastRealm[0], chipsNow) }
    // The resume goes to the engine once it is up: a realm this build still maps dives; else the clean globe at once.
    LaunchedEffect(bridge, hudReady, ui.resume) {
        val target = ui.resume ?: return@LaunchedEffect
        if (!hudReady || uiNow.mode != WorldHudMode.DIVING) return@LaunchedEffect
        val controls = bridge.controls
        if (controls == null || target.realmId !in bridge.mapRealms) applyNow(WorldHudFlow.diveFailed(uiNow, target.realmId))
        else controls.resume(target)
    }

    // ---- back chain: card or search → realm map → globe selection/sheet → the app's screen handler (base) ----
    // While OPEN BASE waits (the enter-base seam) the first Back cancels it at the card's priority: nothing opens and the
    // card stays. The card is up under every OPEN BASE, so its Back alone closed it while the flight still opened the base.
    val layers = WorldHudFlow.backLayers(ui)
    for (priority in listOf(BackPriority.REALM_CARD, BackPriority.GLOBE_LIST, BackPriority.REALM_MAP, BackPriority.GLOBE_LAYERS)) {
        val seamBack = priority == BackPriority.REALM_CARD
        BackHandlerAt(priority, priority in layers || (seamBack && seamPending != null)) {
            if (seamBack && seamPending != null) { seamPending = null; bridge.controls?.cancelBase() } else applyNow(WorldHudFlow.back(uiNow, priority))
        }
    }

    val density = LocalDensity.current
    BoxWithConstraints(Modifier.fillMaxSize().background(HudStyle.bg)
        .pointerInput(Unit) { awaitPointerEventScope { while (true) { awaitPointerEvent(PointerEventPass.Initial); if (uiNow.hint) ui = uiNow.copy(hint = false) } } }) {
        val W = maxWidth.value; val H = maxHeight.value
        val insets = WindowInsets.safeDrawing
        val safe = HudInsets(insets.getTop(density) / density.density, insets.getRight(density, LayoutDirection.Ltr) / density.density,
            insets.getBottom(density) / density.density, insets.getLeft(density, LayoutDirection.Ltr) / density.density)
        val type = remember(W, H, density.density) { HudType.of(density.density, W > H, H) }
        CompositionLocalProvider(LocalHudType provides type) {
            // Field report 2026-10-06 (MAP → back: one black frame under the realm labels and this HUD): beneath the engine,
            // for as long as this HUD is composed, the globe's last frame (else its sky) — the surface punches through it while
            // it is up, and it is what shows if the surface leaves before these layers do.
            gg.pixelkingdomwars.nativeclient.scene.world.WorldBacking(art?.let { "world-engine-${it.name}" })
            if (art != null) key(art) { engine.Content(art, bridge, Modifier.fillMaxSize()) }
            val ready = art != null && (bridge.ready || framed)
            // map/SPEC §2.1 motion: the world cross-fades in under a HUD that is already there (220 ms; a 120 ms fade under
            // reduced motion). The stage veil covers the engine until its first frame and then fades; the map chrome above it
            // never leaves, so opening MAP never shows a full-screen loader (c-gap-map).
            WorldVeil(ready, reducedSystem)
            if (!ready) WorldHudLoading(current, bridge, model::retryArt, onBack ?: onOpenBases, realms, resourceRows, homeIcon)
            else when (ui.mode) {
                WorldHudMode.GLOBE, WorldHudMode.DIVING -> GlobeLayer(model, current, ui, realms, bridge, W, H, safe, motionActive, reducedSystem, busy,
                    selectedBaseId, onOpenLand, onOpenBases, onOpenShop, onBack, onOpenCampaign, ownedBaseCount, columns, rows, ::apply, onOpenBase,
                    { realm, x, y, skip -> openDeed(realm, x, y, skip) }, resourceRows, homeIcon, onOpenPhaseE, onOpenClanHall, focusBuilding, buildMenu,
                    seekerAuction, onCraftVehicle, searchRecent) { ui = it }
                WorldHudMode.REALM -> RealmLayer(model, current, ui, realms, realmBases, filtered, bridge, W, H, safe, busy, selectedBaseId, onOpenLand, onOpenBases,
                    columns, rows, ::apply, { myBaseIn(ui.realmId) }, ::myBaseD, onOpenBase, onOpenShop, onBack ?: onOpenBases,
                    { island -> pendingIsland = island; apply(WorldHudFlow.leave(ui)) },
                    { realm -> pendingRealm = realm; apply(WorldHudFlow.leave(ui)) },
                    { realm, x, y, skip -> openDeed(realm, x, y, skip) }, resourceRows, homeIcon, searchRecent) { ui = it }
                WorldHudMode.LEAVING -> Unit
            }

        }
    }
}

private fun onRealmTap(event: WorldHudEvent.RealmTap, u: WorldHudUi, model: WorldViewModel, bridge: WorldHudBridge, apply: (HudStep) -> Unit) {
    val realm = u.realmId ?: return
    RealmLabelsState.hitCluster(bridge, event.viewX, event.viewY)?.let { (x, y, d) ->
        bridge.offer(WorldIntent.FlyTo(WorldTarget.Deed(realm, x, y), d)); return
    }
    RealmLabelsState.tagCard(event.viewX, event.viewY)?.let { apply(WorldHudFlow.selectDeed(u, it, fly = false)); return }
    val x = event.deedX; val y = event.deedY
    val tile = if (x != null && y != null) model.tileAt(x, y) else null
    val columns = model.catalogGrid?.first
    if (tile == null || columns == null || model.tile(tile)?.realmId != realm) { apply(WorldHudFlow.selectDeed(u, null, fly = false)); return }
    apply(WorldHudFlow.selectDeed(u, RealmCard(tile, tile % columns, tile / columns), fly = false))
}

/** The last FAR counters on screen, for the map tap's cluster test (ui.js `hitCluster`), and the last name tags, for its
 *  tag test ([tagCard]). UI thread only. */
internal object RealmLabelsState {
    private var counters: List<RealmHudModel.Counter> = emptyList(); private var density = 1f; private var cameraD = 0.0; private var columns = 1
    private var tags: WorldLabels.RealmLabels? = null
    fun set(list: List<RealmHudModel.Counter>, density: Float, d: Double, columns: Int, labels: WorldLabels.RealmLabels? = null) {
        counters = list; this.density = density; cameraD = d; this.columns = columns; tags = labels
    }
    fun clear() { counters = emptyList(); tags = null }
    /** A tap on a kingdom's name tag selects that kingdom ([WorldLabels.RealmLabels.tagAt]), not the deed under the finger. */
    fun tagCard(viewX: Float, viewY: Float): RealmCard? =
        tags?.tagAt((viewX / density).toDouble(), (viewY / density).toDouble())?.let { RealmCard(it.tileId, it.x, it.y) }
    /** A tap on a counter zooms into it: (deed x, deed y, d) = its centroid at max(d × 2.4, mapStart). */
    fun hitCluster(bridge: WorldHudBridge, viewX: Float, viewY: Float): Triple<Int, Int, Double>? {
        val c = RealmHudModel.hitCluster(counters, (viewX / density).toDouble(), (viewY / density).toDouble()) ?: return null
        val x = Math.floorMod(Math.floor(c.u / c.n).toInt(), columns) // catalog columns wrap at the dateline (Cinderfall)
        return Triple(x, Math.floor(c.v / c.n).toInt(), maxOf(cameraD * 2.4, HudBands.MAP_START_D))
    }
}

/** The stage veil over the engine until its first frame, then a 220 ms fade (120 under reduced motion). Its own restart
 *  scope, and the alpha is read in the layer, so the fade recomposes this box only, never the HUD over it. */
@Composable private fun WorldVeil(ready: Boolean, reduced: Boolean) {
    val veil by animateFloatAsState(if (ready) 0f else 1f,
        tween(if (!ready) 0 else if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else WORLD_CROSSFADE_MS), label = "worldVeil")
    // Owner 2026-10-06 ("black screen is low quality"): the stage is the globe's own sky, never the #100E14 shell, so the
    // world fades in on the same space it is drawn on (scene-transitions spec §3 "World open: sky colour and the line").
    if (veil > 0f) Box(Modifier.fillMaxSize().graphicsLayer { alpha = veil }.background(WORLD_SKY))
}

/**
 * Loading (map/SPEC §2.1 "Loading: never a full-screen loader"): the map's own top bar is up at once (HOME, the WORLD title
 * plate, the resource stack) over the globe's sky (WorldVeil). Owner 2026-10-06 (no centred plate, honest indicators): after
 * 400 ms the D-193 strip at the bottom says "Shaping the realms…" with a meter measured in verified files while the world
 * downloads (else the sweep), or the failure and RETRY. HOME ([onHome]) never traps a slow first download. The rail's island
 * chips and thumbnails are read while this shows, so the globe's first HUD frame has them.
 */
@Composable private fun WorldHudLoading(current: WorldUiState?, bridge: WorldHudBridge, onRetry: () -> Unit, onHome: () -> Unit,
    realms: List<GlobeRealmInfo>, resources: List<ResourceChipUi>, homeIcon: String) {
    WarmPhaseEChips() // the rail's island chips are read while this shows, so the globe's first HUD frame lists them
    val islands = rememberPhaseEChips()
    rememberWorldRailArt(worldChromeRail(realms, islands.map { it.id }, null)) // warms the process cache the rail reads
    val download = current?.artProgress?.takeIf { it.totalFiles > 0 }
    val failed = current?.artError != null
    // Scene-transitions spec §2/§3 (owner 2026-10-06: no centred plate, honest indicators): nothing for the first 400 ms;
    // then the D-193 strip at the bottom over the sky — a byte-measured meter while the world downloads, else the sweep —
    // and the reason with RETRY on a failure.
    val stage = gg.pixelkingdomwars.nativeclient.ui.kingdom.rememberIndicatorStage("world", waiting = !failed, failed = failed)
    Box(Modifier.fillMaxSize()) {
        BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            // the same bar the globe draws once it is up, so nothing at the top moves when the world fades in
            MapTopBar("WORLD", "${realms.size} realms · ${islands.size} islands", back = false, onBackOrHome = onHome,
                homeIcon = homeIcon, onSearch = { Toasts.post(MAP_STILL_OPENING) }, resources = resources, onResourceRow = {}, sealShown = true,
                compact = mapTopBarCompact(maxWidth.value), tight = mapTopBarTight(maxWidth.value))
        }
        worldOpeningStrip(failed, download).takeIf { failed || download != null || stage != gg.pixelkingdomwars.nativeclient.ui.kingdom.IndicatorStage.HIDDEN }?.let { content ->
            gg.pixelkingdomwars.nativeclient.ui.kingdom.SceneStrip(content,
                actions = if (failed) { { gg.pixelkingdomwars.nativeclient.ui.boot.StripButton("RETRY", onRetry) } } else null)
        }
    }
}

@Composable private fun GlobeLayer(model: WorldViewModel, current: WorldUiState?, ui: WorldHudUi, realms: List<GlobeRealmInfo>, bridge: WorldHudBridge,
    W: Float, H: Float, safe: HudInsets, motionActive: Boolean, reducedSystem: Boolean, busy: Boolean, selectedBaseId: String?,
    onOpenLand: () -> Unit, onOpenBases: () -> Unit, onOpenShop: (() -> Unit)?, onBack: (() -> Unit)?, onOpenCampaign: (() -> Unit)?, ownedBaseCount: Int?,
    columns: Int, rows: Int, apply: (HudStep) -> Unit, onOpenBase: (String) -> Unit, openDeed: (String, Int, Int, Set<Int>) -> RealmCard?,
    resources: List<ResourceChipUi>, homeIcon: String, onOpenPhaseE: (PhaseEActivity) -> Unit, onOpenClanHall: () -> Unit,
    focusBuilding: (String) -> Unit, buildMenu: () -> Unit, seekerAuction: SeekerIslandSlot?, craftVehicle: (() -> Unit)?,
    recent: WorldSearchRecent, setUi: (WorldHudUi) -> Unit) {
    val t = LocalHudType.current
    val density = LocalDensity.current.density
    var query by remember { mutableStateOf("") }
    var peekH by remember { mutableFloatStateOf(150f) }
    var hudMode by remember { mutableStateOf(MapMode.EXPLORE) }
    var modeSheet by remember { mutableStateOf(false) }
    var chromeBounds by remember { mutableStateOf(emptyList<Rect>()) }
    val chromeRects = chromeBounds.map { HudRect(it.left, it.top, it.width, it.height) }
    // The designed half sheet over the globe (island, parcel, archipelago island) and its measured bounds in dp: a label
    // obstacle like the chrome, and only while a sheet is up.
    val sheet = worldGlobeSheet(ui, current != null)
    var sheetBounds by remember { mutableStateOf<HudRect?>(null) }
    val sheetRects = listOfNotNull(sheetBounds.takeIf { sheet != WorldGlobeSheet.NONE })
    BackHandlerAt(BackPriority.SHEET, modeSheet) { modeSheet = false }
    val mapped = bridge.mapRealms
    // An intent's instruction (choose land, rivals, your deeds) stays up; the plain hint leaves at the first touch.
    val hintText = WorldHudFlow.hint(ui, GLOBE_HINT)
    // The final rail leads with Phase E islands enabled by this build's world bundle.
    val islands = rememberPhaseEChips()
    // Existing side panels start below the final top bar/resource stack on short landscape.
    val panelSafe = if (W > H && H <= HudTokens.SHORT_LANDSCAPE_MAX_H) safe.copy(top = safe.top + 48f) else safe
    val plan = remember(W, H, panelSafe, t, ui.globeSearch, current?.search?.size, query, ui.panel, ui.archipelagoId, ui.peek, peekH, ui.hint, ui.noMap, ui.intent, ui.mode, realms, mapped, islands, onBack != null, onOpenCampaign != null) {
        GlobeHudPlan.plan(GlobeHudPlan.Input(W, H, panelSafe, t, back = onBack != null, campaign = onOpenCampaign != null,
            destinations = realms.map { it.name } + islands.map { it.title }, mapped = realms.indices.filter { realms[it].id in mapped }.toSet(),
            searchOpen = ui.globeSearch, resultRows = if (!ui.globeSearch || query.trim().length < 2) 0 else current?.search?.size?.takeIf { it > 0 }?.coerceAtMost(8) ?: -1,
            panelOpen = worldGlobeFramePanel(ui), sheetPeek = ui.peek, peekH = peekH,
            hint = hintText.takeIf { WorldHudFlow.hintShown(ui) }, diving = ui.mode == WorldHudMode.DIVING))
    }
    val labelRects = chromeRects + sheetRects + listOfNotNull(plan.panel)
    UiRectsEffect(bridge, labelRects, density)
    LaunchedEffect(labelRects, W, H, density) {
        val headerBottom = chromeRects.filter { it.y < safe.top + 80f }.maxOfOrNull { it.bottom } ?: (safe.top + 144f)
        val out = FloatArray(labelRects.size * 4)
        labelRects.forEachIndexed { i, r -> out[i * 4] = r.x * density; out[i * 4 + 1] = r.y * density; out[i * 4 + 2] = r.w * density; out[i * 4 + 3] = r.h * density }
        // a half sheet at its 50 % cap starts at H / 2 (c-gap-map: the realm sheet can); it still bounds the free area
        val bandTop = (chromeRects + sheetRects).filter { it.y >= H * .4f && it.w > W * .6f }.minOfOrNull { it.y } ?: (H - safe.bottom)
        val free = plan.panel?.let { p ->
            if (plan.landscape) HudRect(0f, headerBottom, p.x.coerceAtLeast(0f), (bandTop - headerBottom).coerceAtLeast(0f))
            else HudRect(0f, headerBottom, W, (p.y - headerBottom).coerceAtLeast(0f))
        } ?: HudRect(0f, headerBottom, W, (bandTop - headerBottom).coerceAtLeast(0f))
        bridge.globeLayout = GlobeHudLayout(headerBottom * density, out, labelRects.size,
            floatArrayOf(free.x * density, free.y * density, free.w * density, free.h * density))
    }

    // ---- place labels (engine anchors → placement against the UI rects) ----
    val board = remember { LabelBoard<Int>(16) }
    val labelRectsNow by rememberUpdatedState(labelRects); val uiNow by rememberUpdatedState(ui)
    LaunchedEffect(bridge, realms, W, H, t) {
        snapshotFlow { bridge.frameTick.longValue }.collectLatest {
            val f = bridge.latestFrame()
            if (f == null || f.engine != WorldEngine.GLOBE) { board.publish(emptyList(), FloatArray(0), FloatArray(0)); return@collectLatest }
            val u = uiNow
            val hide = if (u.panel == GlobePanel.ISLAND) PhaseEIslands.ALL.indexOfFirst { it.id == u.islandId }.takeIf { it >= 0 }?.let(PhaseEIslands::anchorId)
                else realms.indexOfFirst { it.id == u.realmId }.takeIf { u.panel == GlobePanel.REALM }
            val placed = worldChromeGlobeLabels(f.anchorIds, f.anchorXY, f.anchorCount, density, realms.map { it.name }, t, labelRectsNow, W, H, hide)
            board.publish(placed.map { it.id }, FloatArray(placed.size) { placed[it].x }, FloatArray(placed.size) { placed[it].y })
        }
    }
    val labelsAlpha by animateFloatAsState(if (ui.mode == WorldHudMode.DIVING) 0f else 1f, tween(HudStyle.fadeMs), label = "labels")
    LabelLayer(board, { it }, Modifier.alpha(labelsAlpha)) { id ->
        val isle = PhaseEIslands.byAnchor(id)
        val realm = if (isle == null) realms.getOrNull(id) else null
        if (realm != null) CompositionLocalProvider(LocalHudAccent provides HudAccent(HudRealms.accent(realm.id))) {
            HudPlaceText(realm.name, selected = false, dim = ui.panel != GlobePanel.NONE)
        }
        // a live Phase E island's name (the engine publishes its anchor only while the layer is on), in its accent
        if (isle != null) CompositionLocalProvider(LocalHudAccent provides HudAccent(PhaseEIslands.accent(isle.id) ?: HudStyle.accentDefault)) {
            PlaceLabel(PlaceLabelUi(worldIslandRailId(isle.id) ?: isle.id, "ui:${worldIslandRailId(isle.id)}-navigation", worldIslandPlaceName(isle.id) ?: isle.title,
                selected = ui.panel == GlobePanel.ISLAND && ui.islandId == isle.id),
                { model.select(null); apply(PhaseEIslands.select(ui, isle.id)) })
        }
    }

    val mine = current?.globe?.me?.ownedTiles?.let { o -> o.firstOrNull { it.selected } ?: o.firstOrNull { it.active } ?: o.firstOrNull() }
    fun openResult(row: FantasySearchResult) {
        query = ""; model.search("")
        val realm = row.realmId
        if (realm in mapped) apply(WorldHudFlow.enterMap(ui.copy(globeSearch = false), realm, tile = RealmCard(row.tileId, row.tileId % columns, row.tileId / columns)))
        else { model.select(row.tileId); apply(WorldHudFlow.openPanel(ui.copy(realmId = realm, globeSearch = false), GlobePanel.PARCEL)) }
    }
    val actions = GlobeHudActions(
        back = onBack, campaign = onOpenCampaign, bases = onOpenBases,
        selectRealm = { model.select(null); apply(WorldHudFlow.selectRealm(ui, it)) },
        selectIsland = { model.select(null); apply(PhaseEIslands.select(ui, it)) },
        deselect = { model.select(null); apply(WorldHudFlow.deselect(ui)) },
        enterMap = { realm, mineCta -> apply(WorldHudFlow.browseMap(ui, realm, mine = mineCta)) },
        toggleSearch = { if (ui.globeSearch) { query = ""; model.search("") }; setUi(ui.copy(globeSearch = !ui.globeSearch, hint = false, panel = GlobePanel.NONE)) },
        query = { query = it; model.search(it) }, openResult = ::openResult,
        explore = { apply(WorldHudFlow.openPanel(ui.copy(chainId = null), if (ui.panel == GlobePanel.EXPLORE) GlobePanel.NONE else GlobePanel.EXPLORE)) },
        warzone = { apply(WorldHudFlow.openPanel(ui, if (ui.panel == GlobePanel.WARZONE) GlobePanel.NONE else GlobePanel.WARZONE)) },
        motion = { setUi(ui.copy(motion = !ui.motion)) },
        // main.js tools `mine`: the realm with your base, offering "My base" as its gold CTA (F7; without a map, its parcel panel)
        myParcel = {
            if (mine == null) apply(WorldHudFlow.openPanel(ui, GlobePanel.PARCEL_HELP))
            else { val step = WorldHudFlow.myParcel(ui, mine.realmId, mine.realmId in mapped); model.select(if (step.ui.panel == GlobePanel.PARCEL) mine.tileId else null); apply(step) }
        },
        night = { setUi(ui.copy(night = !ui.night)) },
        zoom = { bridge.controls?.zoom(it); setUi(ui.copy(hint = false)) },
        peek = { setUi(ui.copy(peek = it)) },
        peekMeasured = { if (kotlin.math.abs(it - peekH) > 0.5f) peekH = it },
        // Choose mode (`land-realm-enter`): into the realm map in choose mode; a realm without a map shows a suggested open
        // deed in the globe's parcel panel instead (its card confirms with the metered read).
        chooseLand = { realm ->
            if (realm in mapped) apply(WorldHudFlow.enterMap(ui, realm))
            else model.realmAnchorTile(realm)?.let { a -> openDeed(realm, a % columns, a / columns, emptySet()) }?.let { c ->
                model.select(c.tileId); apply(WorldHudFlow.openPanel(ui.copy(realmId = realm, offered = listOf(c.tileId)), GlobePanel.PARCEL))
            }
        },
    )
    val panelTitle = when (ui.panel) {
        GlobePanel.PARCEL -> current?.selectedTileId?.let { "Tile $it" } ?: "Parcel"
        GlobePanel.WARZONE -> "Warzone"; GlobePanel.EXPLORE -> model.chains.firstOrNull { it.string("id") == ui.chainId }?.string("name") ?: "Explore"
        GlobePanel.PARCEL_HELP -> "My parcel"; GlobePanel.ISLAND -> PhaseEIslands.byId(ui.islandId)?.title ?: ""; else -> ""
    }
    val rail = worldChromeRail(realms, islands.map { it.id }, mine?.realmId)
    var artRetry by remember { mutableIntStateOf(0) }
    val railArt = rememberWorldRailArt(rail, artRetry)
    fun selectMode(mode: MapMode) {
        modeSheet = false; hudMode = mode
        when (mode) {
            MapMode.WARZONE -> if (ui.panel != GlobePanel.WARZONE) actions.warzone()
            MapMode.EXPLORE, MapMode.KINGDOMS -> if (ui.panel != GlobePanel.NONE) actions.deselect()
        }
    }
    val chrome: @Composable () -> Unit = {
        MapHud(MapHudUi(MapScreen.WORLD, hudMode, "WORLD", "${realms.size} realms · ${islands.size} islands", resources, rail,
            worldIslandRailId(ui.islandId).takeIf { ui.panel == GlobePanel.ISLAND } ?: ui.realmId,
            panelOpen = ui.panel != GlobePanel.NONE || ui.globeSearch || modeSheet,
            topPill = when {
                ui.noMap != null -> MapPillUi("no-map", hintText)
                railArt.missing.isNotEmpty() -> MapPillUi("art", "Some map thumbnails did not load", "RETRY")
                WorldHudFlow.hintShown(ui) && ui.intent != WorldHudIntent.NONE -> MapPillUi("intent", hintText)
                else -> null
            },
            resourcesEnabled = false, homeIcon = homeIcon),
            MapHudActions(onHome = onBack ?: onOpenBases, onSearch = actions.toggleSearch,
                onZoom = actions.zoom, onMe = actions.myParcel, onMode = { selectMode(nextMode(hudMode)) },
                onModeLong = { modeSheet = true }, onPill = {
                    if (it == "art") artRetry++
                },
                onRail = { id -> worldIslandDestination(id)?.let(actions.selectIsland) ?: run {
                    if (ui.realmId == id && id in mapped) actions.enterMap(id, false) else actions.selectRealm(id)
                } }), railArt = { tile -> WorldRailImage(tile, railArt) }, onChromeBounds = { chromeBounds = it })
    }
    // c-gap-map: the old dark frame draws for no panel any more (worldGlobeFramePanel), so it takes no body; every globe panel
    // is a designed half sheet below.
    GlobeHud(plan, ui, realms, mapped, bridge.diveReadiness, query, current?.search.orEmpty(), ownedBaseCount?.toString() ?: "—", motionActive, reducedSystem,
        hintText, actions, panelTitle, islands, chrome = chrome) { }
    // MS-UI3 mount: the designed half sheets in place of the old ISLAND · COMING SOON panel, the old parcel card and the
    // archipelago island row's panel; c-gap-map: and of the old realm, warzone, chain-list and parcel-help panels. Each closes
    // through the HUD flow (X, Back) and acts only through existing owners. A new sheet rises 180 ms (SPEC §2.1 motion;
    // a 120 ms fade under reduced motion); its measured bounds are where it rests.
    if (sheet != WorldGlobeSheet.NONE) key(sheet) {
        val rise = remember { Animatable(0f) }
        LaunchedEffect(Unit) {
            rise.animateTo(1f, tween(if (reducedSystem) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.HALF_SHEET_IN, easing = PkwTokens.Motion.Out))
        }
        Box(Modifier.fillMaxSize().graphicsLayer {
            alpha = if (reducedSystem) rise.value else 1f
            translationY = if (reducedSystem) 0f else (1f - rise.value) * SHEET_RISE_DP * this.density
        }, contentAlignment = Alignment.BottomCenter) {
        val sheetModifier = Modifier.widthIn(max = 412.dp).onGloballyPositioned { c ->
            val p = c.positionInParent()
            sheetBounds = HudRect(p.x / density, p.y / density, c.size.width / density, c.size.height / density)
        }
        when (sheet) {
            WorldGlobeSheet.ISLAND -> ui.islandId?.let { island ->
                WorldIslandSheet(island, model, onClose = { model.select(null); apply(WorldHudFlow.deselect(ui)) }, onOpenPhaseE = onOpenPhaseE,
                    onOpenClanHall = onOpenClanHall, onFocusBuilding = focusBuilding, onBuildMenu = buildMenu, modifier = sheetModifier,
                    seekerAuction = seekerAuction, onCraftVehicle = craftVehicle)
            }
            WorldGlobeSheet.PARCEL -> if (current != null) {
                // Choose mode on a realm without a map: the next open deed from here, in the same sheet.
                val nextHere: (() -> Unit)? = ui.realmId?.takeIf { ui.intent == WorldHudIntent.CHOOSE_LAND }?.let { realm -> {
                    val from = current.selectedTileId ?: model.realmAnchorTile(realm)
                    from?.let { f -> openDeed(realm, f % columns, f / columns, ui.offered.toSet() + f) }?.let { c ->
                        model.select(c.tileId); setUi(ui.copy(offered = (ui.offered + c.tileId).takeLast(WorldHudFlow.OFFERED_MAX)))
                    }
                    Unit
                } }
                WorldParcelSheet(model, current, selectedBaseId, busy, columns, rows, realms.firstOrNull { it.id == ui.realmId }?.name, null,
                    onOpenLand, onOpenBases, onOpenBase, onClose = actions.deselect, onNextOpen = nextHere, onLookCloser = null, onHeight = {},
                    modifier = sheetModifier)
            }
            WorldGlobeSheet.ARCHIPELAGO -> ui.archipelagoId?.let { island ->
                // the starter journal is opened only for this sheet (its lazy repository is not the World tab's to start)
                val starter = remember(model) { model.starterExpedition }?.collectAsState()?.value
                // "No eligible vehicle → GO to the Solana Public Workshop" (SPEC §6) opens that island's sheet in place
                val workshop: (() -> Unit)? = if (islands.none { it.id == SOLANA_ISLAND }) null
                    else { { model.select(null); apply(PhaseEIslands.select(ui, SOLANA_ISLAND)) } }
                WorldArchipelagoSheet(island, model, realms, starter, onClose = actions.deselect, onFocusBuilding = focusBuilding,
                    onBuildMenu = buildMenu, modifier = sheetModifier, onPublicWorkshop = workshop)
            }
            WorldGlobeSheet.REALM -> realms.firstOrNull { it.id == ui.realmId }?.let { realm ->
                WorldRealmPlaceSheet(realm, mapped, bridge.diveReadiness, ui.mineCta, ui.intent == WorldHudIntent.CHOOSE_LAND, railArt.images[realm.id],
                    onEnterMap = actions.enterMap, onChooseLand = actions.chooseLand, onClose = actions.deselect, modifier = sheetModifier)
            }
            WorldGlobeSheet.WARZONE -> WorldWarzoneSheet(current?.warzone, current?.warzoneError, runCatching { model.warzoneCooldownHours }.getOrNull(),
                onShop = onOpenShop?.let { shop -> { apply(WorldHudFlow.deselect(ui)); shop() } }, onRefresh = { model.showWarzone(true) },
                onClose = actions.deselect, modifier = sheetModifier)
            WorldGlobeSheet.EXPLORE -> WorldExploreSheet(model.chains, ui.chainId,
                onChain = { id -> apply(WorldHudFlow.openPanel(ui.copy(chainId = id), GlobePanel.EXPLORE)) },
                onIsland = { id -> apply(WorldHudFlow.selectIsland(ui, id)) }, onClose = actions.deselect, modifier = sheetModifier)
            WorldGlobeSheet.PARCEL_HELP -> WorldParcelHelpSheet(current?.loading == true, onOpenBases, actions.deselect, sheetModifier)
            WorldGlobeSheet.NONE -> Unit
        }
        }
    }
    if (ui.globeSearch) {
        // The kingdoms of this query, or (empty query) the ones chosen before; GO resolves against the list on screen and
        // remembers the choice, so RECENT flies to that kingdom rather than to whatever the last query returned.
        val recentRows = recent.rows()
        WorldSearch(query, current?.search.orEmpty().map { kingdomSearchRow(model, realms, it) }, current?.searchBusy == true, current?.searchError,
            recentRows.map { kingdomSearchRow(model, realms, it) }, actions.query, { model.search(query) }, actions.toggleSearch) { row ->
            val source = if (query.isBlank()) recentRows else current?.search.orEmpty()
            source.firstOrNull { worldSearchRowId(it.realmId, it.tileId) == row.id }?.let { chosen -> recent.record(chosen); actions.openResult(chosen) }
        }
    }
    if (modeSheet) WorldModes(hudMode, ::selectMode, { modeSheet = false }, listOfNotNull(
        "Explore archipelagos" to actions.explore,
        "Your bases" to actions.bases,
        actions.campaign?.let { "Campaign" to it },
        if (!reducedSystem) (if (motionActive) "Pause globe motion" else "Resume globe motion") to actions.motion else null,
        (if (ui.night) "Day view" else "Night view") to actions.night,
    ))
}

@Composable private fun BoxScope.RealmLayer(model: WorldViewModel, current: WorldUiState?, ui: WorldHudUi, realms: List<GlobeRealmInfo>, bases: List<RealmHudBase>,
    filtered: List<RealmHudBase>, bridge: WorldHudBridge, W: Float, H: Float, safe: HudInsets, busy: Boolean, selectedBaseId: String?,
    onOpenLand: () -> Unit, onOpenBases: () -> Unit, columns: Int, rows: Int, apply: (HudStep) -> Unit, myBase: () -> RealmCard?,
    myBaseD: (String?) -> Double, onOpenBase: (String) -> Unit, onOpenShop: (() -> Unit)?, onHome: () -> Unit, onIsland: (String) -> Unit, onRealm: (String) -> Unit, openDeed: (String, Int, Int, Set<Int>) -> RealmCard?,
    resources: List<ResourceChipUi>, homeIcon: String, recent: WorldSearchRecent,
    setUi: (WorldHudUi) -> Unit) {
    val t = LocalHudType.current
    val density = LocalDensity.current.density
    val realmId = ui.realmId ?: return
    val realm = realms.firstOrNull { it.id == realmId }
    var query by remember(realmId) { mutableStateOf("") }
    var cardH by remember { mutableFloatStateOf(0f) }
    // The designed card sheet (kingdom or Reach tile) and its measured bounds in dp, a label obstacle while it is up.
    val cardSheet = worldRealmSheet(ui.card != null, current != null, current?.selected)
    var cardBounds by remember { mutableStateOf<HudRect?>(null) }
    val cardRects = listOfNotNull(cardBounds.takeIf { cardSheet != WorldRealmSheet.NONE })
    var hudMode by remember(realmId) { mutableStateOf(MapMode.KINGDOMS) }
    var modeSheet by remember { mutableStateOf(false) }
    var mapTools by remember { mutableStateOf(false) }
    var chromeBounds by remember { mutableStateOf(emptyList<Rect>()) }
    val chromeRects = chromeBounds.map { HudRect(it.left, it.top, it.width, it.height) }
    BackHandlerAt(BackPriority.SHEET, modeSheet) { modeSheet = false }
    val searchShown = ui.realmSearch || query.isNotBlank()
    // F9: the loaded bases first (ui.js), then the owner search (the globe's own debounced, 60/min read) for kingdoms
    // outside the loaded window: this realm's results join the list, other mapped realms are offered as "Go to ‹realm›".
    val serverQuery = query.trim().takeIf { searchShown && it.length >= 2 }
    LaunchedEffect(realmId) { model.search("") }
    val server = if (serverQuery == null) emptyList() else current?.search.orEmpty()
    val ownedTiles = current?.globe?.me?.ownedTiles
    val results = remember(query, bases, server, ownedTiles) {
        val local = RealmHudModel.search(bases, query)
        val have = local.mapTo(HashSet()) { it.tileId }; val mineTiles = ownedTiles.orEmpty().mapTo(HashSet()) { it.tileId }
        (local + server.filter { it.realmId == realmId && it.tileId !in have }
            .map { r -> RealmHudBase(r.tileId, r.tileId % columns, r.tileId / columns, r.name, r.keepLevel, r.tileId in mineTiles) }).take(8)
    }
    val mapped = bridge.mapRealms
    val elsewhere = remember(server, mapped, realms) {
        server.filter { it.realmId != realmId && it.realmId in mapped }.take(4)
            .map { r -> RealmElsewhere(r.tileId, r.realmId, realms.firstOrNull { it.id == r.realmId }?.name ?: r.realmId, r.name, r.keepLevel) }
    }
    val grid = bridge.realmGrid?.takeIf { it.realmId == realmId }
    // Camera → the scale label, "whole realm", the feed window (one read per settled window, never per frame).
    var scale by remember { mutableStateOf(60 to "2 deeds") }
    // The band readiness cue (ui.js W1 S2): while the zoom waits at a band gate the scale pill adds "· detail N%".
    val cue = bridge.bandGate?.label
    val scaleShown = if (cue == null) scale else scale.first to "${scale.second} · $cue"
    var wholeRealm by remember { mutableStateOf(false) }
    val tilesPerDeed = model.constant("BASE_GROUND_WORLD_GEOMETRY", "worldTiles")
    // F16: the WARZONE chip while the server says a warzone is active (`/globe/fantasy` warzone), its panel on demand.
    val warzoneActive = (current?.globe?.warzone?.get("active") as? JsonPrimitive)?.booleanOrNull == true
    val choose = ui.intent == WorldHudIntent.CHOOSE_LAND
    val rowsShown = results.size + elsewhere.size
    // D-169 + D-181 + D-191: Unshielded only once the feed has carried the bit (server PR #147); clan and attackable stay hidden
    val chips = HudChips.realm(current?.shieldFed == true)
    val shown = WorldHudFlow.shownFilter(ui.filter, chips) // the filter as the chips can show it (D-191); ui.filter as chosen
    val plan = remember(W, H, safe, t, grid, shown, ui.card != null, cardH, ui.miniOpen, ui.miniPin, wholeRealm, ui.levelOpen, searchShown, rowsShown, query, scaleShown, realm,
        warzoneActive, ui.warzoneOpen, choose, chips) {
        val (lg, sm) = shown.levelLabels()
        RealmHudPlan.plan(RealmHudPlan.Input(W, H, safe, t, grid?.cols, grid?.rows, chips, lg, sm, realm?.name ?: realmId,
            RealmHudModel.subtitle(realm?.deeds, realm?.kingdoms, filtered.size, shown.active), if (ui.card != null) maxOf(cardH, 1f) else 0f,
            ui.miniOpen, ui.miniPin, wholeRealm, ui.levelOpen, searchShown, if (!searchShown || query.isBlank()) 0 else rowsShown.takeIf { it > 0 } ?: -1,
            scaleShown.first, scaleShown.second, warzone = warzoneActive || ui.warzoneOpen, warzoneOpen = ui.warzoneOpen, choose = choose))
    }
    // c-gap-map: the warzone status and the LV range are designed half sheets now (realmPanelSheet below), measured where they
    // rest; the old dark panels at the plan's "level" / "warzonePanel" rects are no longer drawn.
    val panelSheet = realmPanelSheet(ui.card != null, searchShown, ui.warzoneOpen, ui.levelOpen)
    var panelBounds by remember { mutableStateOf<HudRect?>(null) }
    val auxiliaryRects = buildMap {
        if (mapTools && !ui.realmSearch && ui.card == null && !ui.warzoneOpen && !ui.levelOpen)
            putAll(worldChromeMinimap(plan, W, H, safe))
    }
    val labelRects = chromeRects + auxiliaryRects.values + listOfNotNull(plan.rect("card")) + cardRects +
        listOfNotNull(panelBounds.takeIf { panelSheet != RealmPanelSheet.NONE })
    UiRectsEffect(bridge, labelRects, density)
    LaunchedEffect(plan, ui.card != null) { bridge.realmFocusOffset = plan.focusOffset(ui.card != null) }
    LaunchedEffect(auxiliaryRects["minimap"], bridge.controls) { bridge.controls?.minimapRect(auxiliaryRects["minimap"]?.let { r -> floatArrayOf(r.x * density, r.y * density, r.w * density, r.h * density) }) }

    val board = remember { LabelBoard<WorldLabels.RealmLabel>(64) }
    val labelRectsNow by rememberUpdatedState(labelRects)
    val planNow by rememberUpdatedState(plan); val filteredNow by rememberUpdatedState(filtered); val uiNow by rememberUpdatedState(ui)
    val selectedNow by rememberUpdatedState(bases.firstOrNull { it.tileId == ui.card?.tileId })
    LaunchedEffect(bridge, realmId, grid, W, H, t, columns) {
        var lastWindow: WorldRealmFeed.Window? = null
        // the last inputs the labels were placed for: a still camera over the same kingdoms and HUD skips the frame
        var lastView: WorldLabels.RealmView? = null; var lastPlan: RealmHudPlan? = null; var lastBases: List<RealmHudBase>? = null
        var lastSelected: RealmHudBase? = null; var lastCard = false; var lastChrome: List<HudRect>? = null
        snapshotFlow { bridge.frameTick.longValue }.collectLatest {
            val f = bridge.latestFrame(); val g = grid
            if (f == null || f.engine != WorldEngine.REALM || g == null) {
                if (lastView != null || board.items.isNotEmpty()) { board.publish(emptyList(), FloatArray(0), FloatArray(0)); RealmLabelsState.clear() }
                lastView = null; return@collectLatest
            }
            val s = f.cameraScale / bridge.dpr; if (s <= 0.0) return@collectLatest
            val view = WorldLabels.RealmView(g.x0 + f.cameraX, g.y0 + f.cameraY, s, f.cameraScale, W.toDouble(), H.toDouble())
            val p = planNow; val bs = filteredNow; val sel = selectedNow; val cardOpen = uiNow.card != null
            // Smoothness (D-177): the engine ticks every frame, but the labels, the scale bar and the feed window only change
            // when the camera, the kingdoms or the HUD do; a still map does no label work, allocation or layout pass.
            if (view == lastView && p === lastPlan && bs === lastBases && sel == lastSelected && cardOpen == lastCard && labelRectsNow == lastChrome) return@collectLatest
            lastView = view; lastPlan = p; lastBases = bs; lastSelected = sel; lastCard = cardOpen; lastChrome = labelRectsNow
            val res = WorldLabels.realm(bs, sel, cardOpen, view, columns, labelRectsNow.map { it.ltrb(RealmHudModel.PAD.toFloat()) }, p.safeBox.ltrb(), t)
            board.publish(res.labels, res.xs, res.ys)
            RealmLabelsState.set(res.counters, density, f.cameraScale, columns, res)
            tilesPerDeed?.let { scale = RealmHudModel.scaleBar(s, it) }
            val halfW = W / 2 / s; val halfH = H / 2 / s
            wholeRealm = f.cameraX - halfW <= 0.015 * g.cols && f.cameraX + halfW >= 0.985 * g.cols && f.cameraY - halfH <= 0.015 * g.rows && f.cameraY + halfH >= 0.985 * g.rows
            val window = WorldRealmFeed.Window(view.camX - halfW, view.camY - halfH, view.camX + halfW, view.camY + halfH)
            if (window != lastWindow) { lastWindow = window; model.realmWindow(window, realmId) }
        }
    }
    DisposableEffect(realmId) { onDispose { RealmLabelsState.clear() } }
    CompositionLocalProvider(LocalHudAccent provides HudAccent(HudRealms.accent(realmId))) {
        LabelLayer(board, { it.key }) { label ->
            when (label) {
                is WorldLabels.CounterLabel -> HudCount(label.n, label.mine)
                // c-gap-map: your kingdom wears the designed gold YOU plate in its tag's place (map-realm.png); others keep their tag
                is WorldLabels.TagLabel -> if (label.base.mine) RealmYouPlate(label.base.shield == true,
                    RealmHudModel.tagW(label.name, label.level, label.big, t.cap.toDouble(), t.body.toDouble()), if (label.big) 36.0 else 24.0)
                    else HudNametag(label.name, label.level, label.base.mine, label.big, avatarUrl = label.base.avatarUrl, avatars = model.realmAvatars)
            }
        }
        fun select(b: RealmHudBase, d: Double = HudBands.SELECT_D) { apply(WorldHudFlow.selectDeed(ui.copy(realmSearch = false), RealmCard(b.tileId, b.x, b.y), fly = true, d = d)) }
        /** Choose mode's "Next open deed ▶": the nearest candidate from the card (or the view centre) not offered yet. */
        fun nextOpen() {
            val g = grid; val f = bridge.latestFrame()?.takeIf { it.engine == WorldEngine.REALM }
            val from = ui.card?.let { it.x to it.y } ?: if (g == null) null else
                (g.x0 + kotlin.math.floor(f?.cameraX ?: (g.cols / 2.0)).toInt()) to (g.y0 + kotlin.math.floor(f?.cameraY ?: (g.rows / 2.0)).toInt())
            from ?: return
            val skip = HashSet(ui.offered); ui.card?.let { skip += it.tileId }
            apply(WorldHudFlow.nextOpenDeed(ui, openDeed(realmId, from.first, from.second, skip)))
        }
        val actions = RealmHudActions(
            exit = { apply(WorldHudFlow.leave(ui)) },
            zoom = { bridge.controls?.zoom(it) },
            // ME never does nothing (c-gap-map): your kingdom here; else your kingdom in its own realm (a mapped realm dives
            // there with it selected, any other opens on the globe); with no kingdom on the map, it says so.
            myBase = {
                val here = myBase()
                val home = if (here != null) null else ownedTiles?.let { list -> list.firstOrNull { it.selected } ?: list.firstOrNull { it.active } ?: list.firstOrNull() }
                when {
                    here != null -> apply(WorldHudFlow.selectDeed(ui, here, fly = true, d = myBaseD(realmId)))
                    home == null -> Toasts.post(NO_KINGDOM_ON_MAP)
                    home.realmId in mapped -> apply(WorldHudFlow.jump(ui, home.realmId, RealmCard(home.tileId, home.tileId % columns, home.tileId / columns)))
                    else -> onRealm(home.realmId)
                }
            },
            step = { dir ->
                val f = bridge.latestFrame(); val g = grid
                val sel = bases.firstOrNull { it.tileId == ui.card?.tileId }
                RealmHudModel.step(filtered, sel, (g?.x0 ?: 0) + (f?.cameraX ?: 0.0), (g?.y0 ?: 0) + (f?.cameraY ?: 0.0), dir)?.let { select(it) }
            },
            filter = { kind ->
                val step = WorldHudFlow.setFilter(ui, ui.filter.copy(kind = kind), chips); apply(step)
                if (kind == "mine") bases.firstOrNull { it.mine }?.let { b -> apply(WorldHudFlow.selectDeed(step.ui, RealmCard(b.tileId, b.x, b.y), fly = true)) }
            },
            level = { index, value -> apply(WorldHudFlow.setFilter(ui, ui.filter.withLevel(index, value), chips)) },
            toggleLevel = { setUi(ui.copy(levelOpen = !ui.levelOpen)) },
            toggleSearch = { query = ""; model.search(""); setUi(ui.copy(realmSearch = !ui.realmSearch, card = null, levelOpen = false, warzoneOpen = false)) },
            query = { query = it; model.search(it.trim().takeIf { q -> q.length >= 2 }.orEmpty()) },
            choose = { b -> query = ""; model.search(""); select(b) },
            toggleMinimap = { setUi(WorldHudFlow.toggleMinimap(ui, plan.miniShown, plan.portrait && ui.card != null)) },
            minimap = { g -> bridge.controls?.minimap(g) },
            closeCard = { apply(WorldHudFlow.selectDeed(ui, null, fly = false)) },
            warzone = { setUi(WorldHudFlow.toggleWarzone(ui)) },
            nextOpen = ::nextOpen,
            jump = { e -> query = ""; model.search(""); apply(WorldHudFlow.jump(ui, e.realmId, RealmCard(e.tileId, e.tileId % columns, e.tileId / columns))) },
        )
        // ui.js `look`: fly in on the selected deed at the base distance (F7: MAP's select distance without ready detail)
        val lookCloser = { ui.card?.let { c -> bridge.offer(WorldIntent.FlyTo(WorldTarget.Deed(realmId, c.x, c.y), myBaseD(realmId))) }; Unit }
        val islands = rememberPhaseEChips()
        val homeRealm = ownedTiles?.let { list -> list.firstOrNull { it.selected } ?: list.firstOrNull { it.active } ?: list.firstOrNull() }?.realmId
        val rail = worldChromeRail(realms, islands.map { it.id }, homeRealm)
        var artRetry by remember { mutableIntStateOf(0) }
        val railArt = rememberWorldRailArt(rail, artRetry)
        fun selectMode(mode: MapMode) {
            modeSheet = false; hudMode = mode
            when (mode) {
                MapMode.EXPLORE -> actions.exit()
                MapMode.WARZONE -> if (!ui.warzoneOpen) actions.warzone()
                MapMode.KINGDOMS -> if (ui.warzoneOpen) actions.warzone()
            }
        }
        // This owner has no empty-feed completion signal: an untouched Int(0) is not an observed zero.
        val feedObserved = current?.realmMarkers?.isNotEmpty() == true
        val chrome: @Composable () -> Unit = {
            MapHud(MapHudUi(MapScreen.REALM, hudMode, realm?.name ?: realmId,
                realmChromeSubtitle(realm?.kingdoms, cue), resources, rail, realmId,
                chips = if (hudMode == MapMode.KINGDOMS) worldChromeFilters(bases, shown,
                    feedObserved, current?.shieldFed == true) else emptyList(),
                panelOpen = ui.card != null || searchShown || ui.levelOpen || ui.warzoneOpen || modeSheet,
                bandPill = when {
                    choose && ui.card == null -> MapPillUi("next-open", "Choose an open deed", "NEXT")
                    current?.realmTruncated == true -> MapPillUi("nearby", "Showing nearby kingdoms · zoom closer")
                    filtered.isEmpty() && shown.active && feedObserved -> MapPillUi("all", "No kingdoms match", "ALL")
                    else -> null
                }, topPill = if (railArt.missing.isNotEmpty() && ui.card == null && !searchShown && !ui.levelOpen && !ui.warzoneOpen && !modeSheet)
                    MapPillUi("art", "Some map thumbnails did not load", "RETRY") else null,
                resourcesEnabled = false, homeIcon = homeIcon),
                MapHudActions(onHome = onHome, onSearch = actions.toggleSearch, onZoom = actions.zoom,
                    onMe = actions.myBase, onMode = { selectMode(nextMode(hudMode)) }, onModeLong = { modeSheet = true },
                    onChip = { if (it == "lvl") actions.toggleLevel() else actions.filter(it) },
                    onPill = { when (it) { "all" -> apply(WorldHudFlow.setFilter(ui, RealmFilter(), chips)); "next-open" -> actions.nextOpen(); "art" -> artRetry++ } },
                    onRail = { id ->
                        val island = worldIslandDestination(id)
                        if (island != null) onIsland(island)
                        else if (id != realmId) {
                            val tile = if (id in mapped) model.realmAnchorTile(id) else null
                            if (tile != null) apply(WorldHudFlow.jump(ui, id, RealmCard(tile, tile % columns, tile / columns)))
                            else onRealm(id)
                        }
                        // c-gap-map: this realm's own tile is a door too (SPEC §1.4 "fly the camera to the realm"): back
                        // over the realm's centre at the map band's opening distance
                        else grid?.let { g -> bridge.offer(WorldIntent.FlyTo(WorldTarget.Deed(realmId, g.x0 + g.cols / 2, g.y0 + g.rows / 2), HudBands.MAP_START_D)) }
                    }), railArt = { tile -> WorldRailImage(tile, railArt) }, onChromeBounds = { chromeBounds = it })
        }
        RealmMapHud(plan, ui.copy(filter = shown), realm?.name ?: realmId, RealmHudModel.subtitle(realm?.deeds, realm?.kingdoms, filtered.size, shown.active),
            chips, query, results, scaleShown, filtered.size, actions, { cardH = it }, card = null, elsewhere = elsewhere, warzone = null, chrome = chrome, auxiliaryRects = auxiliaryRects, shownCountKnown = feedObserved,
            levelPanel = false)
        // c-gap-map: the warzone status and the LV range as designed half sheets (the old dark panels are gone); one at a time,
        // never over a card or the search drawer. Each closes through its own toggle, as the old panels' X did.
        if (panelSheet != RealmPanelSheet.NONE) {
            val panelModifier = Modifier.align(Alignment.BottomCenter).widthIn(max = 412.dp).onGloballyPositioned { c ->
                val p = c.positionInParent()
                panelBounds = HudRect(p.x / density, p.y / density, c.size.width / density, c.size.height / density)
            }
            if (panelSheet == RealmPanelSheet.WARZONE) WorldWarzoneSheet(current?.warzone, current?.warzoneError,
                runCatching { model.warzoneCooldownHours }.getOrNull(), onShop = onOpenShop?.let { shop -> { setUi(ui.copy(warzoneOpen = false)); shop() } },
                onRefresh = { model.showWarzone(true) }, onClose = actions.warzone, modifier = panelModifier)
            else WorldLevelSheet(ui.filter.lo, ui.filter.hi, actions.level,
                onAll = { apply(WorldHudFlow.setFilter(ui.copy(levelOpen = false), ui.filter.copy(lo = RealmFilter().lo, hi = RealmFilter().hi), chips)) },
                onClose = actions.toggleLevel, modifier = panelModifier)
        }
        // MS-UI3 mount: the designed card in place of the old dark base card (RealmMapHud draws none now). It still drives the
        // card plan (cardH), the focus offset and the label obstacles; X and Back close it through the HUD flow.
        if (current != null && cardSheet != WorldRealmSheet.NONE) {
            val cardModifier = Modifier.align(Alignment.BottomStart).widthIn(max = 412.dp).onGloballyPositioned { c ->
                val p = c.positionInParent()
                cardBounds = HudRect(p.x / density, p.y / density, c.size.width / density, c.size.height / density)
            }
            if (cardSheet == WorldRealmSheet.REACH) WorldReachTileSheet(current, columns, onClose = actions.closeCard, onHeight = { cardH = it }, modifier = cardModifier)
            else WorldParcelSheet(model, current, selectedBaseId, busy, columns, rows, realm?.name, bases.firstOrNull { it.tileId == ui.card?.tileId },
                onOpenLand, onOpenBases, onOpenBase, onClose = actions.closeCard, onNextOpen = if (choose) ::nextOpen else null,
                onLookCloser = lookCloser, onHeight = { cardH = it }, modifier = cardModifier)
        }
        if (searchShown) {
            // map-search.png rows: "Name · Lv 12" over "Frostveil · no shield" (the shield only where the map's read carried it)
            val rowsHere = results.map { b -> SearchRowUi(worldSearchRowId(realmId, b.tileId), SearchKind.KINGDOM, model.keepPortrait(b.level),
                    searchRowTitle(b.name, b.level), searchRowPlace(realm?.name ?: realmId, b.shield, null)) } +
                elsewhere.map { e -> SearchRowUi(worldSearchRowId(e.realmId, e.tileId), SearchKind.KINGDOM, model.keepPortrait(e.level),
                    searchRowTitle(e.name, e.level), searchRowPlace(e.realmName, null, null)) }
            // RECENT here lists only kingdoms this map can fly to (this realm, or another realm with a map), so no GO is dead
            val recentRows = recent.rows().filter { it.realmId == realmId || it.realmId in mapped }
            // The owner search is this list's second half: its dots and failure count only while it runs (2+ letters), and a
            // failure never hides the loaded kingdoms that did match.
            WorldSearch(query, rowsHere, serverQuery != null && current?.searchBusy == true,
                current?.searchError?.takeIf { serverQuery != null && rowsHere.isEmpty() }, recentRows.map { kingdomSearchRow(model, realms, it) },
                actions.query, { model.search(query.trim().takeIf { it.length >= 2 }.orEmpty()) }, actions.toggleSearch) { row ->
                // A kingdom known only from the loaded map has no owner-search row, so it is not remembered: RECENT keeps
                // the search's own rows, never a row with fields the read did not send.
                if (query.isBlank()) {
                    recentRows.firstOrNull { worldSearchRowId(it.realmId, it.tileId) == row.id }?.let { r ->
                        recent.record(r)
                        if (r.realmId == realmId) actions.choose(RealmHudBase(r.tileId, r.tileId % columns, r.tileId / columns, r.name, r.keepLevel,
                            ownedTiles.orEmpty().any { it.tileId == r.tileId }))
                        else actions.jump(RealmElsewhere(r.tileId, r.realmId, realms.firstOrNull { it.id == r.realmId }?.name ?: r.realmId, r.name, r.keepLevel))
                    }
                } else {
                    results.firstOrNull { worldSearchRowId(realmId, it.tileId) == row.id }?.let { b ->
                        server.firstOrNull { it.realmId == realmId && it.tileId == b.tileId }?.let(recent::record); actions.choose(b)
                    } ?: elsewhere.firstOrNull { worldSearchRowId(it.realmId, it.tileId) == row.id }?.let { e ->
                        server.firstOrNull { it.realmId == e.realmId && it.tileId == e.tileId }?.let(recent::record); actions.jump(e)
                    }
                }
            }
        }
        if (modeSheet) WorldModes(hudMode, ::selectMode, { modeSheet = false }, listOfNotNull(
            "Back to globe" to actions.exit,
            (if (mapTools) "Hide minimap" else "Show minimap") to { mapTools = !mapTools; if (!ui.miniOpen) actions.toggleMinimap() },
            "Previous kingdom" to { actions.step(-1) }, "Next kingdom" to { actions.step(1) },
            if (choose) "Next open deed" to actions.nextOpen else null,
        ))
    }
}

/** Report every control's bounds to the engines (dp → VIEW px), only when they change (SetUiRects, plan §3.6). */
@Composable private fun UiRectsEffect(bridge: WorldHudBridge, rects: List<HudRect>, density: Float) {
    val key = rects.map { listOf(it.x, it.y, it.w, it.h) }
    LaunchedEffect(key, bridge) {
        val out = FloatArray(rects.size * 4)
        rects.forEachIndexed { i, r -> out[i * 4] = r.x * density; out[i * 4 + 1] = r.y * density; out[i * 4 + 2] = r.w * density; out[i * 4 + 3] = r.h * density }
        bridge.offer(WorldIntent.SetUiRects(out, rects.size))
    }
}

/** One owner-search kingdom row (map-search): its keep portrait, name and "‹realm› · LV n"; the id carries realm and tile. */
private fun kingdomSearchRow(model: WorldViewModel, realms: List<GlobeRealmInfo>, result: FantasySearchResult): SearchRowUi =
    SearchRowUi(worldSearchRowId(result.realmId, result.tileId), SearchKind.KINGDOM, model.keepPortrait(result.keepLevel),
        searchRowTitle(result.name, result.keepLevel),
        searchRowPlace(realms.firstOrNull { it.id == result.realmId }?.name ?: result.realmId, null, result.trophies))

/**
 * The map Search drawer (SPEC §2.4) over the existing owner search, which does its own debounce. A query shows its
 * KINGDOMS (there is no spot source, so no SPOTS section and the hint stays "kingdom name"); an empty query shows
 * [recent] as RECENT. [busy] draws the field's dots, [error] the drawer's line with RETRY ([onRetry] runs the same query
 * again). Row IDs resolve against the retained source objects at GO time.
 */
@Composable private fun WorldSearch(query: String, rows: List<SearchRowUi>, busy: Boolean, error: String?, recent: List<SearchRowUi>,
    onQuery: (String) -> Unit, onRetry: () -> Unit, onClose: () -> Unit, onGo: (SearchRowUi) -> Unit) {
    var expanded by remember(query) { mutableStateOf(emptySet<String>()) }
    BackHandlerAt(BackPriority.SHEET) { onClose() }
    val sections = if (query.isBlank()) listOfNotNull(recent.takeIf { it.isNotEmpty() }?.let { SearchSectionUi("RECENT", it) })
        else listOf(SearchSectionUi("KINGDOMS", rows, more = rows.size > 3))
    MapSearchDrawer(MapSearchUi(query, busy, sections, error = error),
        MapSearchActions(onQuery = onQuery, onGo = onGo, onMore = { expanded = expanded + it }, onRetry = onRetry, onClose = onClose),
        searchManagedExternally = true, expandedSections = expanded, emptyMessage = "No kingdoms returned yet", queryHint = "kingdom name")
}

/** The three named modes and the existing secondary destinations; no old dark dock remains underneath. */
@Composable private fun WorldModes(mode: MapMode, onMode: (MapMode) -> Unit, onClose: () -> Unit,
    extras: List<Pair<String, () -> Unit>>) {
    Box(Modifier.fillMaxSize()) {
        // A map half sheet has no dark scrim (SPEC §1.6; owner 2026-10-06 "dark overlap ... is ugly"): a tap on the map
        // around it still closes it, through a clear layer.
        ModalScrim(0f, onClose)
        MapSheetFrame("MAP MODE", null, onClose, Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.safeDrawing)) {
            MapMode.entries.forEach { item ->
                MapRow(onClick = { onMode(item) }) {
                    MapIcon(modeIcon(item), 32.dp)
                    ParchLine(item.name + if (item == mode) " · SELECTED" else "")
                }
            }
            if (extras.isNotEmpty()) MapSectionHeader("MAP TOOLS")
            extras.forEach { (label, action) -> MapRow(onClick = { onClose(); action() }) { ParchLine(label) } }
        }
    }
}

private data class WorldRailArt(val images: Map<String, ImageBitmap> = emptyMap(), val missing: Set<String> = emptySet())

/** The rail thumbnails decoded in this process, by tile id and target size. The bundled paintings never change inside an
 *  APK, so each is read, verified and decoded once (11 thumbnails, well under 1 MB) instead of on every MAP visit and every
 *  globe ↔ realm switch (c-gap-map: the rail filled a beat after the HUD, with ~12 MB read and hashed each time). */
private object WorldRailArtCache {
    private val images = java.util.concurrent.ConcurrentHashMap<String, ImageBitmap>()
    private fun key(id: String, px: Int) = "$id@$px"
    fun get(id: String, px: Int): ImageBitmap? = images[key(id, px)]
    fun put(id: String, px: Int, image: ImageBitmap) { images[key(id, px)] = image }
}

/** Small, verified copies in memory of the bundled paintings; never a full 2048px UI decode or an asset mutation. A
 *  thumbnail decoded before is on screen in the first frame ([WorldRailArtCache]); only the others are read. */
@Composable private fun rememberWorldRailArt(rail: List<RailTileUi>, retry: Int = 0): WorldRailArt {
    val assets = LocalContext.current.assets
    val targetPx = (80f * LocalDensity.current.density).toInt().coerceIn(80, 320)
    val ids = rail.map { it.id }
    val cached = remember(ids, targetPx) { WorldRailArt(ids.mapNotNull { id -> WorldRailArtCache.get(id, targetPx)?.let { id to it } }.toMap()) }
    val result by produceState(cached, assets, ids, targetPx, retry) {
        if (ids.all { WorldRailArtCache.get(it, targetPx) != null }) { value = cached; return@produceState }
        value = withContext(Dispatchers.IO) {
            val files = gg.pixelkingdomwars.nativeclient.scene.world.AssetWorldFiles(assets)
            val images = mutableMapOf<String, ImageBitmap>()
            val missing = mutableSetOf<String>()
            for (id in ids) {
                kotlinx.coroutines.currentCoroutineContext().ensureActive()
                val known = WorldRailArtCache.get(id, targetPx)
                if (known != null) { images[id] = known; continue }
                try {
                    val sourceId = worldIslandDestination(id) ?: id
                    // IDs are catalogue data, but are still restricted to a single bundled filename.
                    require(sourceId.matches(Regex("[a-z][a-z0-9-]*")))
                    val path = "$sourceId.webp"
                    val expected = files.expectedSha256(path)?.takeIf { it.isNotBlank() } ?: error("Unlisted art")
                    val bytes = files.read(path) ?: error("Missing art")
                    val actual = java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
                        .joinToString("") { "%02x".format(it.toInt() and 255) }
                    require(actual.equals(expected, ignoreCase = true))
                    val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true; inScaled = false }
                    android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    require(bounds.outWidth > 0 && bounds.outHeight > 0)
                    var sample = 1
                    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > targetPx) sample *= 2
                    val options = android.graphics.BitmapFactory.Options().apply {
                        inSampleSize = sample; inScaled = false; inPreferredConfig = android.graphics.Bitmap.Config.ARGB_8888
                    }
                    val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: error("Undecodable art")
                    val image = bitmap.asImageBitmap()
                    images[id] = image
                    WorldRailArtCache.put(id, targetPx, image) // only a verified, decoded thumbnail is kept
                } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
                catch (_: Exception) { missing += id }
            }
            WorldRailArt(images, missing)
        }
    }
    return result
}

@Composable private fun BoxScope.WorldRailImage(tile: RailTileUi, art: WorldRailArt) {
    val bitmap = art.images[tile.id]
    if (bitmap != null) Image(bitmap, contentDescription = null, modifier = Modifier.size(72.dp, 52.dp),
        contentScale = ContentScale.Fit, filterQuality = FilterQuality.None)
    else if (tile.icon != null) MapIcon(tile.icon, 32.dp)
    else ParchLine(tile.caption.take(1))
}
