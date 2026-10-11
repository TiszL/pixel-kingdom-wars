package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.data.CommunityState
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubMotion
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.HubLeagueScope
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LeaguesHubPresentationTest {
    private val base = "00000000-0000-4000-8000-000000000001"
    private val start = "2026-10-05T00:00:00Z"
    private val end = "2026-10-12T00:00:00Z"
    private val session = AccountSession("wallet", "https://localhost:18443", testToken())
    private val owner = HubLeagueScope(session, base, 9)
    private val catalogue = buildJsonObject { put("constants", buildJsonObject {
        put("PHASE_E_LEAGUE_TIERS", buildJsonObject {
            put("tiers", buildJsonArray { listOf("bronze", "silver", "gold", "platinum", "diamond", "solana", "seeker").forEach { add(it) } })
            put("thresholds", buildJsonArray { listOf(0, 100, 200, 300, 400, 500, 600).forEach { add(it) } })
        })
        put("LEGACY_ITEMS", buildJsonObject { put("test_reward", buildJsonObject { put("name", "Verified reward") }) })
    }) }
    private fun overview(reward: LeagueRewardV2? = LeagueRewardV2("18446744073709551615", "0", emptyList())) = LeagueOverview(
        LeagueWeek(start, end, end), LeagueRewards("active", end, 5, 1), "cumulative",
        LeagueStanding(base, 40, "bronze", 3, false, false, false, tierV2 = "bronze", rewardV2 = reward),
        listOf(LeagueRank(37, base, "Mira", 40, "bronze", true, tierV2 = "bronze")), null,
        ladderVersion = 2, presentationMode = LeaguePresentationMode.V2)
    private fun state(value: LeagueOverview = overview()) = CommunityState(leagues = value, leagueBaseId = base, leagueSelectionGeneration = 9)
    private fun map(value: CommunityState = state(), captured: HubLeagueScope? = owner, current: HubLeagueScope = owner,
        land: Boolean = true, navigate: Boolean = true, load: LoadState = LoadState.Ready, fallback: String? = null) =
        leaguesHubUi(value, captured, current, catalogue, "REWARDS", 0L, load, land, navigate, fallbackTrophies = fallback)

    @Test fun `unadmitted shared cache is hidden on first load`() {
        val ui = map(captured = null, load = LoadState.Loading)
        assertEquals(LoadState.Loading, ui.league.load)
        assertNull(ui.league.rewardShards)
        assertTrue(ui.league.pastWeeks.isEmpty())
    }
    @Test fun `session replacement with equal text hides rewards`() {
        val next = HubLeagueScope(AccountSession("wallet", "https://localhost:18443", testToken()), base, 9)
        assertFalse(leagueHubScopeCurrent(owner, next))
        assertNull(map(current = next).league.rewardShards)
    }
    @Test fun `round trip kingdom selection generation hides old reward`() {
        assertNull(map(current = owner.copy(selectionGeneration = 11)).league.rewardShards)
    }
    @Test fun `ready reward preserves large amount and known zero gems`() {
        val ui = map()
        assertEquals("18,446,744,073,709,551,615", ui.league.rewardShards)
        assertEquals("0", ui.league.rewardItems.single().count)
        assertEquals(PriceStatus.UNAVAILABLE, ui.rewards.tiers.first { !it.isYou }.shards.status)
        assertNull(ui.rewards.skrLine)
        assertFalse(ui.rewards.paid)
    }
    @Test fun `missing reward never revives a legacy or placeholder amount`() {
        val ui = map(state(overview(null)))
        assertNull(ui.league.rewardShards)
        assertTrue(ui.rewards.tiers.all { it.shards.amount == null })
    }
    @Test fun `disabled rewards stay disabled without changing trophies`() {
        val value = overview().let { it.copy(rewards = it.rewards.copy(status = "disabled")) }
        val ui = map(state(value))
        assertEquals("40", ui.league.trophies)
        assertFalse(ui.rewards.configured)
        assertNull(ui.league.rewardShards)
    }
    @Test fun `match remains a navigation door while loading`() {
        assertEquals(CommandState.ENABLED, map(captured = null, load = LoadState.Loading).league.findMatchState)
        val held = map(navigate = false)
        assertEquals(CommandState.DISABLED, held.league.findMatchState)
        assertNotNull(held.league.findMatchReason)
    }
    @Test fun `land gate appears only for current landless account`() {
        assertEquals("profile.land", map(land = false).rewards.landGate?.feature?.value)
        assertNull(map(land = true).rewards.landGate)
        assertNull(map(captured = null, land = false, load = LoadState.Loading).rewards.landGate)
    }
    @Test fun `close time formats server timestamp in UTC`() {
        assertEquals("Week closes Mon 00:00 UTC", map().rewards.closesLine)
        assertEquals("Week close unavailable", leagueHubCloseLine("bad"))
    }
    @Test fun `refresh error retains same owner data and labels its time`() {
        val error = LoadState.Error("Cannot read", asOf = "14:02")
        val ui = map(load = error)
        assertEquals(error, ui.league.load)
        assertEquals("40", ui.league.trophies)
        assertEquals("Mira", ui.league.ladder?.rows?.single()?.name)
    }
    @Test fun `eligibility includes server minimum and higher kingdom reason`() {
        val value = overview().let { it.copy(you = it.you!!.copy(blockedByHigherBase = true)) }
        val note = map(state(value)).league.rewardNote.orEmpty()
        assertTrue(note.contains("Another kingdom"))
        assertTrue(note.contains("3 / 5"))
    }
    @Test fun `settlement facts preserve all item counts and v2 exact amounts`() {
        val receipt = LeagueSettlement("2026-10-05", "gold", 250, 12, "98765432101234567890",
            listOf(LeagueItem("test_reward", 2)), end, tierV2 = "gold", gems = "0",
            pack = listOf(LeaguePackLine("frost_quartz", "3")))
        val facts = leagueHubSettlementFacts(receipt, catalogue, LeaguePresentationMode.V2)
        assertTrue(facts.any { it.second == "98,765,432,101,234,567,890" })
        assertTrue(facts.any { it.first == "Verified reward" && it.second == "2" })
        assertTrue(facts.any { it.first == "Gems" && it.second == "0" })
        assertTrue(facts.any { it.first == "FROST QUARTZ" && it.second == "3" })
        assertTrue(facts.any { it.first == "Keep level" && it.second == "12" })
        assertTrue(facts.any { it.first == "Trophies" && it.second == "250" })
    }
    @Test fun `unavailable settlement cannot project additive rewards`() {
        val receipt = LeagueSettlement("2026-10-05", "gold", 250, 12, "0", emptyList(), end, gems = "9")
        assertTrue(leagueHubSettlementFacts(receipt, catalogue, LeaguePresentationMode.UNAVAILABLE).isEmpty())
        assertFalse(leagueHubSettlementFacts(receipt, catalogue, LeaguePresentationMode.LEGACY).any { it.first == "Gems" })
    }
    @Test fun `stale or held callback has visible refusal and cannot navigate`() {
        var calls = 0
        val notices = mutableListOf<String>()
        assertFalse(leagueHubControl(owner, { owner.copy(selectionGeneration = 10) }, { true }, notices::add) { calls++ })
        assertFalse(leagueHubControl(owner, { owner }, { false }, notices::add) { calls++ })
        assertEquals(0, calls)
        assertEquals(2, notices.size)
        assertTrue(leagueHubControl(owner, { owner }, { true }, notices::add) { calls++ })
        assertEquals(1, calls)
    }

    // ---- Loading, error and retry (SPEC §3.4, §3.6) ----

    @Test fun `header shows the kingdom own trophies while the standing loads`() {
        // leagues-loading.png: the header keeps the trophies known from the session instead of "…".
        assertEquals("1,284", map(captured = null, load = LoadState.Loading, fallback = "1284").league.trophies)
    }
    @Test fun `the league standing wins over the Home trophies once read`() {
        assertEquals("40", map(fallback = "1284").league.trophies)
    }
    @Test fun `a malformed Home trophy value stays unknown`() {
        assertEquals("…", map(captured = null, load = LoadState.Loading, fallback = "12.5").league.trophies)
    }
    @Test fun `a timed out read keeps the board dimmed with its time and safe line`() {
        val error = leagueReadError(LeagueReadFailure.TIMED_OUT, keptAsOf = "14:02")
        assertEquals("14:02", error.asOf)
        assertEquals("Your trophies are safe.", error.safeLine)
        val ui = map(load = error)
        // The kept board stays (drawn at 60 %), never blanked by a failed refresh.
        assertEquals(error, ui.league.load)
        assertEquals("Mira", ui.league.ladder?.rows?.single()?.name)
        assertEquals("40", ui.league.trophies)
    }
    @Test fun `a first read failure has no kept time to claim`() {
        assertNull(leagueReadError(LeagueReadFailure.FAILED, keptAsOf = null).asOf)
        assertNotEquals(leagueReadError(LeagueReadFailure.FAILED, null).message, leagueReadError(LeagueReadFailure.TIMED_OUT, null).message)
    }
    @Test fun `retry is automatic once and then manual`() {
        assertEquals(HubMotion.AUTO_RETRY.toLong(), leagueAutoRetryDelay(automaticUsed = false, failed = true))
        assertNull(leagueAutoRetryDelay(automaticUsed = true, failed = true))
        assertNull(leagueAutoRetryDelay(automaticUsed = false, failed = false))
    }
    @Test fun `a board that keeps failing gets exactly one automatic retry`() {
        // The card marks the retry used when it schedules it and clears that only on a successful read: no loop.
        var used = false
        var scheduled = 0
        repeat(5) { if (leagueAutoRetryDelay(used, failed = true) != null) { used = true; scheduled++ } }
        assertEquals(1, scheduled)
    }

    @Test fun `a timed out read settles into the error state over the kept board`() {
        // SPEC §3.4: a card that waited 8 s must stop showing skeletons and say what failed, keeping the board's time.
        val settled = leagueReadSettled(LeagueReadFailure.TIMED_OUT, keptAsOf = "14:02", autoRetryUsed = false)
        val error = settled.load as LoadState.Error
        assertEquals("The league board is taking too long to answer.", error.message)
        assertEquals("14:02", error.asOf)
        assertFalse(error.retrying)
    }
    @Test fun `the card schedules one automatic retry and then waits for the player`() {
        // Driven exactly as the card drives it: each settle feeds the next read. A loop would hammer a failing server.
        val first = leagueReadSettled(LeagueReadFailure.FAILED, null, autoRetryUsed = false)
        assertEquals(HubMotion.AUTO_RETRY.toLong(), first.retryAfterMs)
        assertTrue(first.autoRetryUsed)
        val second = leagueReadSettled(LeagueReadFailure.TIMED_OUT, null, first.autoRetryUsed)
        assertNull(second.retryAfterMs)
        assertTrue(second.load is LoadState.Error)
        val third = leagueReadSettled(LeagueReadFailure.FAILED, null, second.autoRetryUsed)
        assertNull(third.retryAfterMs)
    }
    @Test fun `a successful read clears the error and re-arms the automatic retry`() {
        // The next outage later in the session deserves its own single automatic retry.
        val settled = leagueReadSettled(null, keptAsOf = "14:02", autoRetryUsed = true)
        assertEquals(LoadState.Ready, settled.load)
        assertNull(settled.retryAfterMs)
        assertFalse(settled.autoRetryUsed)
    }
    @Test fun `a retry keeps the error row with busy dots instead of blanking it`() {
        // SPEC §3.6: the kept board and its time stay while RETRY runs; dropping to Loading would hide what failed.
        val retrying = leagueReadStarting(LoadState.Error("Can't reach the league board.", asOf = "14:02", safeLine = "Your trophies are safe."))
        assertEquals(LoadState.Error("Can't reach the league board.", asOf = "14:02", retrying = true, safeLine = "Your trophies are safe."), retrying)
        // A routine refresh of a good board is Loading, which keeps the shown board (REFRESHING), never skeletons over it.
        assertEquals(LoadState.Loading, leagueReadStarting(LoadState.Ready))
        assertEquals(LoadState.Loading, leagueReadStarting(LoadState.Loading))
    }
    @Test fun `a board kept through a failed refresh is still drawn while it retries`() {
        // The mapper is handed the busy error over the accepted snapshot: the rows and the trophies stay.
        val ui = map(load = leagueReadStarting(leagueReadError(LeagueReadFailure.FAILED, "14:02")))
        assertEquals("Mira", ui.league.ladder?.rows?.single()?.name)
        assertEquals("40", ui.league.trophies)
        assertTrue((ui.league.load as LoadState.Error).retrying)
    }

    // ---- Doors ----

    @Test fun `find match stays a live door under a read error`() {
        // The raid chooser does not depend on the league board; an error must not strand the player.
        val ui = map(captured = null, load = leagueReadError(LeagueReadFailure.FAILED, null))
        assertEquals(CommandState.ENABLED, ui.league.findMatchState)
        assertNull(ui.league.findMatchReason)
    }
    @Test fun `find match tap reaches the host door only for the current admitted owner`() {
        var opened = 0
        val notices = mutableListOf<String>()
        assertTrue(leagueHubControl(owner, { owner }, { true }, notices::add) { opened++ })
        assertFalse(leagueHubControl(owner, { owner }, { false }, notices::add) { opened++ })
        assertEquals(1, opened)
        assertEquals(listOf("Leagues is waiting for the current action to finish."), notices)
    }
    @Test fun `ladder rows show no clan instead of a constant placeholder`() {
        // The server board carries no clan per row; "Clan unavailable" on every row read as a fact about each player.
        val ladder = map().league.ladder!!
        assertTrue(ladder.rows.all { it.clanTag == null })
        assertNull(ladder.you?.clanTag)
    }
    @Test fun `only the trophy ladder is supplied and the other filters explain`() {
        val ladder = map().league.ladder!!
        assertEquals(LEAGUE_LADDER_SUPPLIED, ladder.filter)
        assertEquals(listOf(LEAGUE_LADDER_SUPPLIED, "CLANS", "FRIENDS"), ladder.filters.map { it.id })
        assertNull(leagueLadderFilterRefusal(LEAGUE_LADDER_SUPPLIED))
        assertEquals("This ladder filter is not supplied by the server.", leagueLadderFilterRefusal("CLANS"))
        assertEquals("This ladder filter is not supplied by the server.", leagueLadderFilterRefusal("FRIENDS"))
    }
    @Test fun `footnote is plain server facts not the raw status line`() {
        val note = map().league.footnote.orEmpty()
        assertTrue(note.contains("1 kingdom(s) per wallet"))
        assertFalse(note.contains("Rewards status"))
        assertEquals(note, map().rewards.footnote)
    }
    @Test fun `a blocked kingdom reason is stated once`() {
        val value = overview().let { it.copy(you = it.you!!.copy(blockedByHigherBase = true)) }
        val note = map(state(value)).league.rewardNote.orEmpty()
        assertEquals(1, Regex("Another kingdom").findAll(note).count())
    }
    @Test fun `back closes the open facts view before the card`() {
        // One Back from a ladder row's facts must return to the board, not drop the player out of Leagues.
        assertEquals(LeagueBackStep.CLOSE_DETAIL, leagueBackStep(detailOpen = true, historyOpen = true))
        assertEquals(LeagueBackStep.CLOSE_HISTORY, leagueBackStep(detailOpen = false, historyOpen = true))
        assertEquals(LeagueBackStep.CLOSE_CARD, leagueBackStep(detailOpen = false, historyOpen = false))
    }
    @Test fun `a hosted league card leaves closing to the Home sheet host`() {
        // Hosted, the SheetHost owns Back for the card; Leagues consumes Back only while its own facts view is open.
        assertFalse(leagueConsumesHostedBack(LeagueBackStep.CLOSE_CARD))
        assertTrue(leagueConsumesHostedBack(LeagueBackStep.CLOSE_HISTORY))
        assertTrue(leagueConsumesHostedBack(LeagueBackStep.CLOSE_DETAIL))
    }
    // Rewritten 2026-10-06 (owner: show the live prize and the would-be winners before the season ends): the card gains a
    // fourth tab, PRIZE. The set stays exact, and the drawn tab strip must offer exactly the ids the host accepts, so a
    // deep link or a restored tab can never select a tab the strip does not draw (or the reverse).
    @Test fun `tab ids are exactly LEAGUE LADDER REWARDS and PRIZE and match the drawn strip`() {
        assertEquals(setOf("LEAGUE", "LADDER", "REWARDS", "PRIZE"), LEAGUE_HUB_TABS)
        assertEquals(LEAGUE_HUB_TABS, gg.pixelkingdomwars.nativeclient.ui.sheets.hub.leaguesTabs().map { it.id }.toSet())
    }
    @Test fun `the PRIZE tab survives the shared three-tab mapper`() {
        assertEquals("PRIZE", leaguesHubUi(state(), owner, owner, catalogue, "PRIZE", 0L, LoadState.Ready, true, true).league.selectedTab)
        assertEquals("LEAGUE", leaguesHubUi(state(), owner, owner, catalogue, "NOPE", 0L, LoadState.Ready, true, true).league.selectedTab)
    }
}
