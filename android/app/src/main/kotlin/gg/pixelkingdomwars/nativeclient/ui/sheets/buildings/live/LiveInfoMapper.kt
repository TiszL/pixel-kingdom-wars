package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.NeedMoreUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PAID_STEP_SUB
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.BuildingInfoUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.InfoExtraUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.InfoLoad
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.InfoPrimaryKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.InfoPrimaryUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.InfoStatUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.InfoTagUi

/*
 * BuildingFacts -> BuildingInfoUi (the INFO half sheet, design/final/buildings/SPEC.md §2A). Pure.
 *
 * The INFO primary acts in place or navigates, by [liveInfoUpgradeRoute]: UPGRADE TO LV n opens the UPGRADE sheet (the
 * Shards review); a SOL step opens the SOL Seal (`onPaidUpgrade`); a hero building opens the Heroes sheet; a spent trap's
 * REARM TRAP rearms in place (`model.repairTrap`, Shards, the bar's own REARM), or opens Need-more when short. FINISH calls
 * the same `finishBuilderJob` the bar and the old footer call, whose paid branch is the existing currency review. No
 * KEEP / Gems / SOL amount is put on this sheet (money paths keep their own review), so FINISH carries no price pill and a
 * SOL step shows no price chip.
 */

/** The INFO sheet's fifth action (design correction 7) and where the host routes it. */
internal enum class InfoExtraKind { CANCEL_JOB, TOGGLE_ROW, EXPAND }

/** Where INFO's green primary goes (SPEC §2A + the slice brief). */
internal enum class InfoUpgradeRoute {
    /** The UPGRADE half sheet (the Shards review). */
    REVIEW,
    /** The SOL Seal for a SOL-priced step. */
    PAID,
    /** The Heroes sheet: hero upgrades and recovery live there. */
    HEROES,
    /** Rearm a spent trap in place (Shards). */
    REARM,
    /** A spent trap the known balance cannot rearm: Need-more, never a refused order. */
    REARM_SHORT,
}

/** The route of INFO's primary for [f]. A running job's primary is FINISH and never reaches this. */
internal fun liveInfoUpgradeRoute(f: BuildingFacts): InfoUpgradeRoute {
    val repair = f.repair
    return when {
        repair != null -> if (shortfall(f.shardsBalance, repair.costRaw) != null) InfoUpgradeRoute.REARM_SHORT else InfoUpgradeRoute.REARM
        f.type in HERO_BUILDING_TYPES -> InfoUpgradeRoute.HEROES
        f.paidStep -> InfoUpgradeRoute.PAID
        else -> InfoUpgradeRoute.REVIEW
    }
}

/** The Need-more sheet for a short REARM (null when nothing is missing or the balance is unknown). */
internal fun liveRearmNeedMore(f: BuildingFacts): NeedMoreUi? {
    val repair = f.repair ?: return null
    return liveShardsNeedMore("${titleCase(f.name)} rearm", f.shardsBalance, repair.cost, repair.costRaw, f.mine)
}

private const val NO_FIELD_REPORT = "Field reports on this structure are still being written."

internal fun liveBuildingInfoUi(f: BuildingFacts): BuildingInfoUi {
    val upgradeOpen = f.canShowUpgrade && f.job == null && f.repair == null
    // A SOL step's price is a money path: no chip here; its amounts are on the UPGRADE sheet and the Seal. A hero
    // building's upgrades are the Heroes sheet's (item / KEEP priced), so it carries no Shards chip either.
    val price = if (upgradeOpen && !f.paidStep && f.type !in HERO_BUILDING_TYPES) upgradePrice(f) else null
    val short = price?.takeIf { it.status == PriceStatus.SHORT }?.let { shortfall(f.shardsBalance, f.upgradeCostRaw) }
    return BuildingInfoUi(
        buildingId = f.buildingId,
        name = f.name.uppercase(),
        levelTag = "LV ${f.level}",
        role = f.role?.takeIf { it.isNotBlank() } ?: NO_FIELD_REPORT,
        category = InfoTagUi(categoryText(f.category), Verb.STONE),
        stateTag = stateTag(f),
        headerFrames = listOf(f.artNow).filter { it.isNotBlank() },
        stats = f.stats.map(::infoStat) + f.capabilities.mapNotNull(::capabilityStat),
        nextLegend = if (f.level < f.maxLevel && f.stats.any { it.next != null && it.next != it.now }) "at LV ${f.level + 1}" else null,
        upgrading = f.job != null,
        price = price,
        time = if (price != null) f.upgradeTime ?: UNKNOWN else null,
        builders = if (price != null) buildersLine(f.freeBuilders, f.totalBuilders) else null,
        shortfall = short?.let { exactAmount(it) },
        primary = infoPrimary(f, upgradeOpen),
        extra = liveInfoExtraKind(f)?.let { infoExtra(f, it) },
        load = InfoLoad.READY,
    )
}

/** The upgrade price chip: the SHARDS amount exactly as the current sheet prints it; SHORT only when the balance is known
 *  and below it; UNAVAILABLE when the current sheet would keep its UPGRADE disabled for want of a price. */
internal fun upgradePrice(f: BuildingFacts): PriceUi = when {
    f.upgradeCost == null -> PriceUi(Currency.SHARDS, null, PriceStatus.CHECKING)
    !f.upgradePriced -> PriceUi(Currency.SHARDS, null, PriceStatus.UNAVAILABLE)
    shortfall(f.shardsBalance, f.upgradeCostRaw) != null -> PriceUi(Currency.SHARDS, f.upgradeCost, PriceStatus.SHORT)
    else -> PriceUi(Currency.SHARDS, f.upgradeCost, PriceStatus.OK)
}

/** Which fifth action the INFO sheet offers: the server's refundable CANCEL first, then the wall ROW toggle. Each only
 *  while the current sheet enables it (its CANCEL is off unless `gates.enabled`, its ROW toggle off while busy): the
 *  stone row has no disabled face, so an off action is not offered. */
internal fun liveInfoExtraKind(f: BuildingFacts): InfoExtraKind? = when {
    f.job?.cancelRefund != null && f.enabled -> InfoExtraKind.CANCEL_JOB
    f.type == "wall" && !f.busy -> InfoExtraKind.TOGGLE_ROW
    // The Keep's EXPAND does not fit its 4-command bar (correction 7); the Expand sheet itself says max / locked / price.
    f.type == "keep" && !f.busy -> InfoExtraKind.EXPAND
    else -> null
}

private fun infoExtra(f: BuildingFacts, kind: InfoExtraKind): InfoExtraUi = when (kind) {
    InfoExtraKind.CANCEL_JOB -> {
        val noun = jobNounOf(f.job?.kind.orEmpty())
        val refund = f.job?.cancelRefund ?: UNKNOWN
        InfoExtraUi("shape:close", "Cancel $noun · +$refund Shards", "Cancel the $noun and get $refund Shards back")
    }
    InfoExtraKind.TOGGLE_ROW -> if (f.wallRow) InfoExtraUi("shape:minus", "Select single wall")
        else InfoExtraUi("shape:plus", "Select whole row")
    InfoExtraKind.EXPAND -> InfoExtraUi("layout", "Expand land", "Expand land: see the next ring and its price")
}

/** A catalogue capability as a yes/no STATS row (info.png "Hits flying troops YES"). An unknown key draws nothing. */
internal fun capabilityStat(c: CapabilityFact): InfoStatUi? = when (c.key) {
    CapabilityKeys.AIR -> InfoStatUi("ui_portrait_dragon_t2", "Hits flying troops", null, yesNo = c.yes)
    CapabilityKeys.GROUND -> InfoStatUi("ui_portrait_highlander_t2", "Hits ground troops", null, yesNo = c.yes)
    else -> null
}

private fun infoPrimary(f: BuildingFacts, upgradeOpen: Boolean): InfoPrimaryUi {
    val job = f.job
    val repair = f.repair
    return when {
        job != null -> {
            val canFinish = job.freeFinish || job.canReview
            val on = f.enabled && canFinish
            InfoPrimaryUi(InfoPrimaryKind.FINISH,
                if (job.freeFinish) "FINISH NOW · FREE" else "REVIEW FINISH",
                if (job.freeFinish) "Complete this ${jobNounOf(job.kind)}" else "Review current currency and maximum charge",
                if (on) CommandState.ENABLED else CommandState.DISABLED,
                if (on) null else if (!canFinish) "Finish price unavailable" else f.blockedReason)
        }
        repair != null -> InfoPrimaryUi(InfoPrimaryKind.UPGRADE, "REARM TRAP", "${repair.cost} Shards · ${repair.time}",
            if (f.enabled) CommandState.ENABLED else CommandState.DISABLED, if (f.enabled) null else f.blockedReason)
        // A hero building's upgrades and recovery are the Heroes sheet's; this only navigates there (the old sheet's words).
        f.type in HERO_BUILDING_TYPES -> InfoPrimaryUi(InfoPrimaryKind.UPGRADE,
            if (f.heroReady == false) "HERO RECOVERY" else "MANAGE HERO", "Review upgrades and recovery")
        f.level >= f.maxLevel -> InfoPrimaryUi(InfoPrimaryKind.MAX, "MAX LEVEL", null)
        upgradeOpen -> {
            val priced = if (f.paidStep) f.paidOfferReady else f.upgradePriced
            val on = f.enabled && priced
            InfoPrimaryUi(InfoPrimaryKind.UPGRADE, "UPGRADE TO LV ${f.level + 1}",
                if (f.paidStep) PAID_STEP_SUB else "Uses 1 builder for ${f.upgradeTime ?: UNKNOWN}",
                if (on) CommandState.ENABLED else CommandState.DISABLED,
                if (on) null else if (!f.enabled) f.blockedReason else "Price unavailable right now")
        }
        f.type == "wall" && f.wallRow -> InfoPrimaryUi(InfoPrimaryKind.UPGRADE, "UPGRADE TO LV ${f.level + 1}", null,
            CommandState.DISABLED, "Use UPGRADE ROW on the bar")
        else -> InfoPrimaryUi(InfoPrimaryKind.UPGRADE, "UPGRADE TO LV ${f.level + 1}", null, CommandState.DISABLED, "Not available now")
    }
}

private fun stateTag(f: BuildingFacts): InfoTagUi {
    val job = f.job
    return when {
        job != null -> InfoTagUi("${if (job.kind == "build") "BUILDING" else "UPGRADING"} ${job.remaining ?: UNKNOWN}", Verb.GOLD)
        f.repair != null -> InfoTagUi("SPENT", Verb.RED)
        f.heroReady == false -> InfoTagUi("RECOVERING", Verb.GOLD)
        f.category == BuildingCategory.DEFENCE || f.category == BuildingCategory.TRAP || f.category == BuildingCategory.WALL ->
            InfoTagUi("GUARDING", Verb.MOSS)
        else -> InfoTagUi("READY", Verb.GREEN)
    }
}

private fun categoryText(category: BuildingCategory): String = when (category) {
    BuildingCategory.DEFENCE -> "DEFENCE"; BuildingCategory.TRAP -> "TRAP"; BuildingCategory.WALL -> "WALL"
    BuildingCategory.PRODUCER -> "PRODUCER"; BuildingCategory.STORAGE -> "STORAGE"; BuildingCategory.ARMY -> "ARMY"
    BuildingCategory.HERO -> "HERO"; BuildingCategory.KEEP -> "KEEP"; BuildingCategory.CLAN -> "CLAN"
    BuildingCategory.FEATURE -> "FEATURE"
}

/** A `levelStats` row as an INFO stat: the value verbatim; the next value only when it differs (else a single value). */
internal fun infoStat(s: StatFact): InfoStatUi {
    val (icon, label) = statLook(s.key)
    // `rangeTiles` is in tiles (info.png "7 tiles"); the number itself stays the table's.
    fun shown(v: String) = if (s.key == "RNG") "$v tiles" else v
    return InfoStatUi(icon, label, shown(s.now), s.next?.takeIf { it != s.now }?.let(::shown))
}

/** The icon and words of a `levelStats` label; an unknown label keeps its own words. */
internal fun statLook(key: String): Pair<String, String> = when (key) {
    "HP" -> "shield" to "Hitpoints"
    "DMG" -> "attack" to "Damage per second"
    "RNG" -> "scout" to "Range"
    "SHIELDS" -> "shield" to "Loot protection"
    "CAP" -> "army" to "Capacity"
    "PWR" -> "shards" to "Mining power"
    else -> "shape:info" to key
}

/** Guarded host entry. Keep original job/recovery and special-review routes intact. */
internal fun liveBuildingInfoUi(f: BuildingFacts, costs: LiveBuildingCosts): BuildingInfoUi {
    if (!f.canShowUpgrade || f.job != null || f.repair != null) return liveBuildingInfoUi(f)
    val cost = costs.upgrade(f)
        ?: return liveBuildingInfoUi(f).copy(price = null, time = null, builders = null, shortfall = null)
    return liveBuildingInfoUi(f.withCosts(cost)).copy(price = cost.price)
}

internal fun liveBuildingInfoUi(f: LiveBuildingSheetFacts): BuildingInfoUi = liveBuildingInfoUi(f.facts, f.costs)
