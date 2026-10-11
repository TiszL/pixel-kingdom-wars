package gg.pixelkingdomwars.nativeclient.boundcosmetics

import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic frozen appearance identities prove grammar, never content admission. */
class BoundCosmeticWakeTest {
    private val appearance = BoundCosmeticAppearance(1, "aurora_wake", "auroraWake", "a".repeat(64), "b".repeat(64), "c".repeat(64))
    private val on = cosmeticJson.encodeToJsonElement(BoundCosmeticWakeRead("available", BoundCosmeticWakeVisual(1, appearance))).jsonObject
    private val off = buildJsonObject { put("state", "available"); put("visual", buildJsonObject { put("version", 1); put("wake", JsonNull) }) }
    private val unavailable = buildJsonObject { put("state", "unavailable"); put("visual", JsonNull) }
    private fun change(raw: JsonObject, path: String, value: JsonElement): JsonObject {
        val parts = path.split('.', limit = 2)
        return JsonObject(raw + (parts[0] to if (parts.size == 1) value else change(raw.charterObject(parts[0]), parts[1], value)))
    }
    private fun rejects(block: () -> Unit) { assertThrows(Exception::class.java, block) }
    @Test fun `captured Wake on off and unavailable are distinct strict values`() {
        assertEquals(appearance, BoundCosmeticWakeRead.from(on).visual!!.wake)
        assertNull(BoundCosmeticWakeRead.from(off).visual!!.wake)
        assertNull(BoundCosmeticWakeRead.from(unavailable).visual)
        assertNotEquals(BoundCosmeticWakeRead.from(off), BoundCosmeticWakeRead.from(unavailable))
    }
    @Test fun `Wake refuses null forged families primitive coercion private fields and incomplete observations`() {
        val bad = listOf(JsonNull, JsonObject(on - "visual"), change(on, "visual", JsonNull),
            change(unavailable, "visual", off.getValue("visual")), change(on, "visual.version", JsonPrimitive("1")),
            change(on, "visual.wake.outputId", JsonPrimitive("artisan_market_awning_t1")),
            change(on, "visual.wake.sourceId", JsonPrimitive("artisan-market-t1")),
            change(on, "visual.wake.bindingSha256", JsonPrimitive("C".repeat(64))),
            change(on, "visual.wake.version", JsonPrimitive("1")), change(on, "visual.wake.sourceId", JsonPrimitive(1)),
            JsonObject(on + ("wallet" to JsonPrimitive("private"))), change(on, "visual.wake", JsonObject(on.charterObject("visual").charterObject("wake") + ("enabled" to JsonPrimitive(true)))))
        bad.forEach { rejects { BoundCosmeticWakeRead.from(it) } }
        rejects { BoundCosmeticWakeRead.from(JsonObject(off + ("state" to JsonPrimitive("unknown")))) }
    }
}
