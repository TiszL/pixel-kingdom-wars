package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.data.CommunityState
import gg.pixelkingdomwars.nativeclient.model.LeagueOverview
import gg.pixelkingdomwars.nativeclient.model.LeaguePackLine
import gg.pixelkingdomwars.nativeclient.model.LeaguePresentationMode
import gg.pixelkingdomwars.nativeclient.model.LeagueRank
import gg.pixelkingdomwars.nativeclient.model.LeagueRewardV2
import gg.pixelkingdomwars.nativeclient.model.LeagueRewards
import gg.pixelkingdomwars.nativeclient.model.LeagueSkrOverview
import gg.pixelkingdomwars.nativeclient.model.LeagueStanding
import gg.pixelkingdomwars.nativeclient.model.LeagueWeek
import gg.pixelkingdomwars.nativeclient.model.LeagueWeeklyRank
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import java.time.Instant
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 2eb3e8f9: pure display regressions. Fixture numbers are synthetic inputs, not game policy.
 * Tests are authored before the ATTACKS delta; execution belongs to Cedar3. */
class LeagueLadderDisplayTest {
    private val baseA = "00000000-0000-4000-8000-000000000011"
    private val baseB = "00000000-0000-4000-8000-000000000022"
    private val baseC = "00000000-0000-4000-8000-000000000033"
    private val opens = "2031-05-12T00:00:00Z"
    private val closes = "2031-05-19T00:00:00Z"
    private val session = AccountSession("wallet", "https://localhost:18443", testToken())
    private val scope = HubLeagueScope(session, baseA, 11)

    private fun overview() = LeagueOverview(
        week = LeagueWeek(opens, closes, closes),
        rewards = LeagueRewards("active", closes, 7, 1),
        trophyModel = "cumulative",
        you = LeagueStanding(baseA, 1234, "silver", 2, false, false, false,
            tierV2 = "silver", rewardV2 = LeagueRewardV2("0", "0", emptyList())),
        board = listOf(LeagueRank(23, baseA, "North", 1234, "silver", true, tierV2 = "silver")),
        lastSettlement = null,
        ladderVersion = 2,
        presentationMode = LeaguePresentationMode.V2,
    )

    private fun state(value: LeagueOverview = overview()) = CommunityState(
        leagues = value, leagueBaseId = baseA, leagueSelectionGeneration = scope.selectionGeneration,
    )

    private val catalogue = buildJsonObject {
        put("constants", buildJsonObject {
            put("PHASE_E_LEAGUE_TIERS", buildJsonObject {
                put("tiers", buildJsonArray {
                    listOf("bronze", "silver", "gold", "platinum", "diamond", "solana", "seeker").forEach { add(it) }
                })
                put("thresholds", buildJsonArray {
                    // Deliberately synthetic: display must use this supplied catalogue, not live tuning.
                    listOf(0, 10, 20, 30, 40, 50, 60).forEach { add(it) }
                })
            })
        })
    }

    /** LD01: the new card says ATTACKS; blank fields would hide known participation progress. */
    @Test fun `LD01 rated attacks populate ATTACKS never WINS`() {
        val ui = liveLeagueUi(state(), scope, scope)
        assertEquals(2, ui.league.wins)
        assertEquals(7, ui.league.winsNeeded)
        assertEquals(2, ui.rewards.raidsDone)
        assertEquals(7, ui.rewards.raidsNeeded)
        assertEquals("Rated attacks 2 / 7", ui.league.winsLine)
        assertFalse(ui.league.winsLine.contains("wins", ignoreCase = true))
    }

    /** LD02: a missing standing/read is unknown, never a successful zero-attack result. */
    @Test fun `LD02 absent attack counts stay unknown`() {
        val noStanding = liveLeagueUi(state(overview().copy(you = null)), scope, scope)
        assertNull(noStanding.league.wins)
        assertEquals(7, noStanding.league.winsNeeded) // The threshold is independently supplied.
        assertEquals("Rated attacks unavailable", noStanding.league.winsLine)
        val noRead = liveLeagueUi(CommunityState(), null, scope)
        assertNull(noRead.league.wins)
        assertNull(noRead.league.winsNeeded)
        assertNull(noRead.league.ladder)
    }

    /** LD03: an explicit server zero must not be erased by a truthiness/positive-only check. */
    @Test fun `LD03 known zero differs from missing counts`() {
        val source = overview()
        val ui = liveLeagueUi(state(source.copy(
            you = source.you!!.copy(currentWeekRatedAttacks = 0),
            rewards = source.rewards.copy(minRatedAttacks = 0),
        )), scope, scope)
        assertEquals(0, ui.league.wins)
        assertEquals(0, ui.league.winsNeeded)
        assertEquals("Rated attacks 0 / 0", ui.league.winsLine)
    }

    /** LD04: pagination/ties may supply non-consecutive ranks; display must not re-rank. */
    @Test fun `LD04 server ranks and row order survive ties`() {
        val rows = listOf(
            LeagueRank(23, baseA, "North", 1200, "silver", true, tierV2 = "silver"),
            LeagueRank(7, baseB, "South", 1200, "gold", false, tierV2 = "gold"),
            LeagueRank(91, baseC, "West", 3000, "gold", false, tierV2 = "seeker"),
        )
        val ui = liveLeagueUi(state(overview().copy(board = rows)), scope, scope).league.ladder!!
        assertEquals(listOf(baseA, baseB, baseC), ui.rows.map { it.id })
        assertEquals(listOf(23, 7, 91), ui.rows.map { it.rank })
        assertEquals(listOf("23", "7", "91"), ui.rows.map { it.rankText })
        assertEquals(listOf("1,200", "1,200", "3,000"), ui.rows.map { it.trophies })
    }

    /** LD05: the selected standing is not enough evidence to invent an off-page player rank. */
    @Test fun `LD05 pinned player comes only from supplied you row`() {
        val row = overview().board.single()
        val supplied = liveLeagueUi(state(overview().copy(board = listOf(row))), scope, scope).league.ladder!!
        assertEquals(supplied.rows.single(), supplied.you)
        val notYou = liveLeagueUi(state(overview().copy(board = listOf(row.copy(you = false)))), scope, scope).league.ladder!!
        assertNull(notYou.you)
        assertNull(liveLeagueUi(state(overview().copy(board = emptyList())), scope, scope).league.ladder!!.you)
    }

    /** LD06: UUIDs are routing identities; missing clan data also cannot mean 'no clan'. */
    @Test fun `LD06 missing player name never exposes base identity`() {
        val data = overview()
        val row = liveLeagueUi(state(data.copy(board = listOf(data.board.single().copy(name = null)))),
            scope, scope).league.ladder!!.rows.single()
        assertEquals(baseA, row.id)
        assertEquals("…", row.name)
        assertFalse(row.name.contains(baseA))
        assertEquals("Clan unavailable", row.clanTag)
    }

    /** LD07: returning to the same base/wallet does not revive a retired read generation. */
    @Test fun `LD07 changed session base or generation masks every old league read`() {
        val replacements = listOf(
            scope.copy(session = AccountSession("wallet", "https://localhost:18443", testToken())),
            scope.copy(baseId = baseB),
            scope.copy(selectionGeneration = scope.selectionGeneration + 1),
        )
        for (current in replacements) {
            val ui = liveLeagueUi(state(), scope, current)
            assertEquals("…", ui.league.trophies)
            assertNull(ui.league.ladder)
            assertNull(ui.league.rewardShards)
            assertNull(ui.league.wins)
            assertNull(ui.league.winsNeeded)
            assertTrue(ui.league.load is LoadState.Error)
        }
        val staleRepository = liveLeagueUi(state().copy(leagueSelectionGeneration = 10), scope, scope)
        assertNull(staleRepository.league.ladder)
        assertNull(staleRepository.league.wins)
        assertNull(liveLeagueUi(state(), null, scope).league.ladder)
    }

    /** LD08: same-scope refresh retains useful rows; initial loading must not manufacture a board. */
    @Test fun `LD08 refresh keeps last good rows while first read stays loading`() {
        val refresh = liveLeagueUi(state(), scope, scope, load = LoadState.Loading)
        assertEquals(LoadState.Loading, refresh.league.load)
        assertEquals(baseA, refresh.league.ladder!!.rows.single().id)
        assertEquals(2, refresh.league.wins)
        val initial = liveLeagueUi(CommunityState(), null, scope, load = LoadState.Loading)
        assertEquals(LoadState.Loading, initial.league.load)
        assertNull(initial.league.ladder)
        assertEquals("…", initial.league.trophies)
    }

    /** LD09: a network error preserves an admitted read, but cannot revive a stale one. */
    @Test fun `LD09 refresh error retains only same scope data`() {
        val error = LoadState.Error("offline", asOf = "08:00")
        val kept = liveLeagueUi(state(), scope, scope, load = error)
        assertEquals(error, kept.league.load)
        assertEquals(baseA, kept.league.ladder!!.you!!.id)
        assertEquals(2, kept.league.wins)
        val retired = liveLeagueUi(state(), scope, scope.copy(baseId = baseB), load = error)
        assertNull(retired.league.ladder)
        assertNull(retired.league.wins)
    }

    /** LD10: malformed V2 evidence cannot become a plausible legacy reward projection. */
    @Test fun `LD10 unknown and legacy modes remain distinct`() {
        val unknown = liveLeagueUi(state(overview().copy(presentationMode = LeaguePresentationMode.UNAVAILABLE)), scope, scope)
        assertNull(unknown.league.ladder)
        assertNull(unknown.league.wins)
        assertNull(unknown.league.rewardShards)
        assertTrue(unknown.league.load is LoadState.Error)
        val legacy = liveLeagueUi(state(overview().copy(presentationMode = LeaguePresentationMode.LEGACY)), scope, scope)
        assertNotNull(legacy.league.ladder)
        assertEquals(2, legacy.league.wins)
        assertNull(legacy.league.rewardShards)
        assertFalse(legacy.rewards.configured)
    }

    /** LD11: catalogue values draw progression; they never override the server's tier identity. */
    @Test fun `LD11 catalogue supplies progress without promoting server tier`() {
        val ui = liveLeagueUi(state(), scope, scope, catalogue)
        assertEquals("SILVER LEAGUE", ui.league.tierName)
        assertEquals("silver", ui.league.tiers.single { it.isYou }.id)
        assertEquals("60 trophies", ui.league.tiers.first().threshold)
        assertEquals(listOf("seeker", "solana", "diamond", "platinum", "gold", "silver", "bronze"),
            ui.league.tiers.map { it.id })
        val missing = liveLeagueUi(state(), scope, scope)
        assertTrue(missing.league.tiers.isEmpty())
        assertNull(missing.league.nextLine)
        assertEquals("SILVER LEAGUE", missing.league.tierName)
    }

    /** LD12: reward amounts are supplied exact integers, including digits beyond floating-point precision. */
    @Test fun `LD12 rewards preserve exact digits zero and absence`() {
        val source = overview()
        val reward = LeagueRewardV2("18446744073709551615", "9007199254740993",
            listOf(LeaguePackLine("sunstone_rubble", "1234567")))
        val exact = liveLeagueUi(state(source.copy(you = source.you!!.copy(rewardV2 = reward))), scope, scope)
        assertEquals("18,446,744,073,709,551,615", exact.league.rewardShards)
        assertEquals("9,007,199,254,740,993", exact.league.rewardItems.single { it.id == "gems" }.count)
        assertEquals("1,234,567", exact.league.rewardItems.single { it.id == "sunstone_rubble" }.count)
        assertEquals("0", liveLeagueUi(state(), scope, scope).league.rewardShards)
        val absent = liveLeagueUi(state(source.copy(you = source.you!!.copy(rewardV2 = null))), scope, scope)
        assertNull(absent.league.rewardShards)
        assertTrue(absent.league.rewardItems.isEmpty())
    }

    /** LD13: deferred SKR claims must not delay or falsely monetize the independent ladder display. */
    @Test fun `LD13 deferred claims retain ladder without a paid state`() {
        val ui = liveLeagueUi(state(overview().copy(skr = LeagueSkrOverview("payout_deferred"))), scope, scope)
        assertEquals(23, ui.league.ladder!!.rows.single().rank)
        assertFalse(ui.rewards.paid)
        assertNull(ui.rewards.skrLine)
        assertTrue(ui.rewards.footnote!!.contains("deferred"))
        assertEquals(CommandState.DISABLED, ui.league.findMatchState)
    }

    /** LD14: server week/clock and cumulative trophies stay distinct from signed weekly scores. */
    @Test fun `LD14 no local season dates or weekly score ranks are invented`() {
        val source = overview()
        val data = source.copy(
            you = source.you!!.copy(weeklyScore = -9),
            weeklyBoard = listOf(LeagueWeeklyRank(baseB, "South", -8, 8888), LeagueWeeklyRank(baseA, "North", 0, 1234)),
        )
        val ui = liveLeagueUi(state(data), scope, scope, selectedTab = "LADDER",
            nowMillis = Instant.parse(closes).minusSeconds(3600).toEpochMilli())
        assertEquals("LADDER", ui.league.selectedTab)
        assertEquals("1h", ui.league.weekEnds)
        assertEquals("1,234", ui.league.trophies)
        assertEquals(listOf(baseA), ui.league.ladder!!.rows.map { it.id })
        assertEquals("1,234", ui.league.ladder!!.rows.single().trophies)
        assertEquals(23, ui.league.ladder!!.rows.single().rank)
        assertTrue(ui.rewards.closesLine.contains(closes))
        assertTrue(ui.league.footnote!!.contains(closes))
    }
}
