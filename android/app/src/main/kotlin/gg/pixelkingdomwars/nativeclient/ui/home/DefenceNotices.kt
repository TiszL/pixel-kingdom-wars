package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.network.objects
import gg.pixelkingdomwars.nativeclient.network.string
import java.time.Instant
import kotlinx.serialization.json.JsonObject

/** Web baseDefences.ts: new-device history is silent; only opening the raid log marks later defences read. */
class DefenceNotices(private val read: (String) -> String?, private val write: (String, String) -> Unit) {
    private val announced = mutableSetOf<String>()
    private fun stamp(baseId: String) = runCatching { read("skp_defences_seen_v1:$baseId") }.getOrNull()?.let(::instant)
    private fun save(baseId: String, at: Instant) { runCatching { write("skp_defences_seen_v1:$baseId", at.toString()) } }
    fun unread(baseId: String?, raw: JsonObject?): Int {
        if(baseId == null) return 0
        val seen = stamp(baseId) ?: return 0
        val defences = raw?.get("defences") as? JsonObject ?: return 0
        return defences.objects("recent").count { row -> row.string("createdAt")?.let(::instant)?.isAfter(seen) == true }
    }
    fun announce(baseId: String?, raw: JsonObject?, now: Instant): String? {
        if(baseId == null) return null
        val defences = raw?.get("defences") as? JsonObject ?: return null
        if(stamp(baseId) == null) { save(baseId, defences.string("lastAt")?.let(::instant) ?: now); return null }
        val count = unread(baseId, raw)
        if(count == 0 || !announced.add(baseId)) return null
        return "YOUR BASE WAS RAIDED ×$count — OPEN RAID LOG"
    }
    fun markRead(baseId: String?, raw: JsonObject?, now: Instant) {
        if(baseId == null) return
        val latest = (raw?.get("defences") as? JsonObject)?.string("lastAt")?.let(::instant)
        save(baseId, latest?.takeIf { it > now } ?: now)
    }
    private fun instant(value: String): Instant? = runCatching { Instant.parse(value) }.getOrNull()
}
