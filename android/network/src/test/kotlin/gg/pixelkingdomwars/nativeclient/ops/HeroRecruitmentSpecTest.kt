package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class HeroRecruitmentSpecTest {
    private val wallet = "11111111111111111111111111111111"
    private val key = "12345678-1234-4123-8123-123456789012"
    private val base = "22345678-1234-4123-8123-123456789012"
    private val definition = HeroAltarDefinition("vex", "heroaltar", "Vex", "item_hero_vex", "37", 5, 2, 30)
    private val spec = HeroRecruitmentSpec("devnet")
    private fun request(contract: Boolean = false) = HeroRecruitmentRequest(key, base, "heroaltar", 10, 11, contract, if (contract) "0" else "37")
    private fun intent(contract: Boolean = false) = spec.intent(wallet, request(contract), definition)
    private fun json(s: String) = Json.parseToJsonElement(s).jsonObject
    private fun receipt(contract: Boolean = false, sourceBase: String? = base): JsonObject = json("""{
        "version":1,"actor":"$wallet","idempotencyKey":"$key","request":${request(contract).body},"hero":"vex",
        "building":{"id":"32345678-1234-4123-8123-123456789012","baseId":"$base","type":"heroaltar","level":1,"tx":10,"ty":11},
        "job":{"id":"42345678-1234-4123-8123-123456789012","buildingId":"32345678-1234-4123-8123-123456789012","startedAt":"2026-09-13T00:00:00.000Z","finishesAt":"2026-09-13T00:00:02.000Z"},
        "funding":${if (contract) """{"kind":"contract","itemId":"item_hero_vex","itemUseId":"52345678-1234-4123-8123-123456789012","sourceBaseId":${sourceBase?.let { "\"$it\"" } ?: "null"},"quantity":1}""" else """{"kind":"keep","amount":"37","ledgerTransactionId":"62345678-1234-4123-8123-123456789012"}"""},
        "createdAt":"2026-09-13T00:00:00.000Z"}""")
    private fun status(proof: JsonElement = JsonNull) = buildJsonObject { put("version", 1); put("wallet", wallet); put("idempotencyKey", key); put("enabled", false); put("receipt", proof) }
    private fun patch(raw: JsonObject, name: String, value: JsonElement) = JsonObject(raw + (name to value))
    @Test fun `signed hero quote freezes original bounds while legacy quotes remain unchanged`() {
        val plot=PlotGeometry.supported(2);val d=definition.copy(plotTiles=plot.size,plotGeometry=plot)
        val signed=request().copy(tx=-10,ty=38);val original=spec.intent(wallet,signed,d)
        assertEquals(d,spec.definition(original));assertEquals(key,original.idempotencyKey)
        assertEquals("/heroes/recruit/v1/$key",spec.receiptRequest(original).path)
        val proof=receipt();val b=proof.getValue("building").jsonObject
        val accepted=JsonObject(proof+mapOf("request" to signed.body,"building" to JsonObject(b+mapOf("tx" to JsonPrimitive(-10),"ty" to JsonPrimitive(38)))))
        assertEquals(signed,spec.restore(original,ReceiptDocument.fromPost(accepted)).request)
        val forged=original.copy(quote=JsonObject(original.quote!!+("plotGeometry" to JsonObject(plot.json+("max" to JsonPrimitive(41))))))
        assertThrows(IllegalArgumentException::class.java) { spec.definition(forged) }
        assertFalse(intent().quote!!.containsKey("plotGeometry"))
    }
    @Test fun `a contract can fund an accepted altar from the original deed or the legacy wallet`() {
        for (source in listOf(base, null)) assertEquals(source?.let(::JsonPrimitive) ?: JsonNull,
            spec.acknowledge(intent(true), receipt(true, source)).funding["sourceBaseId"])
    }
    @Test fun `an accepted KEEP ceiling permits a later prepaid contract without changing consent`() {
        val raw = patch(receipt(true), "request", request(false).body)
        assertEquals("contract", spec.acknowledge(intent(), raw).funding["kind"]!!.jsonPrimitive.content)
    }
    @Test fun `contract only consent cannot be silently converted into a KEEP debit`() {
        val changed = patch(receipt(), "request", request(true).body)
        assertThrows(IllegalArgumentException::class.java) { spec.acknowledge(intent(true), changed) }
    }
    @Test fun `payer request and every returned destination must belong to the original command`() {
        val raw = receipt()
        for (changed in listOf(
            patch(raw, "actor", JsonPrimitive("22222222222222222222222222222222")),
            patch(raw, "request", request().copy(tx = 12).body), patch(raw, "hero", JsonPrimitive("theodor")),
            patch(raw, "building", patch(raw.getValue("building").jsonObject, "baseId", JsonNull)),
            patch(raw, "job", patch(raw.getValue("job").jsonObject, "buildingId", JsonPrimitive(base))),
        )) assertThrows(IllegalArgumentException::class.java) { spec.acknowledge(intent(), changed) }
    }
    @Test fun `a foreign contract custody row or different hero item is never accepted`() {
        val raw = receipt(true); val funding = raw.getValue("funding").jsonObject
        for ((field, value) in listOf("sourceBaseId" to JsonPrimitive(key), "itemId" to JsonPrimitive("item_hero_theodor"), "quantity" to JsonPrimitive(2)))
            assertThrows(IllegalArgumentException::class.java) { spec.acknowledge(intent(true), patch(raw, "funding", patch(funding, field, value))) }
    }
    @Test fun `over ceiling zero malformed and floating point debit proofs stay unknown`() {
        val raw = receipt(); val funding = raw.getValue("funding").jsonObject
        for (amount in listOf(JsonPrimitive("38"), JsonPrimitive("0"), JsonPrimitive("1e1"), JsonPrimitive(37), JsonPrimitive("9223372036854775808")))
            assertThrows(IllegalArgumentException::class.java) { spec.acknowledge(intent(), patch(raw, "funding", patch(funding, "amount", amount))) }
    }
    @Test fun `receipt GET stays authoritative with flag disabled while null proves no outcome`() {
        // Rewritten 2026-10-06 (server facts, owner review M1): the GET is a locked read, so `receipt: null` is the server's
        // proof that no row holds this key (Absent), still never a refusal; MoneyOp waits out the minimum age before CLOSE.
        assertEquals(Receipt.Absent, spec.decodeReceipt(intent(), status()))
        val proof = (spec.decodeReceipt(intent(), status(receipt())) as Receipt.Accepted).value
        assertEquals(request(), proof.request); assertEquals("/heroes/recruit/v1/$key", spec.receiptRequest(intent()).path)
    }
    @Test fun `stored receipts validate original frozen terms instead of todays mutable catalogue`() {
        val original = intent(); val document = ReceiptDocument.fromPost(receipt())
        assertEquals("37", spec.restore(original, document).funding["amount"]!!.jsonPrimitive.content)
        assertThrows(IllegalArgumentException::class.java) { HeroRecruitmentSpec("mainnet-beta").definition(original) }
        assertThrows(IllegalArgumentException::class.java) { spec.definition(original.copy(body = request().copy(tx = 12).body, baseId = null)) }
    }
    @Test fun `strict request prevents optional scope guessing uppercase aliases and contradictory funding`() {
        for (raw in listOf(JsonObject(request().body - "baseId"), patch(request().body, "heroContractOnly", JsonPrimitive("false")),
            request().copy(idempotencyKey = "abcdefab-abcd-4abc-8abc-abcdefabcdef".uppercase()).body,
            request().copy(heroContractOnly = true).body, request().copy(tx = definition.plotTiles).body))
            assertThrows(IllegalArgumentException::class.java) { HeroRecruitmentRequest.from(raw, definition.plotTiles) }
    }
    @Test fun `unknown receipt fields malformed null and reverse job time cannot become success`() {
        for (raw in listOf(patch(status(), "receipt", JsonPrimitive(false)), patch(status(receipt()), "unexpected", JsonPrimitive(true)),
            status(patch(receipt(), "job", patch(receipt().getValue("job").jsonObject, "finishesAt", JsonPrimitive("2026-09-12T00:00:00.000Z"))))))
            assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(intent(), raw) }
    }
}
