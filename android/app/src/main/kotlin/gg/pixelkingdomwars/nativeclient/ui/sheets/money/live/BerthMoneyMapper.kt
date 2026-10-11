package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.charter.CharterGrammar
import gg.pixelkingdomwars.nativeclient.charter.charterObject
import gg.pixelkingdomwars.nativeclient.charter.charterOptional
import gg.pixelkingdomwars.nativeclient.charter.charterText
import gg.pixelkingdomwars.nativeclient.data.StarterFleetState
import gg.pixelkingdomwars.nativeclient.data.StarterFleetHydration
import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.data.VehicleState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.StarterPresence
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.*
import gg.pixelkingdomwars.nativeclient.vehicle.VehiclePolicy
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleProtocol
import java.time.Instant
import kotlinx.serialization.json.*

/**
 * Read-only presentation of current native state. It creates no intent, starts no clock and never infers a successful
 * burn or a definite refusal. The caller retains the existing repository review/confirm/recovery callbacks and Seal.
 * [nowMs] is sampled by the host; it only expires a displayed fee, never authorizes a signature.
 *
 * The currentness flags are explicit owner admission of fresh reads in the active session/base generation. Set them
 * false on dismissal, account/wallet/base or generation changes, failed reads and invalidation. Matching wallet/base
 * strings (including A -> B -> A) and `loaded` must never restore admission; only newly admitted reads may do so.
 * [assetsComplete] additionally witnesses that the owner supplied the entire current wallet inventory, not merely a
 * terminal page: VehicleRepository replaces each page, and `nextCursor == null` alone proves no aggregate total.
 * All witnesses default false. The native loaded/busy/error guards still apply when a witness is true.
 *
 * Empty quay slots are layout placeholders. Unknown fleet state has no FLEET primary or install picker. The starter
 * endpoint proves installation, while current base presentation supplies its away/docked status; neither is inferred
 * from an archived receipt. Original requests remain accessible through the existing history/recovery host.
 */
fun berthMoneySheetUi(
    base: BaseSnapshot?,
    vehicles: VehicleState,
    starter: StarterFleetState?,
    policy: VehiclePolicy?,
    wallet: String?,
    ordersAllowed: Boolean,
    configured: Boolean,
    nowMs: Long,
    tab: String = BerthSheetUi.TAB_FLEET,
    section: String? = null,
    selectedFamily: VehicleFamily? = null,
    selectedInstallationId: String? = null,
    selectedAssetId: String? = null,
    selectedOp: ServiceOp? = null,
    baseCurrent: Boolean = false,
    fleetCurrent: Boolean = false,
    assetsCurrent: Boolean = false,
    starterCurrent: Boolean = false,
    assetsComplete: Boolean = false,
): BerthSheetUi {
    val boundBase = base?.takeIf { baseCurrent && wallet != null && it.player.wallet == wallet && !it.baseId.isNullOrBlank() }
    val completed = boundBase?.buildings.orEmpty().filter { it.type == "berth" && it.level > 0 && !it.underConstruction }
        .takeIf { rows -> rows.map { it.id }.distinct().size == rows.size }.orEmpty()
    val baseId = boundBase?.baseId
    val rules = runCatching { policy?.let { VehiclePolicy.from(it.raw) } }.getOrNull()
    val fleet = runCatching {
        require(fleetCurrent && vehicles.loaded)
        val raw = VehicleProtocol.fleet(requireNotNull(vehicles.fleet))
        require(baseId != null && raw.charterText("baseId") == baseId && raw.charterText("wallet") == wallet)
        rules?.verifyFleet(raw)
        require(raw.getValue("vehicles").jsonArray.all { row -> completed.any { it.id == row.jsonObject.charterText("berthId") } })
        raw
    }.getOrNull()
    val assets = runCatching {
        require(baseCurrent && assetsCurrent && vehicles.loaded)
        VehicleProtocol.assetsV2(requireNotNull(vehicles.assets)).also { require(wallet != null && it.charterText("wallet") == wallet) }
    }.getOrNull()
    val owned = assets?.getValue("items")?.jsonArray?.map { it.jsonObject.charterObject("identity") }
    val completeAssets = assetsComplete && assets != null && assets["nextCursor"] == JsonNull
    val starterView = runCatching {
        require(starterCurrent)
        requireNotNull(starter?.view).also { view ->
            view.validate()
            require(starter?.journal?.identity?.wallet == wallet)
            require(starter?.hydration != StarterFleetHydration.ORIGINAL_BASE_UNAVAILABLE)
            require(baseId != null && view.baseId == baseId && view.wallet == wallet)
            require(view.eligibleBerths.all { berth -> completed.any { it.id == berth.berthId } })
        }
    }.getOrNull()
    val fleetRows = fleet?.getValue("vehicles")?.jsonArray?.map { it.jsonObject }.orEmpty()
    val starterInstallation = starterView?.installation?.takeIf { installation ->
        fleetRows.none { it.charterText("berthId") == installation.berthId }
    }
    val starterPresence = starterInstallation?.let { installation ->
        boundBase?.servicePresentation?.berths?.singleOrNull { it.buildingId == installation.berthId }
            ?.installation?.takeIf { it.family == "starter" }?.presence
    }
    val installed = fleetRows.map { row -> berthVehicleUi(row, rules) }
    val starterVehicle = starterInstallation?.takeIf { starterPresence != null }?.let { installation ->
        VehicleUi(VehicleFamily.STARTER, null, installation.installationId, installation.berthId,
            if (starterPresence == StarterPresence.AWAY) VehicleStatus.AWAY else VehicleStatus.DOCKED,
            null, null, if (starterPresence == StarterPresence.AWAY) "…" else null, 0)
    }
    val quay = VehicleFamily.entries.map { family ->
        if (family == VehicleFamily.STARTER && starterVehicle != null) starterVehicle
        else installed.singleOrNull { it.family == family }
            ?: VehicleUi(family, null, null, "", VehicleStatus.EMPTY, null, null, null, 0)
    }
    val journal = vehicles.journal?.takeIf { wallet != null && it.identity.wallet == wallet }
    val selected = journal?.records?.singleOrNull { it.id == vehicles.selectedId }
    val original = selected?.let { berthOriginal(it, wallet) }
    val pending = journal?.pending.orEmpty().filter { it.kind in listOf("installation", "service") }.filter { record ->
        val current = berthOriginal(record, wallet)
        record.held || current == null || VehicleProtocol.terminal(current) == null
    }
    val pendingInstall = pending.filter { it.kind == "installation" && berthRecordBase(it, wallet) == baseId }
    val pendingInstallFamily = pendingInstall.mapNotNull { record ->
        berthOriginal(record, wallet)?.let { berthFamily(VehicleProtocol.original(it).charterObject("identity").charterText("family")) }
    }.distinct().singleOrNull()
    val fleetReason = when {
        boundBase == null || completed.isEmpty() -> "Refresh a completed Berth in your kingdom."
        fleet == null -> "Refresh the current fleet before continuing."
        rules == null -> "Vehicle rules are unavailable."
        rules.completedUses.berthInt() == null -> "Current service limits need a newer presentation."
        !ordersAllowed -> "This base is read-only."
        !configured -> "Vehicle approval is unavailable. Saved requests can still be checked."
        !CharterGrammar.bool(fleet.getValue("acceptingNewActions")) -> "New vehicle actions are paused."
        vehicles.busy -> "Wait for the current vehicle check."
        owned == null -> "Refresh the current wallet vehicles before continuing."
        pending.isNotEmpty() -> "Check the saved vehicle request before starting another."
        vehicles.error != null -> "Refresh the current vehicle state before continuing."
        else -> null
    }
    val familySelection = selectedFamily?.takeIf { family ->
        fleet != null && completed.isNotEmpty() &&
            (family != VehicleFamily.STARTER || starterVehicle != null || starterView?.installation == null && starterView != null)
    }
    val level = (quay.singleOrNull { it.family == familySelection }?.berthId?.let { berth -> completed.singleOrNull { it.id == berth } }
        ?: completed.singleOrNull())?.level?.let { "LV $it" } ?: "…"
    val counts = if (completeAssets) VehicleFamily.entries.associateWith { family ->
        owned.orEmpty().count { berthFamily(it.charterText("family")) == family }
    } else null
    val currentService = installed.singleOrNull { it.installationId == selectedInstallationId }
    val serviceRow = fleetRows.singleOrNull { it.charterText("installationId") == currentService?.installationId }
    val matching = owned?.filter { asset ->
        currentService != null && berthFamily(asset.charterText("family")) == currentService.family &&
            CharterGrammar.number(asset.getValue("tier")).toInt() == currentService.tier
    }
    val handIn = (if (selectedAssetId == null) matching?.singleOrNull()
        else matching?.singleOrNull { it.charterText("assetId") == selectedAssetId })?.let(::berthOwnedUi)
    val serviceOriginal = original?.takeIf { client ->
        selected?.kind == "service" && VehicleProtocol.destination(client).charterText("baseId") == baseId &&
            VehicleProtocol.original(client).charterObject("state").charterText("installationId") == currentService?.installationId
    }
    val servicePending = pending.any { record ->
        record.kind == "service" && record.request["installationId"] == currentService?.installationId?.let(::JsonPrimitive)
    }
    val serviceReason = fleetReason ?: when {
        currentService == null -> "Choose a current installed vehicle."
        currentService.status == VehicleStatus.AWAY -> "Service when it is docked."
        currentService.status == VehicleStatus.BUSY_SERVICE || servicePending -> "Check the saved service request."
        owned == null -> "Refresh owned wallet vehicles."
        else -> null
    }
    val nextTier = currentService?.tier?.toLong()?.let { current ->
        rules?.tiers?.let { tiers -> tiers.indexOf(current).takeIf { it >= 0 }?.let { tiers.getOrNull(it + 1)?.toInt() } }
    }
    val options = listOf(
        ServiceOptionUi(ServiceOp.RESTORE_USES, serviceReason == null && currentService?.tripsLeft == 0,
            serviceReason ?: if (currentService?.tripsLeft != 0) "Use restoration is available when this vehicle is exhausted." else null,
            null, rules?.completedUses?.berthInt()),
        ServiceOptionUi(ServiceOp.UPGRADE, serviceReason == null && nextTier != null,
            serviceReason ?: if (nextTier == null) "This vehicle is at the maximum known tier." else null, nextTier, null),
    )
    val reviewAllowed = boundBase != null && completed.isNotEmpty() && fleet != null && rules != null &&
        rules.completedUses.berthInt() != null && owned != null && vehicles.loaded &&
        ordersAllowed && configured && !vehicles.busy && vehicles.error == null &&
        CharterGrammar.bool(fleet.getValue("acceptingNewActions"))
    val serviceFee = if (reviewAllowed && selected != null && serviceOriginal != null && serviceRow != null && handIn != null &&
        selectedOp?.let { if (it == ServiceOp.RESTORE_USES) "restore_uses" else "upgrade" } == selected.request["operation"]?.jsonPrimitive?.content &&
        selected.request["assetId"] == JsonPrimitive(handIn.assetId) &&
        owned?.singleOrNull { it.charterText("assetId") == handIn.assetId } == VehicleProtocol.original(serviceOriginal).charterObject("identity") &&
        berthServiceMatches(serviceOriginal, serviceRow)) {
        berthReviewedFee(vehicles, selected, serviceOriginal, rules, nowMs)
    } else null
    val serviceRecovery = serviceOriginal != null && serviceFee == null
    val service = BerthServiceUi(installed, currentService?.installationId, options, selectedOp, handIn,
        if (completeAssets) matching?.size else null, serviceFee,
        if (serviceRecovery) VoyageSealState.ERROR else VoyageSealState.IDLE,
        if (serviceRecovery) VoyageMoneyErrorUi("Check the saved service request before continuing.", authoritative = false) else null)
    val installOriginal = original?.takeIf { client ->
        selected?.kind == "installation" && VehicleProtocol.destination(client).charterText("baseId") == baseId &&
            completed.any { it.id == VehicleProtocol.destination(client).charterText("berthId") } &&
            berthFamily(VehicleProtocol.original(client).charterObject("identity").charterText("family")) == selectedFamily
    }
    val pickerAssets = owned.orEmpty().filter { berthFamily(it.charterText("family")) == familySelection }.map(::berthOwnedUi)
    val pickedAsset = pickerAssets.singleOrNull { it.assetId == selectedAssetId }
    val installDestinationOccupied = installOriginal?.let { client ->
        val berth = VehicleProtocol.destination(client).charterText("berthId")
        fleetRows.any { it.charterText("berthId") == berth } || starterInstallation?.berthId == berth ||
            boundBase?.servicePresentation?.berths?.any { it.buildingId == berth && it.installation != null } == true ||
            boundBase?.advancedServicePresentation?.berths?.any { it.buildingId == berth && it.installation != null } == true
    } ?: false
    val installFee = if (reviewAllowed && selected != null && installOriginal != null && pickedAsset != null &&
        !installDestinationOccupied && installed.none { it.family == selectedFamily } &&
        selected.request["assetId"] == JsonPrimitive(pickedAsset.assetId) &&
        owned?.singleOrNull { it.charterText("assetId") == pickedAsset.assetId } == VehicleProtocol.original(installOriginal).charterObject("identity")) {
        berthReviewedFee(vehicles, selected, installOriginal, rules, nowMs)
    } else null
    // A retained original may still show its picker for CHECK when new actions are paused. No new picker is opened
    // without the current base/fleet binding; its fee remains unknown until that original's live review is bound.
    val install = familySelection?.takeIf { family ->
        section == "install" && family != VehicleFamily.STARTER && fleet != null && completed.isNotEmpty() &&
            (installed.none { it.family == family } || installOriginal != null) && (fleetReason == null || installOriginal != null)
    }?.let { family ->
        InstallUi(family, pickerAssets, assets?.get("nextCursor")?.takeUnless { it == JsonNull }?.jsonPrimitive?.content,
            pickedAsset?.assetId, installFee,
            if (installOriginal != null && installFee == null) VoyageSealState.ERROR else VoyageSealState.IDLE,
            loading = assets == null)
    }
    // The native starter journal is one operation per account, not one per selected base. A different original base
    // still owns that slot, so its request must be resolved through history before any fresh installation.
    val starterPending = starter?.journal?.operation != null
    val healthyFleet = fleet != null && vehicles.loaded && !vehicles.busy && vehicles.error == null
    val starterAvailable = starterView != null && starterView.installation == null && starterView.acceptingInstallations &&
        starterView.eligibleBerths.isNotEmpty() && ordersAllowed && healthyFleet && !starterPending && starter?.busy != true &&
        starterView.eligibleBerths.any { berth -> fleetRows.none { it.charterText("berthId") == berth.berthId } }
    val starterPanel = if (section == "starter" || familySelection == VehicleFamily.STARTER && starterVehicle == null) {
        StarterFleetUi(starterAvailable, starterInstallation != null,
            when {
                starterPending -> "Check the saved starter installation in history before continuing."
                !starterAvailable && starterInstallation == null -> "Refresh the starter fleet and a completed eligible Berth."
                else -> null
            }, pending = starter?.busy == true && starterPending)
    } else null
    return BerthSheetUi(level, if (tab == BerthSheetUi.TAB_SERVICE) tab else BerthSheetUi.TAB_FLEET, quay,
        familySelection, if (fleet == null || completed.isEmpty()) null else BerthFleetUi(level, quay, familySelection,
            counts, fleetReason == null, walletLinked = wallet != null, featureOffReason = fleetReason,
            pendingInstallFamily = pendingInstallFamily), starterPanel, install, service,
        history = true, serviceLocked = fleetReason != null)
}

private fun berthFamily(wire: String): VehicleFamily? = when (wire) {
    "starter" -> VehicleFamily.STARTER
    "survey_balloon" -> VehicleFamily.SURVEY_BALLOON
    "cargo_cutter" -> VehicleFamily.CARGO_CUTTER
    "courier_airship" -> VehicleFamily.COURIER_AIRSHIP
    "expedition_barge" -> VehicleFamily.EXPEDITION_BARGE
    else -> null
}

private fun Long.berthInt(): Int? = takeIf { it in 0..Int.MAX_VALUE.toLong() }?.toInt()

private fun berthVehicleUi(row: JsonObject, policy: VehiclePolicy?): VehicleUi {
    val away = CharterGrammar.bool(row.getValue("away"))
    val service = CharterGrammar.bool(row.getValue("pendingService"))
    val left = CharterGrammar.number(row.getValue("remainingUses")).berthInt()
    val tier = CharterGrammar.number(row.getValue("tier")).toInt()
    return VehicleUi(requireNotNull(berthFamily(row.charterText("family"))), tier, row.charterText("installationId"),
        row.charterText("berthId"), when { away -> VehicleStatus.AWAY; service -> VehicleStatus.BUSY_SERVICE
            left == 0 -> VehicleStatus.WORN_OUT; else -> VehicleStatus.DOCKED },
        left, policy?.completedUses?.berthInt(), if (away) "…" else null, tier)
}

private fun berthOwnedUi(identity: JsonObject) = OwnedVehicleUi(identity.charterText("assetId"),
    CharterGrammar.number(identity.getValue("tier")).toInt())

/** Recheck original identity before displaying a fee; history is never substituted for current fleet authority. */
private fun berthOriginal(record: VehicleRecord, wallet: String?): JsonObject? = runCatching {
    require(record.kind in listOf("installation", "service"))
    val client = VehicleProtocol.client(requireNotNull(record.response))
    VehiclePolicy.from(record.policy).verifyClient(client)
    require(wallet != null && VehicleProtocol.actor(client) == wallet && client.charterText("kind") == record.kind)
    require(VehicleProtocol.request(client) == record.request && record.request.charterText("idempotencyKey") == record.key)
    record.destination?.let { require(it == VehicleProtocol.destination(client)) }
    client
}.getOrNull()

private fun berthRecordBase(record: VehicleRecord, wallet: String?): String? = runCatching {
    berthOriginal(record, wallet)?.let { VehicleProtocol.destination(it).charterText("baseId") }
        ?: (if (record.kind == "installation") record.request else record.destination)?.charterText("baseId")
}.getOrNull()

private fun berthServiceMatches(client: JsonObject, row: JsonObject): Boolean = runCatching {
    val original = VehicleProtocol.original(client).charterObject("state")
    require(!CharterGrammar.bool(row.getValue("away")))
    listOf("installationId", "berthId", "family", "tier", "revision", "completedTotal", "allowanceStart")
        .all { original[it] == row[it] }
}.getOrDefault(false)

private fun berthReviewedFee(state: VehicleState, record: VehicleRecord, client: JsonObject,
    policy: VehiclePolicy?, nowMs: Long): String? = runCatching {
    val rules = requireNotNull(policy)
    require(state.selectedId == record.id && !record.held && record.signed == null && "wallet" !in record.attempts)
    require(VehicleProtocol.terminal(client) == null && client.charterObject("record").charterOptional("signed") == null)
    require(VehiclePolicy.from(record.policy).sameBurnPolicy(rules))
    val review = VehicleProtocol.review(requireNotNull(state.review))
    rules.verifyReview(review, client)
    require(review.charterText("status") == "ready")
    val reviewed = Instant.parse(review.charterText("reviewedAt")).toEpochMilli()
    val expires = Instant.parse(review.charterText("expiresAt")).toEpochMilli()
    require(nowMs >= 0 && nowMs >= reviewed && nowMs < expires)
    marketSol(review.charterObject("observation").charterText("networkFeeLamports"))
}.getOrNull()
