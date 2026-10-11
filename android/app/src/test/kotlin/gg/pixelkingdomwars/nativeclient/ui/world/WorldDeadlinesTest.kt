package gg.pixelkingdomwars.nativeclient.ui.world

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class WorldDeadlinesTest {
    private fun json(text:String)=Json.parseToJsonElement(text).jsonObject
    @Test fun `server duration is anchored to monotonic elapsed and cannot run backwards`() {
        val clock=WorldDeadline("shield",5_000,10_000_000_000)
        assertEquals(3_000L,clock.remaining(12_000_000_000));assertEquals(0L,clock.remaining(90_000_000_000))
        assertEquals(5_000L,clock.remaining(1_000_000_000))
    }
    @Test fun `earlier warzone boundary refreshes effective rules before a longer shield`() {
        val detail=json("""{"shield":{"active":true,"expiresAt":"shield-end","remainingMs":30000},"warzone":{"boundaryAt":"warzone-start","remainingMs":5000}}""")
        val clocks=parcelDeadlines(detail,0)
        assertEquals(5_250L,WorldBoundaryRefresh().nextDelay(15_000,clocks,0))
    }
    @Test fun `suppressed shield still counts down while inactive ordinary shield does not refresh`() {
        val suppressed=json("""{"shield":{"active":false,"suppressedByWarzone":true,"expiresAt":"expiry","remainingMs":3000}}""")
        assertEquals(3_250L,WorldBoundaryRefresh().nextDelay(15_000,parcelDeadlines(suppressed,0),0))
        assertTrue(parcelDeadlines(json("""{"shield":{"active":false,"expiresAt":"expiry","remainingMs":3000}}"""),0).isEmpty())
    }
    @Test fun `unchanged expired boundary cannot create a tight read loop and new boundary remains eligible`() {
        val next=WorldBoundaryRefresh()
        assertEquals(250L,next.nextDelay(15_000,listOf(WorldDeadline("one",0,0)),0))
        repeat(4){assertEquals(15_000L,next.nextDelay(15_000,listOf(WorldDeadline("one",0,0)),0))}
        assertEquals(250L,next.nextDelay(15_000,listOf(WorldDeadline("two",0,0)),0))
    }
    @Test fun `heartbeat does not consume a future boundary and coincident clocks schedule only one read`() {
        val next=WorldBoundaryRefresh();val deadline=WorldDeadline("one",20_000,0)
        assertEquals(15_000L,next.nextDelay(15_000,listOf(deadline),0))
        assertEquals(5_250L,next.nextDelay(15_000,listOf(deadline,deadline),15_000_000_000))
    }
    @Test fun `current purge and scheduled status use their own disclosed boundaries and legacy has no invented clock`() {
        val purge=WorldWarzone.parse(json("""{"mode":"purge","active":true,"startsAt":null,"endsAt":"purge-end","nextStartsAt":null,"remainingMs":9000}"""),0)
        assertEquals("purge-end",purge.boundary);assertEquals(9_000L,purge.deadline!!.remaining(0))
        val scheduled=WorldWarzone.parse(json("""{"mode":"scheduled","active":false,"startsAt":null,"endsAt":null,"nextStartsAt":"next","remainingMs":7000}"""),0)
        assertEquals("next",scheduled.boundary)
        val legacy=WorldWarzone.parse(json("""{"active":true}"""),0)
        assertEquals("unknown",legacy.mode);assertNull(legacy.deadline)
    }
}
