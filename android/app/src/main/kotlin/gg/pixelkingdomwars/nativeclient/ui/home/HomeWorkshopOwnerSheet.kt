package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.ui.economy.BoundCosmeticWakeWorkshopViewModel
import gg.pixelkingdomwars.nativeclient.ui.economy.BoundCosmeticWorkshopViewModel
import gg.pixelkingdomwars.nativeclient.ui.economy.OrdinaryCraftingContent
import gg.pixelkingdomwars.nativeclient.ui.economy.OrdinaryCraftingViewModel
import gg.pixelkingdomwars.nativeclient.ui.economy.WorkshopScreen
import gg.pixelkingdomwars.nativeclient.ui.economy.WorkshopStyleOwnerScreen
import gg.pixelkingdomwars.nativeclient.ui.economy.WorkshopViewModel
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.nav.graphViewModel
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftFrameUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHeaderUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.LocalWorkshopOwnerHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopObservationUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopOwnerHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopSheetActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.craftBuildingArtTier
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.workshopTabs

/*
 * The Workshop's Home sheet (craft/SPEC.md §2, frames 36-43): the existing owners act in place on the designed sheet.
 * INGOTS is WorkshopScreen over WorkshopViewModel (CAST, COLLECT), REFINE is OrdinaryCraftingContent over
 * OrdinaryCraftingViewModel (START), STYLE is WorkshopStyleOwnerScreen over the Awning and Aurora owners. Each owner keeps
 * its own read, review, consent, journal and receipts; this host supplies only currentness, the tab, the header art from
 * the selected base's Workshop and the navigation doors. TOOLS belongs to the Equipment owner: its tab opens that pane.
 * A repository that cannot be opened shows its recovery sentence inside the sheet frame, never a blank.
 */

/** A tab tap refused while this sheet is not the current read owner (an open review, another kingdom, paused app). */
private const val TAB_REFUSAL = "Finish the current review or reopen this Workshop before changing tabs."

/** The four Workshop tabs this sheet can draw (registry ids). */
private val HOME_WORKSHOP_TABS = setOf(WorkshopTab.REFINE, WorkshopTab.INGOTS, WorkshopTab.EQUIPMENT, WorkshopTab.COSMETICS)

/**
 * The Workshop sheet mounted on Home. [canRead] is the Home lease's read control; [explain] says why a tap was refused;
 * [onTab] changes the sheet's tab (the host sends TOOLS to the Equipment owner); [onOpenTools] opens that owner;
 * [onOpenDestination] opens another designed sheet (Gold Forge SMELT, Harvester, Market BUY).
 */
@Composable internal fun HomeWorkshopOwnerSheet(graph: AppGraph, session: SessionGraph, identity: HomeRouteIdentity, entry: SheetEntry,
    modifier: Modifier, canRead: () -> Boolean, explain: (String) -> Unit, onTab: (String) -> Unit, onClose: () -> Unit,
    onOpenTools: () -> Unit, onOpenDestination: (Destination) -> Unit) {
    val content by graph.content.state.collectAsState()
    val raid by session.interlock.state.collectAsState()
    val baseState by session.base.state.collectAsState()
    val artGeneration by session.boundCosmeticArtGeneration.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val ingots = remember(session) { runCatching { session.workshop } }
    val materials = remember(session) { runCatching { session.ordinaryCrafting } }
    val awnings = remember(session) { runCatching { session.boundCosmeticWorkshop }.getOrNull() }
    val wake = remember(session) { runCatching { session.boundCosmeticWakeWorkshop }.getOrNull() }
    val ingotRepository = ingots.getOrNull()
    val ingotState = ingotRepository?.state?.collectAsState()?.value
    val tab = homeWorkshopOwnerTab(entry, ingotOriginalSaved = ingotState?.journal?.operation != null)
        .let { requested -> homeWorkshopReadyTab(entry, requested, ingotState?.view?.jobs?.any { it.ready && it.collectedAt == null } == true) }
    val canReadNow by rememberUpdatedState(canRead)
    val explainNow by rememberUpdatedState(explain)
    val onTabNow by rememberUpdatedState(onTab)
    val onCloseNow by rememberUpdatedState(onClose)
    val current: () -> Boolean = remember(graph, session, identity, lifecycle, ingotRepository) {
        {
            lifecycle.currentState == Lifecycle.State.RESUMED && homeOwnerProjectionIdentity(graph, session) == identity &&
                // An open INGOTS review is itself one of the reviews that close Home read controls; it stays current for
                // its own owner, so its half sheet can still be confirmed or dismissed in place.
                (canReadNow() || ingotRepository?.state?.value?.review != null)
        }
    }
    val wallet = session.session.wallet
    val actionsAllowed = content.allowsGameOrders(graph.versionCode) && raid.actionsAllowed
    val level = homeWorkshopLevel(baseState.base, identity.baseId)
    val tier = craftBuildingArtTier(content.catalogue, level)
    val capacity = runCatching { session.boundCosmeticArt.maxConcurrentPerBase() }.getOrNull()
    val host = remember(tab, capacity, tier, level, current) {
        WorkshopOwnerHost(tab, onTab = { selected -> if (current()) onTabNow(selected) else explainNow(TAB_REFUSAL) },
            onClose = { onCloseNow() }, benchCapacity = capacity, current = current, headerTier = tier,
            titleTag = level?.let { "LV $it" })
    }
    // Copied from the OrdinaryCraftingRoute registration: a verified appearance belongs to this account, art and kingdom.
    val previewGuard: () -> Unit = {
        graph.holder.requireCurrent(session.session)
        check(session.boundCosmeticArtGeneration.value == artGeneration) { "The verified appearance content changed." }
        check(graph.account.state.value.selectedBaseId == identity.baseId &&
            graph.account.state.value.baseSelectionGeneration == identity.baseSelectionGeneration) {
            "The selected kingdom changed. Reopen its verified appearance."
        }
    }
    CompositionLocalProvider(LocalWorkshopOwnerHost provides host) {
        Box(modifier) {
            when (tab) {
                WorkshopTab.INGOTS -> if (ingotRepository == null) WorkshopRecovery(tab,
                    "Saved Workshop recovery could not be opened. Keep this app's data; no request was sent or replaced. " +
                        "Reopen after storage is available.", host.onTab, onClose)
                else WorkshopScreen(graphViewModel(session) { WorkshopViewModel(ingotRepository) }, wallet, identity.baseId,
                    identity.baseSelectionGeneration, actionsAllowed, Modifier.fillMaxSize(), onOpenDestination, onBack = onClose)
                WorkshopTab.REFINE -> {
                    val repository = materials.getOrNull()
                    if (repository == null) WorkshopRecovery(tab,
                        "Saved refining recovery could not be opened. Keep this app's data and reopen when storage is available.",
                        host.onTab, onClose)
                    else OrdinaryCraftingContent(graphViewModel(session) { OrdinaryCraftingViewModel(repository) }, wallet,
                        identity.baseId, identity.baseSelectionGeneration, actionsAllowed, Modifier.fillMaxSize(), onOpenDestination)
                }
                WorkshopTab.COSMETICS -> WorkshopStyleOwnerScreen(
                    awnings = awnings?.let { repository -> graphViewModel(session) { BoundCosmeticWorkshopViewModel(repository) } },
                    wake = wake?.let { repository -> graphViewModel(session) { BoundCosmeticWakeWorkshopViewModel(repository) } },
                    wallet = wallet, selectedBase = identity.baseId, generation = identity.baseSelectionGeneration,
                    actionsAllowed = actionsAllowed, art = session.boundCosmeticArt, artGeneration = artGeneration,
                    previewGuard = previewGuard, wakeSourcePreview = session.boundCosmeticWakeSourcePreview, host = host)
                // TOOLS is reached here only by a deep link: the sheet says what it cannot show and opens the Equipment owner.
                else -> WorkshopSheet(WorkshopSheetUi(CraftFrameUi("WORKSHOP", null, null, false, workshopTabs(), tab), CraftHeaderUi(null),
                    observation = WorkshopObservationUi("Tools information is unavailable. Equipment and trips have not been observed.",
                        canOpenControls = true)),
                    WorkshopSheetActions(onClose = onClose, onTab = host.onTab,
                        onOpenControls = { if (current()) onOpenTools() else explain(TAB_REFUSAL) }), Modifier.fillMaxSize())
            }
        }
    }
}

/** A Workshop owner whose saved-request storage cannot be opened: its recovery sentence inside the sheet frame, the tabs
 *  and the close door, never a blank sheet and never an empty bench. */
@Composable private fun WorkshopRecovery(tab: String, message: String, onTab: (String) -> Unit, onClose: () -> Unit) {
    WorkshopSheet(WorkshopSheetUi(CraftFrameUi("WORKSHOP", null, null, false, workshopTabs(), tab), CraftHeaderUi(null),
        observation = WorkshopObservationUi(message)), WorkshopSheetActions(onClose = onClose, onTab = onTab), Modifier.fillMaxSize())
}

/** The tab this sheet draws: the sheet's own selected tab, else the destination's, else the SPEC §2 entry default
 *  (INGOTS when an ingot batch waits to be collected, otherwise REFINE: CRAFT★ opens the crafting bench); an unknown id
 *  is that default. A saved INGOTS original takes precedence over a destination tab until the player picks a tab in this
 *  sheet, so its recovery is never hidden behind REFINE or STYLE. */
internal fun homeWorkshopOwnerTab(entry: SheetEntry, ingotOriginalSaved: Boolean = false): String {
    val chosen = entry.selectedTab
    val requested = chosen ?: (entry.destination as? Destination.Workshop)?.tab ?: WorkshopTab.REFINE
    if (chosen == null && ingotOriginalSaved) return WorkshopTab.INGOTS
    return requested.takeIf { it in HOME_WORKSHOP_TABS } ?: WorkshopTab.REFINE
}

/** SPEC §2 Entry rule 1: a door that names no tab (CRAFT★, a plain Workshop door) opens INGOTS while an ingot batch waits
 *  to be collected ([ingotsReady]); a tab the door or the player chose keeps [requested]. */
internal fun homeWorkshopReadyTab(entry: SheetEntry, requested: String, ingotsReady: Boolean): String =
    if (ingotsReady && entry.selectedTab == null && (entry.destination as? Destination.Workshop)?.tab == null) WorkshopTab.INGOTS
    else requested

/** The selected base's completed Workshop level (not under construction), from the server's base snapshot of exactly
 *  [baseId]; null when it has none or the snapshot belongs to another base. */
internal fun homeWorkshopLevel(base: BaseSnapshot?, baseId: String): Int? =
    base?.takeIf { it.baseId == baseId }?.buildings
        ?.firstOrNull { it.type == "workshop" && it.level > 0 && !it.underConstruction }?.level
