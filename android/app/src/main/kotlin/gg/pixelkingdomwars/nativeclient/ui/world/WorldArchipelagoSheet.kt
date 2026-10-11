package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionState
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.home.rememberHomeVoyageArt
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ArchipelagoPanel
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ArchipelagoPanelActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ReachStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ReachTileActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ReachTileSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.archipelagoPanelUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.reachTileUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.worldReachTileApplies
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.reachLayout
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LocalVoyageArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.LODGE_TYPE
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.voyagePolicyFacts
import gg.pixelkingdomwars.nativeclient.vehicle.VehiclePolicy

/*
 * The World tab's two designed half sheets for slice C: the archipelago island panel (design/final/map/SPEC.md §6,
 * archipelago-panel.png), drawn for a selected small island in place of the old EXPLORE body, and the Solana Reach Seeker-tile
 * sheet (design/final/account/SPEC.md §6.2, reach-tile.png), drawn on the realm map in place of the old parcel card's
 * Seeker reserve note. Both are MapSheetFrame half sheets with no scrim; the caller places them.
 *
 * Neither owns an action. The island never dispatches: SEND and GO TO LODGE close the sheet and hand the player to the Lodge
 * on Home ([onFocusBuilding]); BUILD A LODGE opens the build menu. The Reach sheet is always OFF (no unlock owner exists),
 * so it draws no button but the X; any other Reach door still says why it is shut.
 *
 * Route art: the archipelago sheet provides LocalVoyageArt from Home's route-art source ([rememberHomeVoyageArt]) over the
 * World tab's catalogue policy, so the head row shows the island's real route card (the stand-in only while it loads or
 * when it cannot). The trip list stays empty: the World tab has no vehicle read of its own.
 */

/** The toast when the base is not read yet and the Lodge cannot be named. */
private const val BASE_LOADING = "Your base is still loading. Try again in a moment."

/**
 * The archipelago island panel for [archipelagoId] (`WorldHudUi.archipelagoId`). It reads [model]'s presentation chains, the
 * installed island catalogue (the same `VehiclePolicy.catalogue` the Lodge's island list reads) and the selected base's
 * buildings (`model.home`, only when it is the World tab's base); [realms] names the realm line, [starter] says which islands
 * are HOME.
 */
@Composable internal fun WorldArchipelagoSheet(archipelagoId: String, model: WorldViewModel, realms: List<GlobeRealmInfo>,
    starter: StarterExpeditionState?, onClose: () -> Unit, onFocusBuilding: (String) -> Unit, onBuildMenu: () -> Unit,
    modifier: Modifier = Modifier,
    /** The blue GO to the Solana Public Workshop (SPEC §6 "No eligible vehicle"): the host selects Solana Island on this globe,
     *  whose sheet is the Public Workshop (c-gap-map); null where this build has no Solana Island, which then says where it is. */
    onPublicWorkshop: (() -> Unit)? = null) {
    val world by model.state.collectAsState()
    val home by model.home.collectAsState()
    // another base's snapshot is unknown here (the chrome's own rule), never "no Lodge"
    val buildings = home.base?.takeIf { worldChromeBaseIsCurrent(world.baseId, it.baseId) }?.buildings
    val catalogue = model.catalogue
    val routes = remember(catalogue) { voyagePolicyFacts(VehiclePolicy.catalogue(catalogue)).routes }
    val realmNames = remember(realms) { realms.associate { it.id to it.name } }
    val ui = archipelagoPanelUi(archipelagoId, model.chains, realmNames, buildings, starter, routes)
    val lodge = buildings?.firstOrNull { it.type == LODGE_TYPE }
    val toLodge: () -> Unit = { if (lodge == null) Toasts.post(BASE_LOADING) else { onClose(); onFocusBuilding(lodge.id) } }
    // The route card is the installed chain atlas cell, through Home's own route-art source over this tab's catalogue policy
    // (the same OrdinaryRoutes the Lodge reads); while it loads, or when it cannot, the voyage stand-in draws instead.
    CompositionLocalProvider(LocalVoyageArt provides rememberHomeVoyageArt(model.appGraph, model.sessionGraph) {
        VehiclePolicy.catalogue(model.catalogue)?.ordinaryRoutes }) {
        ArchipelagoPanel(ui, ArchipelagoPanelActions(
            onSend = toLodge,
            onGoLodge = toLodge,
            onBuildLodge = { onClose(); onBuildMenu() },
            onPublicWorkshop = { if (onPublicWorkshop != null) onPublicWorkshop() else Toasts.post("The Public Workshop is on Solana Island") },
            onReport = { Toasts.post("This island is not listed for expeditions on this server yet") },
            onExplain = { reason -> Toasts.post(reason) },
            onClose = onClose,
        ), modifier)
    }
}

/**
 * The Solana Reach Seeker-tile sheet for the realm map's selected parcel; draws nothing unless [worldReachTileApplies]. Always
 * [ReachStatus.OFF] with no price ([reachTileUi]); [onHeight] reports its height in dp for the realm HUD's card plan.
 */
@Composable internal fun WorldReachTileSheet(current: WorldUiState, columns: Int, onClose: () -> Unit, onHeight: (Float) -> Unit,
    modifier: Modifier = Modifier) {
    val parcel = current.selected?.takeIf { worldReachTileApplies(it) } ?: return
    val density = LocalDensity.current
    val ui = reachTileUi(parcel, columns, current.globe?.me?.ownedTiles?.isNotEmpty())
    // OFF hides every door but the X (reachLayout); one still reached says why, in the sheet's own words
    val reason = reachLayout(ReachStatus.OFF, ui.hasDeed, false).line ?: UNKNOWN
    val shut: () -> Unit = { Toasts.post(reason) }
    ReachTileSheet(ui, ReachTileActions(onUnlock = shut, onInfo = shut, onGetSkr = shut, onGetLand = shut, onBuyBase = shut, onClose = onClose),
        modifier.onSizeChanged { onHeight(it.height / density.density) })
}
