package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure rules behind the hub cluster (design/final/hub/SPEC.md). Each test names the player-facing promise it keeps:
 * honest numbers ("…", never a fake 0), money moved is money honoured, a card never blanks, world chat never peeks,
 * and a draft is never lost silently.
 */
class HubLogicTest {
    private val go = HubLink(FeatureId("hud.quests"))
    private fun now(id: String, priority: NowPriority, ready: Boolean = false) = NowRowUi(id, "quest", id, "where", ready, go, priority)
    private fun quest(id: String, state: QuestState) = QuestRowUi(id, "quest", id, "0", "1", 0f, null, state, null)

    // SPEC §2.1: "what can I do right now" must lead with what pays the player, and never grow past four rows.
    @Test fun `right now rows lead with claims, keep priority order and stop at four`() {
        val rows = listOf(now("quest", NowPriority.QUEST_REWARD), now("builder", NowPriority.IDLE_BUILDER), now("claim", NowPriority.READY_TO_CLAIM, true),
            now("auction", NowPriority.AUCTION), now("lodge", NowPriority.COLLECT, true))
        assertEquals(listOf("claim", "lodge", "auction", "builder"), rightNowRows(rows).map { it.id })
        assertEquals(0, rightNowRows(emptyList()).size)
    }

    @Test fun `only the top right-now row can use the ready look, and only when it is ready`() {
        assertTrue(nowRowReady(0, now("claim", NowPriority.READY_TO_CLAIM, ready = true)))
        assertFalse(nowRowReady(1, now("lodge", NowPriority.COLLECT, ready = true)))
        assertFalse(nowRowReady(0, now("auction", NowPriority.AUCTION, ready = false)))
    }

    // Honest numbers: an unknown count must never draw as zero filled pips or "0/5".
    @Test fun `pips and fractions never invent a zero`() {
        assertNull(pipFills(null, 5))
        assertNull(pipFills(3, null))
        assertNull(pipFills(3, 0))
        assertEquals(listOf(true, true, true, false, false), pipFills(3, 5))
        assertEquals(listOf(true, true), pipFills(9, 2))
        assertEquals("…/5", fractionText(null, 5))
        assertEquals("3/…", fractionText(3, null))
        assertEquals("3/5", fractionText(3, 5))
    }

    // SPEC §3.4 / §3.6: a card never blanks; kept data stays (dimmed only under an error); a refresh keeps the last good view.
    @Test fun `loading keeps the last good view and errors keep data dimmed`() {
        assertEquals(BoardView.SKELETON, boardView(LoadState.Loading, hasData = false))
        assertEquals(BoardView.REFRESHING, boardView(LoadState.Loading, hasData = true))
        assertEquals(BoardView.LIVE, boardView(LoadState.Ready, hasData = true))
        assertEquals(BoardView.STALE, boardView(LoadState.Stale("14:02"), hasData = true))
        assertEquals(BoardView.ERROR_KEPT, boardView(LoadState.Error("x", "14:02"), hasData = true))
        assertEquals(BoardView.ERROR_EMPTY, boardView(LoadState.Error("x"), hasData = false))
        assertEquals(0.6f, boardAlpha(BoardView.ERROR_KEPT), 0f)
        assertEquals(1f, boardAlpha(BoardView.REFRESHING), 0f)
        assertEquals(1f, boardAlpha(BoardView.STALE), 0f)
    }

    @Test fun `an in-card loading turns into the error state after eight seconds`() {
        assertFalse(loadingTimedOut(startedAtMs = 1_000, nowMs = 8_999))
        assertTrue(loadingTimedOut(startedAtMs = 1_000, nowMs = 9_000))
    }

    // SPEC §2.3: the player sees what to claim first, and claimed quests sink to the bottom.
    @Test fun `quests sort ready first, done last, stable inside a group`() {
        val rows = listOf(quest("d1", QuestState.DONE), quest("g1", QuestState.GO), quest("r1", QuestState.READY), quest("l1", QuestState.LOCKED),
            quest("r2", QuestState.READY), quest("g2", QuestState.GO))
        assertEquals(listOf("r1", "r2", "g1", "l1", "g2", "d1"), orderQuests(rows).map { it.id })
    }

    @Test fun `claim all shows only for a real positive count`() {
        assertFalse(claimAllShown(null))
        assertFalse(claimAllShown(ClaimAllUi(0, "")))
        assertTrue(claimAllShown(ClaimAllUi(2, "300 Shards · 10 Gems")))
    }

    // SPEC §2.4 + design correction 7: an uncertain claim is never "done" or "failed"; it keeps its recovery and its letter.
    @Test fun `an uncertain letter claim keeps recovery and cannot be archived`() {
        val checking = letterControls(LetterState.CHECKING, hasRewards = true)
        assertTrue(checking.recheck)
        assertFalse(checking.claim)
        assertFalse(checking.archiveEnabled)
        val claiming = letterControls(LetterState.CLAIMING, hasRewards = true)
        assertTrue(claiming.claimBusy)
        assertFalse(claiming.archiveEnabled)
        assertEquals("RETRY", letterControls(LetterState.FAILED, hasRewards = true).claimLabel)
        assertFalse(letterControls(LetterState.EXPIRED, hasRewards = true).claim)
        assertEquals(0.45f, letterControls(LetterState.EXPIRED, hasRewards = true).tileAlpha, 0f)
        assertFalse(letterControls(LetterState.CLAIMABLE, hasRewards = false).claim)
    }

    @Test fun `mail chips never show an unknown inbox as empty`() {
        val unknown = mailFilterChips(emptyMap())
        assertEquals("…", unknown.first { it.id == MAIL_ALL }.count)
        assertNull(unknown.first { it.id == MAIL_REWARDS }.badge)
        val chips = mailFilterChips(mapOf(MAIL_ALL to 8, MAIL_REWARDS to 2))
        assertEquals("8", chips.first { it.id == MAIL_ALL }.count)
        assertEquals("2", chips.first { it.id == MAIL_REWARDS }.badge?.text)
        assertEquals(BadgeTone.REWARD, chips.first { it.id == MAIL_REWARDS }.badge?.tone)
        assertEquals("0", mailFilterChips(mapOf(MAIL_ALL to 0)).first { it.id == MAIL_ALL }.count)
    }

    // SPEC §2.8: a pending money flow reads as in progress, never as finished; NEEDS YOU is a door, never a status word.
    @Test fun `history statuses keep money honest`() {
        assertTrue(historyStatusLook(HistoryStatus.PENDING).dots)
        assertEquals(Verb.STONE, historyStatusLook(HistoryStatus.PENDING).verb)
        assertEquals(Verb.STONE, historyStatusLook(HistoryStatus.HELD).verb)
        assertEquals(Verb.MOSS, historyStatusLook(HistoryStatus.SENT).verb)
        assertEquals("OPEN", historyStatusLook(HistoryStatus.NEEDS_YOU).label)
        HistoryStatus.entries.filter { it != HistoryStatus.NEEDS_YOU }.forEach { assertFalse(historyStatusLook(it).label == "OPEN") }
    }

    // SPEC §2.9: the peek must never shout world chat over the kingdom, even for an @mention there.
    @Test fun `chat peek shows clan messages and mentions, never world chat`() {
        assertTrue(chatPeekAllowed(CHAT_CLAN, mentionsMe = false, drawerOpen = false))
        assertTrue(chatPeekAllowed("DM", mentionsMe = true, drawerOpen = false))
        assertFalse(chatPeekAllowed(CHAT_WORLD, mentionsMe = true, drawerOpen = false))
        assertFalse(chatPeekAllowed(CHAT_WORLD, mentionsMe = false, drawerOpen = false))
        assertFalse(chatPeekAllowed(CHAT_CLAN, mentionsMe = true, drawerOpen = true))
        assertFalse(chatPeekAllowed("DM", mentionsMe = false, drawerOpen = false))
    }

    @Test fun `a drawer closes only past thirty percent of its width`() {
        assertFalse(drawerSwipeCloses(-90f, 300f))
        assertTrue(drawerSwipeCloses(-91f, 300f))
        assertFalse(drawerSwipeCloses(200f, 300f))
        assertFalse(drawerSwipeCloses(-500f, 0f))
    }

    @Test fun `send needs a non-blank draft and nothing in flight`() {
        // A clan channel that exists (clanLockedReason = null): the CLAN tab's own lock is pinned in the next test.
        val chat = ChatUi(CHAT_CLAN, emptyMap(), emptyList(), draft = "hi", canSend = true, blockedReason = null, sending = false, clanLockedReason = null)
        assertTrue(chatCanSend(chat))
        assertFalse(chatCanSend(chat.copy(draft = "  ")))
        assertFalse(chatCanSend(chat.copy(sending = true)))
        assertFalse(chatCanSend(chat.copy(blockedReason = "Clans need land")))
        assertFalse(chatCanSend(chat.copy(canSend = false)))
    }

    // Chat is GLOBAL: until a clan channel exists the CLAN tab must say so instead of offering a composer that cannot
    // reach anyone, and a paused chat must never claim that clan chat still works.
    @Test fun `the CLAN tab is locked with its reason while clan chat does not exist, and paused copy stays global`() {
        val world = ChatUi(CHAT_WORLD, mapOf(CHAT_CLAN to 2), emptyList(), draft = "hi", canSend = true, blockedReason = null, sending = false)
        val tabs = chatTabs(world)
        assertEquals(listOf(CHAT_WORLD, CHAT_CLAN), tabs.map { it.id })
        assertFalse(tabs[0].locked)
        assertTrue("locked by default: clan chat does not exist yet", tabs[1].locked)
        assertNull("the WORLD tab is untouched by the clan lock", chatBlockedReason(world))
        assertTrue(chatCanSend(world))
        val clan = world.copy(tab = CHAT_CLAN)
        assertEquals(CLAN_CHAT_LOCKED, chatBlockedReason(clan))
        assertFalse("nothing can be sent into a channel that does not exist", chatCanSend(clan))
        assertEquals("the server's own reason still shows once the lock lifts", "Clans need land",
            chatBlockedReason(clan.copy(clanLockedReason = null, blockedReason = "Clans need land")))
        assertFalse(chatTabs(clan.copy(clanLockedReason = null))[1].locked)
        assertFalse(CHAT_PAUSED_LINE.contains("clan", ignoreCase = true) || CHAT_PAUSED_TITLE.contains("clan", ignoreCase = true))
        assertTrue(CHAT_PAUSED_TITLE.contains("Global"))
    }

    // SPEC §2.7: a draft is never thrown away without asking; a sent report needs no question.
    @Test fun `feedback asks before discarding a draft, not after sending`() {
        assertFalse(feedbackNeedsDiscardConfirm("", "  ", MoneylessSendState.IDLE))
        assertTrue(feedbackNeedsDiscardConfirm("Claim stays grey", "", MoneylessSendState.IDLE))
        assertTrue(feedbackNeedsDiscardConfirm("", "details", MoneylessSendState.FAILED))
        assertFalse(feedbackNeedsDiscardConfirm("Claim stays grey", "details", MoneylessSendState.SENT))
    }

    @Test fun `feedback sends only with a category, a title, within bounds and once`() {
        val ui = FeedbackUi("NEW", "BUG", "Claim stays grey", "details", FeedbackBoundsUi(80, 2000, 4), emptyList(), true, "Ironhold",
            MoneylessSendState.IDLE, emptyList(), 0, false)
        assertTrue(feedbackCanSend(ui))
        assertNull(feedbackSendReason(ui))
        assertFalse(feedbackCanSend(ui.copy(category = null)))
        assertFalse(feedbackCanSend(ui.copy(title = " ")))
        assertFalse(feedbackCanSend(ui.copy(send = MoneylessSendState.SENDING)))
        assertFalse(feedbackCanSend(ui.copy(send = MoneylessSendState.SENT)))
        assertFalse(feedbackCanSend(ui.copy(title = "x".repeat(81))))
        assertTrue(feedbackCanSend(ui.copy(bounds = FeedbackBoundsUi(null, null, null), body = "y".repeat(5000))))
        assertTrue(feedbackCanSend(ui.copy(send = MoneylessSendState.FAILED)))
        assertEquals("Pick what happened first", feedbackSendReason(ui.copy(category = null)))
    }

    @Test fun `text fields obey the server bound and say so`() {
        assertEquals("abc", clampInput("abcdef", 3))
        assertEquals("abcdef", clampInput("abcdef", null))
        assertEquals("23/80", counterText(23, 80))
        assertEquals("23", counterText(23, null))
    }

    @Test fun `settings groups toggles by section in first-seen order, per tab`() {
        val toggles = listOf(
            ToggleRowUi("sfx", "SOUND & FEEL", "Sound", "", true, null),
            ToggleRowUi("left", "PLAY", "Left-handed", "", false, null),
            ToggleRowUi("music", "SOUND & FEEL", "Music", "", true, null),
            ToggleRowUi("diag", "DIAGNOSTICS", "Diagnostics", "", false, null, tab = "HELP"),
        )
        val game = toggleSections(toggles, "GAME")
        assertEquals(listOf("SOUND & FEEL", "PLAY"), game.map { it.first })
        assertEquals(listOf("sfx", "music"), game.first().second.map { it.key })
        assertEquals(listOf("DIAGNOSTICS"), toggleSections(toggles, "HELP").map { it.first })
    }

    // SPEC §3.7: a required update or maintenance must never be dismissible; only the optional update is.
    @Test fun `only the optional update gate can be dismissed`() {
        assertTrue(gateDismissible(GateKind.UPDATE_OPTIONAL))
        assertFalse(gateDismissible(GateKind.UPDATE_REQUIRED))
        assertFalse(gateDismissible(GateKind.MAINTENANCE))
    }

    @Test fun `countdowns, tips and sprite frames tick as specified`() {
        assertEquals("0:24", checkCountdown(24))
        assertEquals("1:05", checkCountdown(65))
        assertEquals("0:00", checkCountdown(-3))
        assertEquals(-1, tipIndex(10_000, 0))
        assertEquals(0, tipIndex(3_999, 3))
        assertEquals(1, tipIndex(4_000, 3))
        assertEquals(0, tipIndex(12_000, 3))
        assertEquals(0, spriteFrame(0, 16, 12))
        assertEquals(12, spriteFrame(1_000, 16, 12))
        assertEquals(8, spriteFrame(2_000, 16, 12))
        assertEquals(0, spriteFrame(1_000, 0, 12))
    }

    @Test fun `rank medals only for the podium`() {
        assertEquals(MedalTone.GOLD, medalTone(1))
        assertEquals(MedalTone.SILVER, medalTone(2))
        assertEquals(MedalTone.BRONZE, medalTone(3))
        assertEquals(MedalTone.NONE, medalTone(4))
        assertEquals(MedalTone.NONE, medalTone(null))
    }

    // The league counts RATED ATTACKS (`minRatedAttacks`), never wins: calling them wins promises a reward for results the
    // server does not measure, on screen and to a screen reader alike.
    @Test fun `league progress names rated attacks, never wins`() {
        assertEquals("ATTACKS 3/5", ratedAttacksLabel(3, 5))
        assertEquals("Rated attacks 3/5", ratedAttacksSpoken(3, 5))
        assertEquals("ATTACKS …/5", ratedAttacksLabel(null, 5))
        listOf(ratedAttacksLabel(3, 5), ratedAttacksSpoken(null, null)).forEach { assertFalse(it, it.contains("win", ignoreCase = true)) }
    }

    // The server says only WHETHER a report has an unread reply: a count would be invented, so null is "…", 0 is nothing.
    @Test fun `a report's unread badge never invents a reply count`() {
        val unknown = reportUnreadBadge(null)
        assertEquals("…", unknown?.text)
        assertEquals(BadgeTone.COUNT, unknown?.tone)
        assertFalse(unknown?.description.orEmpty().any { it.isDigit() })
        assertNull("no unread reply, no badge", reportUnreadBadge(0))
        assertEquals("2", reportUnreadBadge(2)?.text)
        assertEquals("2 unread replies", reportUnreadBadge(2)?.description)
        assertEquals("99+", reportUnreadBadge(120)?.text)
    }

    @Test fun `quest tabs badge claimable counts only`() {
        val tabs = questsTabs(mapOf("DAILY" to 2), keepTier = 9)
        assertEquals("2", tabs.first { it.id == "DAILY" }.badge?.text)
        assertEquals(BadgeTone.READY, tabs.first { it.id == "DAILY" }.badge?.tone)
        assertNull(tabs.first { it.id == "KINGDOM" }.badge)
        assertEquals("ui_portrait_keep_t4", tabs.first { it.id == "KINGDOM" }.icon)
    }
}
