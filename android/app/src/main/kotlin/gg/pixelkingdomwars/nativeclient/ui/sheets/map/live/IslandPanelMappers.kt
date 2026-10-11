package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.data.realmSalesPolicy
import gg.pixelkingdomwars.nativeclient.divine.DivineRules
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.ClanMembership
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.IslandPanelUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEActivity
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.groupedAmount
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.AuctionPhase
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DivinePanelActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DivinePanelUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DoorUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.PublicWorkshopActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.PublicWorkshopUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SeekerPanelActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SeekerPanelUi
import kotlinx.serialization.json.JsonObject

/*
 * The World tab's island panels (design/final/map/SPEC.md §3.1, the §4.1 Public Workshop sheet, §5) from what this client
 * can read today. No Seeker auction, Solana licence or island scene repository exists and the Divine owners live in the
 * Bases route, so these panels say so honestly (server off, "…" unknown, locked with a reason) and their actions only
 * navigate to an existing owner or explain why not. Nothing here signs, submits, pays or reads the server.
 */

private const val OPENS_LATER = "Opens later on this server"
private const val CLAN_HALL = "Citadels: join a clan at the Clan Hall"

/** A catalogue count as drawn ("1,234"); null for unknown or malformed, which the panels read as "…". */
private fun shownCount(n: Int?): String? = groupedAmount(n?.toString())

/** The last value one read showed: a routine refresh that briefly reads nothing never blanks a value already shown. */
internal class IslandLastKnown<T : Any> {
    private var last: T? = null
    fun keep(fresh: T?): T? { if (fresh != null) last = fresh; return last }
}

/** Seeker Island. Auctions have no repository on this client, so the panel is SERVER_OFF (YOU HERE hidden) and ENTER
 *  ISLAND is locked with its reason. The spot counts and the permit term come from the catalogue; "…" without it. */
internal fun seekerPanelUi(catalogue: JsonObject?): SeekerPanelUi {
    val policy = realmSalesPolicy(catalogue)
    val term = policy?.protocol?.permitDurationSec?.let { " for ${fmtDur(it)}" }.orEmpty()
    val enter = CommandUi(FeatureId("island.seeker.enter"), "ui:seeker-navigation", "ENTER ISLAND", null, true, CommandState.LOCKED,
        "Seeker Island opens later on this server", null, verb = Verb.GOLD)
    return SeekerPanelUi(IslandPanelUi("seeker-island", "Win a trading spot to sell realm permits$term.", enter, emptyList()),
        policy?.let { "${it.protocol.totalSpots} spots, ${it.kingSpots} of them King." } ?: UNKNOWN, AuctionPhase.SERVER_OFF)
}

/** Seeker panel taps: X closes; the locked ENTER ISLAND toasts its reason (the only other doors are hidden while off). */
internal fun seekerPanelActions(explain: (String) -> Unit, onClose: () -> Unit) =
    SeekerPanelActions(onClose = onClose, onPrimaryRefused = { explain(it.reason ?: it.caption) })

/** The Public Workshop sheet. The World tab cannot price a crafting try (UNAVAILABLE, never a number) and no public queue is
 *  served. Unknown buildings (null) never claim "no Lodge"; a read kingdom without one gets the Build-a-Lodge EmptyState. */
internal fun publicWorkshopUi(buildings: List<Building>?): PublicWorkshopUi = PublicWorkshopUi(emptyList(),
    "Public queue is not shown on this server yet", PriceUi(Currency.SOL, null, PriceStatus.UNAVAILABLE),
    noLodge = buildings != null && buildings.none { it.type == "lodge" })

/** CRAFT VEHICLE with no vehicle owner in this session (the same sentence as the Home craft doors). */
internal const val VEHICLE_CRAFT_UNAVAILABLE = "Vehicle controls are unavailable for this session."

/** Public Workshop taps. CRAFT VEHICLE (and a family card) opens [onCraftVehicle], the one vehicle owner's craft page (map
 *  SPEC §4.1), never the base screen; with no owner in this session it says so. GO TO LODGE (drawn only without a Lodge)
 *  selects the Lodge or opens the build menu. */
internal fun publicWorkshopActions(buildings: List<Building>?, onCraftVehicle: (() -> Unit)?, onFocusBuilding: (String) -> Unit,
    onBuildMenu: () -> Unit, explain: (String) -> Unit, onClose: () -> Unit): PublicWorkshopActions {
    val lodge = buildings?.firstOrNull { it.type == "lodge" }
    return PublicWorkshopActions(
        onCraft = { if (onCraftVehicle != null) onCraftVehicle() else explain(VEHICLE_CRAFT_UNAVAILABLE) },
        onGoLodge = { if (lodge != null) onFocusBuilding(lodge.id) else onBuildMenu() },
        onExplain = explain, onClose = onClose)
}

/** Whether the admitted catalogue configures Divine Trials: the same check the trial owner makes. */
internal fun divineTrialsConfigured(catalogue: JsonObject?): Boolean =
    runCatching { DivineRules.catalogue(catalogue) != null }.getOrDefault(false)

/** The Divine Isle panel. WEST and SOLO TRIALS lock with "Opens later on this server" when the catalogue has no trials.
 *  EAST locks only when the clan read says no clan; an unread membership leaves the door to the tournament owner, which
 *  shows the real state. Fragments have no World-side read, so "…" (VIEW opens the owner). */
internal fun divinePanelUi(soloSites: Int?, citadels: Int?, trialsConfigured: Boolean, membership: ClanMembership?): DivinePanelUi {
    val soloReason = if (trialsConfigured) null else OPENS_LATER
    val noClan = membership != null && membership.clan == null
    return DivinePanelUi(
        DoorUi("WEST", "site:divine-solo-active", "Solo Trials", shownCount(soloSites)?.let { "$it solo areas" } ?: UNKNOWN,
            soloReason != null, soloReason),
        DoorUi("EAST", "site:divine-clan-occupied", "Clan Citadels", shownCount(citadels)?.let { "$it clan areas" } ?: UNKNOWN,
            noClan, if (noClan) CLAN_HALL else null),
        UNKNOWN,
        CommandUi(FeatureId("island.divine.trials"), "ui:divine-navigation", "SOLO TRIALS", null, true,
            if (trialsConfigured) CommandState.ENABLED else CommandState.LOCKED, soloReason, null))
}

/** Divine panel taps: each door opens its existing Bases-route owner, the Clan Hall line opens the Clan Hall, and a locked
 *  door or primary toasts its reason. */
internal fun divinePanelActions(onOpenPhaseE: (PhaseEActivity) -> Unit, onOpenClanHall: () -> Unit, explain: (String) -> Unit,
    onClose: () -> Unit) = DivinePanelActions(
    onSolo = { onOpenPhaseE(PhaseEActivity.DIVINE_TRIALS) },
    onClan = { onOpenPhaseE(PhaseEActivity.TOURNAMENTS) },
    onClanHall = onOpenClanHall,
    onFragments = { onOpenPhaseE(PhaseEActivity.FRAGMENTS) },
    onExplain = explain, onClose = onClose)
