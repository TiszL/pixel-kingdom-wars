package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.data.ChatBounds
import gg.pixelkingdomwars.nativeclient.data.ChatCardState
import gg.pixelkingdomwars.nativeclient.model.ChatAuthor
import gg.pixelkingdomwars.nativeclient.model.ChatAuthorCard
import gg.pixelkingdomwars.nativeclient.model.ChatAuthorClan
import gg.pixelkingdomwars.nativeclient.model.ChatMessage
import gg.pixelkingdomwars.nativeclient.model.ChatStatus
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import java.util.UUID

/** Owner, 0.5.4: "chatbox is not convenient to use". These pin why each piece of the rework exists, so a later
 * layout pass cannot quietly bring back the two-message log or the composer that loses what was typed. */
class ChatConvenienceTest {
    private val bounds = ChatBounds(50, 200, 1024, 4, 280, 2500, 25000)
    private val base = Instant.parse("2026-09-18T12:00:00Z")
    private fun message(id: Int, author: String, atSeconds: Long, own: Boolean = false, text: String = "hello $id", avatar: String? = null) =
        ChatMessage(id.toString(), UUID.nameUUIDFromBytes("m$id".toByteArray()).toString(), text, base.plusSeconds(atSeconds).toString(),
            ChatAuthor(author, avatar, false), canBlock = !own)
    private fun measured(text: String) = chatDraftMeasure(text, bounds) { it.codePointCount(0, it.length) }
    private fun status(reason: String?, mutedUntil: String? = null) = ChatStatus(true, reason == null, reason, mutedUntil, "9", 2500, 25000)

    // ---- grouping
    @Test fun `consecutive messages by one sender share a single name and avatar row`() {
        val rows = chatRows(listOf(message(1, "ironvale", 0), message(2, "ironvale", 20), message(3, "ironvale", 45), message(4, "69arc", 50), message(5, "ironvale", 55)))
        assertEquals(listOf(true, false, false, true, true), rows.map { it.head })
    }
    @Test fun `a long pause starts a new run so its time is shown again`() {
        val rows = chatRows(listOf(message(1, "ironvale", 0), message(2, "ironvale", CHAT_GROUP_WINDOW_MS / 1000), message(3, "ironvale", CHAT_GROUP_WINDOW_MS / 1000 * 2 + 1)))
        assertEquals(listOf(true, false, true), rows.map { it.head })
    }
    @Test fun `own messages are marked from the viewer-relative permission and never merge into another player's run`() {
        // Public chat exposes no author key: another player may carry the same display name as the viewer.
        val rows = chatRows(listOf(message(1, "keeper", 0), message(2, "keeper", 5, own = true), message(3, "keeper", 9, own = true)))
        assertEquals(listOf(false, true, true), rows.map { it.own })
        assertEquals(listOf(true, true, false), rows.map { it.head })
    }
    @Test fun `a changed avatar or an out-of-order clock does not hide who is speaking`() {
        assertEquals(listOf(true, true), chatRows(listOf(message(1, "ironvale", 0), message(2, "ironvale", 5, avatar = "/api/avatars/x.webp"))).map { it.head })
        assertEquals(listOf(true, true), chatRows(listOf(message(1, "ironvale", 60), message(2, "ironvale", 0))).map { it.head })
        assertTrue(chatRows(emptyList()).isEmpty())
    }
    @Test fun `time is a bare clock today and names the day for older runs`() {
        val zone = ZoneId.of("UTC")
        assertEquals("14:05", chatStamp("2026-09-18T14:05:00Z", Instant.parse("2026-09-18T20:00:00Z"), zone, Locale.UK))
        assertEquals("17 SEP", chatStamp("2026-09-17T23:59:00Z", Instant.parse("2026-09-18T00:01:00Z"), zone, Locale.US))
        assertEquals("", chatStamp("invalid", base, zone, Locale.UK))
    }

    // ---- counter visibility
    @Test fun `counter stays silent until the player is close to the catalogue limit`() {
        assertNull("an empty field owes the player no row", chatCounter(measured(""), bounds))
        assertNull(chatCounter(measured("hello there"), bounds))
        assertNull(chatCounter(measured("a".repeat(bounds.maxGraphemes - CHAT_COUNTER_NEAR - 1)), bounds))
        val near = requireNotNull(chatCounter(measured("a".repeat(bounds.maxGraphemes - CHAT_COUNTER_NEAR)), bounds))
        assertEquals("240/280", near.text); assertFalse("approaching the limit is information, not an error", near.warning)
        assertNull("without catalogue limits there is nothing truthful to count against", chatCounter(measured("hello"), null))
    }
    @Test fun `counter names the limit that is broken and uses the catalogue numbers`() {
        val long = requireNotNull(chatCounter(measured("a".repeat(bounds.maxGraphemes + 5)), bounds))
        assertEquals("285/280", long.text); assertTrue(long.warning)
        val lines = requireNotNull(chatCounter(measured("a\nb\nc\nd\ne"), bounds))
        assertEquals("5/4 LINES", lines.text); assertTrue(lines.warning)
        val tight = bounds.copy(maxUtf8Bytes = 8, maxGraphemes = 200)
        val bytes = requireNotNull(chatCounter(chatDraftMeasure("😀😀😀", tight) { 3 }, tight))
        assertEquals("MESSAGE TOO LARGE", bytes.text); assertTrue(bytes.warning)
        assertEquals("9/8", chatCounter(chatDraftMeasure("123456789", bounds.copy(maxGraphemes = 8)) { it.length }, bounds.copy(maxGraphemes = 8))?.text)
    }
    @Test fun `links and markup raise the rule as a hint but never decide whether SEND is allowed`() {
        for (text in listOf("join https://example.com now", "www.example.com", "visit example.org today", "ping 10.0.0.1", "<b>hi</b>", "[x](y)", "`code`", "**bold**", "__under__")) {
            val hint = requireNotNull(chatCounter(measured(text), bounds)) { text }
            assertEquals(text, "NO LINKS OR MARKUP", hint.text); assertTrue(hint.warning)
            assertTrue("the server is the judge; a false positive must not block a message: $text", chatCanSend(status(null), true, false, false, measured(text)))
        }
        for (text in listOf("gg that was close", "3.5 stars", "wait... what", "@ironvale thanks", "a_b", "5 * 3")) assertNull(text, chatCounter(measured(text), bounds))
    }

    // ---- composer lock and SEND
    @Test fun `a request in flight never locks the composer, only a real reason does`() {
        assertNull("status still loading: the player may already type", chatLock(null, true) { it })
        assertNull(chatLock(status(null), true) { it })
        assertEquals(ChatLock("SET A USERNAME TO CHAT", ChatUnlock.PROFILE), chatLock(status("USERNAME_REQUIRED"), true) { it })
        assertEquals(ChatLock("A DEED IS REQUIRED TO CHAT", ChatUnlock.LAND), chatLock(status("DEED_REQUIRED"), true) { it })
        assertEquals(ChatLock("MUTED UNTIL 5:40 PM", null), chatLock(status("MUTED", "2026-09-18T17:40:00Z"), true) { "5:40 PM" })
        assertEquals(ChatLock("CHAT MUTED", null), chatLock(status("MUTED"), true) { it })
        assertEquals("missing limits outrank an open status: nothing could be validated", ChatLock("CHAT LIMITS UNAVAILABLE — UPDATE GAME CONTENT", null), chatLock(status(null), false) { it })
    }
    @Test fun `SEND follows this composer's own flight and the saved-message recovery, not the poll`() {
        val ok = measured("hello")
        assertTrue(chatCanSend(status(null), true, pendingSaved = false, sending = false, measure = ok))
        assertFalse("one flight at a time: a double tap must not send the text twice", chatCanSend(status(null), true, false, sending = true, measure = ok))
        assertFalse("an interrupted message is resolved before another is sent", chatCanSend(status(null), true, pendingSaved = true, sending = false, measure = ok))
        assertFalse(chatCanSend(status("MUTED"), true, false, false, ok))
        assertFalse(chatCanSend(null, true, false, false, ok))
        assertFalse(chatCanSend(status(null), false, false, false, ok))
        assertFalse(chatCanSend(status(null), true, false, false, measured("   ")))
    }

    // ---- send keeps the draft
    @Test fun `a failed send keeps every typed character and says why`(): Unit = runBlocking {
        var field = "hello keepers"
        val failed = chatSubmit("hello keepers", { field }) { field += " and more"; throw IOException("reply lost") }
        assertEquals(ChatSubmit.Failed("hello keepers and more", "reply lost"), failed)
        val silent = chatSubmit("x", { "x" }) { throw IllegalStateException() }
        assertEquals("Chat connection interrupted. Refresh to check.", (silent as ChatSubmit.Failed).reason)
    }
    @Test fun `a delivered send clears only what was delivered so typing can continue`(): Unit = runBlocking {
        assertEquals(ChatSubmit.Sent(""), chatSubmit("gg", { "gg" }) {})
        var field = "gg"
        assertEquals("text typed while the send was in flight survives", ChatSubmit.Sent("next one"), chatSubmit("gg", { field }) { field = "gg next one" })
        assertEquals("an edited draft is the player's, not ours to clear", "g", chatDraftAfterSend("g", "gg"))
    }
    @Test fun `cancellation is not reported as a failed send`() {
        assertThrows(kotlinx.coroutines.CancellationException::class.java) { runBlocking { chatSubmit("gg", { "gg" }) { throw kotlinx.coroutines.CancellationException("left chat") } } }
    }

    // ---- follow the latest / NEW MESSAGES
    private fun rows(vararg ids: Int, own: Set<Int> = emptySet()) = chatRows(ids.map { message(it, if (it in own) "me" else "other$it", it.toLong(), own = it in own) })
    @Test fun `a player at the newest message follows arrivals and sees no chip`() {
        val next = chatFollow("3", rows(1, 2, 3, 4, 5), following = true, unseen = emptySet(), listVisible = true)
        assertEquals(ChatFollow("5", emptySet(), scrollToLatest = true), next)
    }
    @Test fun `a player reading history is left where they are and told what arrived`() {
        val next = chatFollow("3", rows(1, 2, 3, 4, 5), following = false, unseen = emptySet(), listVisible = true)
        assertEquals(ChatFollow("5", setOf("4", "5"), scrollToLatest = false), next)
        assertEquals("2 NEW MESSAGES ↓", chatNewLabel(next.unseen.size)); assertEquals("1 NEW MESSAGE ↓", chatNewLabel(1))
        val redacted = chatFollow("5", rows(1, 2, 3, 5), following = false, unseen = next.unseen, listVisible = true)
        assertEquals("a removed message stops counting", setOf("5"), redacted.unseen)
    }
    @Test fun `older history and the first page never raise the chip`() {
        assertEquals(ChatFollow("9", emptySet(), scrollToLatest = true), chatFollow(null, rows(7, 8, 9), following = false, unseen = emptySet(), listVisible = true))
        assertEquals(ChatFollow("9", emptySet(), scrollToLatest = false), chatFollow("9", rows(1, 2, 7, 8, 9), following = false, unseen = emptySet(), listVisible = true))
        assertEquals(ChatFollow(null, emptySet(), scrollToLatest = false), chatFollow(null, emptyList(), following = true, unseen = emptySet(), listVisible = true))
    }
    @Test fun `the player's own message always brings them to it and is never counted as new`() {
        val next = chatFollow("3", rows(1, 2, 3, 4, own = setOf(4)), following = false, unseen = setOf("3"), listVisible = true)
        assertEquals(ChatFollow("4", emptySet(), scrollToLatest = true), next)
    }
    @Test fun `a selected message holds the log still so its report and block cannot slide away`() {
        val held = chatFollow("3", rows(1, 2, 3, 4), following = true, unseen = emptySet(), listVisible = true, holding = true)
        assertEquals(ChatFollow("4", setOf("4"), scrollToLatest = false), held)
        val own = chatFollow("3", rows(1, 2, 3, 4, own = setOf(4)), following = true, unseen = emptySet(), listVisible = true, holding = true)
        assertTrue("sending is a decision to go to the newest message", own.scrollToLatest)
    }
    @Test fun `the blocked-players list is not scrolled but still counts what arrives behind it`() {
        val next = chatFollow("3", rows(1, 2, 3, 4), following = true, unseen = emptySet(), listVisible = false)
        assertEquals(ChatFollow("4", setOf("4"), scrollToLatest = false), next)
    }

    // ---- selected-message actions
    @Test fun `report and block stay reachable for exactly the message the player tapped`() {
        // Rewritten 2026-09-18 (owner: tapping a player shows their profile): every message also offers PROFILE, because
        // a grouped line has no avatar or name to tap and a compact landscape line writes its name inside the text.
        // MENTION stays first; REPORT and BLOCK are exactly as before.
        val other = chatRows(listOf(message(1, "ironvale", 0))).single()
        assertEquals(listOf(ChatMessageAction.MENTION, ChatMessageAction.PROFILE, ChatMessageAction.COPY, ChatMessageAction.REPORT, ChatMessageAction.BLOCK), chatMessageActions(other, canMention = true))
        assertEquals("a locked composer cannot mention, moderation is untouched", listOf(ChatMessageAction.PROFILE, ChatMessageAction.COPY, ChatMessageAction.REPORT, ChatMessageAction.BLOCK), chatMessageActions(other, canMention = false))
        val own = chatRows(listOf(message(2, "me", 0, own = true))).single()
        assertEquals("the server offers no block for the viewer's own message", listOf(ChatMessageAction.PROFILE, ChatMessageAction.COPY, ChatMessageAction.REPORT), chatMessageActions(own, canMention = true))
        val grouped = chatRows(listOf(message(3, "ironvale", 0), message(4, "ironvale", 5))).last()
        assertFalse(grouped.head); assertTrue("the only way to a card from a line without an avatar", ChatMessageAction.PROFILE in chatMessageActions(grouped, canMention = false))
    }

    // ---- player card
    @Test fun `a card offers exactly its message's moderation actions and the viewer's own card offers none`() {
        val other = chatRows(listOf(message(1, "ironvale", 0))).single()
        assertEquals(listOf(ChatMessageAction.MENTION, ChatMessageAction.REPORT, ChatMessageAction.BLOCK), chatCardActions(other, canMention = true))
        assertEquals("a locked composer cannot mention from the card either", listOf(ChatMessageAction.REPORT, ChatMessageAction.BLOCK), chatCardActions(other, canMention = false))
        val own = chatRows(listOf(message(2, "me", 0, own = true))).single()
        assertEquals("nobody mentions, reports or blocks themselves from their own card", emptyList<ChatMessageAction>(), chatCardActions(own, canMention = true))
        val unblockable = ChatRow(other.message.copy(canBlock = false), head = true, own = false)
        assertFalse("the card never offers what the message does not", ChatMessageAction.BLOCK in chatCardActions(unblockable, canMention = true))
    }
    @Test fun `a card that cannot be read still offers its message's report and block`() {
        // Production has no card route today, so EVERY card there ends Unavailable. Tapping a player to report or
        // block them (what 58e2776 made findable) must not show the actions for the blink of Loading and then swap
        // them for a dead end. The actions are the message's own; nothing in them waits for the card response.
        val other = chatRows(listOf(message(1, "ironvale", 0))).single()
        val loaded = ChatCardState.Loaded(ChatAuthorCard("ironvale", null, false, 2, 9, 40, null))
        val states = listOf(ChatCardState.Loading, loaded, ChatCardState.Unavailable, ChatCardState.RateLimited(13_000), ChatCardState.RateLimited(1_000), ChatCardState.RateLimited(null))
        for (state in states) {
            assertEquals("$state", listOf(ChatMessageAction.MENTION, ChatMessageAction.REPORT, ChatMessageAction.BLOCK), chatCardBody(state, other, canMention = true, nowMs = 5_000).actions)
            assertEquals("$state, composer locked", listOf(ChatMessageAction.REPORT, ChatMessageAction.BLOCK), chatCardBody(state, other, canMention = false, nowMs = 5_000).actions)
        }
        val own = chatRows(listOf(message(2, "me", 0, own = true))).single()
        for (state in states) assertEquals("the viewer's own card stays facts only, $state", emptyList<ChatMessageAction>(), chatCardBody(state, own, canMention = true, nowMs = 5_000).actions)
        // What replaces the facts is unchanged: one neutral line, the wait counted down, then the player's own TRY AGAIN.
        assertEquals(ChatCardBody(null, CHAT_CARD_UNAVAILABLE, false, listOf(ChatMessageAction.REPORT, ChatMessageAction.BLOCK)), chatCardBody(ChatCardState.Unavailable, other, false, 5_000))
        assertEquals("TRY AGAIN IN 8s", chatCardBody(ChatCardState.RateLimited(13_000), other, false, 5_000).note)
        assertFalse(chatCardBody(ChatCardState.RateLimited(13_000), other, false, 5_000).retry)
        assertTrue("the named wait has passed", chatCardBody(ChatCardState.RateLimited(1_000), other, false, 5_000).retry)
        assertNull("facts and the one line never show together", chatCardBody(loaded, other, false, 5_000).note)
        assertEquals(chatCardFacts(loaded.card), chatCardBody(loaded, other, false, 5_000).facts)
        assertEquals(chatCardFacts(null), chatCardBody(ChatCardState.Loading, other, false, 5_000).facts)
    }
    @Test fun `a report says whose words and which words it files, also when it was pressed on a player's card`() {
        // REPORT is message-level on the wire. Only a run's head line has an avatar and a name, so a card opened by
        // tapping the player is bound to that head line: ironvale's innocuous "me", not the two lines under it. The
        // dialog quotes exactly the message whose id it sends, so the player sees that before a daily report is spent.
        val rows = chatRows(listOf(message(1, "ironvale", 0, text = "me"), message(2, "ironvale", 5, text = "grouped line"), message(3, "ironvale", 9, text = " second\n\n  grouped line ")))
        val head = rows.single { it.head }
        assertEquals("1", head.message.id)
        assertEquals(ChatReportPrompt("ironvale", "“me”"), chatReportPrompt(head.message))
        assertEquals("the row path names its own line", ChatReportPrompt("ironvale", "“grouped line”"), chatReportPrompt(rows[1].message))
        assertEquals("line breaks never hide the rest of the message behind the first line", "“second grouped line”", chatReportPrompt(rows[2].message).quote)
    }
    @Test fun `the card says three things and words the empty ones instead of showing a zero or a blank`() {
        val owner = ChatAuthorCard("Aldric", null, true, 2, 9, 12_340, ChatAuthorClan("Iron Crest", "IRON"))
        assertEquals(listOf(ChatCardFact("KINGDOMS", "2"), ChatCardFact("HIGHEST KEEP", "LEVEL 9"), ChatCardFact("TROPHIES", "12340")), chatCardFacts(owner))
        assertEquals("[IRON] Iron Crest", chatCardClan(owner))
        val landless = owner.copy(bases = 0, highestKeepLevel = 4, trophies = 0, clan = null)
        assertEquals("a landless player still has a Keep", listOf(ChatCardFact("NO KINGDOM YET", ""), ChatCardFact("HIGHEST KEEP", "LEVEL 4"), ChatCardFact("TROPHIES", "0")), chatCardFacts(landless))
        assertNull("no clan, no line", chatCardClan(landless))
        assertEquals("no base at all", ChatCardFact("HIGHEST KEEP", "—"), chatCardFacts(landless.copy(highestKeepLevel = null))[1])
        assertEquals("still loading: the same three lines, no values yet", listOf("KINGDOMS", "HIGHEST KEEP", "TROPHIES"), chatCardFacts(null).map { it.label })
        assertTrue(chatCardFacts(null).all { it.value == null })
    }
    @Test fun `a rate-limited card counts its wait down and then leaves the retry to the player`() {
        assertEquals("TRY AGAIN IN 12s", chatCardWaitLine(untilMs = 13_000, nowMs = 1_000))
        assertEquals("a started second is still a second to wait", "TRY AGAIN IN 1s", chatCardWaitLine(13_000, 12_001))
        assertNull("the wait is over: TRY AGAIN is a button the player presses", chatCardWaitLine(13_000, 13_000))
        assertEquals("the server named no wait", "TRY AGAIN LATER", chatCardWaitLine(null, 1_000))
    }
    @Test fun `only a frame too short for the plate gives up its keyboard for a card`() {
        assertTrue("landscape with the keyboard up", chatCardClosesKeyboard(150f))
        assertFalse("portrait with the keyboard up keeps the keyboard and the draft in view", chatCardClosesKeyboard(520f))
        assertFalse(chatCardClosesKeyboard(Float.NaN))
    }
    @Test fun `tapping toggles one selection and a message that left the log takes its actions with it`() {
        assertEquals("4", chatSelect(null, "4")); assertEquals("5", chatSelect("4", "5")); assertNull(chatSelect("4", "4"))
        val log = rows(1, 2, 3)
        assertEquals("2", chatSelectionIn("2", log)); assertNull("blocked or redacted while selected", chatSelectionIn("9", log)); assertNull(chatSelectionIn(null, log))
    }
    @Test fun `report and block behind a tap are announced until the player has opened a message's actions once`() {
        // They used to be on screen under every message. A harassed player must not have to guess that a message is tappable.
        val log = rows(1, 2, 3, own = setOf(2))
        assertEquals("TAP A MESSAGE TO REPORT OR BLOCK", chatActionsHint(log, usedActions = false, shortFrame = false))
        assertNull("found once, the line gives its place back to messages", chatActionsHint(log, usedActions = true, shortFrame = false))
        assertNull("a landscape keyboard frame keeps its few rows for messages", chatActionsHint(log, usedActions = false, shortFrame = true))
        assertNull("nobody to report in an empty log", chatActionsHint(emptyList(), usedActions = false, shortFrame = false))
        assertNull("the viewer's own messages offer no block", chatActionsHint(rows(1, 2, own = setOf(1, 2)), usedActions = false, shortFrame = false))
    }
    @Test fun `the one-row recovery names the whole saved message on its single line`() {
        // One ellipsized line: a line break would hide everything after it, and the player decides RETRY from this text.
        assertEquals("INTERRUPTED: on my way back now", chatInterruptedLine("on my way\nback\nnow"))
        assertEquals("INTERRUPTED: hello", chatInterruptedLine("hello"))
    }
}
