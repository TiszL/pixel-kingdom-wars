package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.addJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The designed vehicle crafting sheet's rules. Why they matter: the sheet replaces the old dark preview plate, and it must
 * stay exactly as honest as that plate was — every chance, fee and count is the server's quote for the selection on
 * screen, a quote for another vehicle or kingdom is never shown, and the sheet never offers a craft the server does not.
 */
class VehicleCraftLogicTest {
    private val base = "1f4f0f0e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"

    private fun quote(family: String = "survey_balloon", tier: Long = 2, baseId: String = base, oddsBps: Long = 4550,
        feeLamports: String = "50000000", rows: List<Triple<String, String, String>> = listOf(
            Triple("frostglass", "4", "1"), Triple("heartwood_beams", "2", "9")), held: String = "0",
        fragment: Boolean = false): JsonObject = buildJsonObject {
        put("baseId", baseId)
        putJsonObject("recipe") { put("family", family); put("tier", tier); put("oddsBps", oddsBps) }
        put("applicationFeeLamports", feeLamports)
        putJsonArray("ingredients") {
            rows.forEach { (item, required, available) ->
                addJsonObject { put("kind", "refined"); put("itemId", item); put("required", required); put("available", available); put("held", held) }
            }
            if (fragment) addJsonObject { put("kind", "fragment"); put("itemId", "crystal_fragment"); put("required", "1"); put("available", "1"); put("held", "0") }
        }
        put("serverNow", "2026-10-06T10:00:00.000Z")
    }

    private fun record(key: String, family: String, tier: Long, status: String, reservedAt: String): JsonObject = buildJsonObject {
        put("idempotencyKey", key)
        putJsonObject("identity") { put("family", family); put("tier", tier) }
        put("status", status)
        putJsonObject("recipe") {
            put("inputs", buildJsonArray { addJsonObject { put("itemId", "frostglass"); put("quantity", "4") } })
        }
        put("reservedAt", reservedAt)
    }

    @Test fun `a quote for another vehicle tier or kingdom is never shown as the current one`() {
        // The owner's quote is replaced asynchronously; drawing a stale one would show another recipe's chance and fee.
        assertNull(vehicleQuoteUi(quote(), base, "cargo_cutter", 2))
        assertNull(vehicleQuoteUi(quote(), base, "survey_balloon", 3))
        assertNull(vehicleQuoteUi(quote(), "2f4f0f0e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", "survey_balloon", 2))
        assertNull(vehicleQuoteUi(quote(), null, "survey_balloon", 2))
        assertNotNull(vehicleQuoteUi(quote(), base, "survey_balloon", 2))
    }

    @Test fun `chance and fee are the server values exactly`() {
        val ui = requireNotNull(vehicleQuoteUi(quote(oddsBps = 4550, feeLamports = "50000000"), base, "survey_balloon", 2))
        assertEquals("45.5%", ui.odds)
        assertEquals("0.05 SOL", ui.fee)
        assertEquals("25%", requireNotNull(vehicleQuoteUi(quote(oddsBps = 2500), base, "survey_balloon", 2)).odds)
    }

    @Test fun `each ingredient row carries the server have and need and marks only real shortfalls`() {
        val lines = requireNotNull(vehicleQuoteUi(quote(), base, "survey_balloon", 2)).lines
        val glass = lines.single { it.itemId == "frostglass" }
        assertEquals("1/4", glass.count); assertEquals(3L, glass.missing); assertTrue(glass.short)
        val beams = lines.single { it.itemId == "heartwood_beams" }
        assertEquals("9/2", beams.count); assertTrue(beams.ok); assertFalse(beams.short)
        assertFalse(requireNotNull(vehicleQuoteUi(quote(), base, "survey_balloon", 2)).ready)
        assertTrue(requireNotNull(vehicleQuoteUi(quote(rows = listOf(Triple("frostglass", "4", "4"))), base, "survey_balloon", 2)).ready)
    }

    @Test fun `materials already held by an original craft are named in the row`() {
        val line = requireNotNull(vehicleQuoteUi(quote(held = "2"), base, "survey_balloon", 2)).lines.first()
        assertEquals("2 held in original crafting", line.source)
    }

    @Test fun `the fragment uses its own art and is never sent to the Workshop to refine`() {
        val line = requireNotNull(vehicleQuoteUi(quote(fragment = true), base, "survey_balloon", 2)).lines.last()
        assertEquals("ui:crystal-fragments", line.icon)
        assertFalse(vehicleIngredientRefinable(line.itemId))
        assertTrue(vehicleIngredientRefinable("frostglass"))
    }

    @Test fun `once checked the craft primary is honestly off because the server offers no new vehicle crafting`() {
        val ui = vehicleQuoteUi(quote(), base, "survey_balloon", 2)
        val primary = vehicleCraftPrimary(base, listOf(1L, 2L), false, ui, "survey_balloon", 2)
        assertEquals("CRAFT VEHICLE", primary.label)
        assertEquals(CommandState.DISABLED, primary.state)
        assertEquals(PrimaryAction.SHAKE, primary.action)
        assertEquals(VEHICLE_CRAFT_OFF_LINE, primary.reason)
        assertEquals("Survey Balloon T2 · 45.5% chance", primary.sub)
        assertNull(primary.price)
    }

    @Test fun `without a quote the primary is a blue check that spends nothing`() {
        val primary = vehicleCraftPrimary(base, listOf(1L, 2L), false, null, "cargo_cutter", 1)
        assertEquals("CHECK INGREDIENTS", primary.label)
        assertEquals(Verb.BLUE, primary.verb)
        assertEquals(PrimaryAction.START, primary.action)
        assertNull(primary.price)
        assertEquals(CommandState.BUSY, vehicleCraftPrimary(base, listOf(1L), true, null, "cargo_cutter", 1).state)
    }

    @Test fun `a check that cannot run says why instead of doing nothing`() {
        assertEquals(VEHICLE_NO_CATALOGUE_LINE, vehicleCraftPrimary(base, emptyList(), false, null, "survey_balloon", null).reason)
        assertEquals(VEHICLE_NO_BASE_LINE, vehicleCraftPrimary(null, listOf(1L), false, null, "survey_balloon", 1).reason)
        assertNull(vehicleCheckBlocked(base, listOf(1L)))
    }

    @Test fun `vehicle art follows the family and tier and an unknown family shows the visible unknown glyph`() {
        assertEquals("voyage:veh-survey-balloon-t2", vehicleCraftArt("survey_balloon", 2))
        assertEquals("voyage:veh-expedition-barge-t4", vehicleCraftArt("expedition_barge", 9))
        assertEquals("shape:unknown", vehicleCraftArt("dragon", 1))
        assertEquals("SURVEY BALLOON T2", vehicleCraftTitle("survey_balloon", 2))
    }

    @Test fun `history lists newest first and leaves out a record it cannot read`() {
        val rows = vehicleCraftRecords(listOf(
            record("k-old", "cargo_cutter", 1, "paid_loss", "2026-10-01T10:00:00.000000Z"),
            record("k-new", "survey_balloon", 2, "minted", "2026-10-05T10:00:00.000000Z"),
            buildJsonObject { put("idempotencyKey", "k-broken") },
        ))
        assertEquals(listOf("k-new", "k-old"), rows.map { it.key })
        assertEquals("MINTED", rows[0].tag); assertEquals(Verb.GREEN, rows[0].tagVerb); assertNotNull(rows[0].note)
        assertEquals("UNSUCCESSFUL", rows[1].tag); assertNull(rows[1].note)
        assertEquals("Frostglass 4", rows[1].inputs)
    }

    @Test fun `the live chip turns green only when every input is available`() {
        val short = vehicleQuoteUi(quote(), base, "survey_balloon", 2)
        assertFalse(vehicleCraftLive(false, short).ready)
        val enough = vehicleQuoteUi(quote(rows = listOf(Triple("frostglass", "4", "4"))), base, "survey_balloon", 2)
        assertTrue(vehicleCraftLive(false, enough).ready)
        assertEquals(CHECKING_TEXT, vehicleCraftLive(true, enough).text)
    }
}
