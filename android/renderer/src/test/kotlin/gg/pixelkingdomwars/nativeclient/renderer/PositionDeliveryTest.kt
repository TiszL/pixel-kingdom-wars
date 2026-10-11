package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.test.*
import org.junit.Test

class PositionDeliveryTest {
    private fun event(t: Int, type: String, id: Int = 1) =
        PresentationEvent.fromJson("""{"t":$t,"e":"$type","id":$id}""")

    @Test fun `captured Lunge landing is delivered beside cast in both full and resumed streams`() {
        // Actual source737 real-Scene captures: .reports/lunge-source/browser.
        // These are fixture inputs supplied to the compiler, not client game rules.
        val events = listOf(event(0, "deploy"), event(10, "troopAbility"), event(15, "pos"))
        for (from in listOf(0f, 10f)) {
            val deliveries = PositionDelivery.compile(events, 5, 2, 100f, from)
            assertEquals(mapOf(2 to PositionDelivery(2, 10f, 500f)), deliveries)
            val order = events.indices.filter { events[it].t >= from }
                .sortedWith(compareBy<Int> { deliveries[it]?.startTick ?: events[it].t.toFloat() }.thenBy { it })
            assertEquals(listOf(1, 2), order.filter { events[it].e != "deploy" },
                "The position must consume pending Lunge after cast, never at endpoint tick 15")
        }
    }

    @Test fun `ability and emergence do not replace the preceding canonical position`() {
        val events = listOf(event(0, "deploy"), event(4, "pos"), event(8, "troopAbility"),
            event(9, "emerge"), event(10, "pos"))
        assertEquals(PositionDelivery(4, 4f, 60f), PositionDelivery.compile(events, 7, 2, 10f)[4])
        assertEquals(mapOf(4 to PositionDelivery(4, 6f, 40f)), PositionDelivery.compile(events, 7, 2, 10f, 6f),
            "A pre-boundary endpoint still determines duration without being redelivered")
    }

    @Test fun `zero duration predecessor is skipped even when replacement endpoint has a later tick`() {
        val events = listOf(event(0, "deploy"), event(10, "pos"), event(10, "pos"), event(12, "pos"))
        assertEquals(linkedMapOf(
            1 to PositionDelivery(1, 10f, 0f, true),
            2 to PositionDelivery(2, 10f, 0f, true),
            3 to PositionDelivery(3, 10f, 20f),
        ), PositionDelivery.compile(events, 5, 2, 10f, 10f))
        val full = PositionDelivery.compile(events, 5, 2, 10f)
        assertFalse(full.getValue(1).skip, "A real movement segment must survive a same-tick endpoint")
        assertTrue(full.getValue(2).skip)
    }

    @Test fun `independent actor cadence and long pauses retain only actual final movement window`() {
        val events = listOf(event(0, "deploy", 1), event(0, "troopSpawn", 2), event(0, "spawn", 3),
            event(100, "pos", 1), event(100, "pos", 2), event(100, "pos", 3), event(100, "pos", 4))
        assertEquals(listOf(93f, 98f, 93f, 100f), PositionDelivery.compile(events, 7, 2, .5f).values.map { it.startTick })
        assertEquals(listOf(3.5f, 1f, 3.5f, 0f), PositionDelivery.compile(events, 7, 2, .5f).values.map { it.durationMs })
    }

    @Test fun `equal delivery times keep original ordinals across actors and earlier future endpoints`() {
        val events = listOf(event(0, "deploy", 1), event(0, "deploy", 2), event(10, "troopAbility", 1),
            event(14, "pos", 2), event(15, "pos", 1))
        val deliveries = PositionDelivery.compile(events, 5, 2, 10f)
        assertEquals(listOf(3, 4), deliveries.keys.toList())
        val order = listOf(2, 3, 4).sortedWith(compareBy<Int> { deliveries[it]?.startTick ?: events[it].t.toFloat() }.thenBy { it })
        assertEquals(listOf(3, 2, 4), order, "Endpoint 14 is delivered before cast; endpoint 15 ties after cast")
    }

    @Test fun `empty and fully elapsed streams cannot invent a replacement position`() {
        assertTrue(PositionDelivery.compile(emptyList(), 3, 1, 10f).isEmpty())
        assertTrue(PositionDelivery.compile(listOf(event(0, "deploy"), event(2, "pos")), 3, 1, 10f, 3f).isEmpty())
    }

    @Test fun `fractional recovery preserves the exact remaining movement window`() {
        val events=listOf(event(0,"deploy"),event(3,"pos"),event(8,"pos"))
        val deliveries=PositionDelivery.compile(events,5,2,100f,3.5f)
        assertEquals(mapOf(2 to PositionDelivery(2,3.5f,450f)),deliveries,
            "Recovery after tick3 must hydrate that endpoint, not deliver it again or round away half a tick")
        for(boundary in listOf(Float.NaN,Float.POSITIVE_INFINITY))
            assertFailsWith<IllegalArgumentException> { PositionDelivery.compile(events,5,2,100f,boundary) }
    }

    @Test fun `invalid clocks order or wrapper mismatch fail before constructing motion`() {
        val events = listOf(event(0, "deploy"), event(2, "pos"))
        assertFailsWith<IllegalArgumentException> { PositionDelivery.compile(events, 0, 1, 10f) }
        assertFailsWith<IllegalArgumentException> { PositionDelivery.compile(events, 1, 0, 10f) }
        for (tick in listOf(0f, -1f, Float.NaN, Float.POSITIVE_INFINITY))
            assertFailsWith<IllegalArgumentException> { PositionDelivery.compile(events, 1, 1, tick) }
        assertFailsWith<IllegalArgumentException> { PositionDelivery.compile(events, 1, 1, 10f, -1f) }
        assertFailsWith<IllegalArgumentException> { PositionDelivery.compile(events.reversed(), 1, 1, 10f) }
        assertFailsWith<IllegalArgumentException> {
            PositionDelivery.compile(listOf(events.first().copy(t = 1)), 1, 1, 10f)
        }
        assertFailsWith<IllegalArgumentException> { PositionDelivery.compile(events, 2, 1, Float.MAX_VALUE) }
    }
}
