package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.ActiveBaseRaid
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import okio.Buffer
import okio.buffer
import org.junit.Assert.*
import org.junit.Test

/** The SSE framing of `/bases/:id/raid-events` (web lib/raidEvents.ts): a defender's controls follow only a
 * frame that names this base and a valid lock; anything malformed is an interrupted stream, never an unlock. */
class RaidEventStreamTest {
    private val base = "b86b557b-bb8f-488b-8b18-035600ba0e4a"
    private fun frames(text: String) = runBlocking { runCatching { raidEventFrames(Buffer().writeUtf8(text), base).toList() } }

    @Test fun `snapshot heartbeat and unlock frames decode in order and the closed stream is reported`() {
        val result = frames("event: snapshot\ndata: {\"baseId\":\"$base\",\"activeRaid\":{\"raidId\":\"r1\",\"state\":\"live\"}}\n\n: heartbeat\n\nevent: snapshot\ndata:{\"baseId\":\"$base\",\"activeRaid\":null}\n\n")
        val error = result.exceptionOrNull() as ApiException
        assertEquals("End of stream is a closed connection to reconnect, not an unlock", RAID_EVENTS_CLOSED, error.code)
    }
    @Test fun `frames are delivered before the close`() = runBlocking {
        val seen = mutableListOf<RaidEventFrame>()
        runCatching { raidEventFrames(Buffer().writeUtf8("event: snapshot\ndata: {\"baseId\":\"$base\",\"activeRaid\":{\"raidId\":\"r1\",\"state\":\"live\"}}\n\n: heartbeat\n\nevent: snapshot\ndata: {\"baseId\":\"$base\",\"activeRaid\":null}\n\n"), base).collect { seen += it } }
        assertEquals(listOf(RaidEventFrame.Snapshot(ActiveBaseRaid("r1", "live")), RaidEventFrame.Heartbeat, RaidEventFrame.Snapshot(null)), seen)
    }
    @Test fun `a snapshot for another deed an unknown lock state or a bare raid is an interrupted stream`() {
        for (data in listOf(
            """{"baseId":"other","activeRaid":null}""",
            """{"baseId":"$base","activeRaid":{"raidId":"r1","state":"paused"}}""",
            """{"baseId":"$base","activeRaid":{"raidId":"","state":"live"}}""",
            """{"baseId":"$base"}""",
            """not json""",
        )) {
            val error = frames("event: snapshot\ndata: $data\n\n").exceptionOrNull() as ApiException
            assertEquals(data, RAID_EVENTS_INVALID, error.code)
        }
    }
    @Test fun `an error event carries the server's own status and code`() {
        val error = frames("event: error\ndata: {\"status\":404,\"code\":\"RAID_EVENTS_DISABLED\",\"message\":\"raid streaming is unavailable\"}\n\n").exceptionOrNull() as ApiException
        assertEquals(404, error.status); assertEquals(RAID_EVENTS_DISABLED, error.code); assertEquals("raid streaming is unavailable", error.message)
        val malformed = frames("event: error\ndata: {\"status\":200,\"message\":\"x\"}\n\n").exceptionOrNull() as ApiException
        assertEquals(RAID_EVENTS_INVALID, malformed.code)
    }
    @Test fun `an unbounded frame is refused before it can exhaust memory`() {
        val error = frames("data: " + "x".repeat(17_000) + "\n\n").exceptionOrNull() as ApiException
        assertEquals(RAID_EVENTS_INVALID, error.code)
    }
    @Test fun `an unterminated server line is rejected without reading its unbounded body`() = runBlocking {
        var bytesRead = 0L
        val source = object : okio.Source {
            override fun read(sink: Buffer, byteCount: Long): Long {
                val count = minOf(byteCount, 8_192L)
                sink.write(ByteArray(count.toInt()) { 'x'.code.toByte() }); bytesRead += count
                check(bytesRead < 100_000) { "The frame limit must apply before looking for an unbounded newline" }
                return count
            }
            override fun timeout() = okio.Timeout.NONE
            override fun close() = Unit
        }.buffer()
        val error = runCatching { raidEventFrames(source, base).toList() }.exceptionOrNull()
        assertTrue(error is ApiException); assertEquals(RAID_EVENTS_INVALID, (error as ApiException).code)
        assertTrue("Allow only the frame bound and one buffered segment", bytesRead <= 24_576L)
    }
    @Test fun `the active-raid poll answer is parsed by the same rule`() {
        assertNull(RaidInterlock.activeRaidOf(kotlinx.serialization.json.Json.parseToJsonElement("""{"activeRaid":null}""").let { it as kotlinx.serialization.json.JsonObject }, base))
        assertEquals(ActiveBaseRaid("r1", "reserved"), RaidInterlock.activeRaidOf(kotlinx.serialization.json.Json.parseToJsonElement("""{"activeRaid":{"raidId":"r1","state":"reserved"}}""") as kotlinx.serialization.json.JsonObject, base))
        assertThrows(ApiException::class.java) { RaidInterlock.activeRaidOf(kotlinx.serialization.json.Json.parseToJsonElement("""{"activeRaid":{"raidId":"r1"}}""") as kotlinx.serialization.json.JsonObject, base) }
        assertThrows("A malformed poll cannot unlock deed actions; only explicit activeRaid null can", ApiException::class.java) {
            RaidInterlock.activeRaidOf(kotlinx.serialization.json.JsonObject(emptyMap()), base)
        }
    }
}
