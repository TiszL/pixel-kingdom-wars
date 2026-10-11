package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.baseJson
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** What a money-consent Seal may never print (owner 2026-10-06 17:24, "a black developer interface"): a raw id or a raw
 *  server instant. Defined here, independently of SealWords.kt, so a mapper cannot pass by sharing the rule it is tested by. */
internal object RawSealText {
    private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    private val iso = Regex("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}")
    fun assertPlayerWords(where: String, texts: List<String?>) {
        texts.filterNotNull().forEach { text ->
            assertFalse("$where shows a raw id: $text", uuid.containsMatchIn(text))
            assertFalse("$where shows a raw server instant: $text", iso.containsMatchIn(text))
        }
    }
    fun ui(ui: GemSpendUi): List<String?> = listOf(ui.title, ui.subjectName, ui.subjectLine, ui.timeLeft, ui.price.amount,
        ui.price.description, ui.unavailableReason, ui.consentDetails, ui.confirmLabel)
}

class SealWordsTest {
    private val now = Instant.parse("2030-01-01T11:30:00Z").toEpochMilli()
    private fun named(name: String, baseId: String = BASE_ID): BaseSnapshot {
        val raw = baseJson(baseId); val player = raw.getValue("player").jsonObject
        return BaseSnapshot.from(JsonObject(raw + ("player" to JsonObject(player + ("name" to JsonPrimitive(name))))))
    }

    @Test fun `the reviewed kingdom is named only by its own Home read and never by its id`() {
        assertEquals("Kingdom · Stormhold", sealKingdomLine(named("Stormhold"), BASE_ID))
        // Another kingdom's read must not lend its name to this consent; no read, no name, or a blank name says "Your kingdom".
        assertEquals("Your kingdom", sealKingdomLine(named("Stormhold", "33333333-3333-4333-8333-333333333333"), BASE_ID))
        assertEquals("Your kingdom", sealKingdomLine(null, BASE_ID))
        assertEquals("Your kingdom", sealKingdomLine(named("  "), BASE_ID))
        assertEquals("Your kingdom", sealKingdomLine(named("Stormhold"), null))
        RawSealText.assertPlayerWords("kingdom line", listOf(sealKingdomLine(BaseSnapshot.from(json("""{"baseId":"$BASE_ID","player":{"keepLevel":1}}""")), BASE_ID)))
    }

    @Test fun `a frozen instant reads as time left from now and an unreadable one is left out`() {
        assertEquals("in 4m", sealTimeFromNow("2030-01-01T11:34:00.000Z", now))
        assertEquals("in 1h 30m", sealTimeFromNow("2030-01-01T13:00:00Z", now))
        assertEquals("now", sealTimeFromNow("2030-01-01T11:00:00Z", now))
        assertNull(sealTimeFromNow("tomorrow", now)); assertNull(sealTimeFromNow(null, now))
        assertEquals("1 troop", sealTroops(1)); assertEquals("9 troops", sealTroops(9))
    }
}
