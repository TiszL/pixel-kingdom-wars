package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.ChatLauncherState
import gg.pixelkingdomwars.nativeclient.data.ChatState
import gg.pixelkingdomwars.nativeclient.model.ChatAuthor
import gg.pixelkingdomwars.nativeclient.model.ChatMessage
import gg.pixelkingdomwars.nativeclient.model.ChatStatus
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CHAT_WORLD
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.chatPeekAllowed
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** Hub SPEC §2.9 "Peek": @mentions only (the server has no clan channel), never world chat, 4 s, one at a time. A peek
 * for every global line would be a world-chat ticker over the base, which the design forbids. */
class HomeChatPeekTest {
    private val status = ChatStatus(true, true, null, null, "9", 2500, 25000)
    private fun message(id: Int, author: String = "moonsunder", text: String = "@qa_fixture thanks for the tip", mentioned: Boolean = true, own: Boolean = false) =
        ChatMessage(id.toString(), UUID.nameUUIDFromBytes("p$id".toByteArray()).toString(), text, "2026-10-05T11:00:00Z",
            ChatAuthor(author, null, false), canBlock = !own, mentioned = mentioned)
    private fun launcher(unread: Map<String, Boolean>, open: Boolean = false, chat: ChatStatus? = status) =
        ChatLauncherState(status = chat, cursor = "9", open = open, unreadMessages = unread)

    @Test fun `a world chat line never peeks even while it is unread`() {
        val state = ChatState(status = status, messages = listOf(message(10, text = "anyone up for a raid", mentioned = false)))
        assertNull(homeChatPeekUi(state, launcher(mapOf("10" to false)), emptySet()))
    }
    @Test fun `a mention peeks as a mention of the player and never as world or global chat`() {
        val peek = requireNotNull(homeChatPeekUi(ChatState(status = status, messages = listOf(message(11))), launcher(mapOf("11" to true)), emptySet()))
        assertEquals("moonsunder", peek.author); assertEquals("11", peek.messageId); assertEquals("@qa_fixture thanks for the tip", peek.text)
        assertEquals(CHAT_PEEK_CHANNEL, peek.channel)
        assertFalse(peek.channel == CHAT_WORLD || peek.channel.equals("GLOBAL", ignoreCase = true))
        assertTrue("the hub's own peek rule agrees", chatPeekAllowed(peek.channel, mentionsMe = true, drawerOpen = false))
    }
    @Test fun `only a mention whose text the reader already holds can peek`() {
        // The closed launcher keeps opaque ids and the mention bit only (web parity): no text, no peek, never a guess.
        assertNull(homeChatPeekUi(ChatState(status = status, messages = listOf(message(11))), launcher(mapOf("12" to true)), emptySet()))
    }
    @Test fun `the viewer's own line never peeks`() {
        assertNull(homeChatPeekUi(ChatState(status = status, messages = listOf(message(13, own = true))), launcher(mapOf("13" to true)), emptySet()))
    }
    @Test fun `mentions peek one at a time oldest first and a shown one never repeats`() {
        val state = ChatState(status = status, messages = listOf(message(20), message(21, author = "ironvale")))
        val unread = launcher(mapOf("21" to true, "20" to true))
        val first = requireNotNull(homeChatPeekUi(state, unread, emptySet()))
        assertEquals("20", first.messageId)
        val shown = homeChatPeekShown(emptySet(), unread, first.messageId)
        val second = requireNotNull(homeChatPeekUi(state, unread, shown))
        assertEquals("21", second.messageId); assertNotEquals("a new key restarts the 4 s hold", first.key, second.key)
        assertNull("both have peeked", homeChatPeekUi(state, unread, homeChatPeekShown(shown, unread, second.messageId)))
    }
    @Test fun `the shown set keeps only ids that are still unread`() {
        assertEquals(setOf("31"), homeChatPeekShown(setOf("20", "21"), launcher(mapOf("31" to true)), "31"))
    }
    @Test fun `a peek is one line`() {
        val peek = requireNotNull(homeChatPeekUi(ChatState(status = status, messages = listOf(message(14, text = "@qa_fixture line one\nline two"))),
            launcher(mapOf("14" to true)), emptySet()))
        assertEquals("@qa_fixture line one line two", peek.text)
    }
    @Test fun `nothing peeks while the drawer is open or chat is off`() {
        val state = ChatState(status = status, messages = listOf(message(11)))
        assertNull("the drawer is the reader", homeChatPeekUi(state, launcher(mapOf("11" to true), open = true), emptySet()))
        assertNull("chat is off for this account", homeChatPeekUi(state, launcher(mapOf("11" to true), chat = null), emptySet()))
    }
}

/** Hub SPEC §3.1: the defence notice is a herald banner (no longer the header Notice bar) and its tap opens the raid log. */
class HomeHeraldTest {
    @Test fun `no defence notice raises no herald`() {
        assertNull(homeHeraldUi(null)); assertNull(homeHeraldUi(" "))
    }
    @Test fun `a defence notice is a shield herald that opens the raid log`() {
        val herald = requireNotNull(homeHeraldUi("YOUR BASE WAS RAIDED ×2 — OPEN RAID LOG"))
        assertEquals("shield", herald.icon)
        assertEquals("hud.shield is registry row 4, the Battle log", FeatureId("hud.shield"), herald.target)
        assertEquals("YOUR BASE WAS RAIDED ×2 — OPEN RAID LOG", herald.text)
    }
    @Test fun `a new notice restarts the banner and the same notice does not`() {
        assertEquals(homeHeraldUi("YOUR BASE WAS RAIDED ×1 — OPEN RAID LOG")?.key, homeHeraldUi("YOUR BASE WAS RAIDED ×1 — OPEN RAID LOG")?.key)
        assertNotEquals(homeHeraldUi("YOUR BASE WAS RAIDED ×1 — OPEN RAID LOG")?.key, homeHeraldUi("YOUR BASE WAS RAIDED ×2 — OPEN RAID LOG")?.key)
    }
}
