package gg.pixelkingdomwars.nativeclient.ui.home

import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class DefenceNoticesTest {
    private val earlier = Instant.parse("2026-09-12T12:00:00Z")
    private val later = Instant.parse("2026-09-13T12:00:00Z")
    private fun base(at: Instant) = Json.parseToJsonElement("""{"defences":{"lastAt":"$at","recent":[{"createdAt":"$at"}]}}""").jsonObject
    private fun notices(storage: MutableMap<String,String>) = DefenceNotices(storage::get) { key,value -> storage[key] = value }

    @Test fun `a new device never alarms the player about historical defences`() {
        val storage = mutableMapOf<String,String>(); val notices = notices(storage)
        assertNull(notices.announce("deed-a",base(earlier),later))
        assertEquals(0,notices.unread("deed-a",base(earlier)))
        assertEquals(earlier.toString(),storage["skp_defences_seen_v1:deed-a"])
    }
    @Test fun `new defences stay unread until the actual log is opened`() {
        val storage = mutableMapOf<String,String>(); val notices = notices(storage)
        notices.announce("deed-a",base(earlier),earlier)
        assertEquals("YOUR BASE WAS RAIDED ×1 — OPEN RAID LOG",notices.announce("deed-a",base(later),later))
        assertNull(notices.announce("deed-a",base(later),later))
        assertEquals(1,notices.unread("deed-a",base(later)))
        notices.markRead("deed-a",base(later),later)
        assertEquals(0,notices.unread("deed-a",base(later)))
    }
    @Test fun `reading one deed cannot clear another deeds unread raids`() {
        val storage = mutableMapOf<String,String>(); val notices = notices(storage)
        listOf("a","b").forEach { notices.announce(it,base(earlier),earlier) }
        notices.markRead("a",base(later),later)
        assertEquals(0,notices.unread("a",base(later)))
        assertEquals(1,notices.unread("b",base(later)))
    }
    @Test fun `a stale snapshot cannot move the log read stamp backwards`() {
        val storage = mutableMapOf<String,String>(); val notices = notices(storage)
        notices.markRead("a",base(earlier),later)
        assertEquals(later.toString(),storage["skp_defences_seen_v1:a"])
        notices.markRead("b",base(later),earlier)
        assertEquals(later.toString(),storage["skp_defences_seen_v1:b"])
    }
    @Test fun `refused device storage never creates an uncleareable raided badge`() {
        val notices = DefenceNotices({ throw IllegalStateException("storage unavailable") }, { _,_ -> throw IllegalStateException("storage unavailable") })
        assertNull(notices.announce("a",base(later),later))
        assertEquals(0,notices.unread("a",base(later)))
        notices.markRead("a",base(later),later)
    }
}
