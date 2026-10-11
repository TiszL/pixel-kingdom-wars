package gg.pixelkingdomwars.nativeclient.ui.chrome

import org.junit.Assert.*
import org.junit.Test

/** Owner 2026-09-17: "any action should not give a message which cannot be dismissed or be stuck on screen".
 * A toast therefore retires itself on the host's clock, a tap retires it early, and a burst can never wall
 * the screen: the queue keeps only the newest few. */
class ToastQueueTest {
    @Test fun `a toast expires exactly after its lifetime and the host learns when to wake`() {
        val queue = ToastQueue(lifetimeMs = 4_000)
        val first = queue.post("NAME UPDATED", now = 1_000)
        assertEquals(listOf(first), queue.items.value)
        assertEquals("Wake at the toast's own expiry", 4_000L, queue.expire(now = 1_000))
        assertEquals("Still alive one tick before the deadline", 1L, queue.expire(now = 4_999)); assertEquals(1, queue.items.value.size)
        assertNull("Gone at the deadline, nothing left to wait for", queue.expire(now = 5_000)); assertTrue(queue.items.value.isEmpty())
    }
    @Test fun `a tap dismisses only the tapped toast`() {
        val queue = ToastQueue()
        val a = queue.post("A", now = 0); val b = queue.post("B", error = true, now = 10)
        queue.dismiss(a.id)
        assertEquals(listOf(b), queue.items.value); assertTrue(queue.items.value.single().error)
    }
    @Test fun `a burst keeps only the newest toasts so the stack never walls the screen`() {
        val queue = ToastQueue(maxVisible = 3)
        (1..5).forEach { queue.post("T$it", now = it.toLong()) }
        assertEquals(listOf("T3", "T4", "T5"), queue.items.value.map { it.message })
        assertEquals("Ids keep increasing across drops", 5L, queue.items.value.last().id)
    }
    /** Hub SPEC §3.2 "the same key merges and restarts the timer": a door tapped three times must not wall the thumb area
     *  with three copies of the same sentence, and the merged plate must live a full lifetime from the last post. */
    @Test fun `the same line posted again merges into one toast that moves to the bottom and restarts its timer`() {
        val queue = ToastQueue(lifetimeMs = 4_000)
        val first = queue.post("Leagues is already refreshing.", now = 0)
        queue.post("OTHER", now = 10)
        val again = queue.post("Leagues is already refreshing.", now = 3_000)
        assertEquals("Same plate, same id", first.id, again.id)
        assertEquals("The fade restarts with the merge", first.revision + 1, again.revision)
        assertEquals(listOf("OTHER", "Leagues is already refreshing."), queue.items.value.map { it.message })
        assertEquals("Lives 4 s from the last post", 7_000L, queue.items.value.last().postedAt + queue.lifetimeMs)
        queue.post("Leagues is already refreshing.", error = true, now = 3_100)
        assertEquals("An error is a different line", 3, queue.items.value.size)
    }
    @Test fun `expiry drops the oldest first and reports the next deadline of what remains`() {
        val queue = ToastQueue(lifetimeMs = 100)
        queue.post("OLD", now = 0); queue.post("NEW", now = 60)
        assertEquals(40L, queue.expire(now = 60))
        assertEquals(60L, queue.expire(now = 100)); assertEquals(listOf("NEW"), queue.items.value.map { it.message })
    }
}
