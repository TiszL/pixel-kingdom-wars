package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Fixtures mirror shared/forgeClaims.ts; small injected batch bounds exercise the contract. */
class ForgeClaimSpecTest {
    private val wallet = "11111111111111111111111111111111"
    private val key = "00000000-0000-4000-8000-000000000001"
    private val base = "00000000-0000-4000-8000-000000000002"
    private val ledger = "00000000-0000-4000-8000-000000000003"
    private val spec = ForgeClaimSpec("devnet")
    private fun intent(day: String? = null, scope: String? = base) = spec.intent(wallet, key, scope, day, 2)
    private fun row(day: String = "2026-09-11", keep: String = "777", id: String = ledger) = buildJsonObject {
        put("day", day); put("keep", keep); put("ledgerTransactionId", id)
    }
    private fun proof(rows: List<JsonObject> = listOf(row()), total: String = "777", scope: String? = base, day: String? = null) = buildJsonObject {
        put("version", 1); put("actor", wallet); put("idempotencyKey", key); put("baseId", scope?.let(::JsonPrimitive) ?: JsonNull)
        put("day", day?.let(::JsonPrimitive) ?: JsonNull); put("createdAt", "2026-09-13T00:00:00.000Z")
        put("result", buildJsonObject { put("claimed", JsonArray(rows)); put("totalKeep", total); put("remaining", 1) })
    }
    private fun status(receipt: JsonElement = JsonNull, enabled: Boolean = true) = buildJsonObject {
        put("version", 1); put("wallet", wallet); put("idempotencyKey", key); put("enabled", enabled); put("receipt", receipt)
    }
    private fun JsonObject.change(field: String, value: JsonElement) = JsonObject(this + (field to value))
    @Test fun `request freezes explicit nullable selectors and distinct ledger evidence`() {
        val i = intent(); assertEquals(setOf("idempotencyKey", "baseId", "day"), i.body.keys)
        assertEquals(JsonNull, i.body["day"]); assertEquals(JsonNull, intent(scope = null).body["baseId"])
        assertEquals("/forge/claims/v1/$key", spec.receiptRequest(i).path)
        assertEquals(ledger, spec.acknowledge(i, proof()).result.claimed.single().ledgerTransactionId)
    }
    @Test fun `empty immutable receipt is terminal while missing history is unknown`() {
        assertEquals(Receipt.Unknown, spec.decodeReceipt(intent(), status()))
        val r = spec.decodeReceipt(intent(), status(proof(emptyList(), "0"))) as Receipt.Accepted
        assertEquals("0", r.value.result.totalKeep); assertTrue(r.value.result.claimed.isEmpty())
        assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(intent(), JsonObject(status() - "receipt")) }
    }
    @Test fun `disabled claims still expose original history and post or get proof restores identically`() {
        val p = proof(); val accepted = spec.decodeReceipt(intent(), status(p, false)) as Receipt.Accepted
        assertEquals(spec.acknowledge(intent(), p), accepted.value)
        assertEquals(accepted.value, spec.restore(intent(), accepted.document))
        assertEquals(accepted.value, spec.restore(intent(), ReceiptDocument.fromPost(p)))
    }
    @Test fun `wallet key base and day must match original consent independently`() {
        for ((field, value) in listOf("actor" to JsonPrimitive("22222222222222222222222222222222"), "idempotencyKey" to JsonPrimitive(ledger), "baseId" to JsonNull, "day" to JsonPrimitive("2026-09-11"))) {
            assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(intent(), status(proof().change(field, value))) }
        }
        assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(intent(), status().change("wallet", JsonPrimitive("22222222222222222222222222222222"))) }
    }
    @Test fun `single day cannot certify a different allocation even if amount agrees`() {
        assertEquals("777", spec.acknowledge(intent("2026-09-11"), proof(day = "2026-09-11")).result.totalKeep)
        assertThrows(IllegalArgumentException::class.java) { spec.acknowledge(intent("2026-09-12"), proof(day = "2026-09-12")) }
    }
    @Test fun `bound sum strict day ordering and unique ledger ids reject malformed proof`() {
        val invalid = listOf(proof(total = "778"), proof(listOf(row(), row()), "1554"),
            proof(listOf(row("2026-09-12"), row("2026-09-11", id = base)), "1554"),
            proof(listOf(row(), row("2026-09-12")), "1554"),
            proof(listOf(row(), row("2026-09-12", id = base), row("2026-09-13", id = key)), "2331"), proof(listOf(row(keep = "0")), "0"))
        invalid.forEach { assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(intent(), status(it)) } }
    }
    @Test fun `amounts are bounded integer strings and remaining is a safe JSON integer`() {
        for (amount in listOf("1e2", "01", "-1", "9223372036854775808", "0.1")) {
            assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(intent(), status(proof(listOf(row(keep = amount)), amount))) }
        }
        for (remaining in listOf(JsonPrimitive("1"), JsonPrimitive(-1), JsonPrimitive(9007199254740992L), JsonPrimitive(1.5))) {
            val p = proof(); assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(intent(), status(p.change("result", p["result"]!!.jsonObject.change("remaining", remaining)))) }
        }
        val p = proof(); assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(intent(), status(p.change("result", p["result"]!!.jsonObject.change("totalKeep", JsonPrimitive(777))))) }
    }
    @Test fun `missing nullable fields unknown fields and wrong versions fail closed`() {
        for (field in listOf("baseId", "day")) assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(intent(), status(JsonObject(proof() - field))) }
        assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(intent(), status(proof().change("extra", JsonPrimitive(true)))) }
        assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(intent(), status().change("version", JsonPrimitive(2))) }
    }
    @Test fun `canonical UUID date cluster and immutable request validation reject aliases`() {
        assertThrows(IllegalArgumentException::class.java) { spec.intent(wallet, "ABC00000-0000-4000-8000-000000000001", base, null, 2) }
        assertThrows(Exception::class.java) { intent("2026-02-30") }
        assertThrows(IllegalArgumentException::class.java) { ForgeClaimSpec("localnet") }
        val i = intent()
        for (bad in listOf(i.copy(path = "/forge/claim"), i.copy(body = JsonObject(i.body - "baseId")), i.copy(baseId = null),
            i.copy(quote = i.quote!!.change("cluster", JsonPrimitive("mainnet-beta"))))) {
            assertThrows(IllegalArgumentException::class.java) { spec.validate(bad) }
        }
    }
    @Test fun `create before attempted crash still allows original v1 explicit retry but never legacy or proven rows`() {
        val i = intent(); assertTrue(InterruptedIntent(i).retryable)
        assertFalse(InterruptedIntent(i.copy(path = "/forge/claim")).retryable)
        assertFalse(InterruptedIntent(i.copy(attempted = true, receipt = ReceiptDocument.fromPost(proof()))).retryable)
    }
}
