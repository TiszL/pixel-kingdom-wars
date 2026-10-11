package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.ActiveBaseRaid
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.*
import okio.BufferedSource

/** One decoded server-sent event of `GET /bases/:baseId/raid-events`. Comments (`: heartbeat`) are activity only. */
sealed interface RaidEventFrame {
    data class Snapshot(val activeRaid: ActiveBaseRaid?) : RaidEventFrame
    data object Heartbeat : RaidEventFrame
}

const val RAID_EVENTS_INVALID = "RAID_EVENTS_INVALID"
const val RAID_EVENTS_CLOSED = "RAID_EVENTS_CLOSED"
const val RAID_EVENTS_DISABLED = "RAID_EVENTS_DISABLED"
/** Transport bound (web `lib/raidEvents.ts` MAX_FRAME_LENGTH), not a game rule. */
private const val MAX_FRAME_LENGTH = 16_384

private fun invalid() = ApiException(0, RAID_EVENTS_INVALID, "Live raid updates were interrupted.")

/** Web `parseRaidSnapshot`: the frame must name this base and carry `activeRaid` as null or a lock with a
 * known state. Anything else is an interrupted stream, never a silently unlocked deed. */
fun parseRaidSnapshot(value: JsonElement, baseId: String): ActiveBaseRaid? {
    val snapshot = value as? JsonObject ?: throw invalid()
    if (snapshot.string("baseId") != baseId || !snapshot.containsKey("activeRaid")) throw invalid()
    val raid = snapshot["activeRaid"]
    if (raid == null || raid is JsonNull) return null
    val lock = raid as? JsonObject ?: throw invalid()
    val raidId = (lock["raidId"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() } ?: throw invalid()
    val state = (lock["state"] as? JsonPrimitive)?.contentOrNull?.takeIf { it in ActiveBaseRaid.STATES } ?: throw invalid()
    return ActiveBaseRaid(raidId, state)
}

/** Bounded SSE framing (web `readRaidEvents`): `event:`/`data:` fields, blank line dispatch, comment heartbeats.
 * An `error` event becomes the server's own coded failure; end of stream is a closed connection to reconnect.
 * Reads block in the collector's context: collect on an IO dispatcher. */
fun raidEventFrames(source: BufferedSource, baseId: String): Flow<RaidEventFrame> = flow {
    var event = ""
    val data = mutableListOf<String>()
    var frameLength = 0
    while (true) {
        val remaining = MAX_FRAME_LENGTH - frameLength
        val line = try { source.readUtf8LineStrict(remaining.toLong()) }
        catch (error: java.io.EOFException) {
            if (source.buffer.size > remaining) throw invalid()
            throw ApiException(0, RAID_EVENTS_CLOSED, "Live raid connection closed.")
        }
        frameLength += line.toByteArray(Charsets.UTF_8).size
        if (frameLength > MAX_FRAME_LENGTH) throw invalid()
        if (line.isEmpty()) {
            if (data.isNotEmpty() && (event == "snapshot" || event == "error")) {
                val value = runCatching { Json.parseToJsonElement(data.joinToString("\n")) }.getOrElse { throw invalid() }
                if (event == "snapshot") emit(RaidEventFrame.Snapshot(parseRaidSnapshot(value, baseId)))
                else throw raidEventError(value)
            }
            event = ""; data.clear(); frameLength = 0
            continue
        }
        if (line.startsWith(":")) { emit(RaidEventFrame.Heartbeat); continue }
        val colon = line.indexOf(':')
        val field = if (colon == -1) line else line.substring(0, colon)
        val value = if (colon == -1) "" else line.substring(colon + 1).removePrefix(" ")
        if (field == "event") event = value
        if (field == "data") data += value
    }
}

private fun raidEventError(value: JsonElement): ApiException {
    val error = value as? JsonObject ?: throw invalid()
    val status = (error["status"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull?.takeIf { it in 400..599 } ?: throw invalid()
    val message = (error["message"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw invalid()
    val code = error["code"]?.let { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: throw invalid() }
    return ApiException(status, code, message)
}
