package gg.pixelkingdomwars.nativeclient.scene

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Home's scene preparation is keyed by [BaseSourceKeys]. Home recomposes every second and on every drag, and a routine
 * re-read every 20 s brings a new payload instance that is usually equal: the key must stay put for equal content (no
 * re-preparation, no flicker, no full-tree compare per pass) and must change for any real change (a stale scene would
 * show buildings the server no longer has). */
class BaseSourceKeysTest {
    private fun base(level: Int, extra: String? = null) = buildJsonObject {
        put("baseId", "home-1")
        put("buildings", buildJsonArray { add(buildJsonObject { put("id", "keep-1"); put("type", "keep"); put("level", level) }) })
        if (extra != null) put("note", extra)
    }

    @Test fun `the same payload instance keeps its key`() {
        val keys = BaseSourceKeys(); val raw = base(1)
        val first = keys.keyFor(raw)
        assertSame(first, keys.keyFor(raw))
        assertSame(raw, first.raw)
    }

    @Test fun `an equal re-read keeps the key so the scene is not prepared again`() {
        val keys = BaseSourceKeys(); val shown = base(1)
        val first = keys.keyFor(shown)
        val reread = base(1)
        assertNotSame(shown, reread)
        assertSame("equal content must not restart the preparation", first, keys.keyFor(reread))
        assertSame("asking again for the new instance is the same answer", first, keys.keyFor(reread))
        assertSame("the key keeps the payload the scene was prepared from", shown, first.raw)
    }

    @Test fun `a changed payload gets a new key and a change back is a change too`() {
        val keys = BaseSourceKeys()
        val a = keys.keyFor(base(1)); val b = keys.keyFor(base(2))
        assertNotSame("an upgrade is new content", a, b)
        assertEquals(2, b.raw["buildings"]!!.jsonArray[0].jsonObject["level"]!!.jsonPrimitive.int)
        val back = keys.keyFor(base(1))
        assertNotSame("A then B then A prepares A again, exactly as the payload-keyed effect did", b, back)
        assertNotSame(a, back)
        assertNotSame(back, keys.keyFor(base(1, extra = "anything new")))
    }

    @Test fun `keys compare by identity only`() {
        val raw = base(1)
        assertNotEquals("two keys are never equal, so an effect keyed on one restarts only when the key object changes",
            BaseSourceKey(raw), BaseSourceKey(raw))
    }
}
