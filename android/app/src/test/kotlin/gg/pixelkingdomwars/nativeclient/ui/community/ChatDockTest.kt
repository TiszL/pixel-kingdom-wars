package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.data.ChatBounds
import gg.pixelkingdomwars.nativeclient.data.ChatState
import gg.pixelkingdomwars.nativeclient.data.SavedChatMessage
import gg.pixelkingdomwars.nativeclient.model.ChatStatus
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.BackRegistry
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ChatItemUi
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class ChatDockTest {
    // Rewritten for the designed Chat drawer (hub SPEC §2.9, chat.png; the owner's "designed UI must be finished and the
    // old screens retired"). The old case pinned the 0.5.x portrait bottom sheet of 60 % height. What it protected
    // still holds: the hosted chat is an overlay and the base stays live under it (now under the drawer's 40 % scrim).
    // The drawer is 88 % of the frame wide from the left, so the frame it is given is the whole usable frame.
    @Test fun `portrait gives the drawer the whole usable frame`() {
        for ((width, height) in listOf(390f to 844f, 412f to 780f, 800f to 1280f)) {
            val frame = chatDock(width, height)
            assertTrue(frame.docked); assertEquals(width, frame.widthDp, 0f); assertEquals(height, frame.heightDp, 0f)
        }
    }
    // Rewritten for the designed drawer: the old case pinned the landscape right-side column of 40 % width with a 320dp
    // floor. The drawer has one shape in both orientations; the frame is never wider or taller than what is usable.
    @Test fun `landscape gives the drawer the whole usable frame too`() {
        val seeker = chatDock(915f, 311f)
        assertTrue(seeker.docked); assertEquals(915f, seeker.widthDp, 0f); assertEquals(311f, seeker.heightDp, 0f)
        val tablet = chatDock(1280f, 800f)
        assertEquals(1280f, tablet.widthDp, 0f); assertEquals(800f, tablet.heightDp, 0f)
    }
    // Rewritten for the owner's 0.5.4 report ("chatbox is not convenient to use"), and again for the drawer. What it
    // protects still holds and is asserted: the keyboard is subtracted once, by the caller, and never again here.
    @Test fun `keyboard usable frame is measured once by the caller`() {
        assertEquals(800f, chatDock(1280f, 800f).heightDp, 0f)
        val keyboard = chatDock(1280f, 480f)
        assertTrue(keyboard.docked); assertEquals("the frame is the usable height once", 480f, keyboard.heightDp, 0f)
        assertEquals(1280f, keyboard.widthDp, 0f)
    }
    // Rewritten for the drawer: typing still takes everything above the keyboard (owner 0.5.4); reading now also takes
    // the whole frame instead of 60 % of it, since the drawer replaced the bottom sheet.
    @Test fun `typing in portrait takes everything above the keyboard`() {
        assertEquals(850f, chatDock(411f, 850f).heightDp, 0f)
        val typing = chatDock(411f, 430f)
        assertEquals("the log gets the height the base no longer needs while the player types", 430f, typing.heightDp, 0f)
        assertEquals(411f, typing.widthDp, 0f)
    }
    @Test fun `a portrait phone stays portrait when its keyboard leaves less height than width`() {
        // Usable height is 300dp on a 360dp-wide window: comparing those two once called this landscape and squeezed the
        // chat into a 320dp side column above the keyboard. The drawer has no side column; the frame stays whole.
        val small = chatDock(360f, 300f)
        assertEquals(360f, small.widthDp, 0f); assertEquals(300f, small.heightDp, 0f)
    }
    // Rewritten for the drawer: the old case also pinned that closing the keyboard gave the base back as a 366dp column.
    // The base is now given back by closing the drawer; the short typing frame still keeps the full width.
    @Test fun `typing in a short landscape frame takes the full width so the log and the whole composer fit`() {
        // Owner's phone, landscape, keyboard up: ~150dp of 411dp remain. A 366dp column held no message at all.
        val typing = chatDock(915f, 150f)
        assertEquals(915f, typing.widthDp, 0f); assertEquals(150f, typing.heightDp, 0f)
        assertEquals(915f, chatDock(915f, 387f).widthDp, 0f)
    }
    // Rewritten for the drawer: the old case pinned the compact density of the 0.5.x log (no title row, one line per
    // message under 240dp). The designed drawer keeps its header, its CLOSE and its composer in every frame; what the old
    // rule protected (chat can always be left, the composer is never pushed off) is now the drawer's own layout, so a
    // short frame must still be a real drawer frame and never fall back to the undocked full-screen route.
    @Test fun `a short frame is still a whole drawer frame`() {
        val short = chatDock(915f, 150f)
        assertTrue(short.docked); assertEquals(150f, short.heightDp, 0f)
    }
    // Rewritten for the drawer: the old case pinned a one-row recovery (chatRecoveryInline) for frames under 400dp,
    // because the recovery block above the composer crushed the field, SEND and CLOSE. The saved message is now one
    // bubble in the log ("Tap to retry") and one line, in any frame: nothing is stacked over the composer any more.
    @Test fun `the saved-message recovery lives in the log so it can never crush the composer`() {
        val bounds = ChatBounds(50, 200, 1024, 4, 280, 2500, 25000)
        val saved = SavedChatMessage("offline-chat-fixture", "https://localhost:18443", UUID.nameUUIDFromBytes("dock".toByteArray()).toString(), "lost reply")
        val ui = chatDrawerUi(ChatState(status = ChatStatus(true, true, null, null, "9", 2500, 25000), pending = saved), bounds, "",
            chatDraftMeasure("", bounds) { it.codePointCount(0, it.length) })
        assertEquals(1, ui.items.filterIsInstance<ChatItemUi.Message>().count { it.failed })
        assertEquals(1, ui.items.count { it.id == CHAT_ITEM_RECOVERY })
        assertNull("the composer stays: the recovery does not replace it", ui.blockedReason)
    }
    @Test fun `invalid or transient empty frames cannot produce an oversized or negative dock`() {
        for (height in listOf(0f, -10f, Float.NaN, Float.POSITIVE_INFINITY)) {
            val frame = chatDock(1280f, height)
            assertFalse(frame.docked); assertEquals(0f, frame.heightDp, 0f)
        }
    }
    @Test fun `chat back closes its panel before build or home while real confirmations still win`() {
        val registry = BackRegistry(); val actions = mutableListOf<String>()
        registry.register(BackPriority.HOME) { actions += "exit" }
        val chat = registry.register(CHAT_DOCK_BACK_PRIORITY) { actions += "chat" }
        registry.register(BackPriority.SHEET) { actions += "build" }
        registry.dispatch(); assertEquals(listOf("chat"), actions)
        val confirm = registry.register(BackPriority.CONFIRM) { actions += "consent" }
        registry.dispatch(); assertEquals(listOf("chat", "consent"), actions)
        registry.unregister(confirm); registry.unregister(chat); registry.dispatch()
        assertEquals(listOf("chat", "consent", "build"), actions)
    }
}
