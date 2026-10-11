package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import gg.pixelkingdomwars.nativeclient.data.VehicleUnavailable
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.phasee.VehicleEntryPoint
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.BerthSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.BerthLiveCallbacks
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.BerthLiveDoor
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.BerthLocalState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageLiveInputs
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.berthSheetActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.berthSheetUi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Complete Berth player body (berth-starter, berth-fleet, berth-install, berth-service), moved out of HomeVoyageSheet.
 * The free starter install borrows the existing StarterFleet review. Crafted install and service hand off to the existing
 * Vehicle controls, which own the wallet-signed burn; no money call starts from this body. */
@Composable internal fun HomeBerthLiveSheet(identity: HomeRouteIdentity, entry: SheetEntry, input: VoyageLiveInputs,
    owners: HomeOwnerProjections, modifier: Modifier, onTab: (String) -> Unit, onClose: () -> Unit, onLegacy: () -> Unit,
    onHistory: () -> Unit, openVehicles: (VehicleEntryPoint?, Boolean) -> Unit, openFeature: (String) -> Unit,
    canRead: () -> Boolean, explain: (String) -> Unit, nestedBack: HomeBodyBack, starterReview: HomeStarterFleetReviewController?,
    checkPending: () -> Unit, retry: () -> Unit, readError: String?, unavailable: VehicleUnavailable?,
    berthPlacement: HomeBerthPlacementDoor? = null,
    /** The craft-vehicle GO ("Public Workshop, Solana Island"): the globe on Solana Island's Public Workshop sheet. */
    openSolanaIsland: () -> Unit) {
    val destination = entry.destination as Destination.Berth
    var local by remember(identity, destination) { mutableStateOf(BerthLocalState(tab = destination.tab,
        section = destination.section?.takeUnless { it == "vehicles" })) }
    HomeBodyBackRegistration(nestedBack) {
        homeBerthBack(local)?.let { local = it; true } ?: false
    }
    val scope = rememberCoroutineScope()
    // Exploration end to end: an install the server accepted (now, or in an earlier visit) is archived by its existing
    // owner (GET only), so CHECK, History and INSTALL FREE never fall to the old starter screen and the Berth reads the boat.
    val provenInstall = input.starterFleet?.journal?.operation?.takeIf { it.proof != null }?.command?.key
    LaunchedEffect(starterReview, provenInstall) {
        if (provenInstall == null) return@LaunchedEffect
        val settled = try { starterReview?.settleAccepted() == true }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { false /* The saved proof stays; History still reaches it. */ }
        // Owner Seeker 2026-10-06: the settle's finish re-reads /starter-fleet; when it could not run, the starter owner's own GET
        // re-reads it, so the installed boat shows whatever the crafted vehicle read says (it is independent of /vehicles/*).
        if (!settled) try { owners.starterFleet?.refresh?.invoke(Unit) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* The accepted proof still marks the boat installed (starterFleetUi). */ }
    }
    // Owner 2026-10-06 (free placement): the Berth the player opened and whether a new Berth can be placed come from the
    // Kingdom model; INSTALL goes into a vacant Berth or places a new one (BerthPlacement.kt).
    val sheetInput = if (berthPlacement == null) input
        else input.copy(selectedBerthId = berthPlacement.selectedBerthId(), berthPlacement = berthPlacement.facts())
    val ui = berthSheetUi(sheetInput, local.copy(tab = entry.selectedTab ?: local.tab)).copy(
        readError = readError,
        reviewUnavailable = "Crafted install and service reviews are not available here yet.")
    val actions = berthSheetActions(ui, BerthLiveCallbacks(
        update = { update -> if (canRead()) { val next = update(local.copy(tab = entry.selectedTab ?: local.tab)); local = next; onTab(next.tab) } },
        toast = explain, reviewStarterInstall = { if (canRead()) scope.launch {
            try {
                // Each Berth open re-reads the starter owner; INSTALL FREE tapped meanwhile waits for it, not a refusal.
                starterReview?.awaitReady()
                if (starterReview?.open() != true && starterReview?.openSavedOutcome(onLegacy) != true)
                    explain("Starter installation cannot be reviewed right now.")
            }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { explain("The starter installation could not be reviewed. Its saved request has been kept.") }
        }; Unit },
        loadAssets = { cursor -> if (canRead()) scope.launch {
            try { if (owners.vehicle?.assets?.invoke(cursor) != true) explain("Open Vehicle controls to refresh wallet assets.") }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { explain("Wallet assets could not be refreshed. Try again.") }
        }; Unit }, checkPending = { if (starterReview?.openSavedOutcome(onLegacy) != true) checkPending() },
        go = { door, _ -> when (door) {
            // Terminal or foreign-kingdom starter requests keep their existing recovery owner.
            BerthLiveDoor.HISTORY -> if (starterReview?.openSavedOutcome(onLegacy) != true) {
                if (owners.vehicle != null) onHistory() else explain("Vehicle receipts are unavailable for this session.")
            }
            BerthLiveDoor.LODGE_SEND -> openFeature("lodge.expedition")
            // World › Solana Island › Public Workshop (owner 2026-10-06: the GO must show Solana Island, not the base); the
            // sheet's CRAFT VEHICLE opens the existing craft page there. A closed vehicle server says why instead.
            BerthLiveDoor.SOLANA_WORKSHOP -> if (canRead()) homeVoyageVehicleControls(unavailable, openSolanaIsland, explain)
        } }, close = onClose,
        // MONEY: a crafted install or service burns a wallet vehicle and pays a network fee. Its reviewed sequence and the
        // wallet approval live only in the existing Vehicle controls, so the designed picker card and SERVICE primary open
        // them; nothing is reserved, signed or sent from this body.
        openCraftedControls = { if (canRead()) homeVoyageVehicleControls(unavailable, { openVehicles(VehicleEntryPoint.BERTH, false) }, explain) },
        // Free placement: the Kingdom's ordinary Berth placement (ghost, footprint, PLACE band), after the sheet closes.
        placeBerth = if (berthPlacement == null) null else { { if (canRead()) berthPlacement.place() } }))
    BerthSheet(ui, actions.copy(onRetry = { if (canRead()) retry() }), modifier)
}
