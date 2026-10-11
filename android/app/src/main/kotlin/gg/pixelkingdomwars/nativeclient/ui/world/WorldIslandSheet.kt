package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.SeekerAuctionRepository
import gg.pixelkingdomwars.nativeclient.data.seekerAuctionClient
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.ClanMembership
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination
import gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandOwners
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEActivity
import gg.pixelkingdomwars.nativeclient.ui.phasee.VehicleEntryPoint
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DivinePanel
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.PublicWorkshopSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SeekerPanel
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.IslandLastKnown
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.SeekerAuctionHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divinePanelActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divinePanelUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divineTrialsConfigured
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.publicWorkshopActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.publicWorkshopUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.seekerPanelActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.seekerPanelUi
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import kotlinx.serialization.json.JsonObject

/**
 * The designed sheet of a selected Phase E island on the globe (frames seeker-panel #76, the Public Workshop sheet of
 * solana-island #85, divine-panel #88), in place of the old "ISLAND · COMING SOON" panel ([PhaseEIslands.panel]).
 *
 * Read only: the catalogue, the selected base's Home read and the clan membership read. Every tap navigates to an existing
 * owner ([onOpenPhaseE], [onOpenClanHall], the vehicle owner's craft page through [onCraftVehicle], a kingdom building
 * through [onFocusBuilding] or [onBuildMenu]) or toasts why not; no owner, purchase or server call lives here. A routine
 * refresh that briefly reads nothing keeps what was shown ([IslandLastKnown]). Any other [islandId] draws nothing. The one
 * exception is [seekerAuction]: on a devnet TEST build it draws the live auction host (SeekerAuctionHost), which owns its
 * own reads and wallet steps.
 */
@Composable internal fun WorldIslandSheet(islandId: String, model: WorldViewModel, onClose: () -> Unit,
    onOpenPhaseE: (PhaseEActivity) -> Unit, onOpenClanHall: () -> Unit, onFocusBuilding: (String) -> Unit, onBuildMenu: () -> Unit,
    modifier: Modifier = Modifier,
    /** The live Seeker auction ([rememberSeekerAuctionSlot]); null keeps the designed SERVER_OFF panel below. */
    seekerAuction: SeekerIslandSlot? = null,
    /** The Public Workshop's CRAFT VEHICLE ([publicWorkshopCraftOpening]); null: this session has no vehicle owner. */
    onCraftVehicle: (() -> Unit)? = null) {
    val baseId = model.state.collectAsState().value.baseId
    val home = model.home.collectAsState().value
    val clans = model.clans.collectAsState().value
    val explain: (String) -> Unit = { Toasts.post(it) }
    val catalogue = remember { IslandLastKnown<JsonObject>() }.keep(model.catalogue)
    // The buildings only ever of the selected base: another base's Home read never answers for this one.
    val buildings = remember(baseId) { IslandLastKnown<List<Building>>() }
        .keep(home.base?.takeIf { worldChromeBaseIsCurrent(baseId, it.baseId) }?.buildings)
    val membership = remember { IslandLastKnown<ClanMembership>() }.keep(clans.membership)
    when (islandId) {
        "seeker-island" -> if (seekerAuction != null) seekerAuction(onClose, modifier)
            else SeekerPanel(seekerPanelUi(catalogue), seekerPanelActions(explain, onClose), modifier)
        "solana-island" -> PublicWorkshopSheet(publicWorkshopUi(buildings),
            publicWorkshopActions(buildings, onCraftVehicle, onFocusBuilding, onBuildMenu, explain, onClose), modifier)
        "divine-isle" -> {
            val soloSites = remember { IslandLastKnown<Int>() }.keep(model.constant("PHASE_E_DIVINE_TRIALS", "divineSites"))
            // The clan citadels are the tournament's Divine sites (TournamentAppPorts `tournamentPolicy`).
            val citadels = remember { IslandLastKnown<Int>() }.keep(model.constant("PHASE_E_CHARTER_TOURNAMENT", "divineSites"))
            val trials = remember(catalogue) { divineTrialsConfigured(catalogue) }
            DivinePanel(divinePanelUi(soloSites, citadels, trials, membership),
                divinePanelActions(onOpenPhaseE, onOpenClanHall, explain, onClose), modifier)
        }
    }
}

/** The Seeker Island sheet drawn in [WorldIslandSheet]'s slot: (onClose, the half sheet's modifier). */
internal typealias SeekerIslandSlot = @Composable (onClose: () -> Unit, modifier: Modifier) -> Unit

/**
 * The live Seeker Island auction for the island sheet (plan onchain-client-reach.md §5.4 S-F), or null: the repository
 * ([seekerAuctionClient]) exists only on a debug build carrying the devnet TEST pins, on devnet, online, for the current
 * session; anything else (or a session replaced meanwhile) keeps the designed SERVER_OFF panel and its locked ENTER ISLAND
 * reason, so no door is ever dead. Remembered per session and wallet app, so the host's view model and its in-flight wallet
 * step survive leaving the World tab.
 *
 * Logged deviation (plan §5.3 / §5.5 (3)): there is no island scene yet (seeker-island #78 / seeker-closed #77 have no
 * backing system and no spot anchors), so ENTER ISLAND and the YOU HERE cards open the designed spot-number search
 * (SPEC §2.4 MapSearchDrawer, spotsOnly) instead of the scene; a search row opens that spot's sheet.
 */
@Composable internal fun rememberSeekerAuctionSlot(graph: AppGraph, session: SessionGraph, wallet: WalletLogin?): SeekerIslandSlot? {
    val repository = remember(session, wallet) { runCatching { graph.seekerAuctionClient(session, wallet) }.getOrNull() }
    return remember(graph, session, repository) { repository?.let { seekerAuctionSlot(graph, session, it) } }
}

private fun seekerAuctionSlot(graph: AppGraph, session: SessionGraph, repository: SeekerAuctionRepository): SeekerIslandSlot =
    { onClose, modifier -> SeekerAuctionHost(graph, session, repository, onClose, modifier) }

/**
 * The Public Workshop's CRAFT VEHICLE (map SPEC §4.1: CRAFT opens the existing vehicle crafting through the one fleet-command
 * owner): the vehicle owner's Solana Island entry, its craft page, which is the page every Solana craft door used to open
 * directly. It used to select the Berth instead, which dropped the player on the base screen (owner 2026-10-06). Null when
 * this session has no available vehicle owner. Selecting runs nothing; the owner's own admission runs on the tap.
 */
internal fun publicWorkshopCraftOpening(fleet: FleetCommandOwners?): (() -> Unit)? =
    fleet?.owners?.firstOrNull { it.destination == FleetCommandDestination.VEHICLES && it.available }
        ?.entryOpening(VehicleEntryPoint.SOLANA_PUBLIC.name, historyOnly = false)
