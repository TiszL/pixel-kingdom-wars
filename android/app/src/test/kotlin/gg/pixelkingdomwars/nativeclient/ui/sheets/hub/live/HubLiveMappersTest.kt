package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.data.ChatLauncherState
import gg.pixelkingdomwars.nativeclient.data.ChatState
import gg.pixelkingdomwars.nativeclient.data.CommunityState
import gg.pixelkingdomwars.nativeclient.data.DeviceSettings
import gg.pixelkingdomwars.nativeclient.data.FeedbackState
import gg.pixelkingdomwars.nativeclient.data.StoredDevicePreferences
import gg.pixelkingdomwars.nativeclient.model.ChatAuthor
import gg.pixelkingdomwars.nativeclient.model.ChatMessage
import gg.pixelkingdomwars.nativeclient.model.ChatStatus
import gg.pixelkingdomwars.nativeclient.model.FeedbackReport
import gg.pixelkingdomwars.nativeclient.model.LeagueOverview
import gg.pixelkingdomwars.nativeclient.model.LeaguePresentationMode
import gg.pixelkingdomwars.nativeclient.model.LeagueRank
import gg.pixelkingdomwars.nativeclient.model.LeagueRewardV2
import gg.pixelkingdomwars.nativeclient.model.LeagueRewards
import gg.pixelkingdomwars.nativeclient.model.LeagueSettlement
import gg.pixelkingdomwars.nativeclient.model.LeagueSkrOverview
import gg.pixelkingdomwars.nativeclient.model.LeagueStanding
import gg.pixelkingdomwars.nativeclient.model.LeagueWeek
import gg.pixelkingdomwars.nativeclient.model.MailAttachment
import gg.pixelkingdomwars.nativeclient.model.MailMessage
import gg.pixelkingdomwars.nativeclient.model.MailPage
import gg.pixelkingdomwars.nativeclient.model.MailStatus
import gg.pixelkingdomwars.nativeclient.model.Quest
import gg.pixelkingdomwars.nativeclient.model.QuestBoard
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import gg.pixelkingdomwars.nativeclient.ui.chrome.ToastItem
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.ToastKind
import gg.pixelkingdomwars.nativeclient.ui.more.QuestsScope
import gg.pixelkingdomwars.nativeclient.ui.more.questsScopeCurrent
import gg.pixelkingdomwars.nativeclient.ui.more.readCurrentQuestBoard
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.QuestState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.questsTabs
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ReportStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Hub display must preserve authoritative amounts and recovery scope without inventing eligibility or payouts.
 * Tests-first snapshots are preserved separately; execution belongs to the coordinator's composite queue. */
class HubLiveMappersTest {
    private val base = "00000000-0000-4000-8000-000000000001"
    private val time = "2026-10-05T00:00:00Z"
    private fun quest(id: String? = "q", completed: Boolean = false, reward: String? = null) =
        Quest(id = id, scope = "daily", templateCode = "train", progress = "10", target = "10", completed = completed, rewardShards = reward)
    private fun board(vararg quests: Quest) = QuestBoard(quests = quests.toList())
    private fun mail(attachments: List<MailAttachment> = emptyList()) = MailMessage(base, "system",
        if (attachments.isEmpty()) "info" else "reward", "A letter", "Body", attachments,
        if (attachments.isEmpty()) null else "pending", null, time,
        if (attachments.isEmpty()) null else "2026-11-01T00:00:00Z", null, null, null, null)
    private fun report(status: String, unread: Boolean = false) = FeedbackReport(base, "bug", "Title", "Body", status,
        null, 0, time, null, null, unread = unread)
    private fun chatMessage(id: String) = ChatMessage(id, base, "hello $id", time, ChatAuthor("Mira", null, false), true)
    private val chatStatus = ChatStatus(true, true, null, null, "100", 1000, 5000)
    private fun session() = AccountSession("wallet", "https://localhost:18443", testToken())
    private fun overview(reward: LeagueRewardV2? = LeagueRewardV2("0", "0", emptyList()),
        mode: LeaguePresentationMode = LeaguePresentationMode.V2) = LeagueOverview(
        LeagueWeek(time, "2026-10-12T00:00:00Z", "2026-10-12T00:00:00Z"),
        LeagueRewards("active", "2026-10-12T00:00:00Z", 5, 1), "cumulative",
        LeagueStanding(base, 40, "bronze", 3, false, false, false, tierV2 = "bronze", rewardV2 = reward),
        listOf(LeagueRank(37, base, "Mira", 40, "bronze", true, tierV2 = "bronze")), null,
        ladderVersion = 2, presentationMode = mode)
    private fun leagueState(value: LeagueOverview = overview()) = CommunityState(leagues = value, leagueBaseId = base, leagueSelectionGeneration = 9)
    private fun scope(session: AccountSession = session(), generation: Long = 9) = HubLeagueScope(session, base, generation)
    private val catalogue = buildJsonObject { put("constants", buildJsonObject { put("PHASE_E_LEAGUE_TIERS", buildJsonObject {
        put("tiers", buildJsonArray { listOf("bronze", "silver", "gold", "platinum", "diamond", "solana", "seeker").forEach { add(it) } })
        put("thresholds", buildJsonArray { listOf(0, 100, 200, 300, 400, 500, 600).forEach { add(it) } })
    }) }) }

    @Test fun `missing quests are loading and have no invented bonus`() {
        val ui = liveQuestsUi(null)
        assertEquals(LoadState.Loading, ui.load); assertNull(ui.bonus.total); assertNull(ui.bonus.reward); assertNull(ui.claimAll)
    }
    @Test fun `exact large reward survives and known zero is different from missing`() {
        assertEquals("18,446,744,073,709,551,615", liveQuestsUi(board(quest(reward = "18446744073709551615"))).rows.single().reward?.amount)
        assertEquals(PriceStatus.SERVER_ZERO, liveQuestsUi(board(quest(reward = "0"))).rows.single().reward?.status)
        assertNull(liveQuestsUi(board(quest())).rows.single().reward)
    }
    @Test fun `progress never authorizes a claim`() {
        val row = liveQuestsUi(board(quest()), claimFlowBound = true).rows.single()
        assertEquals(1f, row.progress); assertEquals(QuestState.LOCKED, row.state)
    }
    @Test fun `completed needs an existing claim binding`() {
        assertEquals(QuestState.LOCKED, liveQuestsUi(board(quest(completed = true))).rows.single().state)
        assertEquals(QuestState.READY, liveQuestsUi(board(quest(completed = true)), claimFlowBound = true).rows.single().state)
    }
    @Test fun `missing and duplicate identities cannot claim`() {
        val ui = liveQuestsUi(board(quest(null, true), quest("same", true), quest("same", true)), claimFlowBound = true)
        assertTrue(ui.rows.all { it.state == QuestState.LOCKED && it.lockedReason != null })
        assertEquals(3, ui.rows.map { it.id }.distinct().size)
        assertEquals(0, ui.tabBadges["DAILY"])
    }
    @Test fun `synthetic quest keys cannot collide with opaque server ids`() {
        val ui = liveQuestsUi(board(quest("unavailable:1", true), quest(null, true)), claimFlowBound = true)
        assertEquals(2, ui.rows.map { it.id }.distinct().size)
        assertEquals("unavailable:1", ui.rows.first().id)
        assertEquals(QuestState.READY, ui.rows.first().state)
        assertEquals(QuestState.LOCKED, ui.rows.last().state)
    }
    @Test fun `claimed precedes completed and busy covers only real rows`() {
        val ui = liveQuestsUi(board(quest(completed = true).copy(claimed = true)), busy = true, claimFlowBound = true)
        assertEquals(QuestState.DONE, ui.rows.single().state); assertEquals(setOf("q"), ui.busyIds)
    }
    @Test fun `kingdom includes weekly and onboarding without making up rewards`() {
        val ui = liveQuestsUi(board(quest("a").copy(scope = "weekly"), quest("b").copy(scope = "onboarding", rewardKeep = "55")), tab = "KINGDOM")
        assertEquals(listOf("a", "b"), ui.rows.map { it.id }); assertTrue(ui.rows.all { it.reward == null })
    }
    @Test fun `invalid progress and reward remain unknown`() {
        val row = liveQuestsUi(board(quest(reward = "1e3").copy(progress = "NaN", target = "0"))).rows.single()
        assertNull(row.progress); assertNull(row.reward); assertEquals("…", row.have)
    }
    @Test fun `batch claim requires both existing owner bindings`() {
        val board = board(quest(completed = true, reward = "4"))
        assertNull(liveQuestsUi(board, claimFlowBound = true).claimAll)
        assertNull(liveQuestsUi(board, claimAllBound = true).claimAll)
        assertEquals(1, liveQuestsUi(board, claimFlowBound = true, claimAllBound = true).claimAll?.count)
    }
    @Test fun `batch footer describes every ready quest across both tabs with exact total`() {
        val board = board(quest("daily", true, "18446744073709551615"),
            quest("weekly", true, "2").copy(scope = "weekly"),
            quest("claimed", true, "999").copy(claimed = true), quest("working", false, "999"))
        for (tab in listOf("DAILY", "KINGDOM")) {
            val ui = liveQuestsUi(board, tab = tab, claimFlowBound = true, claimAllBound = true)
            assertEquals(2, ui.claimAll?.count)
            assertEquals("18,446,744,073,709,551,617 Shards · all quests", ui.claimAll?.summary)
            assertEquals(1, ui.tabBadges["DAILY"]); assertEquals(1, ui.tabBadges["KINGDOM"])
        }
    }
    @Test fun `empty or already claimed pool never draws a batch action`() {
        for (board in listOf(board(), board(quest(completed = true).copy(claimed = true)))) {
            assertNull(liveQuestsUi(board, claimFlowBound = true, claimAllBound = true).claimAll)
        }
        assertEquals("0 Shards · all quests", liveQuestsUi(board(quest(completed = true, reward = "0")),
            claimFlowBound = true, claimAllBound = true).claimAll?.summary)
    }
    @Test fun `one missing or duplicate ready identity suppresses the whole batch`() {
        for (unsafe in listOf(listOf(quest(null, true)), listOf(quest("same", true), quest("same", true)))) {
            val ui = liveQuestsUi(QuestBoard(quests = listOf(quest("safe", true, "10")) + unsafe),
                claimFlowBound = true, claimAllBound = true)
            assertNull(ui.claimAll)
            assertEquals(QuestState.READY, ui.rows.single { it.id == "safe" }.state)
            assertTrue(ui.notice?.contains("Refresh") == true)
        }
    }
    @Test fun `unknown batch reward cannot become a partial total or legacy keep`() {
        for (unknown in listOf(quest("unknown", true), quest("unknown", true, "1e3"),
            quest("unknown", true).copy(rewardKeep = "100"))) {
            val ui = liveQuestsUi(board(quest("known", true, "10"), unknown), claimFlowBound = true, claimAllBound = true)
            assertEquals(2, ui.claimAll?.count)
            assertEquals("Reward total unavailable · all quests", ui.claimAll?.summary)
        }
    }
    @Test fun `currentness refusal is visible and removes claim authority`() {
        val reason = "Your kingdom changed. Open quests again."
        val ui = liveQuestsUi(board(quest(completed = true, reward = "10")), claimFlowBound = true,
            claimAllBound = true, claimUnavailable = reason)
        assertEquals(QuestState.LOCKED, ui.rows.single().state)
        assertEquals(reason, ui.rows.single().lockedReason); assertEquals(reason, ui.notice)
        assertEquals(0, ui.tabBadges["DAILY"]); assertNull(ui.claimAll)
    }
    @Test fun `kept rows cannot claim while loading stale or failed`() {
        for (load in listOf(LoadState.Loading, LoadState.Stale("14:02"), LoadState.Error("offline", asOf = "14:02"))) {
            val ui = liveQuestsUi(board(quest(completed = true, reward = "10")), claimFlowBound = true,
                claimAllBound = true, load = load)
            assertEquals(load, ui.load); assertEquals(QuestState.LOCKED, ui.rows.single().state)
            assertNotNull(ui.rows.single().lockedReason); assertNotNull(ui.notice); assertNull(ui.claimAll)
        }
    }
    @Test fun `busy claims retain visible row and footer status without accepting another tap`() {
        val ui = liveQuestsUi(board(quest(completed = true, reward = "10")), busy = true,
            claimFlowBound = true, claimAllBound = true)
        assertEquals(QuestState.READY, ui.rows.single().state); assertEquals(setOf("q"), ui.busyIds)
        assertEquals(1, ui.claimAll?.count); assertTrue(ui.claimAllBusy)
        assertTrue(ui.notice?.contains("progress") == true)
    }
    @Test fun `known bonus amount and board day do not invent progress or reset time`() {
        val ui = liveQuestsUi(board(quest(completed = true)).copy(day = "2026-10-05", allThreeBonus = "0"))
        assertNull(ui.bonus.done); assertNull(ui.bonus.total); assertNull(ui.bonus.resetsIn)
        assertEquals(PriceStatus.SERVER_ZERO, ui.bonus.reward?.status)
    }
    @Test fun `land objective says BUY while completed reward remains a claim`() {
        val land = quest("land").copy(scope = "onboarding", templateCode = "first_land")
        val link = HubLink(FeatureId("quests.land"))
        val ui = liveQuestsUi(board(land), tab = "KINGDOM", claimFlowBound = true,
            destinations = mapOf("first_land" to link), icons = mapOf("first_land" to "deed"))
        assertEquals(QuestState.GO, ui.rows.single().state); assertEquals("BUY", ui.rows.single().goLabel)
        assertEquals("deed", ui.rows.single().icon); assertEquals(link, ui.rows.single().destination)
        val completed = liveQuestsUi(board(land.copy(completed = true)), tab = "KINGDOM", claimFlowBound = true)
        assertEquals(QuestState.READY, completed.rows.single().state); assertNull(completed.rows.single().destination)
    }
    @Test fun `unknown scope and completed onboarding remain in the kingdom pool`() {
        val ui = liveQuestsUi(board(quest("other").copy(scope = "event"),
            quest("missing").copy(scope = null), quest("done", true).copy(scope = "onboarding", claimed = true)), tab = "KINGDOM")
        assertEquals(listOf("other", "missing", "done"), ui.rows.map { it.id })
        assertEquals(QuestState.DONE, ui.rows.last().state)
    }
    @Test fun `unknown keep tier uses a neutral kingdom icon`() {
        val ui = liveQuestsUi(null)
        assertNull(ui.keepTier)
        assertEquals("quest", questsTabs(emptyMap(), ui.keepTier).single { it.id == "KINGDOM" }.icon)
    }
    @Test fun `a scoped quest read returns the exact response while its owner remains current`() = runBlocking {
        val expected = QuestsScope(Any(), "base-a", 4)
        val response = board(quest("fresh", completed = true, reward = "10"))
        var reads = 0
        val observed = readCurrentQuestBoard(requireCurrent = {
            if (!questsScopeCurrent(expected, expected)) throw CancellationException("Quest owner changed")
        }, read = {
            reads++
            yield()
            response
        })
        assertSame(response, observed)
        assertEquals(1, reads)
    }
    @Test fun `a scoped quest read cannot return a snapshot after session or generation changes`() = runBlocking {
        val originalSession = Any()
        val expected = QuestsScope(originalSession, "base-a", 4)
        val response = board(quest("old", completed = true, reward = "10"))
        for (replacement in listOf(QuestsScope(Any(), "base-a", 4), QuestsScope(originalSession, "base-a", 6))) {
            var current = expected
            var published: QuestBoard? = null
            try {
                published = readCurrentQuestBoard(requireCurrent = {
                    if (!questsScopeCurrent(expected, current)) throw CancellationException("Quest owner changed")
                }, read = {
                    yield()
                    current = replacement
                    response
                })
                fail("A superseded read must not return its quest snapshot")
            } catch (_: CancellationException) { }
            assertNull(published)
        }
    }
    @Test fun `mail missing and empty are distinct`() {
        assertEquals(LoadState.Loading, liveMailUi(CommunityState()).load)
        assertEquals(LoadState.Ready, liveMailUi(CommunityState(mailbox = MailPage(emptyList(), null))).load)
    }
    @Test fun `mail counts come from server not page length`() {
        val ui = liveMailUi(CommunityState(mailbox = MailPage(listOf(mail()), base), status = MailStatus(20, 4, 7)))
        assertEquals(20, ui.counts["ALL"]); assertTrue(ui.hasMore); assertNull(ui.counts["NEWS"])
        assertNull(ui.claimAll); assertNull(ui.footnote)
    }
    @Test fun `filtered mail empty page does not claim the mailbox is empty`() {
        val ui = liveMailUi(CommunityState(mailbox = MailPage(listOf(mail()), base)), filter = "REWARDS")
        assertTrue(ui.letters.isEmpty()); assertTrue(ui.hasMore)
        assertTrue(ui.empty.headline.contains("loaded")); assertTrue(ui.empty.reason.contains("ALL"))
        assertNull(ui.empty.go)
    }
    @Test fun `mail mixed rewards are not collapsed into one currency`() {
        val row = liveMailUi(CommunityState(mailbox = MailPage(listOf(mail(listOf(MailAttachment("KEEP", "1"), MailAttachment("SHARDS", "2")))), null))).letters.single()
        assertNull(row.reward)
    }
    @Test fun `mail single reward keeps currency and exact amount`() {
        val row = liveMailUi(CommunityState(mailbox = MailPage(listOf(mail(listOf(MailAttachment("KEEP", "9007199254740993")))), null))).letters.single()
        assertEquals(Currency.KEEP, row.reward?.currency); assertEquals("9,007,199,254,740,993", row.reward?.amount)
    }
    @Test fun `archived mail does not use inbox counters`() {
        assertTrue(liveMailUi(CommunityState(archived = true, status = MailStatus(20, 4, 7))).counts.isEmpty())
    }
    @Test fun `report rejection and duplicate stay explicit`() {
        for (status in listOf("rejected", "duplicate")) {
            val row = liveFeedbackReportsUi(FeedbackState(reports = listOf(report(status)), loaded = true)).reports.single()
            assertEquals(ReportStatus.CLOSED, row.status); assertTrue(row.stateLine.lowercase().contains(status))
        }
    }
    @Test fun `report page cannot invent totals or replies`() {
        val ui = liveFeedbackReportsUi(FeedbackState(reports = listOf(report("accepted", true)), loaded = true))
        assertNull(ui.testerPoints); assertNull(ui.reviewedCount); assertEquals(0, ui.reports.single().unread); assertTrue(ui.reports.single().stateLine.contains("Unread update"))
        assertEquals(ReportStatus.READING, ui.reports.single().status)
    }
    @Test fun `feedback load error does not erase existing rows`() {
        val error = LoadState.Error("offline")
        val ui = liveFeedbackReportsUi(FeedbackState(reports = listOf(report("fixed")), loaded = true), load = error)
        assertEquals(error, ui.load); assertEquals(1, ui.reports.size)
    }
    @Test fun `settings use eight stored keys and preserve explicit flags`() {
        val ui = liveSettingsUi(DeviceSettings(keepConfirm = true, haptics = false, diagnostics = true), "test build")
        assertEquals(8, ui.toggles.size); assertEquals(8, ui.toggles.map { it.key }.distinct().size)
        assertTrue(ui.toggles.single { it.key == StoredDevicePreferences.KEEP_CONFIRM_KEY }.on)
        assertFalse(ui.toggles.single { it.key == StoredDevicePreferences.HAPTICS_KEY }.on)
        assertTrue(ui.toggles.single { it.key == StoredDevicePreferences.DIAGNOSTICS_KEY }.on)
        assertTrue(ui.accountRows.isEmpty()); assertNull(ui.confirm)
    }
    @Test fun `chat uses global truthful identity and numeric newest unread`() {
        val launcher = ChatLauncherState(status = chatStatus, unreadMessages = mapOf("9" to false, "10" to true))
        val ui = liveChatPeekUi(ChatState(status = chatStatus, messages = listOf(chatMessage("9"), chatMessage("10"), chatMessage("11"))), launcher)!!
        assertEquals("GLOBAL", ui.channel); assertEquals("10", ui.messageId); assertEquals("global:10", ui.key)
    }
    @Test fun `chat cannot invent message from unread count or peek while open`() {
        val launcher = ChatLauncherState(status = chatStatus, unreadMessages = mapOf("10" to false))
        assertNull(liveChatPeekUi(ChatState(status = chatStatus), launcher))
        assertNull(liveChatPeekUi(ChatState(status = chatStatus, messages = listOf(chatMessage("10"))), launcher.copy(open = true)))
        assertNull(liveChatPeekUi(ChatState(status = chatStatus, messages = listOf(chatMessage("10"))), launcher.copy(capabilityMissing = true)))
    }
    @Test fun `toast retains identity message and original clock`() {
        val ui = liveToastUi(ToastItem(4, "offline", true, 12))
        assertEquals("toast:4", ui.key); assertEquals("offline", ui.message); assertEquals(12L, ui.postedAtMs)
        assertEquals(ToastKind.ERROR, ui.kind); assertFalse(ui.report); assertNull(ui.go)
    }
    @Test fun `league before first read is loading with no invented values`() {
        val ui = liveLeagueUi(CommunityState(), null, scope())
        assertEquals(LoadState.Loading, ui.league.load)
        assertEquals(LoadState.Loading, ui.rewards.load)
        assertNull(ui.league.rewardShards); assertNull(ui.league.ladder)
    }
    @Test fun `league same wallet new session cannot reuse old read`() {
        val old = scope(); val current = scope()
        assertNull(liveLeagueUi(leagueState(), old, current).league.rewardShards)
    }
    @Test fun `league changed selection generation cannot reuse old read`() {
        val old = scope()
        assertNull(liveLeagueUi(leagueState(), old, old.copy(selectionGeneration = 10)).league.rewardShards)
        assertNull(liveLeagueUi(leagueState().copy(leagueSelectionGeneration = 8), old, old).league.rewardShards)
    }
    @Test fun `league missing captured scope never admits payload`() {
        assertNull(liveLeagueUi(leagueState(), null, scope()).league.rewardShards)
    }
    @Test fun `league unknown mode cannot fallback to legacy rewards`() {
        val scope = scope(); val ui = liveLeagueUi(leagueState(overview(mode = LeaguePresentationMode.UNAVAILABLE)), scope, scope)
        assertNull(ui.league.rewardShards); assertFalse(ui.rewards.configured)
    }
    @Test fun `league current reward is exact and not derived from trophies`() {
        val scope = scope(); val ui = liveLeagueUi(leagueState(overview(LeagueRewardV2("9007199254740993", "2", emptyList()))), scope, scope, catalogue)
        assertEquals("9,007,199,254,740,993", ui.league.rewardShards)
        assertEquals(7, ui.rewards.tiers.size)
        assertEquals(6, ui.rewards.tiers.count { it.shards.amount == null })
    }
    @Test fun `historical v2 settlement keeps gems and never becomes current reward`() {
        val scope = scope()
        val settlement = LeagueSettlement("2026-09-28", "bronze", 40, 3, "999", emptyList(), time,
            tierV2 = "bronze", gems = "17", pack = emptyList())
        val ui = liveLeagueUi(leagueState(overview(null).copy(lastSettlement = settlement)), scope, scope)
        assertNull(ui.league.rewardShards)
        assertEquals("999", ui.league.pastWeeks.single().shards?.amount)
        assertEquals("17", ui.league.pastWeeks.single().items.single { it.id == "gems" }.count)
        assertFalse(ui.rewards.paid)
    }
    @Test fun `league unknown reward is not known zero`() {
        val scope = scope()
        assertNull(liveLeagueUi(leagueState(overview(null)), scope, scope).league.rewardShards)
        assertEquals("0", liveLeagueUi(leagueState(), scope, scope).league.rewardShards)
    }
    // 469bbe92 F2 / 2eb3e8f9: Opus now renders these legacy-named fields as ATTACKS.
    // Replace the obsolete null mapping; server counts must never be described as WINS.
    @Test fun `rated attacks populate ATTACKS never WINS`() {
        val scope = scope(); val ui = liveLeagueUi(leagueState(), scope, scope)
        assertEquals(3, ui.league.wins); assertEquals(5, ui.league.winsNeeded)
        assertEquals(3, ui.rewards.raidsDone); assertEquals(5, ui.rewards.raidsNeeded)
        assertTrue(ui.league.winsLine.contains("Rated attacks 3 / 5"))
        assertFalse(ui.league.winsLine.contains("wins", ignoreCase = true))
    }
    @Test fun `league ranks are server ranks and missing catalogue has no invented table`() {
        val scope = scope(); val ui = liveLeagueUi(leagueState(), scope, scope)
        assertEquals(37, ui.league.ladder!!.rows.single().rank)
        assertEquals("Clan unavailable", ui.league.ladder!!.rows.single().clanTag)
        assertTrue(ui.league.tiers.isEmpty()); assertTrue(ui.rewards.tiers.isEmpty())
    }
    @Test fun `deferred skr never appears paid or as live top500`() {
        val scope = scope(); val ui = liveLeagueUi(leagueState(overview().copy(skr = LeagueSkrOverview("payout_deferred"))), scope, scope)
        assertFalse(ui.rewards.paid); assertNull(ui.rewards.skrLine); assertTrue(ui.rewards.footnote!!.contains("deferred"))
        assertEquals(CommandState.DISABLED, ui.league.findMatchState); assertNotNull(ui.league.findMatchReason)
    }
    @Test fun `league selected base mismatch fails closed`() {
        val scope = scope(); val ui = liveLeagueUi(leagueState().copy(leagueBaseId = null), scope, scope)
        assertEquals("…", ui.league.trophies); assertNull(ui.league.ladder)
    }
    @Test fun `league durations keep seconds and omit empty units`() {
        val scope = scope()
        val closes = java.time.Instant.parse("2026-10-12T00:00:00Z").toEpochMilli()
        assertEquals("36m 5s", liveLeagueUi(leagueState(), scope, scope, nowMillis = closes - 2_165_000).league.weekEnds)
        assertEquals("3d", liveLeagueUi(leagueState(), scope, scope, nowMillis = closes - 259_200_000).rewards.nextPayout)
        assertEquals("0s", liveLeagueUi(leagueState(), scope, scope, nowMillis = closes + 1_000).league.weekEnds)
        assertNull(liveLeagueUi(leagueState(), scope, scope).league.weekEnds)
    }
    @Test fun `disabled or legacy rewards cannot show not yet earning tag`() {
        val scope = scope()
        val disabled = overview().copy(rewards = overview().rewards.copy(status = "disabled"))
        assertNull(liveLeagueUi(leagueState(disabled), scope, scope).rewards.earning)
        assertNull(liveLeagueUi(leagueState(overview(mode = LeaguePresentationMode.LEGACY)), scope, scope).rewards.earning)
        assertEquals(false, liveLeagueUi(leagueState(), scope, scope).rewards.earning)
    }
    @Test fun `keep confirmation describes speed ups without weakening transfer review`() {
        val ui = liveSettingsUi(DeviceSettings(keepConfirm = false), "test")
        val row = ui.toggles.single { it.key == StoredDevicePreferences.KEEP_CONFIRM_KEY }
        assertEquals("Ask before a speed-up. Economy transfers always require their own review.", row.consequence)
        assertFalse(row.on)
    }
    @Test fun `quest progress is formatted but its server fraction stays exact`() {
        val row = liveQuestsUi(board(quest().copy(progress = "1234", target = "2000"))).rows.single()
        assertEquals("1,234", row.have); assertEquals("2,000", row.need)
        assertEquals(0.617f, row.progress)
    }
    @Test fun `league item and trophy text is grouped without losing large digits`() {
        val scope = scope()
        val data = overview(LeagueRewardV2("1234567", "9007199254740993", emptyList()))
        val ui = liveLeagueUi(leagueState(data.copy(you = data.you!!.copy(trophies = 1234),
            board = listOf(data.board.single().copy(rank = 1234, trophies = 5678)))), scope, scope)
        assertEquals("1,234", ui.league.trophies)
        assertEquals("1,234,567", ui.league.rewardShards)
        assertEquals("9,007,199,254,740,993", ui.league.rewardItems.single().count)
        assertEquals(1234, ui.league.ladder!!.rows.single().rank)
        assertEquals("1,234", ui.league.ladder!!.rows.single().rankText)
        assertEquals("5,678", ui.league.ladder!!.rows.single().trophies)
    }
    @Test fun `report points and totals use kit formatting rather than floating point`() {
        val ui = liveFeedbackReportsUi(FeedbackState(reports = listOf(report("fixed").copy(points = 1234)), loaded = true),
            testerPoints = "9007199254740993")
        assertEquals("+1,234", ui.reports.single().points)
        assertEquals("9,007,199,254,740,993", ui.testerPoints)
        assertTrue(ui.reports.single().stateLine.contains("+1,234 points"))
    }

}
