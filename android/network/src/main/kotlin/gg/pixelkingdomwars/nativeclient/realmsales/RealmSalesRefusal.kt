package gg.pixelkingdomwars.nativeclient.realmsales

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** Authority only for the first original prepare POST. No timeout, GET, review,
 * wallet, or submission failure can create this evidence. */
@Serializable data class RealmSalePrepareRefusal(val status: Int, val code: String) {
    fun validate() { require(status == 400 && code == "INVALID_INPUT" || status == 422 && code in setOf("INSUFFICIENT_SOL", "REALM_SALE_NO_QUOTA", "REALM_SALE_UNSOLD", "REALM_SALE_REALM_UNAVAILABLE") || status == 503 && code == "PHASE_E_DISABLED") }
    companion object {
        fun response(status: Int, raw: JsonObject?): RealmSalePrepareRefusal? {
            if (raw == null || raw.keys != setOf("error")) return null
            val error = raw["error"] as? JsonObject ?: return null
            if (error.keys != setOf("code", "message")) return null
            val code = (error["code"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            val message = (error["message"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            if (message.length !in 1..1024) return null
            return RealmSalePrepareRefusal(status, code).takeIf { runCatching { it.validate() }.isSuccess }
        }
    }
}
