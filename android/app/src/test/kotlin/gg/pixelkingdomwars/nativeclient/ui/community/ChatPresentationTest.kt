package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.data.ChatBounds
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId
import java.util.Locale

class ChatPresentationTest {
    private val bounds = ChatBounds(2, 8, 20, 2, 10, 1000, 2000)
    private fun measured(text: String, limits: ChatBounds? = bounds) = chatDraftMeasure(text, limits) { it.codePointCount(0, it.length) }

    @Test fun `mention replaces current selection and places caret after inserted name without losing suffix`() {
        assertEquals("hi @keeper there" to 11, insertChatMention("hi oldthere", 3, 6, "keeper"))
        assertEquals("hello @keeper " to 14, insertChatMention("hello", 5, 5, "keeper"))
        assertEquals("@keeper " to 8, insertChatMention("", 0, 0, "keeper"))
        assertEquals("hi @keeper there" to 11, insertChatMention("hi oldthere", 6, 3, "keeper"))
    }
    @Test fun `composer limits preserve source newline normalization and reject oversized bytes even with few characters`() {
        assertEquals("one\ntwo", measured("one\r\ntwo").text)
        assertEquals(2, measured("one\rtwo").lines)
        assertTrue(measured("one\ntwo").valid)
        assertFalse(measured("a\nb\nc").valid)
        assertFalse(measured("😀😀😀😀😀😀").valid) // 24 UTF-8 bytes, though only six code points.
        assertFalse(measured(" ").valid)
        assertFalse(measured("hello", null).valid)
    }
    @Test fun `display grapheme count uses supplied segmenter rather than UTF16 length`() {
        val text = "👩‍👩‍👧‍👦"
        val roomy = bounds.copy(maxUtf8Bytes = 100, maxGraphemes = 1)
        val result = chatDraftMeasure(text, roomy) { 1 }
        assertEquals(1, result.graphemes)
        assertTrue(result.valid)
        assertFalse(chatDraftMeasure(text, roomy.copy(maxUtf8Bytes = 5)) { 1 }.valid)
    }
    @Test fun `older pages and redactions never count as newly arrived messages`() {
        assertTrue(chatArrivals("50", listOf("1", "2", "49")).isEmpty())
        assertTrue(chatArrivals("50", emptyList()).isEmpty())
        assertTrue(chatArrivals(null, listOf("50")).isEmpty())
        assertEquals(setOf("51", "52"), chatArrivals("50", listOf("49", "50", "51", "52")))
    }
    @Test fun `new-message comparison stays exact above Javascript safe integers`() {
        assertEquals(setOf("9007199254740993"), chatArrivals("9007199254740992", listOf("9007199254740991", "9007199254740992", "9007199254740993")))
    }
    @Test fun `fallback initials keep full Unicode codepoints and invalid clock stays empty`() {
        assertEquals("?", chatInitials("  "))
        assertEquals("AB", chatInitials(" abcd "))
        assertEquals("😀B", chatInitials("😀bob"))
        assertEquals("", chatClock("invalid"))
        assertEquals("14:05", chatClock("2026-09-13T14:05:00Z", ZoneId.of("UTC"), Locale.UK))
    }
}
