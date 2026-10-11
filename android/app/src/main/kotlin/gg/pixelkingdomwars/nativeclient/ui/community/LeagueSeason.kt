package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.groupedAmount
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LeaguePrizeUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LeagueRewardRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LeagueTierRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.PrizeBandRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.PrizeWinnerRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.PrizeYouRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusLook
import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode
import java.time.Instant
import java.util.Locale
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/*
 * GET /leagues/season (server routes-leagues.ts, game/leagueSeason.ts): the read-only weekly season projection behind the
 * Leagues PRIZE tab. The server owns every number: the season end, the pot, each place's share and amount, the
 * would-be winners and why the selected kingdom is or is not placed. This file decodes that answer, refuses a malformed
 * one, and turns it into display strings. It never computes a prize, a place or an eligibility rule.
 */

@Serializable internal data class SeasonWindowWire(val week: String, val startsAt: String, val closesAt: String, val settlesAt: String)
@Serializable internal data class SeasonItemWire(val itemId: String, val qty: Int)
@Serializable internal data class SeasonTierWire(val tier: String, val fromTrophies: Int, val cacheShards: String? = null,
    val items: List<SeasonItemWire> = emptyList())
@Serializable internal data class SeasonTierRewardsWire(val keepLevel: Int? = null, val tiers: List<SeasonTierWire>)
@Serializable internal data class SeasonPlaceWire(val band: Int, val fromPlace: Int, val toPlace: Int, val shareBps: Int,
    val amountRawEach: String? = null)
@Serializable internal data class SeasonPrizeWire(val currency: String, val status: String, val potRaw: String? = null,
    val decimals: Int? = null, val ranking: String, val minWeeklyScore: Int, val minRatedAttacks: Int, val maxPlaces: Int,
    val places: List<SeasonPlaceWire>)
@Serializable internal data class SeasonLeaderWire(val place: Int, val baseId: String, val name: String? = null, val weeklyScore: Int,
    val trophies: Int, val tier: String, val amountRaw: String? = null, val you: Boolean)
@Serializable internal data class SeasonYouWire(val baseId: String, val place: Int? = null, val weeklyScore: Int, val ratedAttacks: Int,
    val trophies: Int, val tier: String, val amountRaw: String? = null, val reason: String)
@Serializable internal data class SeasonStandingsWire(val basis: String, val eligibleCount: Int, val leaders: List<SeasonLeaderWire>,
    val you: SeasonYouWire? = null)
@Serializable internal data class LeagueSeasonView(val serverTime: String, val refreshAfterSec: Int, val season: SeasonWindowWire,
    val tierRewards: SeasonTierRewardsWire, val prize: SeasonPrizeWire, val standings: SeasonStandingsWire)

private val seasonJson = Json { ignoreUnknownKeys = true }
private val RAW_AMOUNT = Regex("0|[1-9][0-9]{0,19}")
private val LEGACY_TIERS = listOf("bronze", "silver", "gold", "sol")
private val YOU_REASONS = setOf("placed", "needs_trophies", "needs_rated_attacks", "needs_weekly_score", "another_kingdom", "beyond_places")

private fun rawOrNull(value: String?) { if (value != null) require(value.matches(RAW_AMOUNT)) }

/** Decodes and checks the season answer; any inconsistency throws, so the card shows its error state, never a guess. */
internal fun decodeLeagueSeason(raw: JsonObject): LeagueSeasonView {
    val view = seasonJson.decodeFromJsonElement(LeagueSeasonView.serializer(), raw)
    Instant.parse(view.serverTime); Instant.parse(view.season.startsAt); Instant.parse(view.season.settlesAt)
    require(Instant.parse(view.season.closesAt).isAfter(Instant.parse(view.season.startsAt)))
    require(view.refreshAfterSec > 0)
    val tiers = view.tierRewards.tiers
    require(tiers.map { it.tier } == LEGACY_TIERS && tiers.zipWithNext().all { (a, b) -> b.fromTrophies > a.fromTrophies })
    tiers.forEach { tier -> rawOrNull(tier.cacheShards); require(tier.items.all { it.itemId.isNotBlank() && it.qty > 0 }) }
    val prize = view.prize
    require(prize.currency == "SKR" && prize.ranking == "weekly_net" && prize.maxPlaces > 0)
    when (prize.status) {
        "unset" -> require(prize.potRaw == null && prize.places.all { it.amountRawEach == null } &&
            view.standings.leaders.all { it.amountRaw == null } && view.standings.you?.amountRaw == null)
        "devnet_test" -> { requireNotNull(prize.potRaw); rawOrNull(prize.potRaw); require(prize.decimals in 0..19) }
        else -> throw IllegalArgumentException("unknown prize status")
    }
    require(prize.places.isNotEmpty() && prize.places.first().fromPlace == 1 && prize.places.last().toPlace == prize.maxPlaces)
    require(prize.places.zipWithNext().all { (a, b) -> b.fromPlace == a.toPlace + 1 } && prize.places.all { it.toPlace >= it.fromPlace && it.band in 1..3 })
    prize.places.forEach { rawOrNull(it.amountRawEach) }
    view.standings.leaders.forEachIndexed { index, row -> require(row.place == index + 1); rawOrNull(row.amountRaw) }
    require(view.standings.eligibleCount >= view.standings.leaders.size)
    view.standings.you?.let { you -> require(you.reason in YOU_REASONS && (you.place == null) == (you.reason != "placed")); rawOrNull(you.amountRaw) }
    return view
}

/** A raw SKR amount as whole SKR at the server's [decimals], floored to two places (never overstated), grouped. */
internal fun formatSkrRaw(raw: String?, decimals: Int?): String? {
    if (raw == null || decimals == null || !raw.matches(RAW_AMOUNT) || decimals !in 0..19) return null
    val exact = BigDecimal(BigInteger(raw), decimals)
    val shown = exact.setScale(2, RoundingMode.DOWN)
    if (shown.signum() == 0 && exact.signum() > 0) return "<0.01"
    val whole = shown.toBigInteger()
    val cents = shown.subtract(BigDecimal(whole)).movePointRight(2).toInt()
    val fraction = when {
        cents == 0 -> ""
        cents % 10 == 0 -> ".${cents / 10}"
        else -> ".%02d".format(Locale.US, cents)
    }
    return "%,d".format(Locale.US, whole) + fraction
}

/** The time left until [closesAt] on the server's clock ([offsetMs] = server minus device), or null when unknown. */
internal fun seasonEndsIn(closesAt: String?, nowMillis: Long, offsetMs: Long): String? = closesAt?.let {
    runCatching {
        val left = Instant.parse(it).toEpochMilli() - (nowMillis + offsetMs)
        fmtDur(maxOf(0L, (left + 999L) / 1_000L))
    }.getOrNull()
}

/** Server minus device clock at the read, so the countdown follows the server's season end. */
internal fun seasonClockOffset(serverTime: String, deviceMillisAtRead: Long): Long =
    runCatching { Instant.parse(serverTime).toEpochMilli() - deviceMillisAtRead }.getOrDefault(0L)

private fun skrPrice(raw: String?, decimals: Int?): PriceUi? = formatSkrRaw(raw, decimals)?.let { PriceUi(Currency.SKR, it, PriceStatus.OK) }
private fun tierTitle(tier: String) = tier.replaceFirstChar { it.titlecase(Locale.ROOT) }
private fun crest(tier: String) = if (tier in LEGACY_TIERS) "league-$tier" else "trophy"
private fun percent(bps: Int): String = if (bps % 100 == 0) "${bps / 100}%" else "${bps / 100}.${(bps % 100).toString().padStart(2, '0').trimEnd('0')}%"
private fun signed(score: Int): String = if (score > 0) "+$score" else score.toString()

/** What the selected kingdom still needs, in plain words (the server's reason code, never recomputed here). */
internal fun seasonYouLine(you: SeasonYouWire, minRatedAttacks: Int): String = when (you.reason) {
    "placed" -> "${signed(you.weeklyScore)} trophies this week"
    "needs_trophies" -> "Earn a trophy to enter the season."
    "needs_rated_attacks" -> "${maxOf(1, minRatedAttacks - you.ratedAttacks)} more rated attacks to enter."
    "needs_weekly_score" -> "${signed(you.weeklyScore)} this week. Gain trophies to place."
    "another_kingdom" -> "Another kingdom holds this wallet's place."
    else -> "${signed(you.weeklyScore)} this week. Outside the paid places."
}

/**
 * The PRIZE tab: the countdown, the pot and its split, places 1..10 as "who would win now" (open places stay listed),
 * the shared bands, and the selected kingdom's own row. [youName] is the player's name from the league board.
 */
internal fun leaguePrizeUi(view: LeagueSeasonView?, nowMillis: Long, offsetMs: Long, load: LoadState, youName: String?): LeaguePrizeUi {
    if (view == null) return LeaguePrizeUi(null, "Week close unavailable", null, null, null, false, null, emptyList(), emptyList(), null, null,
        PRIZE_FOOTNOTE, load)
    val prize = view.prize
    val decimals = prize.decimals
    val standings = view.standings
    val band1 = prize.places.filter { it.band == 1 }
    val winners = band1.map { place ->
        val row = standings.leaders.firstOrNull { it.place == place.fromPlace }
        if (row == null) PrizeWinnerRowUi("open:${place.fromPlace}", place.fromPlace, null, "Open place", "No kingdom qualifies yet",
            skrPrice(place.amountRawEach, decimals), isYou = false, open = true)
        else PrizeWinnerRowUi(row.baseId, row.place, crest(row.tier), row.name ?: "Unnamed kingdom",
            "${signed(row.weeklyScore)} this week · ${groupedAmount(row.trophies.toString()) ?: "…"} trophies",
            skrPrice(row.amountRaw, decimals), isYou = row.you, open = false)
    }
    val bands = prize.places.filter { it.band != 1 }.map { band ->
        val size = band.toPlace - band.fromPlace + 1
        val filled = (standings.eligibleCount - (band.fromPlace - 1)).coerceIn(0, size)
        PrizeBandRowUi("band:${band.band}", "Places ${band.fromPlace}–${band.toPlace}",
            "${groupedAmount(size.toString())} places · ${groupedAmount(filled.toString())} filled now", skrPrice(band.amountRawEach, decimals))
    }
    val shareLine = buildList {
        if (band1.isNotEmpty()) add("Top ${band1.size} share ${percent(band1.sumOf { it.shareBps })}")
        prize.places.filter { it.band != 1 }.forEach { add("${it.fromPlace}–${it.toPlace} share ${percent(it.shareBps)}") }
    }.joinToString(" · ").ifBlank { null }
    val you = standings.you?.let {
        PrizeYouRowUi(it.place?.let { place -> "#${groupedAmount(place.toString())}" } ?: "—", crest(it.tier), youName ?: "Your kingdom",
            seasonYouLine(it, prize.minRatedAttacks), skrPrice(it.amountRaw, decimals))
    }
    val placeTag = standings.you?.let { if (it.place != null) StatusLook("PLACED", Verb.GREEN, false) else StatusLook("NOT YET", Verb.STONE, false) }
    return LeaguePrizeUi(
        endsIn = seasonEndsIn(view.season.closesAt, nowMillis, offsetMs),
        closesLine = leagueHubCloseLine(view.season.closesAt),
        yourPlace = you?.placeText,
        placeTag = placeTag,
        pot = if (prize.status == "devnet_test") formatSkrRaw(prize.potRaw, decimals) else null,
        potTest = prize.status == "devnet_test",
        shareLine = shareLine,
        winners = winners,
        bands = bands,
        you = you,
        note = "${groupedAmount(standings.eligibleCount.toString())} placed now",
        footnote = PRIZE_FOOTNOTE,
        load = load,
    )
}

internal const val PRIZE_FOOTNOTE = "Projected from this week's rated raids. Places are set when the week closes. One kingdom per wallet."

/**
 * The four-league table from the season answer (the cumulative leagues this server pays), highest first, for the
 * LEAGUE tab, and the same rows for REWARDS. [youTier] is the standing's tier; [trophies] its total.
 */
internal data class SeasonTierTables(val league: List<LeagueTierRowUi>, val rewards: List<LeagueRewardRowUi>, val nextLine: String?,
    val yourShards: String?, val yourItems: List<ItemTileUi>, val keepLevel: Int?)

internal fun seasonTierTables(view: LeagueSeasonView, youTier: String?, trophies: Int?, itemIcon: (String) -> String,
    itemName: (String) -> String): SeasonTierTables {
    val tiers = view.tierRewards.tiers
    fun items(tier: SeasonTierWire) = tier.items.map { ItemTileUi(it.itemId, itemIcon(it.itemId), it.qty.toString(), "${itemName(it.itemId)}, ${it.qty}") }
    val index = tiers.indexOfFirst { it.tier == youTier }
    val next = tiers.getOrNull(index + 1)?.takeIf { index >= 0 }
    val progress = if (index >= 0 && next != null && trophies != null) {
        val low = tiers[index].fromTrophies
        ((trophies - low).toFloat() / (next.fromTrophies - low).toFloat()).coerceIn(0f, 1f)
    } else if (index >= 0 && next == null) 1f else null
    val progressLabel = if (next != null && trophies != null) "${groupedAmount(maxOf(0, next.fromTrophies - trophies).toString())} to ${tierTitle(next.tier)}" else null
    val league = tiers.mapIndexed { i, tier ->
        val you = i == index
        LeagueTierRowUi(tier.tier, crest(tier.tier), "${tierTitle(tier.tier)} league", "${groupedAmount(tier.fromTrophies.toString())} trophies",
            groupedAmount(tier.cacheShards)?.let { PriceUi(Currency.SHARDS, it, PriceStatus.OK) }, you,
            progress.takeIf { you }, progressLabel.takeIf { you })
    }.reversed()
    val rewards = tiers.mapIndexed { i, tier ->
        LeagueRewardRowUi(crest(tier.tier), tierTitle(tier.tier), groupedAmount(tier.fromTrophies.toString()) ?: "…",
            groupedAmount(tier.cacheShards)?.let { PriceUi(Currency.SHARDS, it, PriceStatus.OK) } ?: PriceUi(Currency.SHARDS, null, PriceStatus.UNAVAILABLE),
            items(tier), i == index)
    }.reversed()
    val mine = tiers.getOrNull(index)
    return SeasonTierTables(league, rewards, next?.let { "${tierTitle(it.tier)} league at ${groupedAmount(it.fromTrophies.toString())}" },
        groupedAmount(mine?.cacheShards), mine?.let(::items).orEmpty(), view.tierRewards.keepLevel)
}
