package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.ConstructionLayerUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.NeedMoreUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PlacementState
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PlacementUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PlateTone
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.TimerPlateUi
import androidx.compose.ui.unit.IntOffset

/*
 * PlacementFacts -> PlacementUi (the placement band, SPEC §4) and the construction sites -> ConstructionLayerUi
 * (SPEC R2.3). Pure.
 *
 * Placement replaces the current "Place X" dialog for a single SHARDS-priced building: PLACE calls the SAME
 * `model.confirmPlacement()` the dialog's ✓ PLACE calls, under the same conditions the dialog enables it (a picked tile, a
 * price, construction available, not busy, no saved construction payment, a free builder, orders and deed actions
 * allowed). Known buildings, obstacles and claim edges supply local blocked-tile feedback; a clear footprint never
 * admits an order and the server rechecks it. Walls keep drag-to-paint (SPEC §4.2) and a non-SHARDS price (the second
 * Mine, KEEP) keeps the current dialog: the mapper declines them (null). A hero offer is placed on the band when its
 * price words are known; its PLACE opens the existing HeroAltarConfirm review, which stays the consent.
 */

/** The current placement draft and the dialog's inputs. */
internal data class PlacementFacts(
    val type: String,
    /** `trayLabel(type)`. */
    val name: String,
    /** `sheetBuildingPortrait(type, 1)`; blank when none. */
    val art: String,
    /** `footprintOf(type).first` (the band does not draw the ghost; kept for the world lane). */
    val footprint: Int,
    /** The picked tile; null until the player taps the ground. */
    val tile: Pair<Int, Int>?,
    /** `state.price(type)`: currency code, printed amount, plain amount, `fmtDur(seconds)`; all null when no price. */
    val currency: String?,
    val amount: String?,
    val amountRaw: String?,
    val time: String?,
    val shardsBalance: String?,
    val freeBuilders: Int,
    val totalBuilders: Int?,
    val nextBuilderFreeIn: String?,
    /** `state.constructionAvailable(type)`. */
    val available: Boolean,
    /** `!ordersAllowed || !deedActionsAllowed`. */
    val readOnly: Boolean,
    val constructionBlocked: Boolean,
    val busy: Boolean,
    /** A hero recruitment offer exists for this type (the dialog then routes to its review). */
    val heroOffer: Boolean,
    /** Local tile feedback; the server still decides whether PLACE succeeds. */
    val takenTiles: Set<IntOffset> = emptySet(),
    val spaceReason: String? = null,
    val footprintHeight: Int = footprint,
    /** A hero offer's price words (`HeroAltarOffer.priceLabel()`): contract first, else up to the reviewed KEEP. */
    val heroPrice: String? = null,
    /** The offer's KEEP ceiling as printed (`fmtN(definition.costKeep)`); spoken only, the review shows the charge. */
    val heroMaxKeep: String? = null,
    /** Why recruitment cannot start now (`heroRecruitmentBlock`); null when it can. */
    val heroBlocked: String? = null,
)

/** The band's hint pill (SPEC §4.1 words): where to tap first, the blocked-tile line, or the drag line. */
private fun placementHintLine(f: PlacementFacts): String = when {
    f.tile == null -> "Tap where the ${f.name.lowercase()} goes · pinch to zoom"
    f.spaceReason != null -> "Red tiles are taken. Drag it clear."
    else -> "Drag to move · PLACE when green"
}

/**
 * A hero recruitment on the designed band. PLACE does not spend: it opens the existing HeroAltarConfirm review (the only
 * consent; the server uses a contract first, else up to the reviewed KEEP). Null without the offer's words, so the legacy
 * dialog keeps it.
 */
internal fun liveHeroPlacementUi(f: PlacementFacts): PlacementUi? {
    if (!f.heroOffer) return null
    val words = f.heroPrice ?: return null
    // The pill is replaced by [PlacementUi.priceLine]; this price only lets PLACE open the review and is spoken as [words].
    val price = PriceUi(Currency.KEEP, f.heroMaxKeep ?: UNKNOWN, PriceStatus.OK, description = words)
    val (state, reason) = when {
        f.busy -> PlacementState.SENDING to null
        f.readOnly -> PlacementState.BLOCKED to "Orders are paused here"
        f.constructionBlocked -> PlacementState.BLOCKED to "Check the saved payment first"
        f.heroBlocked != null -> PlacementState.BLOCKED to f.heroBlocked
        !f.available -> PlacementState.BLOCKED to "Not available now"
        f.tile == null -> PlacementState.BLOCKED to "Tap a spot first"
        f.spaceReason != null -> PlacementState.BLOCKED to f.spaceReason
        f.freeBuilders == 0 -> PlacementState.NO_BUILDER to "No free builder"
        else -> PlacementState.VALID to null
    }
    val tile = f.tile
    return PlacementUi(
        type = f.type, name = f.name.uppercase(), ghostArt = f.art, footprint = f.footprint.coerceAtLeast(1),
        tile = if (tile == null) IntOffset.Zero else IntOffset(tile.first, tile.second), takenTiles = f.takenTiles,
        footprintHeight = f.footprintHeight, price = price, time = f.time ?: UNKNOWN,
        builders = if (state == PlacementState.NO_BUILDER && f.nextBuilderFreeIn != null) "free in ${f.nextBuilderFreeIn}"
            else "${f.freeBuilders}/${f.totalBuilders?.toString() ?: UNKNOWN}",
        state = state, hint = placementHintLine(f), reason = reason, priceLine = words,
    )
}

/** The placement band for [f], or null when the current dialog / wall panel keeps it. */
internal fun livePlacementUi(f: PlacementFacts): PlacementUi? {
    if (f.type == "wall") return null
    if (f.heroOffer) return liveHeroPlacementUi(f)
    // KEEP / Gems / SOL priced builds (the second Mine is KEEP) keep the legacy dialog: its words are their consent.
    if (f.currency != null && currencyOf(f.currency) != Currency.SHARDS) return null
    val price = when {
        f.amount == null -> PriceUi(Currency.SHARDS, null, PriceStatus.UNAVAILABLE)
        shortfall(f.shardsBalance, f.amountRaw) != null -> PriceUi(Currency.SHARDS, f.amount, PriceStatus.SHORT)
        else -> PriceUi(Currency.SHARDS, f.amount, PriceStatus.OK)
    }
    val (state, reason) = when {
        f.busy -> PlacementState.SENDING to null
        f.readOnly -> PlacementState.BLOCKED to "Orders are paused here"
        f.constructionBlocked -> PlacementState.BLOCKED to "Check the saved payment first"
        !f.available -> PlacementState.BLOCKED to "Not available now"
        f.tile == null -> PlacementState.BLOCKED to "Tap a spot first"
        f.spaceReason != null -> PlacementState.BLOCKED to f.spaceReason
        // The dialog disabled PLACE without a price; the kit draws an UNAVAILABLE price OFF with its own reason.
        price.status == PriceStatus.UNAVAILABLE -> PlacementState.VALID to null
        f.freeBuilders == 0 -> PlacementState.NO_BUILDER to "No free builder"
        price.status == PriceStatus.SHORT -> PlacementState.SHORT to null
        else -> PlacementState.VALID to null
    }
    val tile = f.tile
    return PlacementUi(
        type = f.type,
        name = f.name.uppercase(),
        ghostArt = f.art,
        footprint = f.footprint.coerceAtLeast(1),
        tile = if (tile == null) IntOffset.Zero else IntOffset(tile.first, tile.second),
        takenTiles = f.takenTiles,
        footprintHeight = f.footprintHeight,
        price = price,
        time = f.time ?: UNKNOWN,
        builders = if (state == PlacementState.NO_BUILDER && f.nextBuilderFreeIn != null) "free in ${f.nextBuilderFreeIn}"
            else "${f.freeBuilders}/${f.totalBuilders?.toString() ?: UNKNOWN}",
        state = state,
        hint = placementHintLine(f),
        reason = reason,
    )
}

/** The Need-more sheet for a SHORT placement (null when nothing is missing or the band is not the live one). */
internal fun livePlacementNeedMore(f: PlacementFacts, mine: MineFact): NeedMoreUi? {
    val amount = f.amount ?: return null
    if (currencyOf(f.currency) != Currency.SHARDS) return null
    return liveShardsNeedMore(titleCase(f.name), f.shardsBalance, amount, f.amountRaw, mine)
}

/** One running construction or upgrade, as the builders dock reads it. */
internal data class ConstructionJobFact(
    val buildingId: String,
    /** `trayLabel(type)`. */
    val name: String,
    val kind: String,
    /** Whole seconds left; null when the server sent no readable deadline. */
    val secondsLeft: Long?,
    /** `fmtDur(secondsLeft)`. */
    val remaining: String?,
    /** `baseJobProgress(...).fraction`; null when unknown (an empty meter, never "0 % done"). */
    val progress: Float?,
)

/** The construction plates, soonest to finish first (unknown deadlines last). Builds and upgrades only. */
internal fun liveConstructionSites(jobs: List<ConstructionJobFact>): List<TimerPlateUi> =
    jobs.filter { it.kind == "build" || it.kind == "upgrade" }
        .sortedWith(compareBy(nullsLast()) { it.secondsLeft })
        .map { job ->
            val doing = if (job.kind == "build") "being built" else "upgrading"
            TimerPlateUi(
                buildingId = job.buildingId,
                builderIcon = "builder",
                timeLeft = job.remaining,
                progress = job.progress,
                tone = PlateTone.STRIPE,
                secondsLeft = job.secondsLeft,
                description = "${titleCase(job.name)}: $doing, ${job.remaining?.let { "$it left" } ?: "time unknown"}",
            )
        }

/** The layer: only sites the scene could anchor (an unanchored plate would float at the origin), hidden while anything is
 *  selected, placed, the BUILD tray is open or the layout editor runs (SPEC R2.3). */
internal fun liveConstructionLayer(sites: List<TimerPlateUi>, anchors: Map<String, PxRect>, hidden: Boolean): ConstructionLayerUi =
    ConstructionLayerUi(sites.mapNotNull { site -> anchors[site.buildingId]?.let { site.copy(anchor = it) } }, visible = !hidden)

/** Placement uses the same canonical observation as the tray and upgrade review. A hero offer is routed before the
 *  Shards projection (H1): its band never runs the money mapper; its PLACE only opens the recruitment review. */
internal fun livePlacementUi(f: PlacementFacts, costs: LiveBuildingCosts): PlacementUi? {
    if (f.heroOffer) {
        val hero = liveHeroPlacementUi(f) ?: return null
        return if (costs.savedPaymentBlocked() && hero.state != PlacementState.SENDING)
            hero.copy(state = PlacementState.BLOCKED, reason = "Check the saved payment first") else hero
    }
    val cost = costs.placement(f) ?: return null
    val ui = livePlacementUi(f.copy(amount = cost.price.amount, amountRaw = cost.amountRaw,
        shardsBalance = cost.balanceShards, readOnly = f.readOnly || !cost.current)) ?: return null
    if (f.constructionBlocked || costs.savedPaymentBlocked())
        return ui.copy(price = cost.price, state = PlacementState.BLOCKED, reason = "Check the saved payment first")
    return ui.copy(price = cost.price, state = if (cost.price.status == PriceStatus.CHECKING &&
        ui.state == PlacementState.VALID) PlacementState.CHECKING_PRICE else ui.state)
}

internal fun livePlacementNeedMore(f: PlacementFacts, mine: MineFact, costs: LiveBuildingCosts): NeedMoreUi? {
    val cost = costs.placement(f) ?: return null
    if (cost.price.status != PriceStatus.SHORT) return null
    return liveShardsNeedMore(titleCase(f.name), cost.balanceShards, cost.price.amount ?: return null, cost.amountRaw, mine)
}

internal fun livePlacementUi(f: LivePlacementSheetFacts): PlacementUi? = livePlacementUi(f.facts, f.costs)
internal fun livePlacementNeedMore(f: LivePlacementSheetFacts, mine: MineFact): NeedMoreUi? = livePlacementNeedMore(f.facts, mine, f.costs)
