package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.data.ChatBounds
import gg.pixelkingdomwars.nativeclient.data.ChatState
import gg.pixelkingdomwars.nativeclient.data.SavedChatMessage
import gg.pixelkingdomwars.nativeclient.model.ChatAuthor
import gg.pixelkingdomwars.nativeclient.model.ChatMention
import gg.pixelkingdomwars.nativeclient.model.ChatMessage
import gg.pixelkingdomwars.nativeclient.model.ChatStatus
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CHAT_CLAN
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CHAT_WORLD
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ChatItemUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.chatTabs
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.CLAN_CHAT_UNAVAILABLE_REASON
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.chatBlockedReason as drawerBlockedReason
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.chatCanSend as drawerCanSend
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import java.util.UUID

/** The designed Chat drawer (hub SPEC §2.9) over the live global chat. These pin why each mapping exists: the drawer
 * must keep every rule of the 0.5.x composer (bounds, the saved outbox, moderation) and must never draw a channel,
 * an emote or a place the server does not have. */
class ChatLiveMapperTest {
    private val bounds = ChatBounds(50, 200, 1024, 4, 280, 2500, 25000)
    private val zone = ZoneId.of("UTC")
    private val locale = Locale.UK
    private val now = Instant.parse("2026-10-05T12:00:00Z")
    private val saved = SavedChatMessage("offline-chat-fixture", "https://localhost:18443", UUID.nameUUIDFromBytes("saved".toByteArray()).toString(), "brb, wall upgrade")
    private val paused = ChatStatus(false, false, "DISABLED", null, "9", 2500, 25000)
    private fun status(reason: String? = null) = ChatStatus(true, reason == null, reason, null, "9", 2500, 25000)
    private fun message(id: Int, author: String = "ironvale", own: Boolean = false, text: String = "hello $id", at: String = "2026-10-05T11:00:00Z",
        mentioned: Boolean = false, mentions: List<ChatMention> = emptyList()) =
        ChatMessage(id.toString(), UUID.nameUUIDFromBytes("m$id".toByteArray()).toString(), text, at, ChatAuthor(author, null, false),
            canBlock = !own, mentions = mentions, mentioned = mentioned)
    private fun ui(state: ChatState, draft: String = "", limits: ChatBounds? = bounds, tab: String = CHAT_WORLD, sending: Boolean = false,
        offline: String? = null, canGetLand: Boolean = true, focus: String? = null) =
        chatDrawerUi(state, limits, draft, chatDraftMeasure(draft, limits) { it.codePointCount(0, it.length) }, tab = tab, sending = sending,
            offline = offline, canGetLand = canGetLand, focusHold = focus, now = now, zone = zone, locale = locale)

    // ---- the saved outbox
    @Test fun `an interrupted own message is the failed bubble whose tap retries the one saved message`() {
        val state = ChatState(status = status(), messages = listOf(message(1)), pending = saved)
        val drawn = ui(state, draft = "next one")
        val bubble = drawn.items.filterIsInstance<ChatItemUi.Message>().last()
        assertTrue("the design's red ! and Tap to retry", bubble.failed); assertTrue(bubble.mine)
        assertEquals("the exact saved text, never the draft", "brb, wall upgrade", bubble.text); assertEquals(chatPendingId(saved), bubble.id)
        assertTrue("the recovery line under the saved bubble", drawn.items.any { it is ChatItemUi.System && it.text == CHAT_RECOVERY_HINT })
        // Rewritten 2026-10-06 (dead-end audit): this pinned "a saved message holds SEND", the dead end the owner rule
        // replaces (shape B: no GET lists one exact message id completely and chat moves no money). The saved message
        // keeps its bubble and RETRY while a new one may send; only a full outbox still holds SEND.
        assertTrue("an unconfirmed saved message never blocks a new one", drawn.canSend)
        assertFalse("a full outbox still holds SEND", ui(state.copy(outboxFull = true), draft = "next one").canSend)
        assertNull("idle and enabled: the tap retries", chatRetryRefusal(state, bubble.id))
        // A second retry queued behind the first would find the outbox already cleared, so busy explains instead.
        assertEquals(CHAT_RETRY_BUSY, chatRetryRefusal(state.copy(busy = true), bubble.id))
        assertEquals(CHAT_RETRY_PAUSED, chatRetryRefusal(state.copy(status = paused), bubble.id))
        assertEquals(CHAT_RETRY_GONE, chatRetryRefusal(state.copy(pending = null), bubble.id))
    }
    @Test fun `a saved message the log already holds as the viewer's own is never drawn twice`() {
        val delivered = ChatMessage("7", saved.clientMessageId, saved.text, "2026-10-05T11:30:00Z", ChatAuthor("qa_fixture", null, false), canBlock = false)
        val drawn = ui(ChatState(status = status(), messages = listOf(delivered), pending = saved))
        assertTrue(drawn.items.filterIsInstance<ChatItemUi.Message>().none { it.failed })
        assertTrue(drawn.items.none { it.id == CHAT_ITEM_RECOVERY })
    }

    // ---- channels
    @Test fun `clan is locked with its reason and never sends while world chat does`() {
        val state = ChatState(status = status(), messages = listOf(message(1)))
        val world = ui(state, draft = "hello")
        assertEquals(CLAN_CHAT_UNAVAILABLE_REASON, world.clanLockedReason)
        assertTrue(drawerCanSend(world))
        val clan = ui(state, draft = "hello", tab = CHAT_CLAN)
        assertEquals(CHAT_CLAN, clan.tab)
        assertEquals("the locked tab says why in place of the composer", CLAN_CHAT_UNAVAILABLE_REASON, drawerBlockedReason(clan))
        assertFalse(drawerCanSend(clan))
        assertTrue("no clan channel exists, so world lines are never shown as clan chat", clan.items.isEmpty())
        assertTrue("CLAN draws its padlock", chatTabs(clan).single { it.id == CHAT_CLAN }.locked)
        assertEquals("an unknown tab is world chat", CHAT_WORLD, ui(state, tab = "GUILD").tab)
    }

    // ---- server status
    @Test fun `a paused server draws the paused state and refuses send`() {
        val drawn = ui(ChatState(status = paused), draft = "hello")
        assertTrue(drawn.paused); assertEquals(CHAT_PAUSED_STRIP, drawn.blockedReason)
        assertFalse(drawn.canSend); assertFalse(drawerCanSend(drawn))
        assertTrue("paused is not an empty log", drawn.items.none { it.id == CHAT_ITEM_EMPTY })
    }
    @Test fun `the blocked strip opens its own unlock or says it has none`() {
        val username = ui(ChatState(status = status("USERNAME_REQUIRED")))
        assertEquals("SET A USERNAME TO CHAT", username.blockedReason); assertEquals("SET USERNAME", username.blockedAction)
        assertEquals(ChatUnlock.PROFILE, chatUnlockFor(requireNotNull(username.blockedLink)))
        val land = ui(ChatState(status = status("DEED_REQUIRED")))
        assertEquals("GET LAND", land.blockedAction); assertEquals(ChatUnlock.LAND, chatUnlockFor(requireNotNull(land.blockedLink)))
        val noLand = ui(ChatState(status = status("DEED_REQUIRED")), canGetLand = false)
        assertEquals("A DEED IS REQUIRED TO CHAT", noLand.blockedReason)
        assertNull("no land route on this screen: no button that cannot open", noLand.blockedAction); assertNull(noLand.blockedLink)
        assertNull("a link chat does not own is explained by the screen, never opened", chatUnlockFor(HubLink(FeatureId("hud.quests"))))
    }

    // ---- composer
    @Test fun `a draft over the catalogue bounds refuses send and the counter says why`() {
        val state = ChatState(status = status(), messages = listOf(message(1)))
        val over = ui(state, draft = "x".repeat(bounds.maxGraphemes + 1))
        assertFalse(over.canSend); assertFalse(drawerCanSend(over))
        val counter = over.items.single { it.id == CHAT_ITEM_COUNTER } as ChatItemUi.System
        assertEquals(Verb.RED, counter.tone); assertEquals("${bounds.maxGraphemes + 1}/${bounds.maxGraphemes}", counter.text)
        val fits = ui(state, draft = "hello")
        assertTrue(fits.canSend); assertTrue(drawerCanSend(fits)); assertTrue("a short draft says nothing", fits.items.none { it.id == CHAT_ITEM_COUNTER })
        val noLimits = ui(state, draft = "hello", limits = null)
        assertFalse("no catalogue bounds, no sending", noLimits.canSend)
        assertEquals("CHAT LIMITS UNAVAILABLE — UPDATE GAME CONTENT", noLimits.blockedReason)
    }
    @Test fun `a send in flight refuses another without disabling the field`() {
        val inFlight = ui(ChatState(status = status(), messages = listOf(message(1))), draft = "hello", sending = true)
        assertFalse(inFlight.canSend)
        // The drawer disables its field while `sending`; a disabled field drops focus, the keyboard and what was typed.
        assertFalse(inFlight.sending)
    }

    // ---- the log
    @Test fun `a mention of the player carries the server flag and its handle`() {
        val mentioned = message(3, text = "@qa_fixture spot 142 is yours", mentioned = true, mentions = listOf(ChatMention(0, 11)))
        val lines = ui(ChatState(status = status(), messages = listOf(mentioned, message(4, text = "plain")))).items.filterIsInstance<ChatItemUi.Message>()
        assertTrue(lines[0].mentionsMe); assertEquals("only a server-resolved span is a handle", "@qa_fixture", lines[0].mentionHandle)
        assertFalse(lines[1].mentionsMe); assertNull(lines[1].mentionHandle)
    }
    @Test fun `the drawer never fabricates emotes or shared places`() {
        val drawn = ui(ChatState(status = status(), messages = listOf(message(1, text = "Spot 142 · Seeker Island · live"), message(2, text = "gg"))))
        assertTrue("the wire has no emote or place", drawn.items.none { it is ChatItemUi.Place || it is ChatItemUi.Emote })
        assertFalse(drawn.emotesOpen)
        assertEquals("the emote button explains instead", "Emotes are not open on this server yet.", CHAT_EMOTES_CLOSED)
    }
    @Test fun `own messages are marked and every day gets one divider`() {
        val drawn = ui(ChatState(status = status(), messages = listOf(message(1, at = "2026-10-04T23:00:00Z"),
            message(2, own = true, at = "2026-10-05T09:00:00Z"), message(3, at = "2026-10-05T10:00:00Z"))))
        assertEquals(listOf("4 Oct", "Today"), drawn.items.filterIsInstance<ChatItemUi.Day>().filter { it.id != CHAT_ITEM_TAIL }.map { it.label })
        assertEquals("the viewer-relative permission, as the old log", listOf(false, true, false), drawn.items.filterIsInstance<ChatItemUi.Message>().map { it.mine })
    }
    @Test fun `a reader at the newest end keeps following because the log always ends with the same line`() {
        // The drawer's list keeps its place by item key: a newest line that never changes key is what lets an arrival show.
        val before = ui(ChatState(status = status(), messages = listOf(message(1))))
        val after = ui(ChatState(status = status(), messages = listOf(message(1), message(2))), draft = "x".repeat(bounds.maxGraphemes + 1))
        assertEquals(CHAT_ITEM_TAIL, before.items.last().id); assertEquals(CHAT_ITEM_TAIL, after.items.last().id)
        assertTrue("an empty log has no message to long-press", ui(ChatState(status = status())).items.none { it.id == CHAT_ITEM_TAIL })
    }
    @Test fun `opening at a peeked message ends the log there until the hold is released`() {
        val state = ChatState(status = status(), messages = listOf(message(1), message(2), message(3)), pending = saved)
        val held = ui(state, focus = "2")
        assertEquals("2", held.items.last().id)
        assertTrue(held.items.none { it.id == "3" || it.id == CHAT_ITEM_TAIL || it.id == chatPendingId(saved) })
        val released = ui(state)
        assertEquals(CHAT_ITEM_TAIL, released.items.last().id)
        assertEquals("a message no longer in the log holds nothing back", released.items, ui(state, focus = "99").items)
    }
    @Test fun `earlier pages are offered while the server has them and one pull asks once`() {
        val withOlder = ChatState(status = status(), messages = listOf(message(5)), before = "5")
        assertEquals(CHAT_ITEM_OLDER, ui(withOlder).items.first().id)
        assertTrue(chatPullLoadsOlder(12f, withOlder, inFlight = false))
        assertFalse("a drag towards the newest end", chatPullLoadsOlder(-12f, withOlder, inFlight = false))
        assertFalse("one request at a time", chatPullLoadsOlder(12f, withOlder, inFlight = true))
        assertFalse("the repository is busy", chatPullLoadsOlder(12f, withOlder.copy(busy = true), inFlight = false))
        assertFalse("nothing older on the server", chatPullLoadsOlder(12f, withOlder.copy(before = null), inFlight = false))
        assertTrue(ui(withOlder.copy(before = null)).items.none { it.id == CHAT_ITEM_OLDER })
    }
    @Test fun `a failed read stays said and an empty log says loading or empty`() {
        val offline = ui(ChatState(status = status()), offline = "Chat connection interrupted. Refresh to check.")
        assertEquals(Verb.RED, (offline.items.single { it.id == CHAT_ITEM_OFFLINE } as ChatItemUi.System).tone)
        assertEquals(CHAT_EMPTY_LINE, (offline.items.single { it.id == CHAT_ITEM_EMPTY } as ChatItemUi.System).text)
        assertEquals(CHAT_LOADING_LINE, (ui(ChatState(busy = true)).items.single { it.id == CHAT_ITEM_EMPTY } as ChatItemUi.System).text)
        assertEquals("without bounds chat never reads, so it is not loading", CHAT_EMPTY_LINE,
            (ui(ChatState(), limits = null).items.single { it.id == CHAT_ITEM_EMPTY } as ChatItemUi.System).text)
    }

    // ---- moderation
    @Test fun `a long-press opens a message's options and explains anything else`() {
        val messages = listOf(message(1))
        assertNull(chatLongPressRefusal("1", messages))
        assertEquals("the unsent bubble retries on a tap", CHAT_PENDING_HINT, chatLongPressRefusal(chatPendingId(saved), messages))
        assertEquals(CHAT_MESSAGE_GONE, chatLongPressRefusal("2", messages))
    }
    @Test fun `block asks first and report and block read as the destructive options`() {
        val confirm = chatBlockConfirm("ironvale")
        assertEquals("BLOCK ironvale?", confirm.title); assertEquals("BLOCK", confirm.confirmLabel); assertEquals(Verb.RED, confirm.tone)
        assertEquals(Verb.RED, chatActionVerb(ChatMessageAction.REPORT)); assertEquals(Verb.RED, chatActionVerb(ChatMessageAction.BLOCK))
        assertEquals("Block ironvale", chatActionDescription(ChatMessageAction.BLOCK, "ironvale"))
        assertEquals("Report this message", chatActionDescription(ChatMessageAction.REPORT, "ironvale"))
    }
}
