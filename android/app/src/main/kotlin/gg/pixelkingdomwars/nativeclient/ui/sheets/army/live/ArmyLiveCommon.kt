package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.Dir8
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.SpriteRef
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.WalkerUi
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * Shared pure pieces of the army cluster's LIVE mappers (MS-C2 interim, Opus lane): the switch, the registry ids the
 * live sheets hand back, honest prices and commands, and the small presentation conversions every mapper needs. No
 * Compose, no repository, no network: everything here is a function of data the current screens already receive.
 */

/** The single switch that routes TRAIN / ARMY / RESEARCH / HERO and the raid chooser to the live sheets
 *  (HOOKUP-army-live.md). False sends every route back to the current screens, unchanged. */
internal object ArmyLive {
    const val ENABLED: Boolean = true
}

/** The registry rows the live sheets hand back (UX-ARCHITECTURE §6.2 ids where one exists). */
internal object ArmyLiveIds {
    val TRAIN = FeatureId("barracks.train")
    val TRAIN_FINISH = FeatureId("barracks.finish")
    val LAST_ARMY = FeatureId("barracks.lastArmy")
    val ARMY = FeatureId("camp.army")
    val ATTACK = FeatureId("hud.attack")
    val RESEARCH = FeatureId("forge.research")
    val RESEARCH_FINISH = FeatureId("forge.finish")
    val HERO_UPGRADE = FeatureId("hero.upgrade")
    val HERO_FINISH_REST = FeatureId("hero.finishRest")
    val HERO_RECRUIT = FeatureId("hero.recruit")
    val FIND_MATCH = FeatureId("raid.match")
    val CAMPAIGN_ATTACK = FeatureId("raid.campaign")
    val WORLD_MAP = FeatureId("hud.map")
    fun hero(hero: String) = FeatureId("hero.$hero")
}

/** "Highlander" from the shared troop names ("HIGHLANDER", "KEG RUNNER" -> "Keg Runner"). */
internal fun liveTroopName(troop: String): String =
    Copy.troopName(troop).lowercase().split(' ').joinToString(" ") { word -> word.replaceFirstChar { it.uppercase() } }

/** A level tag ("L3") from a real server level; "…" when the server has not said. */
internal fun levelTag(level: Int?): String = level?.let { "L$it" } ?: UNKNOWN

/** Grouped decimal text ("1,900") from an exact decimal string; null for anything that is not a plain non-negative
 *  integer, so a malformed amount reads "…", never a number. */
internal fun groupedAmount(value: String?): String? =
    value?.takeIf { it.matches(Regex("0|[1-9][0-9]*")) }?.let { "%,d".format(java.util.Locale.US, it.toBigInteger()) }

/** A Shards price exactly as known: the grouped amount with [status], or "…" (CHECKING) when the amount is unknown.
 *  Never a zero the server did not send. */
internal fun shardsPrice(amount: String?, status: PriceStatus = PriceStatus.OK): PriceUi {
    val shown = groupedAmount(amount) ?: return PriceUi(Currency.SHARDS, null, PriceStatus.CHECKING)
    return PriceUi(Currency.SHARDS, shown, status, description = "$shown Shards")
}

/** The price of a paid FINISH whose currency and amount only the existing server review states: CHECKING ("…"), so
 *  the tap is enabled navigation into that review (M48), never a number this client made up. */
internal fun reviewedFinishPrice(): PriceUi = PriceUi(Currency.GEMS, null, PriceStatus.CHECKING,
    description = "Price shown in the review")

/** The server's own "first finish is free" offer: drawn FREE only because the server said so (SERVER_ZERO). */
internal fun serverFreePrice(): PriceUi = PriceUi(Currency.GEMS, "0", PriceStatus.SERVER_ZERO, description = "Free finish")

/** One command. A DISABLED / LOCKED command always carries its [reason] (a tap shows it; never silent). */
internal fun liveCommand(id: FeatureId, caption: String, state: CommandState, reason: String? = null, price: PriceUi? = null,
    primary: Boolean = true, verb: Verb = Verb.GOLD, sub: String? = null, icon: String = ""): CommandUi =
    CommandUi(id, icon, caption, price, primary, state, if (state == CommandState.DISABLED || state == CommandState.LOCKED) reason ?: UNKNOWN else reason,
        null, verb = verb, sub = sub)

/** Whole seconds from [nowMs] to an ISO instant, rounded up like the server; null when the instant is missing or bad. */
internal fun secondsUntil(iso: String?, nowMs: Long): Long? = iso?.let {
    runCatching { ((Instant.parse(it).toEpochMilli() - nowMs + 999).floorDiv(1000)).coerceAtLeast(0) }.getOrNull()
}

/** The highest completed level of a building type ([Building.underConstruction] rows do not count); null when the
 *  base has none or is not loaded. */
internal fun completedLevel(buildings: List<Building>?, type: String): Int? =
    buildings?.filter { it.type == type && !it.underConstruction }?.maxOfOrNull { it.level }

/** The building art the army headers draw: the building's current-tier world sprite through the shared building art
 *  rule (`designedBuildingArt`, owner 2026-10-06: never the old dark-box `ui_portrait_<type>_t<tier>`), tiered by the
 *  same `ART_V2` rule as the troop portraits; tier 1 when the level or the rule is unknown. */
internal fun buildingPortrait(catalogue: JsonObject?, type: String, level: Int?): String {
    val art = (catalogue?.get("constants") as? JsonObject)?.get("ART_V2") as? JsonObject
    val perTier = (art?.get("levelsPerTier") as? JsonPrimitive)?.content?.toIntOrNull()?.takeIf { it > 0 }
    val tiers = (art?.get("tiers") as? JsonPrimitive)?.content?.toIntOrNull()?.takeIf { it > 0 }
    val tier = if (level == null || perTier == null || tiers == null) 1 else ((level.coerceAtLeast(1) - 1) / perTier + 1).coerceAtMost(tiers)
    return gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.designedBuildingArt(type, level ?: 1, tier) ?: "ui_portrait_${type}_t$tier"
}

/** Troop walkers for a living header (SPEC §8: troops x2, 30 dp apart). */
internal fun troopWalkers(portraits: List<String>, dir: Dir8, yDp: Int, startDp: Int = 20, stepDp: Int = 30): List<WalkerUi> =
    portraits.mapIndexed { i, name -> WalkerUi(SpriteRef(name, 56), dir, startDp + i * stepDp, yDp, 2) }

/** The reason a command is off because orders are blocked, in the existing screens' own words; null when it is not. */
internal fun ordersBlockedReason(ordersAllowed: Boolean, actionsAllowed: Boolean): String? = when {
    !ordersAllowed -> "Install the available native app update before submitting game orders. Your account is preserved."
    // RaidInterlockState.actionsAllowed = the raid lock is known AND no raid on this base is under way.
    !actionsAllowed -> "Orders wait while a raid on your base is checked or under way."
    else -> null
}
