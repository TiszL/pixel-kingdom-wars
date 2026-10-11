@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate

import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.zIndex
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.style.TextOverflow
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.ScreenNotice
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.data.WorldContentPhase
import gg.pixelkingdomwars.nativeclient.renderer.GlobeGeometry
import gg.pixelkingdomwars.nativeclient.scene.WorldSurface
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.serialization.json.*
import kotlin.math.roundToInt

/** Web FantasyWorldLayer/world.css chrome on the forged HUD plates; the native viewport and authoritative actions are unchanged.
 * Layout decisions come from [worldChromePlan] so the visible-globe budget is pinned by a JVM test. */
@Composable internal fun WorldScreen(model: WorldViewModel, selectedBaseId: String?, onOpenLand: () -> Unit, onOpenBases: () -> Unit,
    onOpenShop: (() -> Unit)? = null, onBack: (() -> Unit)? = null, onOpenCampaign: (() -> Unit)? = null,
    ownedBaseCount: Int? = null, activeBaseCount: Int? = null,
    /** The GL30 world surface (N1 globe + N2 realm maps) when the engine is admitted; null keeps the legacy globe. */
    worldEngine: WorldEngineSurface? = null,
    /** The app's Home requests: a `HomeRequest.World` (choose land, rivals, view deeds; N4) is consumed here exactly once. */
    requests: gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests? = null,
    /** MS-UI3: the designed island sheets' doors, a Phase E activity in Bases and the Clan Hall (the GL30 HUD only; the
     *  internal [gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEActivity] makes this screen internal). */
    onOpenPhaseE: (gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEActivity) -> Unit = {}, onOpenClanHall: () -> Unit = {},
    /** The live Seeker auction for the GL30 HUD's island sheet ([rememberSeekerAuctionSlot]); null keeps the designed panel. */
    seekerAuction: SeekerIslandSlot? = null,
    /** The Public Workshop's CRAFT VEHICLE ([publicWorkshopCraftOpening]); null: no vehicle owner, the sheet says so. */
    onCraftVehicle: (() -> Unit)? = null) {
    // N4: take the World entry off the queue whichever globe runs (a request left at the head would block every later
    // Home request); only the GL30 HUD acts on it, the legacy globe opens as it always has.
    var entry by remember { mutableStateOf<gg.pixelkingdomwars.nativeclient.data.WorldEntry?>(null) }
    if (requests != null) {
        val pending by requests.pending.collectAsState()
        LaunchedEffect(pending) { (pending as? gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest.World)?.let { entry = it.entry; requests.consume(it) } }
    }
    val state by model.state.collectAsState()
    val notice by model.notice.collectAsState()
    val busy by model.busy.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(model, lifecycle, selectedBaseId) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(selectedBaseId) } }
    val current = state.takeIf { it.baseId == selectedBaseId }
    // An engine that reports itself unavailable for this content falls back to the legacy globe until the next entry.
    var engineUnavailable by remember(worldEngine, current?.art) { mutableStateOf(false) }
    if (worldEngine != null && !engineUnavailable) {
        val hudDensity = LocalDensity.current.density
        SideEffect { model.displayDensity = hudDensity.toDouble() }
        WorldHudScreen(model, current, worldEngine, selectedBaseId, onOpenLand, onOpenBases, onOpenShop, onBack, onOpenCampaign, ownedBaseCount,
            onEngineUnavailable = { android.util.Log.w("WorldHud", "GL30 world unavailable, legacy globe: $it"); engineUnavailable = true },
            entry = entry, onEntryApplied = { entry = null }, onOpenPhaseE = onOpenPhaseE, onOpenClanHall = onOpenClanHall, requests = requests,
            seekerAuction = seekerAuction, onCraftVehicle = onCraftVehicle)
        return
    }
    var detailError by remember(current?.art) { mutableStateOf<String?>(null) }
    var detailRetry by remember(current?.art) { mutableStateOf(0) }
    var surfaceReady by remember(current?.art) { mutableStateOf(false) }
    val density = LocalDensity.current.density
    SideEffect { model.displayDensity = density.toDouble() }
    val artSpec = remember(model) { model.artSpec }
    var motion by remember { mutableStateOf(true) }
    val reducedMotion = gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion.current
    val motionActive = motion && !reducedMotion
    var query by remember(selectedBaseId) { mutableStateOf("") }
    var panel by remember(selectedBaseId) { mutableStateOf<JsonObject?>(null) }
    val realmId = current?.realmId ?: "crownlands"
    var panelOpen by remember(selectedBaseId) { mutableStateOf(false) }
    var panelExpanded by remember(selectedBaseId) { mutableStateOf(false) }
    var explore by remember(selectedBaseId) { mutableStateOf(false) }
    var parcelHelp by remember(selectedBaseId) { mutableStateOf(false) }
    var warzone by remember(selectedBaseId) { mutableStateOf(false) }
    var searchFocused by remember { mutableStateOf(false) }
    // Landscape only: the search field is an overlay opened from the rail, collapsed by Back or ×.
    var searchOpen by remember(selectedBaseId) { mutableStateOf(false) }
    val searchFocus = remember { FocusRequester() }
    var chromeHeight by remember { mutableStateOf(96.dp) }
    var toolsHeight by remember { mutableStateOf(104.dp) }
    var cluster by remember(selectedBaseId) { mutableStateOf<List<GlobeMarker>>(emptyList()) }
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    LaunchedEffect(model, warzone, panelOpen) { model.showWarzone(warzone && panelOpen) }
    LaunchedEffect(current?.selectedTileId) {
        current?.selectedTileId?.let { id -> model.tile(id)?.let { model.showRealm(it.realmId) }; panelOpen = true; explore = false; parcelHelp = false }
    }
    fun clearSearch() { query = ""; model.search(""); searchOpen = false; focus.clearFocus() }
    fun openTile(id: Int) { clearSearch(); panel = null; explore = false; parcelHelp = false; warzone = false; panelOpen = true; model.focusTile(id) }
    fun openRealm(realm: JsonObject) {
        clearSearch(); model.showRealm(realm.string("id").orEmpty()); panel = realm; explore = false; parcelHelp = false; warzone = false; panelOpen = true
        model.select(null); model.focus(realm.getValue("lon").jsonPrimitive.double, realm.getValue("lat").jsonPrimitive.double)
    }
    fun openChain(chain: JsonObject) {
        clearSearch(); panel = chain; explore = true; parcelHelp = false; warzone = false; panelOpen = true; model.select(null)
        model.focus(chain.getValue("lon").jsonPrimitive.double, chain.getValue("lat").jsonPrimitive.double, 3.0)
    }
    BackHandlerAt(BackPriority.GLOBE_LIST, cluster.isNotEmpty()) { cluster = emptyList() }
    BackHandlerAt(BackPriority.GLOBE_LAYERS, panelOpen || warzone || current?.selectedTileId != null || query.isNotEmpty()) {
        panel = null; panelOpen = false; explore = false; parcelHelp = false; warzone = false; clearSearch(); model.select(null)
    }
    // Registered after the layer handler so it wins the tie: Back first collapses the landscape search overlay.
    BackHandlerAt(BackPriority.GLOBE_LAYERS, searchOpen) { clearSearch() }
    LaunchedEffect(searchOpen) { if (searchOpen) { withFrameNanos { }; runCatching { searchFocus.requestFocus() } } }
    val realm = model.regions.firstOrNull { it.string("id") == realmId } ?: model.regions.firstOrNull()
    val mine = current?.globe?.me?.ownedTiles?.let { owned -> owned.firstOrNull { it.selected } ?: owned.firstOrNull { it.active } ?: owned.firstOrNull() }
    val panelTitle = when { parcelHelp -> "MY PARCEL"; warzone -> "WARZONE"; explore -> "EXPLORE"; current?.selectedTileId != null -> "TILE ${current.selectedTileId}"; else -> realm?.string("name") ?: "WORLD" }
    val panelScroll = rememberScrollState()
    LaunchedEffect(panelTitle, current?.selectedTileId) { panelScroll.scrollTo(0) }
    BoxWithConstraints(Modifier.fillMaxSize().background(Color(0xFF0B0E14)).imePadding()) {
        val art = current?.art
        val worldReady = art != null && artSpec != null && current.artError == null && surfaceReady
        if (art != null && artSpec != null && current.artError == null) {
            WorldSurface(art, current.view, model.details, artSpec, motionActive,
                gg.pixelkingdomwars.nativeclient.renderer.GlobeSelection(current.selectedTileId, current.globe?.me?.ownedTiles.orEmpty().map { it.tileId }.toSet(), current.markers.map { it.tileId }.toSet()),
                Modifier.fillMaxSize(), model::viewport, { pick ->
                    panel = null; warzone = false; parcelHelp = false; explore = false; panelOpen = true; clearSearch()
                    if (pick.chain != null) { model.select(null); panel = model.chains.getOrNull(requireNotNull(pick.chain)); explore = true }
                    else if (!pick.deedEligible || model.pick(pick.lon, pick.lat) == null) {
                        model.select(null); panel = pick.realm?.let { model.regions.getOrNull(it) }; panel?.string("id")?.let(model::showRealm)
                    }
                }, { model.reportArtError(it, current.baseId) }, { surfaceReady = true }, { detailError = it }, detailRetry, current.artSource)
            // The legacy globe keeps its keep markers (every refused or failed GL30 engine falls back to it); only the
            // GL30 globe HUD drops them (D-164.1, plan §3.6).
            val markers = remember(current.globe, current.markers, current.view, current.viewport, current.selectedTileId, density) { worldMarkers(current, model, density) }
            if (worldReady) markers.forEach { group ->
                WorldButton(onClick = {
                    if (group.members.size > 1) cluster = group.members else group.members.single().let { marker ->
                        if (marker.realmId != null) { model.regions.firstOrNull { it.string("id") == marker.realmId }?.let(::openRealm); model.focus(marker.lon, marker.lat, 6.0) }
                        else openTile(marker.tileId)
                    }
                }, modifier = Modifier.offset { IntOffset((group.x - 24 * density).roundToInt(), (group.y - 24 * density).roundToInt()) }, active = group.members.any { it.owned }) {
                    GameArt("ui_portrait_keep_t1", Modifier.size(25.dp)); if (group.count > 1) Text("${group.count}")
                }
            }
        }
        if (!worldReady) {
            WorldOpeningOverlay(current?.artProgress, current?.artError != null, model::retryArt, onBack)
        } else {
        // The globe and projected markers share the full viewport; only floating chrome is inset.
        BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
        val viewportWidth = maxWidth; val viewportHeight = maxHeight
        val plan = remember(viewportWidth, viewportHeight) { worldChromePlan(viewportWidth.value.toInt(), viewportHeight.value.toInt()) }
        val rail = plan.rail; val side = plan.sidePanel; val panelWidth = plan.panelWidth.dp
        val edge = WorldChrome.EDGE.dp; val gap = WorldChrome.GAP.dp
        val availableHeight = (viewportHeight - chromeHeight - 16.dp).coerceAtLeast(48.dp)
        // The bottom sheet never rises above the zoom pair under the tools: 36dp = the 4dp gaps around a 44dp dock row minus the 16dp panel inset.
        val panelHeight = if (side || panelExpanded) availableHeight
            else minOf(viewportHeight * .58f, (availableHeight - toolsHeight - 36.dp).coerceAtLeast(48.dp))
        val warzoneActive = current?.globe?.warzone?.get("active")?.jsonPrimitive?.booleanOrNull == true
        val showExplore: () -> Unit = { clearSearch(); model.select(null); panel = null; explore = true; parcelHelp = false; warzone = false; panelOpen = true }
        val showWarzone: () -> Unit = { clearSearch(); model.select(null); parcelHelp = false; explore = false; warzone = true; panelOpen = true }
        val showParcel: () -> Unit = { searchOpen = false; if (mine != null) openTile(mine.tileId) else { parcelHelp = true; warzone = false; explore = false; model.select(null); panelOpen = true } }
        val basesDescription = "Bases, ${ownedBaseCount ?: "unknown"} owned, ${activeBaseCount ?: "unknown"} active"
        val realmScroll = rememberScrollState()
        val realmChips: @Composable RowScope.() -> Unit = {
            model.regions.forEach { item ->
                val reveal = remember { androidx.compose.foundation.relocation.BringIntoViewRequester() }
                LaunchedEffect(realmId, explore) { if (item.string("id") == realmId && !explore) reveal.bringIntoView() }
                WorldButton(onClick = { openRealm(item) }, active = item.string("id") == realmId && !explore, compact = true, minWidth = 96.dp,
                    modifier = Modifier.bringIntoViewRequester(reveal)) {
                    Box(Modifier.size(4.dp, 18.dp).background(worldColor(item.string("color"))))
                    Text(item.string("name") ?: "Realm", maxLines = 1, softWrap = false)
                }
            }
        }
        val searchField: @Composable RowScope.() -> Unit = {
            WorldSearchField(query, { if (it.length <= 96) { query = it; model.search(it) } }, onSubmit = { current?.search?.firstOrNull()?.let { openTile(it.tileId) } },
                onClear = ::clearSearch, onFocus = { searchFocused = it }, modifier = Modifier.weight(1f), focusRequester = if (rail) searchFocus else null)
        }
        val searchResults: @Composable () -> Unit = {
            if (query.trim().length >= 2 && current?.search?.isNotEmpty() == true) PixelPanel(Modifier.fillMaxWidth().heightIn(max = minOf(220.dp, (viewportHeight - chromeHeight - 80.dp).coerceAtLeast(44.dp)))) {
                Column(Modifier.background(Palette.ink).verticalScroll(rememberScrollState()).padding(4.dp), verticalArrangement = Arrangement.spacedBy(gap)) {
                    current.search.forEach { owner -> WorldButton(onClick = { openTile(owner.tileId) }, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.weight(1f)) { Text(owner.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${model.regions.firstOrNull { it.string("id") == owner.realmId }?.string("name") ?: owner.realmId} · KEEP ${owner.keepLevel} · ${owner.trophies} trophies${if (owner.seeker) " · SEEKER" else ""}", style = MaterialTheme.typography.labelSmall, color = Palette.muted) }
                    } }
                }
            }
        }
        // Header bar: [‹ BASE][title, or the realm chips in landscape][CAMPAIGN]; portrait adds the chip row beneath.
        Column(Modifier.align(Alignment.TopCenter).fillMaxWidth().zIndex(5f).onSizeChanged { chromeHeight = (it.height / density).dp }
            .padding(top = edge, start = edge, end = edge), verticalArrangement = Arrangement.spacedBy(gap)) {
            PixelPlate("bar", Modifier.fillMaxWidth().height(WorldChrome.HEADER.dp), PaddingValues(horizontal = 6.dp, vertical = 2.dp)) {
                Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(gap)) {
                    onBack?.let { WorldButton(onClick = it, compact = true) { Text("‹ BASE", maxLines = 1, softWrap = false) } }
                    if (rail) Row(Modifier.weight(1f).horizontalScroll(realmScroll), horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.CenterVertically) { realmChips() }
                    else Column(Modifier.weight(1f).padding(horizontal = 4.dp)) {
                        Text("WORLD MAP", style = MaterialTheme.typography.labelSmall, color = Palette.muted, maxLines = 1)
                        Text(realm?.string("name") ?: "The Shattered Realms", style = MaterialTheme.typography.titleSmall, color = Palette.goldHi, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    onOpenCampaign?.let { WorldButton(onClick = it, compact = true, primary = true) { Text("CAMPAIGN", maxLines = 1, softWrap = false) } }
                }
            }
            if (!rail) Row(Modifier.fillMaxWidth().height(WorldChrome.REALM_ROW.dp).horizontalScroll(realmScroll), horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.CenterVertically) { realmChips() }
        }
        if (rail) {
            val railEnd = edge + if (panelOpen) panelWidth + 8.dp else 0.dp
            Column(Modifier.align(Alignment.TopEnd).padding(top = chromeHeight + gap, end = railEnd, bottom = 8.dp).zIndex(4f).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(gap)) {
                RailDock("scout", "SEARCH", { if (searchOpen) clearSearch() else searchOpen = true }, Modifier.size(WorldChrome.RAIL.dp), active = searchOpen, description = "Find a keeper")
                RailDock("locate", "PARCEL", showParcel, Modifier.size(WorldChrome.RAIL.dp), description = "My parcel")
                RailDock("map", "EXPLORE", showExplore, Modifier.size(WorldChrome.RAIL.dp), active = explore)
                RailDock("attack", "WARZONE", showWarzone, Modifier.size(WorldChrome.RAIL.dp), active = warzoneActive)
                RailDock("profile", "BASES", onOpenBases, Modifier.size(WorldChrome.RAIL.dp), badge = ownedBaseCount?.toString() ?: "—", description = basesDescription)
                RailDock("replay", "MOTION", { motion = !motion }, Modifier.size(WorldChrome.RAIL.dp), active = motionActive, enabled = !reducedMotion, description = if (motionActive) "Globe motion on" else "Globe motion off")
            }
            WorldStatus(current, detailError, notice, model::retry, { detailRetry++ },
                Modifier.align(Alignment.TopStart).padding(start = edge, top = chromeHeight + gap).widthIn(max = 360.dp).zIndex(2f))
            if (searchOpen) {
                val overlayEnd = railEnd + WorldChrome.RAIL.dp + gap
                Column(Modifier.align(Alignment.TopEnd).padding(top = chromeHeight + gap, end = overlayEnd)
                    .width(minOf(410.dp, (viewportWidth - overlayEnd - edge - 120.dp).coerceAtLeast(240.dp))).zIndex(6f), verticalArrangement = Arrangement.spacedBy(gap)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.CenterVertically) {
                        searchField()
                        WorldButton(onClick = showParcel) { GameArt("locate", Modifier.size(18.dp)); Text("MY PARCEL", maxLines = 1, softWrap = false) }
                    }
                    searchResults()
                }
            }
        } else {
            // Portrait / tall tablet: search row, the four mode docks, then transient status and results.
            Column(Modifier.align(Alignment.TopStart).padding(start = edge, end = edge, top = chromeHeight + gap)
                .then(if (side && panelOpen) Modifier.width((viewportWidth - panelWidth - edge * 2 - 8.dp).coerceAtLeast(200.dp)) else Modifier.fillMaxWidth())
                .zIndex(if (searchFocused) 6f else 2f).onSizeChanged { toolsHeight = (it.height / density).dp }, verticalArrangement = Arrangement.spacedBy(gap)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.CenterVertically) {
                    searchField()
                    // The field expands while typing; MY PARCEL folds to its icon so it stays one tap away.
                    if (searchFocused) RailDock("locate", null, showParcel, Modifier.size(WorldChrome.SEARCH_ROW.dp), description = "My parcel")
                    else WorldButton(onClick = showParcel) { GameArt("locate", Modifier.size(18.dp)); Text("MY PARCEL", maxLines = 1, softWrap = false) }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                    val dock = Modifier.weight(1f).height(WorldChrome.MODE_ROW.dp)
                    RailDock("map", "EXPLORE", showExplore, dock, active = explore)
                    RailDock("attack", "WARZONE", showWarzone, dock, active = warzoneActive)
                    RailDock("profile", "BASES", onOpenBases, dock, badge = ownedBaseCount?.toString() ?: "—", description = basesDescription)
                    RailDock("replay", "MOTION", { motion = !motion }, dock, active = motionActive, enabled = !reducedMotion, description = if (motionActive) "Globe motion on" else "Globe motion off")
                }
                WorldStatus(current, detailError, notice, model::retry, { detailRetry++ }, Modifier.fillMaxWidth())
                searchResults()
            }
        }
        val zoomIn: () -> Unit = { current?.let { model.focus(it.view.lon, it.view.lat, it.view.zoom * 1.5) } }
        val zoomOut: () -> Unit = { current?.let { model.focus(it.view.lon, it.view.lat, it.view.zoom / 1.5) } }
        if (side) Column(Modifier.align(Alignment.BottomStart).padding(8.dp).zIndex(2f), verticalArrangement = Arrangement.spacedBy(gap)) {
            ZoomDock("+", "Zoom in", zoomIn, enabled = current != null); ZoomDock("−", "Zoom out", zoomOut, enabled = current != null)
        } else Row(Modifier.align(Alignment.TopEnd).padding(top = chromeHeight + toolsHeight + gap * 2, end = edge).zIndex(2f), horizontalArrangement = Arrangement.spacedBy(gap)) {
            ZoomDock("+", "Zoom in", zoomIn, enabled = current != null); ZoomDock("−", "Zoom out", zoomOut, enabled = current != null)
        }
        val panelModifier = Modifier.align(if (side || !panelOpen) Alignment.BottomEnd else Alignment.BottomCenter).zIndex(3f)
            .then(if (side || !panelOpen) Modifier.padding(start = 8.dp, top = 8.dp, bottom = 8.dp, end = if (!panelOpen && rail) edge + WorldChrome.RAIL.dp + gap else 8.dp) else Modifier)
        if (!panelOpen) DockTab("map", "$panelTitle · DETAILS +", { panelOpen = true }, panelModifier)
        else PixelPanel(panelModifier.then(if (side) Modifier.width(panelWidth) else Modifier.fillMaxWidth()).heightIn(max = panelHeight)) {
            Row(Modifier.fillMaxWidth().background(Palette.ink).padding(start = 10.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(gap)) {
                Column(Modifier.weight(1f)) {
                    Text("WORLD MAP", style = MaterialTheme.typography.labelSmall, color = Palette.muted, maxLines = 1)
                    Text(panelTitle.uppercase(), style = MaterialTheme.typography.titleMedium, color = Palette.goldHi, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (!side) WorldButton(onClick = { panelExpanded = !panelExpanded }, compact = true) { Text(if (panelExpanded) "SHRINK" else "EXPAND", maxLines = 1, softWrap = false) }
                RailDock("close", null, { panelOpen = false }, Modifier.size(48.dp), description = "Close details")
            }
            Column(Modifier.weight(1f, fill = false).background(Palette.ink).verticalScroll(panelScroll).padding(if (side) 14.dp else 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when {
                    parcelHelp -> { WorldKicker("YOUR WORLD PARCEL"); WorldTitle(if (current?.loading == true) "Finding your land…" else "No assigned parcel shown")
                        Text("Open Your Bases to review your deeds or inspect available land on the globe.", color = Palette.muted, style = MaterialTheme.typography.bodyMedium)
                        WorldButton(onClick = onOpenBases, primary = true, modifier = Modifier.fillMaxWidth()) { Text("OPEN YOUR BASES") } }
                    warzone -> {
                        WorldButton(onClick = { warzone = false }) { Text("‹ WORLD") }
                        if (current?.warzoneError != null) Text(current.warzoneError, color = Palette.danger)
                        else current?.warzone?.let { WarzoneClock(it, model.warzoneCooldownHours) } ?: Text("Reading current warzone status…")
                        if (current?.warzone?.active == true && onOpenShop != null) WorldButton(onClick = { warzone = false; onOpenShop() }, primary = true) { Text("WARZONE SHIELD OPTIONS") }
                        WorldButton(onClick = { model.showWarzone(true) }) { Text("REFRESH") }
                    }
                    explore -> { WorldKicker("FUTURE RESOURCE EXPEDITIONS"); WorldTitle(panel?.string("name") ?: "The outer archipelagos")
                        Text(panel?.string("lore") ?: "Island chains lie beyond the realm coastlines. These gameplay destinations cannot be owned.", color = Palette.muted)
                        if (panel == null) model.chains.forEach { chain -> WorldButton(onClick = { openChain(chain) }, modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.weight(1f)) { Text(chain.string("name") ?: "Islands"); Text("${(chain["islands"] as? JsonArray)?.size ?: 0} islands · exploration locked", style = MaterialTheme.typography.labelSmall, color = Palette.muted) }
                        } } else {
                            WorldButton(onClick = { panel = null }) { Text("‹ ALL ARCHIPELAGOS") }
                            val chain = requireNotNull(panel)
                            WorldButton(onClick = { openChain(chain) }) { Text("CHAIN OVERVIEW") }
                            (chain["islands"] as? JsonArray)?.forEachIndexed { index, island -> WorldButton(onClick = { model.focusIsland(island.jsonObject) }, modifier = Modifier.fillMaxWidth()) { Text("${chain.string("name")} · ISLAND ${index + 1}") } }
                        }
                        WorldReserved("Exploration locked — coming later")
                        WorldButton(onClick = {}, enabled = false, primary = true, modifier = Modifier.fillMaxWidth()) { Text("DISPATCH LOCKED") }
                        Text("No land deeds are issued for these islands.", color = Palette.muted, style = MaterialTheme.typography.bodySmall)
                    }
                    current?.selectedTileId != null -> {
                        WorldParcel(model, current, selectedBaseId, busy, onOpenLand, onOpenBases)
                        WorldButton(onClick = { model.select(null) }) { Text("‹ REALM OVERVIEW") }
                    }
                    else -> realm?.let { item ->
                        WorldKicker(item.string("landscape").orEmpty()); WorldTitle(item.string("name") ?: "Realm", worldColor(item.string("color")))
                        item.string("epithet")?.let { Text(it, color = Palette.muted, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic) }
                        item.string("lore")?.let { Text(it, color = Palette.muted) }
                        val counts = current?.globe?.realms?.firstOrNull { it.realmId == item.string("id") }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                            listOf("Deed tiles" to counts?.total, "Assigned" to counts?.occupied, "Available" to counts?.available).forEach { (label, value) -> WorldStat(label, value?.toString() ?: "—", Modifier.weight(1f)) }
                        }
                        if (item.string("id") == "seeker-reach") {
                            WorldButton(onClick = { model.focus(-115.0, 38.0, 3.8); model.select(null) }, primary = true, modifier = Modifier.fillMaxWidth()) { Text("GENESIS SANCTUARY") }
                            Text("Genesis and Seeker owner allocations remain reserved. Awards and claims are not open.", color = Palette.muted, style = MaterialTheme.typography.bodySmall)
                        }
                        WorldButton(onClick = { model.focus(item.getValue("lon").jsonPrimitive.double, item.getValue("lat").jsonPrimitive.double, 16.0) }, primary = true, modifier = Modifier.fillMaxWidth()) { Text("INSPECT LAND TILES") }
                        Text("Exploration islands cannot be owned.", color = Palette.muted, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
        }
    }
    if (cluster.isNotEmpty()) AlertDialog(onDismissRequest = { cluster = emptyList() }, title = { Text("NEARBY KEEPS") }, text = { Column(verticalArrangement = Arrangement.spacedBy(4.dp)) { cluster.forEach { marker -> WorldButton(onClick = { cluster = emptyList(); openTile(marker.tileId) }, modifier = Modifier.fillMaxWidth()) { GameArt("ui_portrait_keep_t1", Modifier.size(25.dp)); Text(marker.name) } } } }, confirmButton = { TextButton(onClick = { cluster = emptyList() }) { Text("CLOSE") } })
}

private fun worldColor(hex: String?): Color = hex?.let { runCatching { Color(android.graphics.Color.parseColor(it)) }.getOrNull() } ?: Palette.gold
@Composable private fun WorldKicker(value: String) { Text(value.uppercase(), style = MaterialTheme.typography.labelSmall, color = Palette.textFaint) }
@Composable private fun WorldTitle(value: String, color: Color = Palette.text) { Text(value, style = MaterialTheme.typography.headlineSmall, color = color) }
@Composable private fun WorldReserved(value: String) {
    PixelPlate("shard", Modifier.fillMaxWidth(), PaddingValues(10.dp)) { Text(value, style = MaterialTheme.typography.bodyMedium, color = Palette.text) }
}
/** One recessed readout: a muted label over its value, as the web realm-count cells. */
@Composable private fun WorldStat(label: String, value: String, modifier: Modifier = Modifier) {
    PixelPlate("shard", modifier.heightIn(min = 48.dp), PaddingValues(horizontal = 6.dp, vertical = 4.dp)) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label.uppercase(), style = MaterialTheme.typography.labelSmall, color = Palette.muted, maxLines = 1)
            Text(value, style = MaterialTheme.typography.titleLarge, color = Palette.text, maxLines = 1)
        }
    }
}
/** Same loading layout used for cold download, verified-cache entry and recoverable failure (the legacy globe).
 * Owner 2026-10-06 ("black screen is low quality … professional solution"; scene-transitions spec §3 "World open"): no
 * centred plate on a dark shell — the globe's own sky, the way back, and after 400 ms the D-193 strip (a measured meter while
 * the world downloads, the reason with TRY AGAIN on a failure). Map controls are absent until the first coarse scene is
 * presented, so this cannot cover +/−. */
@Composable internal fun WorldOpeningOverlay(progress: gg.pixelkingdomwars.nativeclient.data.WorldContentProgress?,
    failed: Boolean, onRetry: () -> Unit, onBack: (() -> Unit)?) {
    val download = progress?.takeIf { it.totalFiles > 0 && it.phase == WorldContentPhase.DOWNLOADING }
    val stage = gg.pixelkingdomwars.nativeclient.ui.kingdom.rememberIndicatorStage("world-legacy", waiting = !failed, failed = failed)
    Box(Modifier.fillMaxSize().background(WORLD_SKY).blockSceneInput()) {
        Row(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing).padding(12.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            onBack?.let { WorldButton(onClick = it, compact = true) { Text("‹ BASE") } }
            Text("WORLD MAP", style = MaterialTheme.typography.labelSmall, color = Palette.muted)
        }
        if (failed || download != null || stage != gg.pixelkingdomwars.nativeclient.ui.kingdom.IndicatorStage.HIDDEN)
            gg.pixelkingdomwars.nativeclient.ui.kingdom.SceneStrip(worldOpeningStrip(failed, download),
                actions = if (failed) { { gg.pixelkingdomwars.nativeclient.ui.boot.StripButton("TRY AGAIN", onRetry) } } else null)
    }
}

/** The globe's own sky (GlobeV2Renderer's clear colour): the stage of every world opening, so the globe fades in on the
 *  same space it is drawn on — never the #100E14 shell. */
internal val WORLD_SKY = Color(gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeV2Renderer.SKY_R,
    gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeV2Renderer.SKY_G, gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeV2Renderer.SKY_B)

/** What the world's opening strip says: the reason on a failure; a meter measured in verified files while the world
 *  downloads (it only moves forward); otherwise the one-way sweep. The web's own words ("Shaping the realms…"). */
internal fun worldOpeningStrip(failed: Boolean, download: gg.pixelkingdomwars.nativeclient.data.WorldContentProgress?): gg.pixelkingdomwars.nativeclient.ui.boot.LoadingStripContent = when {
    failed -> gg.pixelkingdomwars.nativeclient.ui.boot.LoadingStripContent("Couldn't open the world",
        gg.pixelkingdomwars.nativeclient.ui.boot.StripMeter.Still, "Please try again in a moment.", reason = true)
    download != null && download.totalFiles > 0 -> gg.pixelkingdomwars.nativeclient.ui.boot.LoadingStripContent("Shaping the realms…",
        gg.pixelkingdomwars.nativeclient.ui.boot.StripMeter.Measured(download.verifiedFiles.toFloat() / download.totalFiles),
        "Downloading · ${download.verifiedFiles * 100 / download.totalFiles}%")
    else -> gg.pixelkingdomwars.nativeclient.ui.boot.LoadingStripContent("Shaping the realms…", gg.pixelkingdomwars.nativeclient.ui.boot.StripMeter.Sweep)
}

/** Forged tab plate (web Btn on the HUD tab kit): tab/tab-sunk, gold/gold-sunk for the primary action.
 * The touch target is always ≥ 48dp; `compact` draws a 40dp plate centred in it for bars and chip rows. */
@Composable private fun WorldButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, active: Boolean? = null, primary: Boolean = false, compact: Boolean = false, minWidth: Dp = 48.dp, content: @Composable RowScope.() -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val plate = if (primary) "gold" else "tab"
    val sunk = pressed || active == true
    // Min constraints propagate inward, so a caller's fillMaxWidth/weight sizes the plate while a bare
    // button wraps its label; the plate itself never asks to fill (that would swallow a header row).
    Box(modifier.sizeIn(minWidth = minWidth, minHeight = 48.dp).alpha(if (enabled) 1f else .5f).blockSceneInput()
        .semantics { active?.let { selected = it } }
        .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center, propagateMinConstraints = true) {
        Box(Modifier.padding(vertical = if (compact) 4.dp else 0.dp), propagateMinConstraints = true) {
            PixelPlate(if (sunk) "$plate-sunk" else plate, Modifier, PaddingValues(horizontal = 8.dp, vertical = 2.dp)) {
                Row(Modifier.offset(y = if (sunk) 1.dp else 0.dp), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                    CompositionLocalProvider(LocalContentColor provides if (primary) Palette.ink else if (active == true) Palette.goldHi else Palette.text) {
                        ProvideTextStyle(if (compact) MaterialTheme.typography.labelMedium else MaterialTheme.typography.labelLarge, content = { content() })
                    }
                }
            }
        }
    }
}

/** Dock plate with an icon over an 11sp label (label null: icon only), sunk while active or pressed. */
@Composable private fun RailDock(art: String, label: String?, onClick: () -> Unit, modifier: Modifier = Modifier, active: Boolean? = null, enabled: Boolean = true, badge: String? = null, description: String? = null) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val sunk = pressed || active == true
    PixelPlate(if (sunk) "dock-sunk" else "dock", modifier.alpha(if (enabled) 1f else .5f)
        .semantics { active?.let { selected = it }; description?.let { contentDescription = it } }
        .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick), PaddingValues(2.dp)) {
        Column(Modifier.fillMaxSize().offset(y = if (sunk) 1.dp else 0.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            GameArt(art, Modifier.size(if (label == null) 22.dp else 20.dp))
            if (label != null) Text(label, style = MaterialTheme.typography.labelLarge.copy(fontSize = 11.sp, lineHeight = 12.sp), maxLines = 1, softWrap = false, overflow = TextOverflow.Clip,
                color = if (active == true) Palette.goldHi else Palette.muted)
        }
        badge?.let { Text(it, Modifier.align(Alignment.TopEnd).background(Palette.gold).padding(horizontal = 3.dp), color = Palette.ink, style = MaterialTheme.typography.labelSmall) }
    }
}

/** Horizontal dock tab: icon beside a label, for the closed details toggle. */
@Composable private fun DockTab(art: String, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    PixelPlate(if (pressed) "dock-sunk" else "dock", modifier.heightIn(min = WorldChrome.ZOOM.dp)
        .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick), PaddingValues(horizontal = 10.dp, vertical = 2.dp)) {
        Row(Modifier.offset(y = if (pressed) 1.dp else 0.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            GameArt(art, Modifier.size(18.dp))
            Text(label, style = MaterialTheme.typography.labelMedium, color = Palette.goldHi, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable private fun ZoomDock(sign: String, description: String, onClick: () -> Unit, enabled: Boolean) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    PixelPlate(if (pressed) "dock-sunk" else "dock", Modifier.size(WorldChrome.ZOOM.dp).alpha(if (enabled) 1f else .5f).semantics { contentDescription = description }
        .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)) {
        Text(sign, Modifier.align(Alignment.Center).offset(y = if (pressed) 1.dp else 0.dp), style = MaterialTheme.typography.titleLarge, color = Palette.text)
    }
}

/** Recessed search well: scout glyph, the field, and × to clear. Search-on-IME and the 96-char cap are unchanged. */
@Composable private fun WorldSearchField(query: String, onChange: (String) -> Unit, onSubmit: () -> Unit, onClear: () -> Unit, onFocus: (Boolean) -> Unit, modifier: Modifier = Modifier, focusRequester: FocusRequester? = null) {
    PixelPlate("shard", modifier.heightIn(min = WorldChrome.SEARCH_ROW.dp), PaddingValues(start = 8.dp, end = 2.dp, top = 2.dp, bottom = 2.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            GameArt("scout", Modifier.size(18.dp))
            BasicTextField(query, onChange, Modifier.weight(1f).then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
                .onFocusChanged { onFocus(it.hasFocus) }.semantics { contentDescription = "Find a keeper" },
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = Palette.text), singleLine = true, cursorBrush = SolidColor(Palette.gold),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { onSubmit() }),
                decorationBox = { inner -> Box(contentAlignment = Alignment.CenterStart) {
                    if (query.isEmpty()) Text("Find a keeper…", style = MaterialTheme.typography.bodyMedium, color = Palette.textFaint, maxLines = 1)
                    inner()
                } })
            if (query.isNotEmpty()) Box(Modifier.size(40.dp).semantics { contentDescription = "Clear search" }.clickable(role = Role.Button, onClick = onClear), contentAlignment = Alignment.Center) { GameArt("close", Modifier.size(16.dp)) }
        }
    }
}

/** Transient world status on one recessed plate. Only real failures read red; loading and truncation stay muted. */
@Composable private fun WorldStatus(current: WorldUiState?, detailError: String?, notice: ScreenNotice?, onRetry: () -> Unit, onRetryDetail: () -> Unit, modifier: Modifier = Modifier) {
    val loading = current?.loading == true
    val error = current?.error
    val truncated = current?.truncated == true
    if (!loading && error == null && !truncated && detailError == null && notice == null) return
    PixelPlate("shard", modifier, PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (loading) Text("Finding kingdoms…", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            error?.let { Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(it, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = Palette.danger); WorldButton(onClick = onRetry, compact = true) { Text("RETRY") }
            } }
            // The centered loading card owns world errors and retry; do not repeat internal details here.
            if (truncated) Text("Showing nearby deeds from ${current?.matched}. Zoom closer for each parcel.", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            detailError?.let { message -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = Palette.muted); WorldButton(onClick = onRetryDetail, compact = true) { Text("RETRY DETAIL") }
            } }
            notice?.let { Text(it.message, style = MaterialTheme.typography.bodySmall, color = if (it.error) Palette.danger else Palette.gold) }
        }
    }
}

@Composable private fun WorldParcel(model: WorldViewModel, current: WorldUiState, selectedBaseId: String?, busy: Boolean, onOpenLand: () -> Unit, onOpenBases: () -> Unit) {
    val id = current.selectedTileId ?: return
    val parcel = current.selected
    val tile = parcel?.tile ?: model.tile(id)
    var detailsOpen by remember(id,selectedBaseId) {mutableStateOf(false)}
    WorldKicker("${tile?.realmId?.replace('-', ' ') ?: ""} · TILE $id")
    if (parcel == null) { Text("Checking current ownership…"); return }
    val own = current.globe?.me?.ownedTiles?.firstOrNull { it.tileId == id }
    val detail = parcel.detail as? JsonObject
    if (detail != null) {
        val player = detail["player"] as? JsonObject; val shield = detail["shield"] as? JsonObject
        WorldTitle(player?.string("name") ?: "Keeper",Palette.goldHi)
        Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            WorldStat("KEEP", player?.string("keepLevel") ?: "—", Modifier.weight(1f))
            WorldStat("TROPHIES", player?.string("trophies") ?: "—", Modifier.weight(1f))
        }
        val protected = shield?.get("active")?.jsonPrimitive?.booleanOrNull == true
        val suppressed = shield?.get("suppressedByWarzone")?.jsonPrimitive?.booleanOrNull == true
        // A shield state is a status, not a failure: active reads green, anything else gold.
        PixelPlate("shard", Modifier.fillMaxWidth(), PaddingValues(8.dp)) { Column(verticalArrangement=Arrangement.spacedBy(2.dp)) {
            Text(when { suppressed -> "SHIELD SUPPRESSED BY WARZONE"; protected -> "SHIELD ACTIVE"; else -> "UNSHIELDED" },
                color=if(protected && !suppressed) Palette.success else Palette.gold,style=MaterialTheme.typography.labelMedium)
            ParcelShieldClock(detail, current.selectedAtNanos)
        } }
        val actions = detail["actions"] as? JsonObject
        val scout = actions?.get("scout") as? JsonObject; val attack = actions?.get("attack") as? JsonObject
        if (own == null) {
            Row(Modifier.fillMaxWidth(),horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                WorldButton(onClick = { model.scout() }, enabled = !busy && scout?.get("allowed")?.jsonPrimitive?.booleanOrNull == true, modifier = Modifier.weight(1f)) { GameArt("scout", Modifier.size(18.dp)); Text("SCOUT",maxLines=1) }
                WorldButton(onClick = { model.attack() }, enabled = !busy && attack?.get("allowed")?.jsonPrimitive?.booleanOrNull == true, primary = true, modifier = Modifier.weight(1f)) { GameArt("attack", Modifier.size(18.dp)); Text("RAID",maxLines=1) }
            }
            attack?.string("blockedBy")?.let { Text(worldBlockReason(it, attack["keepReach"] as? JsonObject), color = Palette.muted, style = MaterialTheme.typography.bodySmall) }
            scout?.string("blockedBy")?.takeIf { it != attack?.string("blockedBy") }?.let { Text(worldBlockReason(it), color = Palette.muted, style = MaterialTheme.typography.bodySmall) }
        }
    }
    if (own != null) WorldButton(onClick = onOpenBases, primary = true, modifier = Modifier.fillMaxWidth(), enabled = !busy) { Text(if (own.active) "OPEN YOUR BASES" else "MANAGE INACTIVE DEED") }
    if (!parcel.tile.ordinary) WorldReserved("${parcel.tile.allocation?.uppercase()} RESERVE · This sanctuary is not available for ordinary purchase.")
    if (parcel.available) { WorldTitle("Available land",Palette.goldHi); Text("Choose this parcel to continue to checkout.", color = Palette.muted)
        WorldButton(onClick = { model.draftLand(onOpenLand) }, primary = true, modifier = Modifier.fillMaxWidth()) { Text("CHOOSE THIS LAND") } }
    if (parcel.availability == "held") Text("Another checkout currently holds this parcel.")
    if (parcel.availability == "occupied" && detail == null) Text("This land is already assigned. Its base is not currently available for inspection.")
    WorldButton(onClick={detailsOpen=!detailsOpen},modifier=Modifier.fillMaxWidth(),compact=true) {
        Text("PARCEL DETAILS",Modifier.weight(1f));Text(if(detailsOpen) "−" else "+")
    }
    if(detailsOpen) {
        tile?.let {Text("${it.lat ?: "—"}° · ${it.lon ?: "—"}°",color=Palette.muted,style=MaterialTheme.typography.bodySmall)}
        (detail?.get("base") as? JsonObject)?.let {base->Text("${base.string("completedStructures") ?: "—"} structures · ${base.string("walls") ?: "—"} walls",color=Palette.muted,style=MaterialTheme.typography.bodySmall)}
        if(own==null)(detail?.get("availableLootRanges") as? JsonObject)?.let {loot->
            WorldKicker("AVAILABLE LOOT")
            loot.forEach {(tier,value)->val range=value as? JsonObject;Text("${tier.replace("Star"," star")}: ${range?.string("min")}–${range?.string("max")}",style=MaterialTheme.typography.bodySmall,color=Palette.muted)}
        }
    }
    detail?.let {DeedPreview(model,id,selectedBaseId,it)}
}

internal fun worldBlockReason(reason:String,keep:JsonObject?=null)=when(reason){"self"->"This is your parcel";"shielded"->"Shield active";"keep_too_far_below"->if(keep!=null)"Their Keep is too far below yours (L${keep.string("defenderKeep")} vs your L${keep.string("attackerKeep")})" else "Their Keep is too far below yours";"outside_trophy_window"->"Outside trophy range";else->"Temporarily unavailable"}
internal data class GlobeMarker(val tileId:Int,val lon:Double,val lat:Double,val name:String,val realmId:String?=null,val count:Int=1,val owned:Boolean=false)
internal data class GlobeMarkerGroup(val x:Double,val y:Double,val members:MutableList<GlobeMarker>) { val count:Int get()=members.sumOf{it.count} }
internal fun worldMarkers(state:WorldUiState,model:WorldViewModel,density:Float):List<GlobeMarkerGroup> {
    val markers=mutableListOf<GlobeMarker>()
    if(state.view.zoom<5)state.globe?.realms?.filter{it.occupied>0}?.forEach{realm->
        val info=model.regions.firstOrNull{it.string("id")==realm.realmId} ?: return@forEach
        realm.anchorTileId?.let { markers+=GlobeMarker(it,info.getValue("lon").jsonPrimitive.double,info.getValue("lat").jsonPrimitive.double,info.string("name") ?: realm.realmId,realm.realmId,realm.occupied) }
    }
    fun add(id:Int,name:String,owned:Boolean=false) { val tile=model.tile(id) ?: return;markers+=GlobeMarker(id,requireNotNull(tile.lon).toDouble(),requireNotNull(tile.lat).toDouble(),name,owned=owned) }
    if(state.view.zoom>=5)state.markers.forEach{add(it.tileId,it.name ?: "Keeper")}
    state.globe?.me?.ownedTiles?.forEach{ if(state.view.zoom>=5 || markers.none{m->m.realmId==it.realmId})add(it.tileId,it.name ?: "My parcel",true) }
    state.selected?.let { if(markers.none{m->m.tileId==it.tile.tileId})add(it.tile.tileId,"Selected parcel") }
    val groups=mutableListOf<GlobeMarkerGroup>()
    markers.distinctBy{it.tileId}.sortedWith(compareByDescending<GlobeMarker>{it.tileId==state.selectedTileId}.thenByDescending{it.owned}.thenBy{it.tileId}).forEach { marker->
        val p=GlobeGeometry.project(marker.lon,marker.lat,state.view,state.viewport)
        if(p.z<=.15 || p.x<24*density || p.x>state.viewport.width-24*density || p.y<24*density || p.y>state.viewport.height-24*density)return@forEach
        val group=groups.firstOrNull{kotlin.math.abs(it.x-p.x)<58*density && kotlin.math.abs(it.y-p.y)<54*density}
        if(group==null)groups+=GlobeMarkerGroup(p.x,p.y,mutableListOf(marker)) else group.members+=marker
    }
    return groups
}

@Composable internal fun DeadlineText(deadline:WorldDeadline?,prefix:String) {
    var now by remember(deadline) { mutableLongStateOf(System.nanoTime()) }
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(deadline,lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { while(true) {now=System.nanoTime();kotlinx.coroutines.delay(1_000)} } }
    deadline?.let {Text("$prefix ${worldDuration(it.remaining(now))}")}
}
@Composable internal fun ParcelShieldClock(detail:JsonObject,at:Long) {
    val shield=parcelDeadlines(detail,at).firstOrNull {it.key.startsWith("shield:")}
    DeadlineText(shield,"SHIELD TIME LEFT")
}
@Composable internal fun WarzoneClock(status:WorldWarzone,cooldownHours:Int) {
    Text(when {status.mode=="off"->"WARZONES OFF";status.active && status.mode=="purge"->"PURGE WARZONE ACTIVE";status.active->"WARZONE ACTIVE";status.mode=="purge"->"NO WARZONE ACTIVE";else->"NEXT WARZONE"},style=MaterialTheme.typography.titleMedium)
    if(status.deadline!=null)DeadlineText(status.deadline,if(status.active)"TIME REMAINING" else "STARTS IN")
    else Text(when {status.mode=="off"->"No active window";status.mode=="purge" && !status.active->"Purges are unannounced";else->"Boundary time unavailable"})
    Text(if(status.active)"Ordinary loss and purchase shields are suppressed. Only a Warzone shield protects. A defender can be hit again after ${cooldownHours}H."
        else "Ordinary shields protect normally. During a Warzone they keep counting down but do not block attacks.", style=MaterialTheme.typography.bodyMedium, color=Palette.muted)
    Text("Raid loot, stars, trophies and damage rules do not change. A loss shield earned during the window only protects afterward if time remains.", style=MaterialTheme.typography.bodyMedium, color=Palette.muted)
}

@Composable internal fun DeedPreview(model:WorldViewModel,tileId:Int,baseId:String?,detail:JsonObject) {
    val deed=detail["deed"] as? JsonObject ?: return
    val metadata=deed["metadata"] as? JsonObject ?: return
    var expanded by remember(tileId,baseId) {mutableStateOf(false)}
    WorldButton(onClick={expanded=!expanded},modifier=Modifier.fillMaxWidth(),compact=true) {
        Text("BASE PREVIEW",Modifier.weight(1f));Text(if(expanded) "−" else "+")
    }
    if(!expanded)return
    var attempt by remember(tileId,baseId) {mutableIntStateOf(0)}
    var loading by remember(tileId,baseId) {mutableStateOf(true)}
    val image by produceState<android.graphics.Bitmap?>(null,tileId,baseId,metadata,attempt) {
        value=null;loading=true
        try {
            val bytes=model.deedPreview(tileId,detail) { data ->
                val bounds=android.graphics.BitmapFactory.Options().apply {inJustDecodeBounds=true}
                android.graphics.BitmapFactory.decodeByteArray(data,0,data.size,bounds)
                bounds.outWidth in 1..4096 && bounds.outHeight in 1..4096
            }
            value=kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
                val bounds=android.graphics.BitmapFactory.Options().apply {inJustDecodeBounds=true}
                android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds)
                val options=android.graphics.BitmapFactory.Options().apply {inSampleSize=(maxOf(bounds.outWidth,bounds.outHeight)/512).coerceAtLeast(1)}
                android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.size,options)
            }
        } catch(error:kotlinx.coroutines.CancellationException){throw error}
        catch(_:Exception){ /* The inspector remains available when public artwork is offline. */ }
        finally {loading=false}
    }
    image?.let {bitmap->androidx.compose.foundation.Image(bitmap=bitmap.asImageBitmap(),contentDescription="${metadata.string("name") ?: "Land Deed"} preview",modifier=Modifier.fillMaxWidth().height(144.dp))}
        ?: if(loading)Text("Loading base preview…",style=MaterialTheme.typography.bodySmall,color=Palette.muted) else TextButton(onClick={attempt++}){Text("RETRY DEED PREVIEW")}
    metadata.string("name")?.let {Text(it,style=MaterialTheme.typography.titleSmall)}
    deed.string("status")?.let {Text(it.uppercase(),style=MaterialTheme.typography.labelSmall)}
}
