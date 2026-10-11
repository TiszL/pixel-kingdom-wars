package gg.pixelkingdomwars.nativeclient.ui.kit

import org.junit.Assert.*
import org.junit.Test

/** [KitImages] is the reason a reopened sheet draws its art on its first frame: each drawable is decoded once per process,
 * not once per opening. The budget keeps that from growing without bound. */
class ByteBoundedLruTest {
    private class Art(val name: String, val bytes: Long)

    @Test fun `a sheet reopened asks for its art again and gets the first decode without decoding`() {
        val cache = ByteBoundedLru<Int, Art>(1_000) { it.bytes }
        var decodes = 0
        val opened = cache.getOrDecode(7) { decodes++; Art("shield", 100) }
        val reopened = cache.getOrDecode(7) { decodes++; Art("shield again", 100) }
        assertSame(opened, reopened)
        assertEquals("one decode for both openings", 1, decodes)
    }

    @Test fun `over budget the least recently drawn art goes first and recently drawn art stays`() {
        val cache = ByteBoundedLru<Int, Art>(300) { it.bytes }
        cache.put(1, Art("a", 100)); cache.put(2, Art("b", 100)); cache.put(3, Art("c", 100))
        assertNotNull(cache.get(1)) // drawn again: now the most recent
        cache.put(4, Art("d", 100))
        assertNull("the art not drawn for longest is evicted", cache.get(2))
        assertNotNull(cache.get(1)); assertNotNull(cache.get(3)); assertNotNull(cache.get(4))
        assertEquals(300L, cache.usedBytes())
        assertEquals(3, cache.size())
    }

    @Test fun `one image larger than the whole budget still draws`() {
        val cache = ByteBoundedLru<Int, Art>(300) { it.bytes }
        cache.put(1, Art("small", 100))
        val big = cache.put(2, Art("wallpaper", 900))
        assertSame(big, cache.get(2))
        assertNull("everything older made room", cache.get(1))
        assertEquals(900L, cache.usedBytes())
    }

    @Test fun `a racing second decode keeps the first stored image so every caller draws the same pixels`() {
        val cache = ByteBoundedLru<Int, Art>(1_000) { it.bytes }
        val first = cache.put(5, Art("first", 10))
        val second = cache.put(5, Art("second", 10))
        assertSame(first, second)
        assertEquals("the duplicate is not counted", 10L, cache.usedBytes())
    }
}
