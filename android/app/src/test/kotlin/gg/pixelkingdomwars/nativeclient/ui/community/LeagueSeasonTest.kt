package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.data.CommunityState
import gg.pixelkingdomwars.nativeclient.model.LeagueOverview
import gg.pixelkingdomwars.nativeclient.model.LeaguePresentationMode
import gg.pixelkingdomwars.nativeclient.model.LeagueRank
import gg.pixelkingdomwars.nativeclient.model.LeagueRewards
import gg.pixelkingdomwars.nativeclient.model.LeagueStanding
import gg.pixelkingdomwars.nativeclient.model.LeagueWeek
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.HubLeagueScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * The PRIZE tab shows players a prize and a place before the week closes. Every amount and place must be the server's,
 * an unset pot must never become a number, and a malformed answer must fail closed instead of drawing a guess.
 */
class LeagueSeasonTest {
    private val base = "00000000-0000-4000-8000-000000000001"
    private val other = "00000000-0000-4000-8000-000000000002"
    private val closes = "2026-10-12T00:00:00.000Z"
    private val session = AccountSession("wallet", "https://localhost:18443", testToken())
    private val owner = HubLeagueScope(session, base, 4)

    private fun places(amounts: Boolean): String {
        val band1 = listOf(600, 450, 360, 300, 270, 240, 220, 200, 190, 170).mapIndexed { i, bps ->
            val amount = if (amounts) "\"${bps.toLong() * 1_000_000L}\"" else "null"
            """{"band":1,"fromPlace":${i + 1},"toPlace":${i + 1},"shareBps":$bps,"amountRawEach":$amount}"""
        }
        val band2 = """{"band":2,"fromPlace":11,"toPlace":100,"shareBps":3500,"amountRawEach":${if (amounts) "\"38888888\"" else "null"}}"""
        val band3 = """{"band":3,"fromPlace":101,"toPlace":500,"shareBps":3500,"amountRawEach":${if (amounts) "\"8750000\"" else "null"}}"""
        return (band1 + band2 + band3).joinToString(",", "[", "]")
    }

    private fun season(test: Boolean = false, youPlace: Int? = 2, youReason: String = "placed", eligible: Int = 2,
        youBase: String = base, youAmount: String? = if (test) "450000000" else null, leaderAmount: String? = if (test) "600000000" else null): JsonObject {
        val amount = { v: String? -> if (v == null) "null" else "\"$v\"" }
        val pot = if (test) """"status":"devnet_test","potRaw":"10000000000","decimals":6""" else """"status":"unset","potRaw":null,"decimals":null"""
        val second = if (eligible >= 2) """,{"place":2,"baseId":"$base","name":"Rowan","weeklyScore":5,"trophies":60,"tier":"gold","amountRaw":${amount(youAmount)},"you":true}""" else ""
        val text = """{"serverTime":"2026-10-07T17:00:00.000Z","refreshAfterSec":60,
            "season":{"week":"2026-10-05","startsAt":"2026-10-05T00:00:00.000Z","closesAt":"$closes","settlesAt":"2026-10-12T00:15:00.000Z"},
            "tierRewards":{"keepLevel":12,"tiers":[
              {"tier":"bronze","fromTrophies":0,"cacheShards":"9000","items":[{"itemId":"keg_of_haste","qty":1}]},
              {"tier":"silver","fromTrophies":10,"cacheShards":"18000","items":[{"itemId":"keg_of_haste","qty":2}]},
              {"tier":"gold","fromTrophies":50,"cacheShards":"36000","items":[{"itemId":"finishers_seal","qty":1}]},
              {"tier":"sol","fromTrophies":150,"cacheShards":"54000","items":[{"itemId":"finishers_seal","qty":1},{"itemId":"keg_of_haste","qty":2}]}]},
            "prize":{"currency":"SKR",$pot,"ranking":"weekly_net","minWeeklyScore":1,"minRatedAttacks":3,"maxPlaces":500,"places":${places(test)}},
            "standings":{"basis":"projection_resolved_raids","eligibleCount":$eligible,"leaders":[
              {"place":1,"baseId":"$other","name":"Valewarden","weeklyScore":42,"trophies":2914,"tier":"sol","amountRaw":${amount(leaderAmount)},"you":false}$second],
              "you":{"baseId":"$youBase","place":${youPlace ?: "null"},"weeklyScore":5,"ratedAttacks":3,"trophies":60,"tier":"gold","amountRaw":${amount(youAmount)},"reason":"$youReason"}}}"""
        return Json.parseToJsonElement(text).jsonObject
    }

    private val now = Instant.parse("2026-10-07T18:00:00Z").toEpochMilli()

    @Test fun `an unset pot shows the not set state and no amount anywhere`() {
        val ui = leaguePrizeUi(decodeLeagueSeason(season()), now, 0L, LoadState.Ready, "Rowan")
        assertNull(ui.pot)
        assertFalse(ui.potTest)
        assertTrue(ui.winners.all { it.prize == null })
        assertTrue(ui.bands.all { it.prizeEach == null })
        assertNull(ui.you?.prize)
        assertEquals("Top 10 share 30% · 11–100 share 35% · 101–500 share 35%", ui.shareLine)
    }

    @Test fun `a devnet test pot is labelled and each place shows the server amount`() {
        val ui = leaguePrizeUi(decodeLeagueSeason(season(test = true)), now, 0L, LoadState.Ready, "Rowan")
        assertEquals("10,000", ui.pot)
        assertTrue(ui.potTest)
        assertEquals("600", ui.winners[0].prize?.amount)
        assertEquals(Currency.SKR, ui.winners[0].prize?.currency)
        assertEquals("38.88", ui.bands[0].prizeEach?.amount)
        assertEquals("8.75", ui.bands[1].prizeEach?.amount)
        assertEquals("450", ui.you?.prize?.amount)
    }

    @Test fun `ten places are listed and the unfilled ones stay as open places`() {
        val ui = leaguePrizeUi(decodeLeagueSeason(season()), now, 0L, LoadState.Ready, null)
        assertEquals((1..10).toList(), ui.winners.map { it.place })
        assertEquals(listOf("Valewarden", "Rowan"), ui.winners.filterNot { it.open }.map { it.name })
        assertTrue(ui.winners.drop(2).all { it.open && it.name == "Open place" })
        assertTrue(ui.winners[1].isYou)
        assertEquals("90 places · 0 filled now", ui.bands[0].sub)
    }

    @Test fun `the pinned row and tag follow the server place and reason`() {
        val placed = leaguePrizeUi(decodeLeagueSeason(season()), now, 0L, LoadState.Ready, "Rowan")
        assertEquals("#2", placed.yourPlace)
        assertEquals(Verb.GREEN, placed.placeTag?.verb)
        assertEquals("Rowan", placed.you?.name)
        val waiting = leaguePrizeUi(decodeLeagueSeason(season(youPlace = null, youReason = "needs_rated_attacks", eligible = 1)), now, 0L,
            LoadState.Ready, null)
        assertEquals("—", waiting.yourPlace)
        assertEquals("NOT YET", waiting.placeTag?.label)
        assertEquals("Your kingdom", waiting.you?.name)
    }

    @Test fun `what a kingdom still needs comes from the reason code`() {
        val you = SeasonYouWire(base, null, 0, 1, 20, "silver", null, "needs_rated_attacks")
        assertEquals("2 more rated attacks to enter.", seasonYouLine(you, 3))
        assertEquals("Earn a trophy to enter the season.", seasonYouLine(you.copy(reason = "needs_trophies"), 3))
        assertEquals("Another kingdom holds this wallet's place.", seasonYouLine(you.copy(reason = "another_kingdom"), 3))
        assertEquals("+5 trophies this week", seasonYouLine(you.copy(place = 4, weeklyScore = 5, reason = "placed"), 3))
    }

    @Test fun `the countdown follows the server clock and never goes negative`() {
        assertEquals("4d 6h", seasonEndsIn(closes, now, 0L))
        // The device runs one hour slow against the server: one hour less is left.
        assertEquals("4d 5h", seasonEndsIn(closes, now, 3_600_000L))
        assertEquals("0s", seasonEndsIn(closes, Instant.parse("2026-10-13T00:00:00Z").toEpochMilli(), 0L))
        assertNull(seasonEndsIn("not a time", now, 0L))
        assertEquals(3_600_000L, seasonClockOffset("2026-10-07T19:00:00Z", now))
    }

    @Test fun `raw SKR is floored to two places and never overstated`() {
        assertEquals("600", formatSkrRaw("600000000", 6))
        assertEquals("38.88", formatSkrRaw("38888888", 6))
        assertEquals("1.5", formatSkrRaw("1500000", 6))
        assertEquals("<0.01", formatSkrRaw("5", 6))
        assertEquals("0", formatSkrRaw("0", 6))
        assertEquals("1,234,567", formatSkrRaw("1234567", 0))
        assertNull(formatSkrRaw(null, 6))
        assertNull(formatSkrRaw("12", null))
        assertNull(formatSkrRaw("-3", 6))
    }

    @Test fun `a malformed season answer fails closed`() {
        // An unset pot that still carries an amount.
        assertThrows(IllegalArgumentException::class.java) { decodeLeagueSeason(season(leaderAmount = "1")) }
        // A placed reason without a place.
        assertThrows(IllegalArgumentException::class.java) { decodeLeagueSeason(season(youPlace = null)) }
        // Places that leave a gap.
        val gap = season(test = true).toString().replace("\"fromPlace\":101", "\"fromPlace\":102")
        assertThrows(IllegalArgumentException::class.java) { decodeLeagueSeason(Json.parseToJsonElement(gap).jsonObject) }
        val unknown = season().toString().replace("\"status\":\"unset\"", "\"status\":\"live\"")
        assertThrows(IllegalArgumentException::class.java) { decodeLeagueSeason(Json.parseToJsonElement(unknown).jsonObject) }
    }

    @Test fun `a server without the season board says so plainly instead of a connection error`() {
        val error = leagueReadError(LeagueReadFailure.NOT_SUPPLIED, keptAsOf = null)
        assertEquals("This server has no season board yet.", error.message)
        assertNull(error.asOf)
        // Not reachable is still its own words, so a real outage is never mistaken for a missing feature.
        assertEquals("Can't reach the league board.", leagueReadError(LeagueReadFailure.FAILED, null).message)
    }

    private fun legacyState(): CommunityState = CommunityState(leagues = LeagueOverview(
        LeagueWeek("2026-10-05T00:00:00Z", "2026-10-12T00:00:00Z", "2026-10-12T00:15:00Z"), LeagueRewards("active", "2026-09-14T00:15:00Z", 3, 1),
        "cumulative", LeagueStanding(base, 60, "gold", 3, true, true, false), listOf(LeagueRank(214, base, "Rowan", 60, "gold", true)), null,
        presentationMode = LeaguePresentationMode.LEGACY), leagueBaseId = base, leagueSelectionGeneration = 4)

    @Test fun `a cumulative league server draws the four league rows from the season answer`() {
        val ui = leaguesHubUi(legacyState(), owner, owner, null, "LEAGUE", now, LoadState.Ready, true, true,
            season = decodeLeagueSeason(season()))
        assertEquals(listOf("sol", "gold", "silver", "bronze"), ui.league.tiers.map { it.id })
        assertEquals(listOf("54,000", "36,000", "18,000", "9,000"), ui.league.tiers.map { it.reward?.amount })
        val gold = ui.league.tiers.single { it.isYou }
        assertEquals("gold", gold.id)
        assertEquals("90 to Sol", gold.progressLabel)
        assertEquals("Sol league at 150", ui.league.nextLine)
        assertTrue(ui.league.rewardsConfigured)
        assertEquals("36,000", ui.league.rewardShards)
        assertEquals(listOf("finishers_seal"), ui.league.rewardItems.map { it.id })
        assertTrue(ui.rewards.configured)
        assertEquals(true, ui.rewards.earning)
        assertEquals("by league · trophies · Keep 12", ui.rewards.everyWeekNote)
        assertEquals("#2", ui.rewards.skrLine?.rank)
    }

    @Test fun `without the season answer a cumulative server keeps its not set state`() {
        val ui = leaguesHubUi(legacyState(), owner, owner, null, "LEAGUE", now, LoadState.Ready, true, true)
        assertTrue(ui.league.tiers.isEmpty())
        assertFalse(ui.league.rewardsConfigured)
        assertNull(ui.rewards.skrLine)
    }

    @Test fun `disabled cumulative rewards show the rows but pay nothing`() {
        val disabled = legacyState().let { it.copy(leagues = it.leagues!!.copy(rewards = it.leagues!!.rewards.copy(status = "disabled"))) }
        val ui = leaguesHubUi(disabled, owner, owner, null, "REWARDS", now, LoadState.Ready, true, true, season = decodeLeagueSeason(season()))
        assertEquals(4, ui.rewards.tiers.size)
        assertFalse(ui.rewards.configured)
        assertNull(ui.league.rewardShards)
        assertNull(ui.rewards.earning)
    }
}
