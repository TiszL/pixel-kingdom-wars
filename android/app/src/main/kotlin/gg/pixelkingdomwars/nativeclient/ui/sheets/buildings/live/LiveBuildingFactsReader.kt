package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.baseJobProgress
import gg.pixelkingdomwars.nativeclient.model.BaseJob
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.VisualContext
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.data.HeroRecruitmentState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseSol
import gg.pixelkingdomwars.nativeclient.ui.kingdom.builderFinishCanReview
import gg.pixelkingdomwars.nativeclient.ui.kingdom.priceLabel
import gg.pixelkingdomwars.nativeclient.ui.kingdom.buildingGates
import gg.pixelkingdomwars.nativeclient.ui.kingdom.sheetBuildingInfo
import gg.pixelkingdomwars.nativeclient.ui.kingdom.sheetBuildingPortrait
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.buildingArtDrawable
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PRICE_UNAVAILABLE
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BUILDING_UNAVAILABLE
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.SAVED_BUILD_PAYMENT
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.HERO_RECRUIT_BUSY
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.HERO_RECRUIT_OFF
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.HERO_RECRUIT_SAVED
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.HERO_RECRUIT_UNSUPPORTED
import gg.pixelkingdomwars.nativeclient.renderer.BaseScene
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/*
 * The reader: KingdomUiState -> the live sheets' facts. It reads ONLY what the current composables already receive
 * (BuildingSheet: state, building, busy, now; BuildMenu: state, busy; the placement dialog: state, busy, the hero offer)
 * and calls the SAME helpers they call (`buildingGates`, `levelStats`, `sheetBuildingPortrait`, `sheetBuildingInfo`,
 * `state.price`, `buildCountPresentation`, `builderFinishCanReview`, `fmtN`, `fmtDur`). No repository, no network, no
 * new rule. Pure (the clock is the caller's `now`).
 */

/** BuildingSheet's view of [building]; null exactly when BuildingSheet itself draws nothing (no catalogue / base / gates). */
internal fun readBuildingFacts(state: KingdomUiState, building: Building, busy: Boolean, now: Long,
    scene: BaseScene? = null): BuildingFacts? {
    val catalogue = state.catalogue ?: return null
    val base = state.base ?: return null
    val gates = buildingGates(state, building, busy) ?: return null
    val type = building.type
    val heroKey = when (type) { "heroaltar" -> "vex"; "siegestool" -> "theodor"; else -> null }
    val hero = heroKey?.let { key -> base.raw.objects("heroes").firstOrNull { it.string("hero") == key } }
    val heroLevel = hero?.string("level")?.toIntOrNull()
    val job = gates.job
    val artNow = if (type in phaseEBuildingInfoTypes) phaseEBuildingInfoPortrait(base.baseId, building, scene).orEmpty()
        else sheetBuildingPortrait(catalogue, type, gates.level, heroLevel)
    return BuildingFacts(
        buildingId = building.id,
        type = type,
        name = trayLabel(type),
        level = gates.level,
        maxLevel = gates.max,
        artNow = artNow,
        artNext = if (type in phaseEBuildingInfoTypes) artNow else sheetBuildingPortrait(catalogue, type, gates.level + 1, heroLevel),
        role = sheetBuildingInfo(catalogue, type)?.who,
        category = buildingCategory(type, isTrapType(catalogue, type), type in defenceBuildingChoices),
        stats = levelStats(catalogue, type, gates.level)?.rows.orEmpty().map { StatFact(it.label, it.current, it.next) },
        capabilities = readCapabilities(catalogue, type),
        unlocks = if (type == "keep" && gates.level < gates.max)
            unlocksAtKeepLevel(catalogue, gates.level + 1).map { unlockLabel(catalogue, it) } else emptyList(),
        paidSol = gates.upgradeSol?.takeIf { it > 0L }?.let { basePurchaseSol(it.toString()) },
        paidTime = gates.paidOffer?.seconds?.toLongOrNull()?.takeIf { it > 0 }?.let(::fmtDur),
        canShowUpgrade = gates.canShowUpgrade,
        enabled = gates.enabled,
        upgradeCost = gates.upgradeCost?.let(::fmtN),
        upgradeCostRaw = gates.upgradeCost,
        upgradePriced = gates.price != null,
        upgradeTime = gates.price?.seconds?.toLongOrNull()?.let(::fmtDur),
        paidStep = (gates.upgradeSol ?: 0L) > 0L,
        paidOfferReady = gates.paidOffer != null,
        job = job?.let { running ->
            JobFact(running.id, running.kind, secondsLeft(running, now)?.let(::fmtDur), gates.finishPrice == "0",
                builderFinishCanReview(running), running.refundShards?.takeIf { running.canCancel }?.let(::fmtN))
        },
        repair = gates.repair?.let { RepairFact(fmtN(it.costShards), fmtDur(it.repairSec), it.costShards.toString()) },
        shardsBalance = state.home.balances?.shards,
        freeBuilders = base.freeBuilders,
        totalBuilders = base.player.builders,
        nextBuilderFreeIn = nextBuilderFreeIn(base.jobs, now),
        heroReady = (hero?.get("available") as? JsonPrimitive)?.content?.toBooleanStrictOrNull(),
        wallRow = state.local.wallRow,
        blockedReason = blockedReason(state, busy),
        readOnly = !state.ordersAllowed || !state.deedActionsAllowed,
        constructionBlocked = state.constructionBlocked,
        busy = busy,
        mine = readMineFact(state),
    )
}

/** Discovery is independent of construction admission: unavailable buildings retain their design card.
 * All costs, Keep gates and counts still come from the current catalogue/base; absent values remain unknown. */
internal fun readTrayFacts(state: KingdomUiState, busy: Boolean): TrayFacts {
    val base = state.base
    val catalogue = state.catalogue
    val costs = (catalogue?.get("constants") as? JsonObject)?.get("BUILD_COSTS") as? JsonObject
    val types = base?.buildings?.map { it.type }.orEmpty()
    val phaseE = state.phaseEBuildingChoices
    val cards = (realmTradeBuildingTypes + ordinaryBuildingChoices + phaseE + defenceBuildingChoices).distinct().mapNotNull { type ->
        val value = costs?.get(type)
        val price = state.price(type)
        if (type !in realmTradeBuildingTypes && (value == null || price == null)) return@mapNotNull null
        val count = if (catalogue != null && base != null)
            buildCountPresentation(catalogue, type, base.player.keepLevel, types, base.raw["constructionCapacity"]) else null
        val trap = catalogue?.let { isTrapType(it, type) } == true
        TrayCardFact(
            type = type, name = when (type) { "lodge" -> "LODGE"; "harvester" -> "HARVESTER"; else -> trayLabel(type) },
            purpose = realmTradePurpose(type) ?: catalogue?.let { sheetBuildingInfo(it, type)?.who }.orEmpty(),
            // These are bundled UI illustrations, not scene leases or construction capability.
            art = discoveryPortrait(state, type),
            currency = price?.currency.orEmpty(), amount = price?.amount?.let(::fmtN).orEmpty(), amountRaw = price?.amount.orEmpty(),
            time = price?.seconds?.toLongOrNull()?.takeIf { it > 0 }?.let(::fmtDur),
            requiredKeep = (value as? JsonObject)?.string("requiresKeepLevel")?.toIntOrNull(),
            owned = count?.owned ?: base?.let { types.count { it == type } }, max = count?.max, familyOwned = count?.familyOwned,
            atCap = count?.atCap == true, trap = trap,
            group = trayGroup(type, trap, type in defenceBuildingChoices, type in phaseE),
            unavailableReason = when {
                base == null || catalogue == null -> "Loading buildings…"
                type in realmTradeBuildingTypes && type != "goldforge" && type !in phaseE -> BUILDING_UNAVAILABLE
                price == null -> PRICE_UNAVAILABLE
                else -> null
            },
            constructionAdmitted = type !in realmTradeBuildingTypes || type == "goldforge" || type in phaseE,
            nextCapKeep = if (catalogue != null && base != null && count?.atCap == true)
                nextBuildCapKeep(catalogue, type, base.player.keepLevel, count, trap, base.raw["constructionCapacity"]) else null,
        )
    }
    return TrayFacts(base?.player?.keepLevel, base?.freeBuilders, base?.player?.builders, state.home.balances?.shards, cards, busy)
}

/** Display-only lookup, using the same cap tables as buildCountPresentation. Never grants capacity. */
private fun nextBuildCapKeep(catalogue: JsonObject, type: String, keepLevel: Int, count: BuildCount,
    trap: Boolean, capacity: kotlinx.serialization.json.JsonElement?): Int? {
    // GET /base overrides the Berth table; that snapshot does not promise what a future Keep will advertise.
    if (type == "berth" && advertisedBerthBuildCapacity(capacity) != null) return null
    val constants = catalogue["constants"] as? JsonObject ?: return null
    val table = when {
        trap -> (constants["CAPS"] as? JsonObject)?.get("trapsByKeepLevel")
        type == "mine" -> (constants["MINING"] as? JsonObject)?.get("MAX_MINES_BY_KEEP")
        else -> (constants["BUILD_COUNT_CAP_BY_KEEP"] as? JsonObject)?.get(type)
    } as? JsonArray ?: return null
    // Do not skip malformed entries: doing so would shift every later Keep index.
    val caps = table.map { value ->
        (value as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull?.takeIf { it >= 0 } ?: return null
    }
    if (caps.isEmpty() || keepLevel < 1 || caps[minOf(keepLevel, caps.size) - 1] != count.max) return null
    val owned = if (trap) count.familyOwned ?: return null else count.owned
    return caps.indices.firstOrNull { index -> index + 1 > keepLevel && caps[index] > maxOf(count.max, owned) }?.plus(1)
}

private fun discoveryPortrait(state: KingdomUiState, type: String): String {
    gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.ordinaryBuildTrayPortrait(type)?.let { return it }
    if (type == "goldforge") return "ui:goldforge-t1-idle"
    if (type == "harvester") {
        // Admission no longer filters discovery, so validate the display context without coercing strings to numbers.
        val context = state.base?.raw?.get("visualContext") as? JsonObject ?: return ""
        if (listOf("version", "artVersion").any { (context[it] as? JsonPrimitive)?.isString != false } ||
            (context["realmId"] as? JsonPrimitive)?.isString != true) return ""
    }
    return newConstructionPortrait(state, type, realmTradeBuildingTypes)
}

/** Presentation-only, bundled portraits from MOUNT-BUILDINGS.md. They never authorize a scene asset or a start.
 * The caller supplies visible types: BUILD discovery includes unavailable cards; placement requires live admission.
 * A revoked placement has no legacy-art fallback.
 * Harvester uses the selected base's admitted realm, and only names already owned by BuildingArt are returned. */
private fun newConstructionPortrait(state: KingdomUiState, type: String, admitted: List<String>): String {
    val name = when (type) {
        "workshop", "lodge", "market" -> {
            if (type !in admitted) return ""
            "ui:$type-t1-idle"
        }
        "harvester" -> {
            if (type !in admitted) return ""
            val realm = try { VisualContext.of(state.base?.raw)?.realmId } catch (_: IllegalArgumentException) { null }
                ?: return ""
            "ui:harv-$realm-t1-idle"
        }
        "berth" -> {
            if (type !in admitted) return ""
            "ui:berth-starter-intact"
        }
        else -> return state.catalogue?.let { sheetBuildingPortrait(it, type, 1) }.orEmpty()
    }
    return name.takeIf { buildingArtDrawable(it) != null }.orEmpty()
}

/** The placement ghost (buildings/SPEC.md §4.1, placement.png): the building's own transparent tier-1 art, lifted and
 *  outlined over its footprint, never the old `ui_portrait_*` icon in its dark grey-rimmed plate (owner screenshot 3,
 *  2026-10-06). The BUILD tray's tracked identity sprite where one exists, the Gold Forge's Phase E tier art, else the
 *  admitted construction portrait (the types still awaiting owner art keep their catalogue portrait). Presentation only. */
private fun placementGhostArt(state: KingdomUiState, type: String): String =
    gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.ordinaryBuildTrayPortrait(type)
        ?: if (type == "goldforge") "ui:goldforge-t1-idle" else newConstructionPortrait(state, type, state.phaseEBuildingChoices)

/** The placement dialog's inputs for the current draft; null when there is no draft or no base. [heroes]: the hero
 *  recruitment state, so a hero offer for this type can be placed on the designed band (its PLACE opens the existing
 *  HeroAltarConfirm review); without it a hero offer stays on the legacy dialog. */
internal fun readPlacementFacts(state: KingdomUiState, busy: Boolean, now: Long, heroOffer: Boolean,
    heroes: HeroRecruitmentState? = null): PlacementFacts? {
    val draft = state.local.placement ?: return null
    val base = state.base ?: return null
    val catalogue = state.catalogue
    val price = state.price(draft.type)
    val space = readPlacementSpace(state)
    val hero = heroes?.offers?.firstOrNull { it.definition.type == draft.type }?.takeIf { heroOffer }
    return PlacementFacts(
        type = draft.type, name = trayLabel(draft.type),
        art = placementGhostArt(state, draft.type),
        footprint = space?.width ?: state.geometry?.footprint(draft.type, 1)?.first ?: 1,
        tile = draft.tile,
        currency = price?.currency, amount = price?.amount?.let(::fmtN), amountRaw = price?.amount,
        time = hero?.definition?.buildSec?.toLong()?.takeIf { it > 0 }?.let(::fmtDur)
            ?: price?.seconds?.toLongOrNull()?.takeIf { it > 0 }?.let(::fmtDur),
        shardsBalance = state.home.balances?.shards,
        freeBuilders = base.freeBuilders, totalBuilders = base.player.builders, nextBuilderFreeIn = nextBuilderFreeIn(base.jobs, now),
        available = state.constructionAvailable(draft.type),
        readOnly = !state.ordersAllowed || !state.deedActionsAllowed,
        constructionBlocked = state.constructionBlocked,
        busy = busy,
        heroOffer = heroOffer,
        takenTiles = space?.takenTiles.orEmpty(),
        spaceReason = space?.reason,
        footprintHeight = space?.height ?: state.geometry?.footprint(draft.type, 1)?.second ?: 1,
        heroPrice = hero?.priceLabel(),
        heroMaxKeep = hero?.definition?.costKeep?.let(::fmtN),
        heroBlocked = heroes?.takeIf { hero != null }?.let(::heroRecruitmentBlock),
    )
}

/** Why hero recruitment cannot start right now, in the words the recruitment menu and repository already use; null
 *  when it can (the server still re-checks everything in the HeroAltarConfirm review). */
internal fun heroRecruitmentBlock(h: HeroRecruitmentState): String? = when {
    !h.supported -> HERO_RECRUIT_UNSUPPORTED
    !h.enabled -> HERO_RECRUIT_OFF
    h.pending != null -> HERO_RECRUIT_SAVED
    h.busy -> HERO_RECRUIT_BUSY
    else -> null
}

/** `DEFENSES[type].targetsAir` / `targetsGround` exactly as the catalogue states them (JSON booleans only); a missing key
 *  is no row, never a guessed NO. */
internal fun readCapabilities(catalogue: JsonObject, type: String): List<CapabilityFact> {
    val row = ((catalogue["constants"] as? JsonObject)?.get("DEFENSES") as? JsonObject)?.get(type) as? JsonObject
        ?: return emptyList()
    return listOf(CapabilityKeys.AIR, CapabilityKeys.GROUND).mapNotNull { key ->
        (row[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull?.let { CapabilityFact(key, it) }
    }
}

/** The running builds and upgrades on buildings of this base. */
internal fun readConstructionJobs(state: KingdomUiState, now: Long): List<ConstructionJobFact> {
    val base = state.base ?: return emptyList()
    return base.jobs.mapNotNull { job ->
        val building = base.buildings.firstOrNull { it.id == job.buildingId } ?: return@mapNotNull null
        val left = secondsLeft(job, now)
        ConstructionJobFact(building.id, trayLabel(building.type), job.kind, left, left?.let(::fmtDur),
            baseJobProgress(job.startedAt, job.finishesAt, now)?.fraction)
    }
}

/** The first Mine on this base and its buffer (`mine/status`), formatted as the current MineCollect prints it. */
internal fun readMineFact(state: KingdomUiState): MineFact = MineFact(
    state.base?.buildings?.firstOrNull { it.type == "mine" }?.id,
    state.home.mine?.mining?.accrued?.let(::fmtN),
)

/** BuildingSheet's `remainingSec`, null (not 0) when the deadline is missing or unreadable. */
private fun secondsLeft(job: BaseJob, now: Long): Long? =
    job.finishesAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }?.let { maxOf(0L, (it - now + 999) / 1000) }

/** When the next builder frees up: the soonest running job (the BUILDERS dock's own pick). */
private fun nextBuilderFreeIn(jobs: List<BaseJob>, now: Long): String? =
    jobs.mapNotNull { secondsLeft(it, now) }.minOrNull()?.let(::fmtDur)

/** The same words as BuildingCommandAdapter's private `blockedReason` (one rule, two readers until MS-C2's GateContext). */
private fun blockedReason(state: KingdomUiState, busy: Boolean): String = when {
    !state.ordersAllowed || !state.deedActionsAllowed -> "Orders are paused here"
    state.constructionBlocked -> SAVED_BUILD_PAYMENT
    busy -> "Working…"
    else -> "Not available now"
}

/** One synchronous owner observation; the host uses catalogue object identity as its content fence. */
internal data class LiveBuildingCostSnapshot(
    val account: gg.pixelkingdomwars.nativeclient.session.AccountSession,
    val state: KingdomUiState,
    val contentGeneration: Long,
    val balanceRevision: Long,
)

internal data class LiveBuildingCostProjection(
    val price: gg.pixelkingdomwars.nativeclient.ui.model.PriceUi,
    val amountRaw: String?,
    val balanceShards: String?,
    val current: Boolean,
    /** Display history only; price stays UNAVAILABLE and no balance is admitted. */
    val held: Boolean = false,
)

/** Construct once per composition from live owners, never remember a rendered observation.
 * H2 admits only canonical base-scoped funds through M3. H3 fences refresh start and publication.
 * This presentation reader does not create lifecycle owners or change order/recovery controllers. */
internal class LiveBuildingCosts(
    private val holder: gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder?,
    private val account: gg.pixelkingdomwars.nativeclient.session.AccountSession?,
    private val readState: () -> KingdomUiState,
    private val readBalanceRevision: () -> Long,
    private val readContentGeneration: () -> Long = { 0L },
    private val heldPrices: LiveBuildPriceMemory = LiveBuildPriceMemory(),
    private val rendered: KingdomUiState? = null,
) {
    private fun readOwner(): LiveBuildingCostSnapshot? = try {
        val owner = account
        val currentHolder = holder
        if (owner == null || currentHolder == null || !currentHolder.isCurrent(owner)) null else {
            val revision = readBalanceRevision()
            val state = readState()
            val generation = readContentGeneration()
            if (revision < 0 || revision != readBalanceRevision() || !currentHolder.isCurrent(owner)) null
            else LiveBuildingCostSnapshot(owner, state, generation, revision)
        }
    } catch (_: kotlinx.coroutines.CancellationException) { null }
      catch (_: RuntimeException) { null }

    private val displayObservation = readOwner()
    // Preserve the old unavailable() fallback for every strict projection. The extra observation is display-only.
    private val observed = displayObservation?.takeIf { rendered == null || sameReview(it.state, rendered) }
    init { heldPrices.observe(displayObservation) }

    /** A fresh owner read may not be applied to facts from an older combined UI emission. */
    fun matchesRendered(rendered: KingdomUiState): Boolean = observed?.state?.let { sameReview(it, rendered) } == true

    private fun sameReview(before: KingdomUiState, now: KingdomUiState): Boolean =
        now.wallet == before.wallet && now.selectedBaseId == before.selectedBaseId && now.baseGeneration == before.baseGeneration &&
            now.home === before.home && now.catalogue != null && now.catalogue === before.catalogue &&
            now.renderCatalogue === before.renderCatalogue && now.constructionArt === before.constructionArt &&
            now.constructionPreparation === before.constructionPreparation &&
            now.local.selectedBuildingId == before.local.selectedBuildingId && now.local.placement == before.local.placement &&
            now.local.buildMenu == before.local.buildMenu && now.ordersAllowed == before.ordersAllowed &&
            now.deedActionsAllowed == before.deedActionsAllowed && now.constructionBlocked == before.constructionBlocked

    fun reviewCurrent(): Boolean {
        if (rendered != null && !matchesRendered(rendered)) return false
        val before = observed ?: return false
        val current = readOwner() ?: return false
        val state = current.state
        return current.account === before.account && current.contentGeneration == before.contentGeneration &&
            current.balanceRevision == before.balanceRevision && sameReview(before.state, state) &&
            state.wallet == current.account.wallet && !state.selectedBaseId.isNullOrBlank() &&
            state.selectedBaseId == state.base?.baseId && !state.home.loading && state.home.error == null &&
            state.ordersAllowed && state.deedActionsAllowed && !state.constructionBlocked
    }

    /** Preserve the reason for the saved receipt while price admission stays closed. */
    fun savedPaymentBlocked(): Boolean = observed?.state?.constructionBlocked == true ||
        readOwner()?.state?.constructionBlocked == true

    /** H1: route item/KEEP/SOL reviews before invoking the money mapper. */
    fun upgrade(facts: BuildingFacts): LiveBuildingCostProjection? {
        if (facts.type == "heroaltar" || facts.type == "siegestool" || facts.paidStep) return null
        val state = observed?.state
        val building = state?.selectedBuilding
        val subject = building != null && building.id == facts.buildingId && building.type == facts.type && building.level == facts.level
        val catalogue = state?.catalogue
        if (subject && catalogue != null && (upgradeSolLamports(catalogue, facts.type, facts.level + 1) ?: 0L) > 0L) return null
        val row = state?.base?.raw?.objects("buildings")?.singleOrNull { it.string("id") == facts.buildingId }
        val price = if (subject && catalogue != null && row != null) buildingUpgradePrice(catalogue, row) else null
        if (price != null && price.currency != "SHARDS") return null
        return project(price, subject)
    }

    fun build(type: String): LiveBuildingCostProjection? {
        if (type == "heroaltar" || type == "siegestool") return null
        val before = observed
        val displayBefore = displayObservation
        val state = before?.state
        val price = state?.price(type)
        val displayPrice = displayBefore?.state?.price(type)
        if (price != null && price.currency != "SHARDS") { heldPrices.forget(type); return null }
        val latest = readOwner()
        heldPrices.observe(latest)
        val p = project(price, state != null && state.buildMenu && state.constructionAvailable(type))
        if (p.current && before != null) {
            // Even an admitted missing/zero price ends the hold; the next read says what may be displayed.
            heldPrices.admitted(before, type, price.takeIf {
                p.price.status != gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE
            })
            return p
        }
        val remembered = latest?.let { heldPrices.price(it, type) }
        val held = displayBefore != null && latest != null && remembered != null && remembered == displayPrice &&
            priceHeldContext(displayBefore, latest, type) &&
            (rendered == null || samePriceContext(rendered, latest.state))
        return if (held && p.price.status == gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE)
            p.copy(amountRaw = remembered?.amount, held = true) else p
    }

    /** Omit only refresh observation fields. Account/base/content, capability and interaction scope stay exact. */
    private fun samePriceContext(before: KingdomUiState, now: KingdomUiState): Boolean =
        before.wallet == now.wallet && before.selectedBaseId == now.selectedBaseId && before.baseGeneration == now.baseGeneration &&
            before.base?.baseId == now.base?.baseId && before.catalogue != null && before.catalogue === now.catalogue &&
            before.renderCatalogue === now.renderCatalogue && before.constructionArt === now.constructionArt &&
            before.constructionPreparation === now.constructionPreparation &&
            before.local.selectedBuildingId == now.local.selectedBuildingId && before.local.placement == now.local.placement &&
            before.local.buildMenu == now.local.buildMenu && before.ordersAllowed == now.ordersAllowed &&
            before.deedActionsAllowed == now.deedActionsAllowed && before.constructionBlocked == now.constructionBlocked

    private fun priceHeldContext(before: LiveBuildingCostSnapshot, now: LiveBuildingCostSnapshot, type: String): Boolean {
        val s = now.state
        return now.account === before.account && now.contentGeneration == before.contentGeneration &&
            samePriceContext(before.state, s) && s.wallet == now.account.wallet &&
            !s.selectedBaseId.isNullOrBlank() && s.selectedBaseId == s.base?.baseId &&
            s.buildMenu && s.placement == null && s.ordersAllowed && s.deedActionsAllowed && !s.constructionBlocked &&
            s.constructionAvailable(type) && s.price(type) == before.state.price(type)
    }

    fun placement(facts: PlacementFacts): LiveBuildingCostProjection? {
        if (facts.type == "wall" || facts.heroOffer || facts.type == "heroaltar" || facts.type == "siegestool") return null
        val state = observed?.state
        val price = state?.price(facts.type)
        if (price != null && price.currency != "SHARDS") return null
        return project(price, state != null && state.placement?.type == facts.type && state.placement?.tile == facts.tile &&
            state.constructionAvailable(facts.type))
    }

    private fun project(price: BaseOrderPrice?, subjectCurrent: Boolean): LiveBuildingCostProjection {
        val current = subjectCurrent && reviewCurrent()
        val balance = observed?.state?.home?.balances?.shards.takeIf { current }
        val mapped = gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.buildUpgradeMoneyPrice(
            price, priceCurrent = current, balanceShards = balance, balanceCurrent = current)
            ?: gg.pixelkingdomwars.nativeclient.ui.model.PriceUi(gg.pixelkingdomwars.nativeclient.ui.model.Currency.SHARDS,
                null, gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE)
        // M3 is the sole canonical parser. CHECKING/UNAVAILABLE never reach lenient shortfall readers.
        val admittedBalance = balance.takeIf { mapped.status == gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.OK ||
            mapped.status == gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.SHORT }
        return LiveBuildingCostProjection(mapped, price?.amount, admittedBalance, current)
    }

    companion object {
        fun unavailable() = LiveBuildingCosts(null, null, { KingdomUiState() }, { -1L })
    }
}

/** Canonical amounts replace presentation strings only for the guarded overloads. */
internal fun BuildingFacts.withCosts(cost: LiveBuildingCostProjection): BuildingFacts = copy(
    upgradeCost = cost.price.amount ?: upgradeCost,
    upgradeCostRaw = cost.amountRaw,
    upgradePriced = cost.price.status != gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE,
    shardsBalance = cost.balanceShards,
    enabled = enabled && cost.current,
    readOnly = readOnly || !cost.current,
)
