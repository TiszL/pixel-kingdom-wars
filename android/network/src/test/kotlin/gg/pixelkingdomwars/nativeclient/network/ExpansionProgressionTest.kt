package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ops.*
import java.math.BigDecimal
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Expected sizes, gates and amounts are executed by the source policy, not copied into Kotlin. */
class ExpansionProgressionTest {
    private val fixture = Json.parseToJsonElement(javaClass.classLoader!!.getResource("expansion-progression/source-reference.json")!!.readText()).jsonObject
    private val catalogue = fixture.getValue("catalogue").jsonObject
    private val cases = fixture.getValue("cases").jsonArray.map { it.jsonObject }
    private val baseId = "00000000-0000-4000-8000-000000000001"
    private val key = "00000000-0000-4000-8000-000000000002"
    private fun JsonObject.n(key: String) = getValue(key).jsonPrimitive.int
    private fun changedCaps(change: (JsonObject) -> JsonObject): JsonObject = JsonObject(catalogue + ("constants" to
        JsonObject(catalogue.getValue("constants").jsonObject.let { it + ("CAPS" to change(it.getValue("CAPS").jsonObject)) })))
    private fun base(row: JsonObject, keep: Int) = BaseSnapshot.from(buildJsonObject {
        put("baseId", baseId); put("plotVersion", row.getValue("plotVersion")); put("claim", row.getValue("claim"))
        put("player", buildJsonObject { put("keepLevel", keep); put("expansions", row.getValue("expansions")) })
    })

    @Test fun `every source step quotes exactly one ring and enforces its Keep gate`() {
        assertEquals("Approved progression must exercise every state including max", 13, cases.size)
        for (row in cases) {
            val index = row.n("expansions"); val claim = row.getValue("claim").jsonObject
            val shown = requireNotNull(expansionOffer(catalogue, index))
            assertEquals(claim.n("max") - claim.n("min"), shown.size)
            if (row["offer"] == JsonNull) {
                assertTrue(shown.maxed); assertNull(shown.priceSol); assertNull(shown.next)
                assertNull(basePurchaseOffer(catalogue, base(row, Int.MAX_VALUE), "expansion")); continue
            }
            val expected = row.getValue("offer").jsonObject; val gate = expected.n("requiredKeepLevel")
            assertEquals(expected.n("toClaimTiles"), shown.next); assertEquals(gate, shown.requiredKeepLevel)
            val offer = requireNotNull(basePurchaseOffer(catalogue, base(row, gate), "expansion"))
            assertEquals(expected.getValue("amountLamports").jsonPrimitive.content, offer.amountLamports)
            assertEquals(expected.n("toClaimTiles"), offer.claimTiles)
            assertEquals(index, offer.request(key).expectedExpansions)
            assertEquals(baseId, offer.request(key).baseId)
            assertNull("A larger catalogue never bypasses a Keep gate", basePurchaseOffer(catalogue, base(row, gate - 1), "expansion"))
            assertTrue(unlocksAtKeepLevel(catalogue, gate).any { it.kind == "expansion" && it.value == shown.next })
        }
    }

    @Test fun `all claims place complete footprints at both corners without changing the historical centre`() {
        for (row in cases) {
            val claim = row.getValue("claim").jsonObject; val lo = claim.n("min"); val hi = claim.n("max")
            val plot = PlotGeometry.from(catalogue, row.n("plotVersion"))
            assertEquals(row.getValue("plot").jsonObject.n("min"), plot.min)
            assertEquals(row.getValue("plot").jsonObject.n("max"), plot.max)
            val wall = Building(baseId, "wall", 1, lo, lo)
            val geometry = LayoutGeometry(1, lo, hi, listOf(wall), emptyList(), { footprintOf(catalogue, it) }, { 1 }, plot)
            assertNull(validatePlacement(geometry, emptyList(), wall.id, lo, lo))
            assertNull(validatePlacement(geometry, emptyList(), wall.id, hi - 1, hi - 1))
            assertNotNull(validatePlacement(geometry, emptyList(), wall.id, lo - 1, lo))
            assertNotNull(validatePlacement(geometry, emptyList(), wall.id, hi, hi - 1))
            val keep = geometry.copy(buildings = listOf(wall.copy(type = "keep")))
            val (fw, fh) = footprintOf(catalogue, "keep")
            assertNull(validatePlacement(keep, emptyList(), wall.id, hi - fw, hi - fh))
            assertNotNull(validatePlacement(keep, emptyList(), wall.id, hi - fw + 1, hi - fh))
            val terms = WallBatchTerms.from(catalogue, row.n("plotVersion"))
            WallBatchRequest(key, baseId, listOf(WallBatchTile(lo, lo), WallBatchTile(hi - 1, hi - 1)), terms.cost(2)).validate(terms)
        }
        val final = cases.last().getValue("claim").jsonObject
        assertEquals(-10, final.n("min")); assertEquals(39, final.n("max") - 1)
        assertEquals("Missing version never adopts the current plot", PlotGeometry.supported(1), PlotGeometry.from(catalogue))
    }

    @Test fun `malformed progression cannot shift step identity or fall back to a cheap flat price`() {
        val caps = catalogue.getValue("constants").jsonObject.getValue("CAPS").jsonObject
        for (field in listOf("claimTilesByExpansion", "expansionReqKeepLevel", "expansionPriceSolByIndex")) {
            val original = caps.getValue(field).jsonArray
            for (invalid in listOf<JsonElement>(JsonArray(original.dropLast(1)), JsonArray(original.mapIndexed { i, value -> if (i == 1) JsonNull else value }), JsonNull)) {
                val changed = changedCaps { JsonObject(it + (field to invalid)) }
                assertNull("Invalid $field must not offer a different step", expansionOffer(changed, 0))
            }
        }
        for (price in listOf("NaN", "-1", "0.0000000001")) {
            assertNull(expansionOffer(changedCaps { JsonObject(it + ("expansionPriceSolByIndex" to JsonArray(it.getValue("expansionPriceSolByIndex").jsonArray.map { JsonPrimitive(price) }))) }, 0))
        }
        assertNull(expansionOffer(catalogue, -1)); assertNull(expansionOffer(catalogue, cases.size))
    }

    @Test fun `old packs with no indexed table retain their explicit flat price`() {
        val old = changedCaps { JsonObject(it - "expansionPriceSolByIndex") }
        val expected = old.getValue("constants").jsonObject.getValue("CAPS").jsonObject.getValue("expansionPriceSol").jsonPrimitive.content
        assertEquals(expected, expansionOffer(old, 0)!!.priceSol)
        assertEquals(BigDecimal(expected).movePointRight(9).toBigIntegerExact().toString(), basePurchaseOffer(old, base(cases.first(), Int.MAX_VALUE), "expansion")!!.amountLamports)
    }

    @Test fun `construction recovery preserves each original signed scope and request`() {
        for (row in cases) {
            val plot = PlotGeometry.from(catalogue, row.n("plotVersion")); val claim = row.getValue("claim").jsonObject
            val body = buildJsonObject { put("type", "wall"); put("baseId", baseId); put("idempotencyKey", key); put("tx", claim.n("min")); put("ty", claim.n("max") - 1) }
            val intent = PendingIntent(IntentKind.CONSTRUCTION, "wallet", baseId, key, ConstructionSpec.PLACE, body, "Wall",
                if (plot.version == 2) buildJsonObject { put("plotGeometry", plot.json) } else null, attempted = true)
            assertEquals(body.mapValues { it.value.jsonPrimitive.content }, ConstructionSpec.receiptRequest(intent)!!.query)
            val receipt = buildJsonObject { put("version", 1); put("status", "accepted"); put("request", body); put("baseId", baseId)
                put("receiptId", key); put("acceptedAt", "2026-09-16T00:00:00.000Z")
                put("funding", buildJsonObject { put("currency", "SHARDS"); put("amount", WallBatchTerms.from(catalogue, plot.version).unitCostShards) }) }
            assertTrue(ConstructionSpec.decodeReceipt(intent, receipt) is Receipt.Accepted)
            if (plot.version == 2) assertNull("Removing original signed scope cannot reinterpret a negative request", ConstructionSpec.receiptRequest(intent.copy(quote = null)))
        }
    }
}
