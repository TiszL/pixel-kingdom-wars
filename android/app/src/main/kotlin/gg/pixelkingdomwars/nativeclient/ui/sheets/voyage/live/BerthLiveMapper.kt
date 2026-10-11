package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.data.VehicleUnavailable
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.BerthFleetActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.BerthFleetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.BerthServiceActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.BerthServiceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.BerthSheetActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.BerthSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.InstallActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.InstallUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.OwnedVehicleUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.ServiceOp
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.ServiceOptionUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.StarterFleetActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.StarterFleetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageMoneyErrorUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageSealState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.fleetPrimary
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.isWornOut
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.servicePrimary
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.vehicleTitle
import kotlinx.serialization.json.JsonObject

/*
 * LIVE mapper of the Berth sheet (K/ui/sheets/voyage/BerthSheet.kt: the quay header, FLEET, the starter panel, the
 * wallet picker for an install, SERVICE). State source: [VoyageLiveInputs] — `StarterFleetState` (starter boat install),
 * `StarterExpeditionState` (is the starter at sea), and the crafted `VehicleState` (`/vehicles/fleet`,
 * `/vehicles/client/assets-v2`, the vehicle journal) with the policy's tiers and trips-per-install. Pure.
 *
 * Money: installing a crafted vehicle and both services (RESTORE / UPGRADE) burn a wallet asset and pay a SOL network
 * fee, so their Seals are MS-M3's: the Actions stub refuses those taps with [VOYAGE_MONEY_PENDING], and `feeSol` stays
 * null ("…") because the fee review (`VehicleViewModel.review()`) is itself the first money step. While the host says
 * those reviews are not available on the sheet, [BerthLiveCallbacks.openCraftedControls] hands the same taps to the
 * existing Vehicle controls, which own that sequence and its wallet approval. The FREE starter install keeps its
 * existing reviewed flow.
 */

/** The Berth's local, non-server state (Destination.Berth seeds tab + section). */
data class BerthLocalState(
    /** "FLEET" or "SERVICE". */
    val tab: String = BerthSheetUi.TAB_FLEET,
    /** "starter" (the starter panel) or "install" (the wallet picker); null = FLEET. */
    val section: String? = null,
    /** The selected quay family; null lets the mapper pick (first crafted vehicle, else the starter). */
    val selectedFamily: VehicleFamily? = null,
    /** SERVICE: the chosen vehicle; null lets the mapper pick (first worn out, else first). */
    val selectedInstallationId: String? = null,
    /** SERVICE: the chosen operation; null lets the mapper pick (RESTORE when worn out, else UPGRADE). */
    val selectedOp: ServiceOp? = null,
    /** Install picker: the card the player tapped. */
    val installAssetId: String? = null,
    /** Owner 2026-10-06 (free placement): the vacant Berth the player tapped on the quay; null lets the mapper pick the
     *  Berth they opened, else their first vacant one ([berthInstallDoor]). */
    val selectedBerthId: String? = null,
)

/** The section ids of Destination.Berth. */
const val BERTH_SECTION_STARTER = "starter"
const val BERTH_SECTION_INSTALL = "install"

// ---------- the sheet ----------

/** The whole Berth sheet for [i] and the player's [local] choices. */
fun berthSheetUi(i: VoyageLiveInputs, local: BerthLocalState): BerthSheetUi {
    val unavailable = vehicleUnavailableReason(i.vehicles?.unavailable
        ?: VehicleUnavailable.MISSING_POLICY.takeIf { i.policy.tiers == null })
    if (unavailable != null) {
        // Owner Seeker 2026-10-06 07:24Z (QA, vehicles switched off): crafted vehicles being closed is not the free starter
        // boat being closed. With a starter owner, FLEET keeps the starter panel from /starter-fleet (INSTALL FREE, installing,
        // installed, at sea) with a quiet crafted-off line and no RETRY, and SERVICE says the same. No owner: the closed body.
        val starter = starterFleetUi(i)?.copy(craftedOff = CRAFTED_VEHICLES_OFF)
        return BerthSheetUi(
            level = voyageLevelTag(i.buildings, BERTH_TYPE), tab = local.tab,
            quay = emptyList(), selectedFamily = null, fleet = null,
            starter = starter,
            install = null,
            service = berthServiceUi(i, emptyList(), local), history = hasBerthHistory(i), serviceLocked = true,
            unavailable = if (starter == null) EmptyStateUi("ui:lodge-menu", BerthSheetUi.TAB_FLEET, unavailable, null, null)
                else EmptyStateUi("ui:lodge-menu", BerthSheetUi.TAB_SERVICE, CRAFTED_VEHICLES_OFF, null, null),
        )
    }
    val known = i.vehicles != null && craftedKnown(i)
    val vehicles = if (known) installedVehicles(i) else emptyList()
    val starterBerth = i.starterFleetView?.eligibleBerths?.firstOrNull()?.berthId ?: firstBerthId(i.buildings)
    // Owner 2026-10-06 (no pre-chosen spots): every crafted family used to point at the FIRST Berth, which the starter boat
    // holds, so the server refused the install (VEHICLE_BERTH_OCCUPIED). INSTALL now goes into a vacant Berth the player
    // placed, or places a new one (BerthPlacement.kt). The FLEET rows stay one per family (the server allows one install
    // per family per base); the quay header shows the player's own Berths.
    val door = if (known) berthInstallDoor(i, local.selectedBerthId) else null
    val target = (door as? BerthInstallDoor.Into)?.berthId
    val rows = if (known) berthQuay(vehicles, starterBerth, target) else emptyList()
    val quay = if (known) berthQuayByBuilding(i.buildings, vehicles) else emptyList()
    val opened = i.selectedBerthId?.let { id -> quay.firstOrNull { it.berthId == id } }
    val selected = local.selectedFamily
        // The Berth the player opened: its vehicle, or (vacant) the first family it could take.
        ?: opened?.takeIf { it.status != VehicleStatus.EMPTY }?.family
        ?: opened?.takeIf { it.status == VehicleStatus.EMPTY }?.let { rows.firstOrNull { r -> r.status == VehicleStatus.EMPTY }?.family }
        ?: rows.firstOrNull { it.family != VehicleFamily.STARTER && it.status != VehicleStatus.EMPTY }?.family
        ?: VehicleFamily.STARTER
    val fleet = if (known) berthFleetUi(i, rows, selected)?.copy(installBerthId = target,
        placeBerth = door is BerthInstallDoor.Place, installBlockedReason = (door as? BerthInstallDoor.Refused)?.reason) else null
    val noVehicleYet = rows.all { it.status == VehicleStatus.EMPTY }
    val starter = if (local.section == BERTH_SECTION_STARTER || (known && noVehicleYet && fleet != null) ||
        (i.vehicles == null && installedVehicles(i).isEmpty())) starterFleetUi(i)
        // Installing the free starter does not depend on the crafted read: a failed fleet read keeps its panel reachable.
        // Owner Seeker 2026-10-06: an INSTALLED starter stays too ("YOUR BOAT IS IN", GO TO LODGE), never INSTALL again; before,
        // the boat vanished behind RETRY right after INSTALL FREE and the player could not see it was installed.
        else if (!known && i.vehicles?.error != null) starterFleetUi(i)
        // Owner Seeker 2026-10-06 08:17Z (v7-berth-fleet: five skeleton rows for seconds, then the boat): the crafted read has
        // not answered yet (on QA it ends in a 503). The starter card never waits for it: it draws now from the last known
        // starter state, and the crafted answer replaces it in place when it lands (panelKey).
        else if (!known && starterKnown(i)) starterFleetUi(i)
        else null
    val selectedSlot = rows.firstOrNull { it.family == selected }
    val install = if (local.section == BERTH_SECTION_INSTALL && selected != VehicleFamily.STARTER && selectedSlot?.status == VehicleStatus.EMPTY)
        installUi(i, selected, local.installAssetId) else null
    return BerthSheetUi(
        level = voyageLevelTag(i.buildings, BERTH_TYPE),
        tab = local.tab,
        quay = quay,
        selectedFamily = selected,
        fleet = fleet,
        starter = starter,
        install = install,
        service = berthServiceUi(i, vehicles, local),
        history = hasBerthHistory(i),
        serviceLocked = !known,
        loading = !known && (starter == null || local.tab == BerthSheetUi.TAB_SERVICE) && i.vehicles?.error == null,
        readError = i.vehicles?.error?.let { "Fleet details could not be refreshed. Try again." },
        // The dashed frame marks the install destination only while the selected family has no vehicle to install into.
        selectedBerthId = target?.takeIf { selectedSlot?.status == VehicleStatus.EMPTY && selected != VehicleFamily.STARTER },
        placeSlot = known && i.berthPlacement?.canPlace == true,
        refreshing = !known && starter != null && i.vehicles?.let { it.error == null } == true,
    )
}

/** The starter side already answered for this kingdom, so its card can be drawn without the crafted read: the starter fleet
 *  view (installed or not), the expedition view's installation, or an accepted install proof for this base. */
internal fun starterKnown(i: VoyageLiveInputs): Boolean {
    val proven = i.starterFleet?.journal?.operation?.proof?.receipt?.installation?.baseId
    return i.starterFleetView != null || i.starterView?.installation != null || (proven != null && proven == i.baseId)
}

/** The FLEET rows: exactly one per family, starter first; an EMPTY row where no vehicle is installed. An empty crafted row
 *  names the vacant Berth an INSTALL would use ([installBerthId], "" when there is none), never a pre-chosen Berth. */
internal fun berthQuay(vehicles: List<VehicleUi>, starterBerthId: String?, installBerthId: String?): List<VehicleUi> =
    VehicleFamily.entries.map { f ->
        vehicles.firstOrNull { it.family == f } ?: emptyBerth(f, if (f == VehicleFamily.STARTER) starterBerthId else installBerthId)
    }

// ---------- FLEET ----------

/**
 * FLEET, or null while the crafted fleet has no snapshot for this base (an EMPTY row would then be a guess). With no
 * vehicle client on this build the fleet is "known empty" and INSTALL is LOCKED with the server-off reason.
 */
internal fun berthFleetUi(i: VoyageLiveInputs, quay: List<VehicleUi>, selected: VehicleFamily): BerthFleetUi? {
    if (!craftedKnown(i)) return null
    val accepting = i.vehicles?.fleet?.takeIf { it.prim("baseId") == i.baseId }?.flag("acceptingNewActions")
    return BerthFleetUi(
        level = voyageLevelTag(i.buildings, BERTH_TYPE),
        berths = quay,
        selectedFamily = selected,
        walletAssetsByFamily = walletCounts(i.vehicles?.assets),
        ordersAllowed = i.ordersBlockedReason == null,
        walletLinked = i.walletLinked,
        featureOffReason = when {
            i.vehicles == null -> VEHICLE_UNAVAILABLE_REASON
            accepting == false -> "New vehicle actions are paused on this server"
            else -> null
        },
        pendingInstallFamily = pendingInstallFamily(i),
    )
}

/** The wallet's identities from `/vehicles/client/assets-v2` (the loaded pages), or null while unknown. */
internal fun walletIdentities(assets: JsonObject?): List<JsonObject>? = assets?.children("items")?.mapNotNull { it.child("identity") }

/**
 * Crafted vehicles in the wallet per family, or null while unknown. A family with none on the loaded pages is 0 only
 * when the server says there is no further page (`nextCursor` null); otherwise it is left out (unknown, never 0).
 */
internal fun walletCounts(assets: JsonObject?): Map<VehicleFamily, Int>? {
    val ids = walletIdentities(assets) ?: return null
    val complete = assets?.prim("nextCursor") == null
    val counts = ids.mapNotNull { vehicleFamilyOf(it.prim("family")) }.groupingBy { it }.eachCount()
    return VehicleFamily.entries.filter { it != VehicleFamily.STARTER }
        .mapNotNull { f -> (counts[f] ?: if (complete) 0 else null)?.let { f to it } }.toMap()
}

/** The family whose install request is in flight (a pending installation record with no terminal installation). */
internal fun pendingInstallFamily(i: VoyageLiveInputs): VehicleFamily? {
    val r = i.vehicles?.journal?.pending.orEmpty().firstOrNull {
        it.kind == "installation" && it.request.prim("baseId") == i.baseId && it.response?.child("record")?.child("installation") == null
    } ?: return null
    val fromResponse = r.response?.child("record")?.child("reservation")?.child("identity")?.prim("family")
    val assetId = r.request.prim("assetId")
    val fromWallet = walletIdentities(i.vehicles?.assets)?.firstOrNull { it.prim("assetId") == assetId }?.prim("family")
    return vehicleFamilyOf(fromResponse ?: fromWallet)
}

// ---------- starter ----------

/** The starter panel from `StarterFleetState`. Pending = an attempted install with no proof or refusal yet (CHECK it). */
internal fun starterFleetUi(i: VoyageLiveInputs): StarterFleetUi? {
    val state = i.starterFleet ?: return null
    val view = i.starterFleetView
    val op = state.journal.operation
    // Morning gap audit: the owner is also busy for every routine read (each Berth open re-reads it), which painted INSTALL
    // FREE as "Installing" for a moment on every visit. Installing means a reviewed request is being confirmed (its Seal is
    // up) or an attempted request has no outcome yet.
    val pending = (state.busy && state.review != null) ||
        (op != null && op.attemptRevision != null && op.proof == null && op.refusal == null)
    val installed = view?.installation != null || i.starterView?.installation != null ||
        op?.proof?.receipt?.installation?.baseId == i.baseId
    val reason = when {
        installed -> null
        i.ordersBlockedReason != null -> i.ordersBlockedReason
        view == null -> UNKNOWN
        !view.acceptingInstallations -> "Starter installs are paused on this server"
        view.eligibleBerths.isEmpty() -> "Complete the Berth to install your starter boat"
        else -> null
    }
    // The installed boat's trip timer from the starter expedition view (the same figure the Lodge plate shows); null when docked.
    val atSea = if (!installed) null else installedVehicles(i).firstOrNull { it.family == VehicleFamily.STARTER }
        ?.takeIf { it.status == VehicleStatus.AWAY }?.returnsAt
    return StarterFleetUi(available = !installed && reason == null, installed = installed, reason = reason, pending = pending,
        atSeaLine = atSea?.let { if (it == DUE_BACK) "$DUE_BACK · checking" else "Back in $it" })
}

// ---------- install (wallet picker) ----------

/** The wallet picker for an empty [family]: every wallet vehicle of that family, any tier. `feeSol` stays null and the
 *  seal IDLE: the fee review and the Seal are the money steps MS-M3 wires. */
internal fun installUi(i: VoyageLiveInputs, family: VehicleFamily, selectedAssetId: String?): InstallUi {
    val assets = i.vehicles?.assets
    val owned = walletIdentities(assets).orEmpty()
        .filter { vehicleFamilyOf(it.prim("family")) == family }
        .mapNotNull { id -> id.prim("assetId")?.let { OwnedVehicleUi(it, id.long("tier")?.toInt()) } }
    return InstallUi(family, owned, assets?.prim("nextCursor"), selectedAssetId, feeSol = null,
        sealState = VoyageSealState.IDLE, loading = assets == null)
}

// ---------- SERVICE ----------

/** SERVICE for the installed crafted vehicles (the starter is never serviced). */
internal fun berthServiceUi(i: VoyageLiveInputs, vehicles: List<VehicleUi>, local: BerthLocalState): BerthServiceUi {
    val installed = vehicles.filter { it.family != VehicleFamily.STARTER }
    val selected = installed.firstOrNull { it.installationId == local.selectedInstallationId }
        ?: installed.firstOrNull { isWornOut(it) } ?: installed.firstOrNull()
    val options = selected?.let { serviceOptions(it, i.policy) }.orEmpty()
    val op = local.selectedOp?.takeIf { o -> options.any { it.op == o } }
        ?: selected?.let { if (isWornOut(it)) ServiceOp.RESTORE_USES else ServiceOp.UPGRADE }
    val identities = walletIdentities(i.vehicles?.assets)
    val matches = selected?.let { v ->
        identities?.filter { vehicleFamilyOf(it.prim("family")) == v.family && it.long("tier")?.toInt() == v.tier && v.tier != null }
    }
    val complete = i.vehicles?.assets?.prim("nextCursor") == null
    val pending = selected?.installationId?.let { pendingService(i, it) }
    return BerthServiceUi(
        installed = installed,
        selectedInstallationId = selected?.installationId,
        options = options,
        selectedOp = op,
        handIn = matches?.firstOrNull()?.let { id -> id.prim("assetId")?.let { OwnedVehicleUi(it, id.long("tier")?.toInt()) } },
        walletCount = matches?.size?.takeIf { it > 0 || complete },
        feeSol = null,
        sealState = if (pending != null) VoyageSealState.ERROR else VoyageSealState.IDLE,
        // An in-flight service from an earlier session is uncertain, never "Nothing was sent": CHECK (by key) recovers it.
        error = pending?.let { VoyageMoneyErrorUi("Your service request is being checked", authoritative = false) },
    )
}

/**
 * RESTORE then UPGRADE for [v], from the policy only: RESTORE needs zero trips left and restores to the policy's
 * trips-per-install; UPGRADE needs a next tier in the policy's tier list. Unknown policy or tier → unavailable "…"
 * reasons, never a guessed offer (the server rechecks on reserve, as `vehicleServiceChoice` does today).
 */
internal fun serviceOptions(v: VehicleUi, policy: VoyagePolicyFacts): List<ServiceOptionUi> {
    val restoreReason = when {
        v.tripsLeft == null -> UNKNOWN
        v.tripsLeft != 0 -> "Restore when it has no trips left"
        else -> null
    }
    val tiers = policy.tiers
    val index = v.tier?.let { t -> tiers?.indexOf(t.toLong()) }
    val next = if (tiers == null || index == null || index < 0) null else tiers.getOrNull(index + 1)
    val upgradeReason = when {
        tiers == null || v.tier == null -> "Checking service rules"
        index == null || index < 0 -> "This tier needs current service rules"
        next == null -> "Max tier"
        else -> null
    }
    return listOf(
        ServiceOptionUi(ServiceOp.RESTORE_USES, restoreReason == null, restoreReason, v.tier, policy.tripsPerInstall?.toInt()),
        ServiceOptionUi(ServiceOp.UPGRADE, upgradeReason == null, upgradeReason, next?.toInt(), null),
    )
}

/** A pending service record for [installationId] without a terminal application. */
internal fun pendingService(i: VoyageLiveInputs, installationId: String): VehicleRecord? =
    i.vehicles?.journal?.pending.orEmpty().firstOrNull {
        it.kind == "service" && it.request.prim("installationId") == installationId &&
            it.response?.child("record")?.child("application") == null
    }

private fun hasBerthHistory(i: VoyageLiveInputs): Boolean =
    i.vehicles?.journal?.records.orEmpty().any { it.kind == "installation" || it.kind == "service" } ||
        i.starterFleet?.journal?.let { it.operation != null || it.archives.isNotEmpty() } == true

// ---------- Actions stub ----------

/** Where a Berth tap leads (the host maps each to its Destination / HomeRequest; HOOKUP-berth-live.md). */
enum class BerthLiveDoor {
    /** WalletHistory(berth). */
    HISTORY,
    /** FocusBuilding("lodge", Lodge(SEND)); arg = installation id to preselect, or null. */
    LODGE_SEND,
    /** World › Solana Island › Public Workshop spot (craft stays there, arch Q16). */
    SOLANA_WORKSHOP,
}

/** The host's hooks for [berthSheetActions]. No hook spends money: MONEY taps call [toast] with [VOYAGE_MONEY_PENDING]. */
data class BerthLiveCallbacks(
    val update: ((BerthLocalState) -> BerthLocalState) -> Unit,
    val toast: (String) -> Unit,
    /** INSTALL FREE → `StarterFleetViewModel.start(berthId)` with the view's single eligible berth (its EXISTING review). */
    val reviewStarterInstall: () -> Unit,
    /** The wallet picker list / MORE → `VehicleViewModel.assets(cursor)` (GET). */
    val loadAssets: (cursor: String?) -> Unit,
    /** CHECK an install / service in flight → `VehicleViewModel.check()` / `StarterFleetViewModel.check()` (GET by key). */
    val checkPending: () -> Unit,
    val go: (door: BerthLiveDoor, arg: String?) -> Unit,
    val close: () -> Unit,
    /** A crafted install pick or an enabled RESTORE / UPGRADE while [BerthSheetUi.reviewUnavailable] is set → the existing
     *  Vehicle controls (VehicleScreen), which own the reviewed burn and its wallet approval. Null keeps the refusal. */
    val openCraftedControls: (() -> Unit)? = null,
    /** Owner 2026-10-06 (free placement): close the sheet and start the Kingdom's ordinary placement of a new Berth (ghost,
     *  footprint, PLACE band; POST /build validates the tile). Null: the host has none, and the tap says to use BUILD. */
    val placeBerth: (() -> Unit)? = null,
)

/** The Berth's Actions, built against the [ui] being shown (state-in, callbacks-out). */
fun berthSheetActions(ui: BerthSheetUi, cb: BerthLiveCallbacks): BerthSheetActions {
    if (ui.unavailable != null || ui.loading || (ui.readError != null && ui.fleet == null)) return BerthSheetActions(
        // A loading or failed read still switches tabs (each shows its own loading or retry state); an unavailable server
        // keeps its closed tabs (BerthUnavailableStateTest) unless the starter panel stays open, whose SERVICE tab then says
        // honestly that crafted vehicles are not open.
        onTab = { tab -> if (ui.unavailable == null || ui.starter != null) cb.update { it.copy(tab = tab, section = null) } },
        onHistory = { cb.go(BerthLiveDoor.HISTORY, null) }, onClose = cb.close,
        starter = if (ui.starter != null) StarterFleetActions(
            onInstallStarter = { starterInstallTapped(ui, cb) },
            // The same designed starter panel: its craft link and teasers act here too. With crafted vehicles closed on this
            // server they say so instead of leading to a craft page that cannot open.
            onCraftLink = { val off = ui.starter?.craftedOff; if (off != null) cb.toast(off) else cb.go(BerthLiveDoor.SOLANA_WORKSHOP, null) },
            onFamilyTeaser = { cb.toast(ui.starter?.craftedOff ?: "Craft one at Solana Island ▸") },
            onGoLodge = { cb.go(BerthLiveDoor.LODGE_SEND, null) },
        ) else StarterFleetActions(),
    )
    val select: (VehicleFamily) -> Unit = { f -> cb.update { it.copy(selectedFamily = f, section = null, installAssetId = null) } }
    return BerthSheetActions(
        onTab = { tab -> cb.update { it.copy(tab = tab, section = null) } },
        onHistory = { cb.go(BerthLiveDoor.HISTORY, null) },
        onClose = cb.close,
        onSlot = select,
        fleet = BerthFleetActions(
            onSelect = select,
            onInstall = { f -> installTapped(ui, f, cb) },
            onCraftLink = { cb.go(BerthLiveDoor.SOLANA_WORKSHOP, null) },
            onSendFromLodge = { id -> cb.go(BerthLiveDoor.LODGE_SEND, id) },
            onService = { id -> cb.update { it.copy(tab = BerthSheetUi.TAB_SERVICE, section = null, selectedInstallationId = id, selectedOp = null) } },
            onCheckInstall = { cb.checkPending() },
        ),
        starter = StarterFleetActions(
            onInstallStarter = { starterInstallTapped(ui, cb) },
            onCraftLink = { cb.go(BerthLiveDoor.SOLANA_WORKSHOP, null) },
            onFamilyTeaser = { cb.toast("Craft one at Solana Island ▸") },
            onGoLodge = { cb.go(BerthLiveDoor.LODGE_SEND, null) },
        ),
        install = InstallActions(
            onBack = { cb.update { it.copy(section = null, installAssetId = null) } },
            // MONEY: the install Seal burns the asset and pays the network fee (MS-M3). Until the sheet has that Seal, the
            // existing Vehicle controls take the pick; nothing is reserved or signed from here.
            onPickAsset = {
                val handoff = craftedHandoff(ui, cb)
                if (handoff != null) handoff() else cb.toast(ui.reviewUnavailable ?: VOYAGE_MONEY_PENDING)
            },
            onMore = { cb.loadAssets(ui.install?.cursor) },
            onCraftLink = { cb.go(BerthLiveDoor.SOLANA_WORKSHOP, null) },
        ),
        service = BerthServiceActions(
            onPickVehicle = { id -> cb.update { it.copy(selectedInstallationId = id, selectedOp = null) } },
            onAwayVehicle = { id ->
                val v = ui.service.installed.firstOrNull { it.installationId == id }
                cb.toast("Service when it is docked · back ${v?.returnsAt ?: UNKNOWN}")
            },
            onPickOp = { op -> cb.update { it.copy(selectedOp = op) } },
            onHandInGo = { cb.go(BerthLiveDoor.SOLANA_WORKSHOP, null) },
            onServiceConfirm = { serviceTapped(ui, cb) },
            onRecover = cb.checkPending,
            onGoFleet = { cb.update { it.copy(tab = BerthSheetUi.TAB_FLEET, section = null) } },
        ),
        onBerthSlot = { id -> berthSlotTapped(ui, id, cb) },
        onPlaceBerth = { placeBerthTapped(cb) },
    )
}

/** A vacant Berth's quay slot (owner 2026-10-06): it becomes the INSTALL destination and the first crafted family without a
 *  vehicle is selected, so the primary reads INSTALL <FAMILY>. The free starter keeps its own panel and Berth review. */
internal fun berthSlotTapped(ui: BerthSheetUi, berthId: String, cb: BerthLiveCallbacks) {
    if (berthId.isEmpty()) return cb.toast(UNKNOWN)
    val family = ui.fleet?.berths?.firstOrNull { it.family != VehicleFamily.STARTER && it.status == VehicleStatus.EMPTY }?.family
    cb.update { it.copy(selectedBerthId = berthId, selectedFamily = family ?: it.selectedFamily, section = null, installAssetId = null) }
}

/** The quay's "+" slot and INSTALL with no vacant Berth: the Kingdom's ordinary placement of a new Berth. */
internal fun placeBerthTapped(cb: BerthLiveCallbacks) {
    val place = cb.placeBerth ?: return cb.toast(BERTH_PLACE_FROM_BUILD)
    place()
}

/** INSTALL on FLEET: the starter goes to its free panel; a refused primary says why; otherwise the wallet picker opens
 *  (a GET). Picking a card is the money step and is refused there. */
internal fun installTapped(ui: BerthSheetUi, family: VehicleFamily, cb: BerthLiveCallbacks) {
    if (family == VehicleFamily.STARTER) return cb.update { it.copy(selectedFamily = family, section = BERTH_SECTION_STARTER) }
    val fleet = ui.fleet ?: return cb.toast(UNKNOWN)
    // An install in flight is CHECKed by key, never re-opened (fleetPrimary draws it as an ENABLED CHECK).
    if (family == fleet.pendingInstallFamily) return cb.checkPending()
    val slot =fleet.berths.firstOrNull { it.family == family }
    val look = fleetPrimary(slot, family == fleet.pendingInstallFamily, fleet.featureOffReason, fleet.walletLinked, fleet.ordersAllowed).look
    if (look != null && (look.state == CommandState.LOCKED || look.state == CommandState.DISABLED)) return cb.toast(look.reason ?: UNKNOWN)
    // Owner 2026-10-06 (free placement): the vehicle goes into a vacant Berth the player placed. With none, this tap places a
    // new Berth where the player wants it (the Kingdom's building placement); with nowhere to go it says why. A wallet known
    // to hold none of this family still opens the picker, whose craft link leads on, so no Berth is built for nothing.
    if (slot?.status == VehicleStatus.EMPTY && fleet.walletAssetsByFamily?.get(family) != 0) {
        fleet.installBlockedReason?.let { return cb.toast(it) }
        if (fleet.placeBerth) return placeBerthTapped(cb)
    }
    cb.update { it.copy(selectedFamily = family, section = BERTH_SECTION_INSTALL, installAssetId = null,
        selectedBerthId = fleet.installBerthId ?: it.selectedBerthId) }
    cb.loadAssets(null)
}

/** INSTALL FREE: CHECK a pending one, GO TO LODGE once installed, the reason when unavailable, else the existing review. */
internal fun starterInstallTapped(ui: BerthSheetUi, cb: BerthLiveCallbacks) {
    val s = ui.starter ?: return cb.toast(UNKNOWN)
    when {
        s.pending -> cb.checkPending()
        s.installed -> cb.go(BerthLiveDoor.LODGE_SEND, null)
        !s.available -> cb.toast(s.reason ?: UNKNOWN)
        else -> cb.reviewStarterInstall()
    }
}

/**
 * RESTORE / UPGRADE: an off primary says its own reason; an enabled one is MONEY (asset burn + SOL fee). It goes to the
 * existing Vehicle controls when the host offers them ([craftedHandoff]); otherwise it is refused.
 */
internal fun serviceTapped(ui: BerthSheetUi, cb: BerthLiveCallbacks) {
    val handoff = craftedHandoff(ui, cb)
    if (handoff == null) ui.reviewUnavailable?.let { cb.toast(it); return }
    val s = ui.service
    val v = s.installed.firstOrNull { it.installationId == s.selectedInstallationId }
    val option = s.options.firstOrNull { it.op == s.selectedOp }
    val look = servicePrimary(s.selectedOp, option?.available == true, option?.reason, option?.resultTier, s.handIn != null,
        v?.let(::vehicleTitle) ?: UNKNOWN, s.feeSol, v?.status == VehicleStatus.AWAY, v?.returnsAt?.let { "Back in $it" })
    when {
        look == null -> cb.toast(ui.reviewUnavailable ?: VOYAGE_MONEY_PENDING)
        look.state == CommandState.LOCKED || look.state == CommandState.DISABLED -> cb.toast(look.reason ?: UNKNOWN)
        // Only an available option on a docked vehicle with its hand-in reaches the controls that perform the burn.
        handoff != null -> handoff()
        else -> cb.toast(VOYAGE_MONEY_PENDING)
    }
}

/** The existing Vehicle controls take a crafted money tap only while the sheet has no reviewed Seal for it. */
private fun craftedHandoff(ui: BerthSheetUi, cb: BerthLiveCallbacks): (() -> Unit)? =
    cb.openCraftedControls?.takeIf { ui.reviewUnavailable != null }
