package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.WorldContentProgress
import gg.pixelkingdomwars.nativeclient.data.WorldContentSession
import gg.pixelkingdomwars.nativeclient.data.WorldOpenDeeds
import gg.pixelkingdomwars.nativeclient.data.WorldParcelFailure
import gg.pixelkingdomwars.nativeclient.data.WorldParcelReads
import gg.pixelkingdomwars.nativeclient.data.WorldRealmFeed
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.RaidCreateTarget
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.world.WorldLog
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import java.io.File

/** The rendered directory is always keyed to selected-base identity, even before cancellation runs. */
data class WorldUiState(
    val baseId: String? = null, val globe: FantasyGlobe? = null, val selected: FantasyParcel? = null,
    val selectedTileId: Int? = null, val markers: List<FantasyMarker> = emptyList(), val search: List<FantasySearchResult> = emptyList(),
    val matched: Int = 0, val truncated: Boolean = false, val loading: Boolean = false,
    val error: String? = null, val artError: String? = null, val art: File? = null,
    val artProgress: WorldContentProgress? = null,
    val artSource: GlobeAssetSource? = null,
    val selectedAtNanos: Long=0, val warzone: WorldWarzone?=null, val warzoneError:String?=null,
    val view: GlobeView = GlobeView(), val viewport: GlobeViewport = GlobeViewport(0,0),
    val realmId: String = "crownlands",
    /** Realm map (N2): the kingdoms of the visible deed window, from the same bounded parcel-viewport read as the globe. */
    val realmMarkers: List<FantasyMarker> = emptyList(), val realmMatched: Int = 0, val realmTruncated: Boolean = false,
    /** A parcels read (globe or realm) has carried markers' `shielded` (D-181, server PR #147): only then does the realm
     *  map offer the UNSHIELDED chip (D-191, [HudChips.realm]). Sticky: a server capability, not a per-window fact. */
    val shieldFed: Boolean = false,
    /** The selected parcel's last refused or failed metered read (land gate, 429, other), for the card's words and RETRY. */
    val parcelFailure: WorldParcelFailure? = null,
    /** map-search (SPEC §2.4): an owner search is waiting or running (the drawer's dots), and the last one's failure in its
     *  own words (the drawer's line + RETRY). A search never sets [error], so a failed search never blanks the map. */
    val searchBusy: Boolean = false, val searchError: String? = null,
)

class WorldViewModel(private val graph: AppGraph, private val session: SessionGraph) : ScreenViewModel() {
    /** The app graph, read only: the archipelago sheet's route-art source ([rememberHomeVoyageArt][gg.pixelkingdomwars.nativeclient.ui.home.rememberHomeVoyageArt]). */
    internal val appGraph: AppGraph get() = graph
    /** The session graph, read only, for the same route-art source (it opens the world-content session only while art decodes). */
    internal val sessionGraph: SessionGraph get() = session
    var displayDensity=1.0
    private val deedImages=gg.pixelkingdomwars.nativeclient.data.WorldDeedPreview(graph.origin)
    private val _state = MutableStateFlow(WorldUiState())
    val state = _state.asStateFlow()
    /** The Home read of the selected base (`/base`), read only: the realm map's own shield dome ([WorldOwnShield]). */
    val home: StateFlow<gg.pixelkingdomwars.nativeclient.data.BaseState> get() = session.base.state
    /** The admitted content catalogue, read only: the island sheets' counts and switches ([WorldIslandSheet]). */
    val catalogue: JsonObject? get() = graph.content.state.value.catalogue
    /** The session's clan read, read only: the Divine panel's Clan Citadels door (null membership = not read yet). */
    val clans: StateFlow<gg.pixelkingdomwars.nativeclient.data.ClansState> get() = session.clans.state
    /** The starter expedition journal, read only; null when its journal cannot be opened (a corrupt journal throws). */
    val starterExpedition: StateFlow<gg.pixelkingdomwars.nativeclient.data.StarterExpeditionState>? get() = runCatching { session.starterExpedition.state }.getOrNull()
    /** The starter fleet journal, read only; null when its journal cannot be opened (a corrupt journal throws). */
    val starterFleet: StateFlow<gg.pixelkingdomwars.nativeclient.data.StarterFleetState>? get() = runCatching { session.starterFleet.state }.getOrNull()
    private var screen: Job? = null
    private var artRead: Job? = null
    private var worldScope: CoroutineScope? = null
    private var viewportRead: Job? = null; private var parcelRead: Job? = null; private var searchRead: Job? = null
    private var warzoneRead:Job?=null;private var warzoneRequested=false
    private var realmRead: Job? = null; private var realmWindowKey: List<Int>? = null
    private var foregroundEpoch: Any? = null
    private val leases = mutableMapOf<Any,WorldContentSession>()
    /** The card dwell rule and the per-tile cache of the metered parcel read (GLOBE-PRODUCTION-PLAN §2.6.4). */
    private val parcels = WorldParcelReads()
    val presentation: JsonObject? get() = (graph.content.state.value.renderCatalogue?.get("fantasy") as? JsonObject)?.get("presentation") as? JsonObject
    val regions: List<JsonObject> get() = (presentation?.get("regions") as? JsonArray).orEmpty().map { it.jsonObject }
    val chains: List<JsonObject> get() = (presentation?.get("chains") as? JsonArray).orEmpty().map { it.jsonObject }
    val details: List<GlobeDetailSource> get() = (presentation?.get("regionalDetails") as? JsonArray).orEmpty().map { element ->
        val d=element.jsonObject
        GlobeDetailSource(requireNotNull(d.string("id")), d.getValue("west").jsonPrimitive.float,d.getValue("east").jsonPrimitive.float,d.getValue("south").jsonPrimitive.float,d.getValue("north").jsonPrimitive.float,d.getValue("width").jsonPrimitive.int,d.getValue("height").jsonPrimitive.int,d.getValue("filterScale").jsonPrimitive.float)
    }
    val artSpec: GlobeArt? get() {
        val p=presentation ?: return null
        val shape=p["islands"] as? JsonObject ?: return null
        val ocean=p["ocean"] as? JsonObject ?: return null
        val cloud=p["clouds"] as? JsonObject ?: return null
        val effects=p.string("effectsPath") ?: return null
        val catalog=graph.fantasyCatalog() ?: return null
        require(ocean.string("encoding")=="ieee754-float32-big-endian-rgba")
        val islands=chains.flatMapIndexed { chain,c -> c.getValue("islands").jsonArray.mapIndexed { slot,i ->
            val v=i.jsonObject
            GlobeIsland(chain,slot,v.getValue("lon").jsonPrimitive.double,v.getValue("lat").jsonPrimitive.double,v.getValue("rx").jsonPrimitive.double,v.getValue("ry").jsonPrimitive.double)
        } }
        return GlobeArt(chains.map { requireNotNull(it.string("id")) },islands,shape.getValue("cell").jsonPrimitive.int,shape.getValue("atlas").jsonPrimitive.int,shape.getValue("extent").jsonPrimitive.double,
            requireNotNull(ocean.string("path")),ocean.getValue("width").jsonPrimitive.int,ocean.getValue("height").jsonPrimitive.int,ocean.getValue("stops").jsonArray.map { it.jsonArray.map { v->v.jsonPrimitive.float }.toFloatArray() },
            requireNotNull(cloud.string("path")),cloud.getValue("bankWidth").jsonPrimitive.int,cloud.getValue("bankHeight").jsonPrimitive.int,cloud.getValue("banks").jsonArray.map { b->val v=b.jsonArray.map { it.jsonPrimitive.double };GlobeCloudBank(v[0],v[1],v[2],v[3]) },
            effects,catalog.columns,catalog.rows,catalog::isLand,catalog::isGenesis,{lon,lat->catalog.isGenesis(GlobeGeometry.tileAt(lon,lat,catalog.columns,catalog.rows))})
    }
    private fun bound(name: String, key: String): Int = requireNotNull((graph.content.state.value.catalogue?.get("constants") as? JsonObject)?.get(name) as? JsonObject)
        .getValue(key).jsonPrimitive.int.also { require(it > 0) }
    private fun current(base: String?) = graph.holder.isCurrent(session.session) && graph.account.state.value.selectedBaseId == base
    private fun publish(base: String?, change: (WorldUiState)->WorldUiState) { if (current(base)) _state.update(change) }
    private suspend fun read(base: String?, block: suspend ()->Unit) {
        try { block() } catch (error: CancellationException) { throw error }
        catch (error: Exception) { publish(base) { it.copy(error=error.message ?: "World read interrupted. Please retry.",loading=false) } }
    }
    /** Called within repeatOnLifecycle(STARTED). Hidden tabs do not poll or retain private responses. */
    suspend fun foreground(base: String?): Unit = coroutineScope {
        screen?.cancel(); screen=currentCoroutineContext()[Job];worldScope=this
        val epoch=Any();foregroundEpoch=epoch
        parcels.clear() // detail (actions, reach) is per viewing base: never reuse another entry's reads
        val prior=_state.value
        _state.value=WorldUiState(baseId=base,view=prior.view,viewport=prior.viewport,realmId=prior.realmId,loading=true)
        artRead=launch { loadArt(base,epoch) }
        launch {
            while (isActive) {
                read(base) {
                    session.world.refreshGlobe()
                    publish(base) { it.copy(globe=session.world.state.value.globe,loading=false,error=null) }
                }
                delay(bound("GLOBE","cacheSec")*1_000L)
            }
        }
        viewport(prior.view,prior.viewport)
        if(warzoneRequested)showWarzone(true)
        try { awaitCancellation() } finally {
            leases.remove(epoch)?.close()
            if(foregroundEpoch===epoch) {
                viewportRead?.cancel();parcelRead?.cancel();searchRead?.cancel();warzoneRead?.cancel();realmRead?.cancel();realmWindowKey=null;worldScope=null;foregroundEpoch=null
                realmAvatars.clear() // no tag picture outlives the stop; a remembered miss lasts one map visit
                _state.update { it.copy(art=null,artSource=null,artProgress=null,selected=null,selectedTileId=null,search=emptyList(),markers=emptyList(),globe=null,warzone=null,warzoneError=null,
                    realmMarkers=emptyList(),realmMatched=0,realmTruncated=false,parcelFailure=null,searchBusy=false,searchError=null) }
            }
        }
    }
    private suspend fun loadArt(base: String?, epoch: Any) {
        try {
            publish(base) { it.copy(art=null,artSource=null,artError=null,artProgress=null) }
            check(artSpec!=null) { "World artwork needs a content update" }
            val acquired=graph.worldContent.open(graph.content.state.value,session.api) { progress ->
                if(foregroundEpoch===epoch)publish(base) { it.copy(artProgress=progress) }
            }
            if (!current(base) || foregroundEpoch!==epoch) { acquired.close();return }
            leases.put(epoch,acquired)?.close()
            publish(base) { it.copy(art=acquired.overview.directory,artSource=acquired.assets,artError=null) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { if(foregroundEpoch===epoch)publish(base) { it.copy(artError=error.message ?: "World art download interrupted",artProgress=null) } }
    }
    fun tile(id: Int) = graph.fantasyCatalog()?.tile(id)
    fun reportArtError(message: String, base: String?) { publish(base) { if(it.baseId==base)it.copy(artError=message) else it } }
    fun retryArt() {
        if(artRead?.isActive==true)return
        val base=_state.value.baseId;val epoch=foregroundEpoch ?: return
        artRead=worldScope?.launch { loadArt(base,epoch) }
    }
    fun retry() { val base=_state.value.baseId;worldScope?.launch { read(base) { session.world.refreshGlobe();publish(base){it.copy(globe=session.world.state.value.globe,error=null,loading=false)} } };viewport(_state.value.view,_state.value.viewport);_state.value.selectedTileId?.let { select(it, fresh = true) } }
    /** The card's RETRY: a fresh metered read of the selected parcel now (no dwell, no cache). */
    fun retryParcel() { _state.value.selectedTileId?.let { select(it, fresh = true) } }
    fun viewport(view: GlobeView, viewport: GlobeViewport) {
        val base=_state.value.baseId;_state.update { it.copy(view=view.normalized(),viewport=viewport) }
        viewportRead?.cancel()
        viewportRead=worldScope?.launch {
            delay(bound("GLOBE","parcelViewportDebounceMs").toLong()) // Commit settled gestures, never one request per touch move.
            read(base) {
                val frozen=requireNotNull(graph.fantasyCatalog())
                val scope=GlobeGeometry.boundedScope(view,viewport,frozen.columns,frozen.rows,bound("GLOBE","parcelViewportQuantumCells"),bound("GLOBE","parcelViewportMaxCells"),bound("GLOBE","parcelViewportMaxSpanCells"),bound("GLOBE","parcelViewportMaxRequests"))
                val rects=scope.rectangles
                if (rects.isEmpty()) { publish(base){it.copy(markers=emptyList(),matched=0,truncated=false)};return@read }
                while (isActive) {
                    val merged=linkedMapOf<Int,FantasyMarker>();var matched=0;var truncated=scope.truncated;var fed=false
                    for (rect in rects) {
                        ensureActive()
                        val result=session.world.markers(rect.x0,rect.y0,rect.x1,rect.y1)
                        result.markers.forEach { merged[it.tileId]=it };matched+=result.matched;truncated=truncated||result.truncated;fed=fed||result.carriesShielded
                    }
                    publish(base){it.copy(markers=merged.values.toList(),matched=matched,truncated=truncated,shieldFed=it.shieldFed||fed)}
                    delay(bound("WORLD","mapPollSec")*1_000L)
                }
            }
        }
    }
    /** The frozen catalog grid (deed columns × rows), null until the pack's world file is admitted. */
    val catalogGrid: Pair<Int,Int>? get() = graph.fantasyCatalog()?.let { it.columns to it.rows }
    fun tileAt(x: Int, y: Int): Int? { val c=graph.fantasyCatalog() ?: return null; return c.tileAt(((x % c.columns)+c.columns)%c.columns,y) }
    /** The world's catalogue constant, read at runtime (never a Kotlin copy). */
    fun constant(name: String, key: String): Int? = ((graph.content.state.value.catalogue?.get("constants") as? JsonObject)?.get(name) as? JsonObject)?.get(key)?.jsonPrimitive?.intOrNull
    /** A base card's Claim fact: contracts.js `plotRule(L).claim` = the catalogue's `CAMPAIGN.claimTilesByKeep[L − 1]`. */
    fun claimTiles(level: Int): Int? = ((((graph.content.state.value.catalogue?.get("constants") as? JsonObject)?.get("CAMPAIGN") as? JsonObject)
        ?.get("claimTilesByKeep") as? JsonArray)?.getOrNull(level - 1) as? JsonPrimitive)?.intOrNull
    /** The game's keep portrait for a keep level (the catalogue's ART_V2 tiers, as the kingdom sheet picks it): the base
     *  card's "Illustration of a level-L kingdom" until the realm packs' keep sprites arrive (N3). */
    fun keepPortrait(level: Int): String = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.keepPortrait(
        // The map's kingdom emblem stays the designed tiered keep portrait (map/SPEC.md, hub/SPEC.md). The kingdom
        // sheet's art (sheetBuildingPortrait) is now the Keep's world strip, which is not this emblem.
        gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.keepTierOf(level, graph.content.state.value.catalogue))
    /** The realm map's name-tag pictures: each player's profile image, read from the server's avatar path within the
     *  catalogue's avatar bounds ([RealmAvatars]; owner code 31: "only player profile picture and name"). */
    internal val realmAvatars = RealmAvatars { path ->
        check(graph.holder.isCurrent(session.session)) { "The session changed" }
        val bounds = gg.pixelkingdomwars.nativeclient.data.ProfileBounds.from(graph.content.state.value.catalogue)
        val bytes = session.api.download(path.removePrefix("/api"), "image/webp", bounds.maxImageBytes)
        withContext(Dispatchers.IO) { RealmAvatars.decode(bytes, bounds) }
    }
    /**
     * Realm map (N2): read the kingdoms of the visible catalog deed [window] (null: the map closed). The same bounded,
     * debounced, polled parcel-viewport read as the globe's [viewport], with the same server bounds; a window that
     * quantises to the same request set keeps the running poll. [realmId] (the open realm map) only labels the one
     * `[world-feed]` line each completed read prints in debug builds and QA candidates ([WorldRealmFeed.feedLine]).
     */
    fun realmWindow(window: gg.pixelkingdomwars.nativeclient.data.WorldRealmFeed.Window?, realmId: String? = null) {
        val base=_state.value.baseId
        if (window == null) { realmRead?.cancel();realmWindowKey=null;_state.update { it.copy(realmMarkers=emptyList(),realmMatched=0,realmTruncated=false) };return }
        val frozen=graph.fantasyCatalog() ?: return
        val scope=gg.pixelkingdomwars.nativeclient.data.WorldRealmFeed.scope(window,frozen.columns,frozen.rows,bound("GLOBE","parcelViewportQuantumCells"),
            bound("GLOBE","parcelViewportMaxCells"),bound("GLOBE","parcelViewportMaxSpanCells"),bound("GLOBE","parcelViewportMaxRequests"))
        val key=scope.rects.flatMap { listOf(it.x0,it.y0,it.x1,it.y1) }
        if (key==realmWindowKey && realmRead?.isActive==true) return
        realmWindowKey=key;realmRead?.cancel()
        realmRead=worldScope?.launch {
            delay(bound("GLOBE","parcelViewportDebounceMs").toLong()) // settled gestures only, never one request per frame
            read(base) {
                while (isActive) {
                    val merged=linkedMapOf<Int,FantasyMarker>();var matched=0;var truncated=scope.truncated;var fed=false
                    for (rect in scope.rects) {
                        ensureActive()
                        val result=session.world.markers(rect.x0,rect.y0,rect.x1,rect.y1)
                        result.markers.forEach { merged[it.tileId]=it };matched+=result.matched;truncated=truncated||result.truncated;fed=fed||result.carriesShielded
                    }
                    publish(base){it.copy(realmMarkers=merged.values.toList(),realmMatched=matched,realmTruncated=truncated,shieldFed=it.shieldFed||fed)}
                    if (WorldLog.enabled) WorldLog.line(WorldRealmFeed.feedLine(realmId,merged.values))
                    delay(bound("WORLD","mapPollSec")*1_000L)
                }
            }
        }
    }
    fun focus(lon: Double, lat: Double, zoom: Double = 1.0) { viewport(GlobeView(lon,lat,zoom),_state.value.viewport) }
    // Keep the realm heading with the retained camera when the map is reopened.
    fun showRealm(id: String) { if (regions.any { it.string("id") == id }) _state.update { it.copy(realmId=id) } }
    fun focusTile(id: Int) {
        val tile=graph.fantasyCatalog()?.tile(id) ?: return
        val view=GlobeGeometry.focusTile(requireNotNull(tile.lon).toDouble(),requireNotNull(tile.lat).toDouble(),_state.value.viewport,requireNotNull(graph.fantasyCatalog()).columns,displayDensity)
        viewport(view,_state.value.viewport);select(id)
    }
    fun focusIsland(island:JsonObject) {
        val site=GlobeIsland(0,0,island.getValue("lon").jsonPrimitive.double,island.getValue("lat").jsonPrimitive.double,island.getValue("rx").jsonPrimitive.double,island.getValue("ry").jsonPrimitive.double)
        viewport(GlobeGeometry.focusIsland(site,requireNotNull(artSpec).extent,_state.value.viewport,displayDensity),_state.value.viewport)
    }
    /**
     * Selects [id] and follows its metered parcel read. [dwellMs] > 0 is the realm card's dwell (a browse that moves on
     * before it ends reads nothing); a read younger than `WORLD.mapPollSec` is reused at once unless [fresh] (RETRY).
     * The poll and the shield/warzone boundaries are as before; a land gate or 429 stops it until RETRY.
     */
    fun select(id: Int?, dwellMs: Long = 0L, fresh: Boolean = false) {
        parcelRead?.cancel();val base=_state.value.baseId
        val cacheMs=runCatching { bound("WORLD","mapPollSec")*1_000L }.getOrDefault(0L)
        val hit=if (id==null || fresh) null else parcels.cached(id,clockMs(),cacheMs)
        _state.update { it.copy(selected=hit?.first,selectedAtNanos=hit?.second ?: 0L,selectedTileId=id,error=null,parcelFailure=null,search=emptyList()) }
        if (id == null) return
        parcelRead=worldScope?.launch {
            val poll=runCatching { bound("WARZONE","currentPhasePollSec")*1_000L }.getOrNull()
            if (poll==null) { publish(base) { if (it.selectedTileId==id) it.copy(error="World timing needs a content update") else it }; return@launch }
            val boundaries=WorldBoundaryRefresh()
            parcels.follow(id,dwellMs,cacheMs,poll,fresh,{ clockMs() },{ System.nanoTime() },
                read={ session.world.parcel(it) },
                publish={ parcel,at -> publish(base) { if (it.selectedTileId==id) it.copy(selected=parcel,selectedAtNanos=at,error=null,parcelFailure=null) else it } },
                fail={ failure -> publish(base) { if (it.selectedTileId==id) it.copy(error=failure.raw,parcelFailure=failure) else it } },
                nextDelayMs={ parcel,at,pollMs -> boundaries.nextDelay(pollMs.coerceAtLeast(1L),parcelDeadlines(parcel.detail as? JsonObject,at),System.nanoTime()) })
        }
    }
    private fun clockMs(): Long = System.nanoTime()/1_000_000L
    /** F6: the tile drafted for checkout and not reserved yet (LandGate's drafted-tile state), else null. */
    val draftedTile: Int? get() = session.land.state.value.let { if (it.reservation==null) it.draftedTile else null }
    /** Choose mode's open-deed candidate in [realmId] nearest catalog ([fromX], [fromY]) ([WorldOpenDeeds]): an ordinary
     *  catalog tile of the realm that is not in [known] (kingdoms in view, your deeds) nor already [skip]ped. */
    fun openDeedCandidate(realmId: String, fromX: Int, fromY: Int, known: Set<Int>, skip: Set<Int>): Int? {
        val catalog=graph.fantasyCatalog() ?: return null
        return WorldOpenDeeds.next(catalog,realmId,fromX,fromY,known,skip)
    }
    /** Where a realm's open-deed search starts on the globe (no map to centre on): the server's anchor tile for the realm,
     *  else its first ordinary catalog tile. */
    fun realmAnchorTile(realmId: String): Int? = _state.value.globe?.realms?.firstOrNull { it.realmId==realmId }?.anchorTileId
        ?: graph.fantasyCatalog()?.ordinaryTiles(realmId, limit = 1)?.firstOrNull()
    /** The enter-base seam's catalogue numbers (OPEN BASE on your own deed): the sections `RealmKitRules.read` needs, the
     *  base scene's world tile (`presentation.tilePixels`, as SceneMappers reads it) and its claim fit's pad. Null where
     *  the catalogue has no realm kit: OPEN BASE then opens the base at its fit, as before the seam. */
    fun baseSeamSpec(): BaseSeamSpec? {
        val catalogue = graph.content.state.value.catalogue ?: return null
        val constants = catalogue["constants"] as? JsonObject ?: return null
        val kit = JsonObject(constants.filterKeys { it in SEAM_CONSTANTS }).takeIf { it.size == SEAM_CONSTANTS.size } ?: return null
        val tile = ((catalogue["presentation"] as? JsonObject)?.get("tilePixels") as? JsonPrimitive)?.doubleOrNull ?: return null
        val pad = ((constants["BASE_CAMERA"] as? JsonObject)?.get("fitPadTiles") as? JsonPrimitive)?.doubleOrNull ?: return null
        return BaseSeamSpec(kit.toString(), tile, pad)
    }
    private val SEAM_CONSTANTS = setOf("REALM_KIT", "LAYERED_GROUND_LIMITS_R5", "GRID", "OBSTACLES", "KIT_OBSTACLES")
    /** OPEN BASE on your own active deed (web `openBase`: select that base, refresh it, then the base screen). */
    fun openBase(baseId: String, onOpened: () -> Unit) = run {
        check(current(_state.value.baseId)) { "The selected base changed" }
        graph.account.selectBase(baseId); session.base.refreshWithoutJourneys(); onOpened() // base-entry hydration: no journey publication (N-C5)
    }
    val warzoneCooldownHours:Int get()=bound("WARZONE","attackCooldownHours")
    fun showWarzone(show:Boolean) {
        warzoneRequested=show;warzoneRead?.cancel()
        if(!show) { _state.update {it.copy(warzone=null,warzoneError=null)};return }
        val base=_state.value.baseId
        warzoneRead=worldScope?.launch {
            val boundaries=WorldBoundaryRefresh()
            while(isActive) {
                var next=bound("WARZONE","currentPhasePollSec")*1_000L
                try {
                    val status=WorldWarzone.parse(session.world.warzone(),System.nanoTime())
                    publish(base) {it.copy(warzone=status,warzoneError=null)}
                    next=boundaries.nextDelay(next,listOfNotNull(status.deadline),System.nanoTime())
                } catch(error:CancellationException) {throw error}
                catch(error:Exception) {publish(base){it.copy(warzoneError=error.message ?: "Current warzone status is unavailable")}}
                delay(next)
            }
        }
    }
    fun pick(lon: Double, lat: Double): Int? {
        val catalog=graph.fantasyCatalog() ?: return null
        val id=GlobeGeometry.tileAt(lon,lat,catalog.columns,catalog.rows)
        return catalog.tile(id)?.tileId?.also { select(it) }
    }
    /**
     * The owner search (map-search, SPEC §2.4), 250 ms after the last call. [WorldUiState.searchBusy] is up while a
     * non-blank [term] waits or runs; the rows already shown stay until the new ones land ("never a blank list") and a
     * blank [term] clears them. A failure is published as [WorldUiState.searchError] (without the old rows, which belong to
     * another query) inside this search's own coroutine, never as the map's [WorldUiState.error]. A search cancelled by a
     * newer one publishes nothing, so the newer one's state stands.
     */
    fun search(term: String) {
        searchRead?.cancel();val base=_state.value.baseId;val scope=worldScope
        _state.update{it.copy(search=if (term.isBlank()) emptyList() else it.search,searchBusy=term.isNotBlank() && scope!=null,searchError=null)}
        searchRead=scope?.launch {
            delay(250)
            try { val result=session.world.search(term);publish(base){it.copy(search=result,searchBusy=false)} }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) { publish(base){it.copy(search=emptyList(),searchBusy=false,searchError=error.message ?: "World read interrupted. Please retry.")} }
        }
    }
    suspend fun deedPreview(tileId:Int,detail:JsonObject,valid:(ByteArray)->Boolean):ByteArray {
        val base=_state.value.baseId
        check(current(base) && _state.value.selectedTileId==tileId)
        val deed=detail.getValue("deed").jsonObject;val metadata=deed.getValue("metadata").jsonObject
        val bytes=deedImages.load(metadata.string("image"),requireNotNull(detail.getValue("player").jsonObject.string("wallet")),deed.string("assetId"),valid)
        check(current(base) && _state.value.selectedTileId==tileId) {"The selected parcel changed"}
        return bytes
    }
    fun scout() = run {
        check(current(_state.value.baseId)) { "The selected base changed" }
        val parcel=requireNotNull(_state.value.selected);val detail=requireNotNull(parcel.detail as? JsonObject)
        require(detail.getValue("actions").jsonObject.getValue("scout").jsonObject.getValue("allowed").jsonPrimitive.boolean)
        val attack = detail.getValue("actions").jsonObject.getValue("attack").jsonObject
        val blocked = if (attack["allowed"]?.jsonPrimitive?.booleanOrNull == true) null else worldBlockReason(attack.string("blockedBy").orEmpty())
        session.battle.scoutTarget(requireNotNull(detail.getValue("player").jsonObject.string("wallet")),(detail["base"] as? JsonObject)?.string("id"), blocked)
    }
    fun attack() = run {
        check(current(_state.value.baseId)) { "The selected base changed" }
        val detail=requireNotNull(_state.value.selected?.detail as? JsonObject)
        require(detail.getValue("actions").jsonObject.getValue("attack").jsonObject.getValue("allowed").jsonPrimitive.boolean)
        val player=detail.getValue("player").jsonObject
        session.battle.pvpBattle(RaidCreateTarget.Pvp(requireNotNull(player.string("wallet")),(detail["base"] as? JsonObject)?.string("id"),name=player.string("name")))
    }
    fun draftLand(onOpen: ()->Unit) = run {
        check(current(_state.value.baseId)) { "The selected base changed" }
        val selected=requireNotNull(_state.value.selected);require(selected.available)
        session.land.open(if (graph.account.state.value.landOwned) "deed" else "entry")
        // Reinspect before drafting. Checkout still obtains its own authoritative frozen reservation.
        require(session.world.parcel(selected.tile.tileId).available) { "This parcel is no longer available" }
        session.land.draft(selected.tile.tileId);onOpen()
    }
}
