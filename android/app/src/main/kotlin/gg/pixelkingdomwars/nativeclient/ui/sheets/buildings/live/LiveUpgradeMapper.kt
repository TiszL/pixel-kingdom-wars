package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.DoorUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PRICE_UNAVAILABLE
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.NeedMoreDoorUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.NeedMoreUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.ShortfallUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.StatDeltaUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.UpgradeSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.UpgradeState

/*
 * BuildingFacts -> UpgradeSheetUi (the UPGRADE half sheet, SPEC §2) and the Shards Need-more sheet (SPEC R2.2). Pure.
 *
 * The live UPGRADE sheet is the review the bar's UPGRADE opens, replacing the current full BuildingSheet for a SHARDS-only
 * upgrade. Its UPGRADE calls the SAME `model.upgrade(id)` the current sheet's UPGRADE plate calls; nothing else spends.
 * [liveUpgradeUi] declines (null) everything the current sheet reviews differently: a SOL step, a spent trap (REARM, in
 * place from INFO / the bar), a running job, or no upgrade to show.
 *
 * A SOL step has its own projection, [livePaidUpgradeUi]: the catalogue's Shards and SOL amounts on the same designed
 * sheet, whose primary only opens the SOL Seal (`routes.onPaidUpgrade`); the Shards money mapper never runs for it (H1).
 * [liveUpgradeSheetUi] is the one the mount asks: the Shards review, else the SOL step. Upgrades priced in KEEP or items
 * (neither Shards nor SOL; `LiveBuildingCosts.upgrade` returns null for them) stay declined on purpose: the old
 * BuildingSheet's KEEP confirmation is the only consent wording that exists for them.
 */

/**
 * The UPGRADE sheet of [f], or null when the current BuildingSheet keeps the review. [sent]: this sheet's own UPGRADE was
 * pressed and the model is still busy with it (only then is the sheet BUSY "Starting…"; any other busy reads "Working…").
 */
internal fun liveUpgradeUi(f: BuildingFacts, sent: Boolean = false): UpgradeSheetUi? {
    if (!f.canShowUpgrade || f.job != null || f.repair != null || f.paidStep || f.upgradeCost == null) return null
    val price = upgradePrice(f)
    val missing = if (price.status == PriceStatus.SHORT) shortfall(f.shardsBalance, f.upgradeCostRaw) else null
    val state = when {
        f.readOnly || f.constructionBlocked -> UpgradeState.READ_ONLY
        f.busy -> if (sent) UpgradeState.BUSY else UpgradeState.READ_ONLY
        // An unavailable price keeps the READY state: the kit draws it OFF with "Price unavailable right now".
        price.status == PriceStatus.UNAVAILABLE -> UpgradeState.READY
        missing != null -> UpgradeState.SHORT
        f.freeBuilders == 0 -> UpgradeState.NO_BUILDER
        else -> UpgradeState.READY
    }
    return UpgradeSheetUi(
        buildingId = f.buildingId,
        name = f.name.uppercase(),
        levelFrom = "LV ${f.level}",
        levelTo = "LV ${f.level + 1}",
        artNow = f.artNow,
        artNext = f.artNext,
        newLook = f.artNext.isNotBlank() && f.artNext != f.artNow,
        rows = upgradeRows(f),
        price = price,
        time = f.upgradeTime ?: UNKNOWN,
        builders = buildersLine(f.freeBuilders, f.totalBuilders),
        state = state,
        shortfall = missing?.let { exactAmount(it) },
        bestDoor = if (state == UpgradeState.SHORT) upgradeDoor(f.mine) else null,
        builderFreeIn = if (state == UpgradeState.NO_BUILDER) f.nextBuilderFreeIn else null,
        reason = if (state == UpgradeState.READ_ONLY) (if (f.busy && !f.readOnly && !f.constructionBlocked) "Working…" else f.blockedReason) else null,
    )
}

/** What improves: the `levelStats` deltas, then a gold UNLOCK row for each thing the catalogue says opens at the next
 *  level (the Keep's `unlocksAtKeepLevel`; never invented, so other buildings carry none). */
internal fun upgradeRows(f: BuildingFacts): List<StatDeltaUi> =
    f.stats.mapNotNull(::statDelta) + f.unlocks.map { StatDeltaUi("plus", it, null, null, unlock = true) }

/**
 * The SOL step on the designed UPGRADE sheet (upgrade.png with a SOL chip beside the Shards chip), or null when [f] is
 * not one. Pure and catalogue-only: the Shards amount is `UPGRADE_COSTS` as the old sheet printed it, the SOL amount
 * `display.upgradeSolLamports` via `basePurchaseSol`. No balance is read and no SHORT is claimed (H1: the Shards money
 * mapper never runs for a SOL review); the primary only opens the SOL Seal, which re-quotes and holds the consent.
 */
internal fun livePaidUpgradeUi(f: BuildingFacts): UpgradeSheetUi? {
    if (!f.paidStep || f.type in HERO_BUILDING_TYPES || !f.canShowUpgrade || f.job != null || f.repair != null) return null
    val shards = f.upgradeCost?.let { PriceUi(Currency.SHARDS, it, PriceStatus.OK) } ?: PriceUi(Currency.SHARDS, null, PriceStatus.UNAVAILABLE)
    val sol = f.paidSol?.let { PriceUi(Currency.SOL, it, PriceStatus.OK) } ?: PriceUi(Currency.SOL, null, PriceStatus.UNAVAILABLE)
    // The old sheet enabled the paid step only with a paid offer and both amounts; otherwise it is off with the reason.
    val priced = f.paidOfferReady && sol.status == PriceStatus.OK && shards.status == PriceStatus.OK
    val state = when {
        f.readOnly || f.constructionBlocked || f.busy -> UpgradeState.READ_ONLY
        !priced -> UpgradeState.READ_ONLY
        f.freeBuilders == 0 -> UpgradeState.NO_BUILDER
        else -> UpgradeState.READY
    }
    return UpgradeSheetUi(
        buildingId = f.buildingId,
        name = f.name.uppercase(),
        levelFrom = "LV ${f.level}",
        levelTo = "LV ${f.level + 1}",
        artNow = f.artNow,
        artNext = f.artNext,
        newLook = f.artNext.isNotBlank() && f.artNext != f.artNow,
        rows = upgradeRows(f),
        price = shards,
        time = f.paidTime ?: f.upgradeTime ?: UNKNOWN,
        builders = buildersLine(f.freeBuilders, f.totalBuilders),
        state = state,
        shortfall = null,
        bestDoor = null,
        builderFreeIn = if (state == UpgradeState.NO_BUILDER) f.nextBuilderFreeIn else null,
        reason = when {
            state != UpgradeState.READ_ONLY -> null
            f.readOnly || f.constructionBlocked -> f.blockedReason
            f.busy -> "Working…"
            else -> PRICE_UNAVAILABLE
        },
        solPrice = sol,
    )
}

/** The designed UPGRADE sheet the review (FULL) opens: the Shards review first, else the SOL step; null keeps the old
 *  BuildingSheet (KEEP / item priced, hero buildings, a rearm, a running job). */
internal fun liveUpgradeSheetUi(f: LiveBuildingSheetFacts, sent: Boolean = false): UpgradeSheetUi? =
    liveUpgradeUi(f, sent) ?: livePaidUpgradeUi(f.facts)

/** The UPGRADE sheet's primary: a SOL step opens the Seal ([onPaidUpgrade]) and never sends the Shards order. */
internal fun dispatchUpgradeSheetPrimary(ui: UpgradeSheetUi, onUpgrade: () -> Unit, onPaidUpgrade: () -> Unit) {
    if (ui.solPrice != null) onPaidUpgrade() else onUpgrade()
}

/**
 * The Need-more sheet for a Gems price of [need] ([have] held) for [forLabel], or null when nothing is missing or either
 * side is unknown. Its only door is the Gold Forge's GEMS tab ([LiveDoors.GEMS]): navigation, never a conversion here.
 */
internal fun liveGemsNeedMore(forLabel: String, have: String?, need: String?): NeedMoreUi? {
    val missing = shortfall(have, need) ?: return null
    return NeedMoreUi(
        forLabel = forLabel,
        blocks = listOf(ShortfallUi("gems", "gem", "GEMS", exactAmount(have), exactAmount(need), exactAmount(missing),
            "From the Gold Forge.", emptyList())),
        best = NeedMoreDoorUi("gem", "GO TO GOLD FORGE", null, LiveDoors.GEMS),
        stale = false,
    )
}

/** A `levelStats` row as a "what improves" row; a stat that does not change at the next level is not an improvement. */
internal fun statDelta(s: StatFact): StatDeltaUi? {
    val next = s.next?.takeIf { it != s.now } ?: return null
    val (icon, label) = statLook(s.key)
    return StatDeltaUi(icon, label, s.now, next)
}

/** The GET SHARDS sub-line: the Mines' buffer when known, else where Shards come from. */
private fun upgradeDoor(mine: MineFact): DoorUi = when {
    mine.mineBuildingId == null -> DoorUi("Build a Mine", LiveDoors.BUILD)
    mine.accrued != null -> DoorUi("Mines hold ${mine.accrued}", LiveDoors.MINES)
    else -> DoorUi("Collect at your Mines", LiveDoors.MINES)
}

/**
 * The Need-more sheet for a SHARDS price of [costRaw] ([cost] as printed) for [forLabel] ("Workshop LV 3"), or null when
 * nothing is missing (unknown balance included: an unknown balance never claims a shortfall). Every door only navigates.
 * Gems -> Shards is a money path and is NOT offered here.
 */
internal fun liveShardsNeedMore(forLabel: String, balance: String?, cost: String, costRaw: String?, mine: MineFact): NeedMoreUi? {
    val missing = shortfall(balance, costRaw) ?: return null
    val best = if (mine.mineBuildingId != null) NeedMoreDoorUi("shards", "GO TO MINES", mine.accrued?.let { "$it Shards ready to collect" }, LiveDoors.MINES)
        else NeedMoreDoorUi("shards", "BUILD A MINE", "Mines dig Shards over time", LiveDoors.BUILD)
    return NeedMoreUi(
        forLabel = forLabel,
        blocks = listOf(ShortfallUi("shards", "shards", "SHARDS", balance?.let { exactAmount(it) } ?: UNKNOWN, cost, exactAmount(missing),
            "Dug at your Mines.", emptyList())),
        best = best,
        stale = false,
    )
}

/** The Need-more sheet for this building's upgrade (null when nothing is missing or the sheet is not the live one). */
internal fun liveUpgradeNeedMore(f: BuildingFacts): NeedMoreUi? {
    val cost = f.upgradeCost ?: return null
    if (f.paidStep) return null
    return liveShardsNeedMore("${titleCase(f.name)} LV ${f.level + 1}", f.shardsBalance, cost, f.upgradeCostRaw, f.mine)
}

/** "ARCHER TOWER" -> "Archer Tower" (the Need-more header's right line). */
internal fun titleCase(name: String): String =
    name.lowercase().split(' ').joinToString(" ") { word -> word.replaceFirstChar { it.uppercase() } }

/** Guarded host entry. The existing review/controller still performs every mutation. */
internal fun liveUpgradeUi(f: BuildingFacts, costs: LiveBuildingCosts, sent: Boolean = false): UpgradeSheetUi? {
    if (!f.canShowUpgrade || f.job != null || f.repair != null) return null
    val cost = costs.upgrade(f) ?: return null
    return liveUpgradeUi(f.withCosts(cost), sent)?.copy(price = cost.price)
}

internal fun liveUpgradeNeedMore(f: BuildingFacts, costs: LiveBuildingCosts): NeedMoreUi? {
    val cost = costs.upgrade(f)?.takeIf { it.price.status == PriceStatus.SHORT } ?: return null
    return liveUpgradeNeedMore(f.withCosts(cost))
}

internal fun liveUpgradeUi(f: LiveBuildingSheetFacts, sent: Boolean = false): UpgradeSheetUi? = liveUpgradeUi(f.facts, f.costs, sent)
internal fun liveUpgradeNeedMore(f: LiveBuildingSheetFacts): NeedMoreUi? = liveUpgradeNeedMore(f.facts, f.costs)
