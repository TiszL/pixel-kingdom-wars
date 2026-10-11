package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import java.math.BigDecimal

/*
 * The facts the live BUILDINGS sheets are mapped from (lead assignment 2026-10-03: "make the BUILDINGS cluster sheets live").
 *
 * Every field is read by `LiveBuildingFactsReader.kt` from what the CURRENT composables already receive (BuildingSheet's
 * `KingdomUiState` / `Building` / `busy` / `now`, the `buildingGates` it shares with the command bar, KingdomScreen's
 * BuildMenu and placement inputs). Nothing here is a new repository or network read and nothing re-derives a server rule:
 * a gate is the gate BuildingSheet computes, a price is the catalogue lookup it prints, formatted the way it prints it.
 * Plain values only, so the mappers are pure and JVM-testable without a catalogue.
 *
 * Money paths are deliberately NOT represented beyond a flag: the KEEP / Gems builder finish (no amount here; the existing
 * currency review shows it) and a non-SHARDS build price make the live mappers decline (return null), so those flows stay
 * on their current composables. A SOL-priced upgrade step ([BuildingFacts.paidStep]) is shown by its own paid projection
 * (`livePaidUpgradeUi`, catalogue amounts only) whose primary only opens the SOL Seal; the Shards money mapper never runs
 * for it (H1).
 */

/** One stat row exactly as `levelStats` printed it (`key` is its label: HP, DMG, RNG, SHIELDS, CAP, PWR). */
internal data class StatFact(val key: String, val now: String, val next: String?)

/** The running builder job on this building (BuildingSheet's `job`). No finish AMOUNT: that is the currency review's. */
internal data class JobFact(
    val id: String,
    /** `builderJobs.kind`: build, upgrade, repair, clear_obstacle. */
    val kind: String,
    /** `fmtDur` of the seconds left; null when the server sent no readable deadline. */
    val remaining: String?,
    /** `finishCostKeep == "0"`: the free onboarding finish (FINISH NOW · FREE). */
    val freeFinish: Boolean,
    /** `builderFinishCanReview(job)`: a positive finish price the existing review can show. */
    val canReview: Boolean,
    /** The server's refundable cancel, formatted ("1,250"); null when the server offers none. */
    val cancelRefund: String?,
)

/** A spent trap's rearm price as the sheet prints it ("1,250", "2h"); [costRaw] is the catalogue's plain decimal (the
 *  shortfall only: a short REARM opens Need-more instead of sending an order the server would refuse). */
internal data class RepairFact(val cost: String, val time: String, val costRaw: String? = null)

/** A yes/no capability the catalogue states for this building (`DEFENSES[type].targetsAir` / `targetsGround`); a key the
 *  catalogue does not carry is no row at all, never a guessed NO. */
internal data class CapabilityFact(val key: String, val yes: Boolean)

/** The capability keys the reader passes through. */
internal object CapabilityKeys {
    const val AIR = "targetsAir"
    const val GROUND = "targetsGround"
}

/** Hero buildings: their upgrades and recovery live on the Heroes sheet, never on a building review. */
internal val HERO_BUILDING_TYPES = setOf("heroaltar", "siegestool")

/** Where Shards come from on this base: the first Mine (selecting it is the same as tapping it) and its buffer. */
internal data class MineFact(val mineBuildingId: String?, val accrued: String?)

/** What a building is, for the INFO header's stone tag. */
internal enum class BuildingCategory { DEFENCE, TRAP, WALL, PRODUCER, STORAGE, ARMY, HERO, KEEP, CLAN, FEATURE }

/** One selected building, as BuildingSheet sees it. */
internal data class BuildingFacts(
    val buildingId: String,
    val type: String,
    /** `trayLabel(type)`. */
    val name: String,
    val level: Int,
    val maxLevel: Int,
    /** `sheetBuildingPortrait` at [level] and at level + 1. */
    val artNow: String,
    val artNext: String,
    /** The Codex `who` line (BuildingSheet's DETAILS prose); null when no field report exists. */
    val role: String?,
    val category: BuildingCategory,
    val stats: List<StatFact>,
    /** `gates.canShowUpgrade`. */
    val canShowUpgrade: Boolean,
    /** `gates.enabled` (not busy, no saved construction payment, orders and deed actions allowed). */
    val enabled: Boolean,
    /** `fmtN(gates.upgradeCost)`: the SHARDS amount the current sheet prints; null when the table has none. */
    val upgradeCost: String?,
    /** The same amount as the plain decimal the catalogue holds (for the shortfall only). */
    val upgradeCostRaw: String?,
    /** `gates.price != null`: the current sheet enables its shard UPGRADE only then. */
    val upgradePriced: Boolean,
    /** `fmtDur(gates.price.seconds)`; null when the table has no time (walls). */
    val upgradeTime: String?,
    /** `gates.upgradeSol > 0`: a SOL-priced step (money path; the live UPGRADE sheet declines it). */
    val paidStep: Boolean,
    /** `gates.paidOffer != null`: the current sheet enables the paid step only then. */
    val paidOfferReady: Boolean,
    val job: JobFact?,
    val repair: RepairFact?,
    /** `home.balances.shards` as sent (plain decimal); null while unknown. */
    val shardsBalance: String?,
    /** `base.freeBuilders` / `base.player.builders` (null: not sent). */
    val freeBuilders: Int?,
    val totalBuilders: Int?,
    /** `fmtDur` of the soonest running job (when the next builder frees up); null when no job runs. */
    val nextBuilderFreeIn: String?,
    /** Hero buildings: `heroes[].available` (null: not a hero building, or the server did not say). */
    val heroReady: Boolean?,
    /** The wall-row selection mode (`local.wallRow`). */
    val wallRow: Boolean,
    /** The command bar's reason for a disabled spend command (BuildingCommandAdapter `blockedReason`). */
    val blockedReason: String,
    /** `!ordersAllowed || !deedActionsAllowed`. */
    val readOnly: Boolean,
    /** A saved construction intent blocks new construction (`constructionBlocked`). */
    val constructionBlocked: Boolean,
    val busy: Boolean,
    val mine: MineFact,
    /** Catalogue capabilities (INFO yes/no rows). */
    val capabilities: List<CapabilityFact> = emptyList(),
    /** What the catalogue says opens at the next level (`unlocksAtKeepLevel` + `unlockLabel`; the Keep only). */
    val unlocks: List<String> = emptyList(),
    /** A SOL step's SOL amount, `basePurchaseSol(display.upgradeSolLamports)`; null when not a SOL step or unknown. */
    val paidSol: String? = null,
    /** A SOL step's build time from the paid offer (`fmtDur(paidOffer.seconds)`); null when unknown. */
    val paidTime: String? = null,
)

/** The registry rows the Need-more doors carry (UX-ARCHITECTURE §6.2); the hosts route them to existing callbacks. */
internal object LiveDoors {
    /** "GO TO MINES": selects the first Mine (the same as tapping it). */
    val MINES = FeatureId("mine.collect")
    /** "BUILD A MINE": opens the BUILD tray. */
    val BUILD = FeatureId("hud.build")
    /** "GO TO GOLD FORGE" (Gems tab): navigation only; Need-more never converts or buys anything itself. */
    val GEMS = FeatureId("goldforge.gems")
}

/** The amount still missing when [balance] is below [cost] (plain decimals), as a plain decimal; null when either is
 *  unknown or nothing is missing. Presentation only: the server re-prices and re-checks every order. */
internal fun shortfall(balance: String?, cost: String?): String? {
    val have = balance?.trim()?.toBigDecimalOrNull() ?: return null
    val need = cost?.trim()?.toBigDecimalOrNull() ?: return null
    if (have.signum() < 0 || need.signum() <= 0) return null
    val missing = need - have
    return if (missing.signum() > 0) missing.stripTrailingZeros().toPlainString() else null
}

/** The kit currency of a catalogue currency code ("SHARDS", "KEEP", …); null for one the kit does not draw. */
internal fun currencyOf(code: String?): Currency? = when (code?.uppercase()) {
    "SHARDS" -> Currency.SHARDS
    "KEEP" -> Currency.KEEP
    "GEMS" -> Currency.GEMS
    "SOL" -> Currency.SOL
    "SKR" -> Currency.SKR
    else -> null
}

/** The builders chip ("1/2 free"); an unknown side reads "…", never 0. */
internal fun buildersLine(free: Int?, total: Int?): String = "${free?.toString() ?: UNKNOWN}/${total?.toString() ?: UNKNOWN} free"

/** The category of a building type. [trap] / [defence] come from the catalogue (`isTrapType`, `defenceBuildingChoices`). */
internal fun buildingCategory(type: String, trap: Boolean, defence: Boolean): BuildingCategory = when {
    type == "wall" -> BuildingCategory.WALL
    trap -> BuildingCategory.TRAP
    defence -> BuildingCategory.DEFENCE
    type == "mine" || type == "goldforge" -> BuildingCategory.PRODUCER
    type == "vault" -> BuildingCategory.STORAGE
    type == "barracks" || type == "forge" || type == "camp" -> BuildingCategory.ARMY
    type == "heroaltar" || type == "siegestool" -> BuildingCategory.HERO
    type == "keep" -> BuildingCategory.KEEP
    type == "clanhall" -> BuildingCategory.CLAN
    else -> BuildingCategory.FEATURE
}

/** `builderJobs.kind` as the noun the current sheet uses ("UPGRADE", "BUILD", …), lower-cased for sentences. */
internal fun jobNounOf(kind: String): String = when (kind) {
    "build" -> "build"; "upgrade" -> "upgrade"; "clear_obstacle" -> "clearing"; "repair" -> "rearm"; else -> "job"
}

private fun String.toBigDecimalOrNull(): BigDecimal? = runCatching { BigDecimal(this) }.getOrNull()

/** Facts and the single live owner observation captured by this composition travel together. */
internal data class LiveBuildingSheetFacts(val facts: BuildingFacts, val costs: LiveBuildingCosts)
internal data class LiveBuildTrayFacts(val facts: TrayFacts, val costs: LiveBuildingCosts)
internal data class LivePlacementSheetFacts(val facts: PlacementFacts, val costs: LiveBuildingCosts)
