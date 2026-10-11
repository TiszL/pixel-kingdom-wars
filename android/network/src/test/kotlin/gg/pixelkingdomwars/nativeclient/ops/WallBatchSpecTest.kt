package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class WallBatchSpecTest {
    private val wallet = "11111111111111111111111111111111"
    private val key = "12345678-1234-4123-8123-123456789012"
    private val base = "22345678-1234-4123-8123-123456789012"
    private val terms = WallBatchTerms("37", 30, 5)
    private val spec = WallBatchSpec("devnet")
    private val request = WallBatchRequest(key, base, listOf(WallBatchTile(10, 11), WallBatchTile(19, 12)), "74")
    private fun intent() = spec.intent(wallet, request, terms)
    private fun json(s: String) = Json.parseToJsonElement(s).jsonObject
    private fun proof() = json("""{"version":1,"actor":"$wallet","idempotencyKey":"$key","request":${request.body},"receiptId":"32345678-1234-4123-8123-123456789012","acceptedAt":"2026-09-13T00:00:00.000Z","funding":{"currency":"SHARDS","amount":"74"}}""")
    private fun patch(raw: JsonObject, name: String, value: JsonElement) = JsonObject(raw + (name to value))
    private fun status(receipt: JsonElement = JsonNull) = buildJsonObject {
        put("version", 1); put("wallet", wallet); put("idempotencyKey", key); put("enabled", false); put("receipt", receipt)
    }
    @Test fun `signed original wall quote restores exact tiles without a current catalogue`() {
        val plot=PlotGeometry.supported(2);val newTerms=terms.copy(plotTiles=plot.size,plotGeometry=plot)
        val signed=request.copy(tiles=listOf(WallBatchTile(-10,39),WallBatchTile(-9,39)))
        val original=spec.intent(wallet,signed,newTerms)
        assertEquals(newTerms,spec.terms(original));assertEquals(key,original.idempotencyKey)
        val receipt=patch(proof(),"request",signed.body)
        assertEquals(signed,spec.restore(original,ReceiptDocument.fromPost(receipt)).request)
        val bad=patch(original.quote!!,"plotGeometry",patch(plot.json,"min",JsonPrimitive(-11)))
        assertThrows(IllegalArgumentException::class.java) { spec.terms(original.copy(quote=bad)) }
        assertFalse(intent().quote!!.containsKey("plotGeometry"))
    }
    @Test fun `one ledger receipt proves every original ordered tile without current wall identities`() {
        val receipt = spec.acknowledge(intent(), proof())
        assertEquals(request, receipt.request); assertEquals("74", receipt.amount)
        assertEquals("32345678-1234-4123-8123-123456789012", receipt.receiptId)
        assertEquals("/base/walls/batch/v1/$key", spec.receiptRequest(intent()).path)
    }
    @Test fun `reordered same key different actor or substituted destination is not original acceptance`() {
        for (raw in listOf(patch(proof(), "actor", JsonPrimitive("22222222222222222222222222222222")),
            patch(proof(), "request", request.copy(tiles = request.tiles.reversed()).body),
            patch(proof(), "request", request.copy(baseId = null).body), patch(proof(), "idempotencyKey", JsonPrimitive(base))))
            assertThrows(IllegalArgumentException::class.java) { spec.acknowledge(intent(), raw) }
    }
    @Test fun `missing scope duplicate tiles bounds and extra fields cannot silently change a request`() {
        for (raw in listOf(JsonObject(request.body - "baseId"), request.copy(tiles = request.tiles + request.tiles.first()).body,
            request.copy(tiles = listOf(WallBatchTile(terms.plotTiles, 2))).body, request.copy(tiles = emptyList()).body,
            request.copy(tiles = (0..terms.maxTiles).map { WallBatchTile(it, 2) }).body,
            patch(request.body, "tiles", JsonArray(listOf(json("""{"tx":"10","ty":11}""")))), patch(request.body, "partial", JsonPrimitive(true))))
            assertThrows(IllegalArgumentException::class.java) { WallBatchRequest.from(raw, terms) }
    }
    @Test fun `lowercase key and explicit null wallet mode remain distinct from missing base`() {
        assertNull(WallBatchRequest.from(request.copy(baseId = null).body, terms).baseId)
        assertThrows(IllegalArgumentException::class.java) {
            request.copy(idempotencyKey = "abcdefab-abcd-4abc-8abc-abcdefabcdef".uppercase()).validate(terms)
        }
    }
    @Test fun `actual debit must be positive signed64 decimal SHARDS below original ceiling`() {
        val funding = proof().getValue("funding").jsonObject
        for (amount in listOf(JsonPrimitive("0"), JsonPrimitive("75"), JsonPrimitive("1e1"), JsonPrimitive("-1"),
            JsonPrimitive("01"), JsonPrimitive(74), JsonPrimitive("9223372036854775808")))
            assertThrows(IllegalArgumentException::class.java) { spec.acknowledge(intent(), patch(proof(), "funding", patch(funding, "amount", amount))) }
        assertThrows(IllegalArgumentException::class.java) { spec.acknowledge(intent(), patch(proof(), "funding", patch(funding, "currency", JsonPrimitive("KEEP")))) }
        assertEquals("73", spec.acknowledge(intent(), patch(proof(), "funding", patch(funding, "amount", JsonPrimitive("73")))).amount)
    }
    @Test fun `timestamp is exact server millisecond Z and ledger id is mandatory`() {
        for (time in listOf("2026-09-13T00:00:00Z", "2026-09-13T00:00:00.000+00:00", "2026-09-13T00:00:00.000001Z", "not a date"))
            assertThrows(Exception::class.java) { spec.acknowledge(intent(), patch(proof(), "acceptedAt", JsonPrimitive(time))) }
        assertThrows(IllegalArgumentException::class.java) { spec.acknowledge(intent(), JsonObject(proof() - "receiptId")) }
    }
    @Test fun `disabled GET still recovers accepted history while null never proves a refusal`() {
        // Rewritten 2026-10-06 (server facts, owner review M1): the GET is a locked read, so `receipt: null` is the server's
        // proof that no row holds this key (Absent), still never a refusal; MoneyOp waits out the minimum age before CLOSE.
        assertEquals(Receipt.Absent, spec.decodeReceipt(intent(), status()))
        assertEquals(request, (spec.decodeReceipt(intent(), status(proof())) as Receipt.Accepted).value.request)
        for (raw in listOf(patch(status(), "receipt", JsonPrimitive(false)), patch(status(), "wallet", JsonPrimitive("wrong")),
            patch(status(), "enabled", JsonPrimitive("false")), patch(status(), "version", JsonPrimitive(2))))
            assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(intent(), raw) }
    }
    @Test fun `stored frozen quote is used after process death and cannot cross network or scope`() {
        assertEquals(request, spec.restore(intent(), ReceiptDocument.fromPost(proof())).request)
        assertThrows(IllegalArgumentException::class.java) { WallBatchSpec("mainnet-beta").terms(intent()) }
        assertThrows(IllegalArgumentException::class.java) { spec.terms(intent().copy(baseId = null)) }
        assertThrows(IllegalArgumentException::class.java) { spec.intent(wallet, request.copy(maxCostShards = "75"), terms) }
        assertThrows(ArithmeticException::class.java) { WallBatchTerms(Long.MAX_VALUE.toString(), 30, 2) }
    }
}
