package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class WithdrawalUnwindSpecTest {
    private val wallet = "DnF3JgFtAEdF7Gkcdne5DMtwyLE1S25Uyb9ip4FEfVUX"
    private val id = "00000000-0000-4000-8000-000000000001"
    private val base = "00000000-0000-4000-8000-000000000002"
    private fun row(status: String = "unbonding", refundable: Boolean = false) = buildJsonObject {
        put("id", id); put("status", status); put("amount", "100"); put("feeBurned", "10"); put("netAmount", "90")
        put("destination", wallet); put("createdAt", "2026-09-12T00:00:00Z"); put("unbondsAt", "2026-09-13T00:00:00Z")
        put("completedAt", if (status in setOf("cancelled", "refunded", "sent")) JsonPrimitive("2026-09-13T01:00:00Z") else JsonNull)
        put("txSignature", if (status == "sent") JsonPrimitive("original-signature") else JsonNull); put("mint", JsonNull); put("refundable", refundable)
    }
    private fun history(vararg rows: JsonObject, version: Int = 1) = buildJsonObject {
        put("features", buildJsonObject { put("withdrawalReceipts", buildJsonObject { put("version", version) }) })
        put("withdrawals", JsonArray(rows.toList()))
    }
    private fun intent(action: WithdrawalUnwindAction = WithdrawalUnwindAction.CANCEL) =
        WithdrawalUnwindSpec.intent(wallet, base, action, WithdrawalUnwindTarget.from(row()))
    @Test fun `exact row and action are journaled before a bodyless intrinsically idempotent unwind`() {
        val saved = intent(); assertEquals("$id:cancel", saved.idempotencyKey)
        assertEquals("/withdrawals/$id/cancel", saved.path); assertTrue(saved.body.isEmpty())
        assertEquals(ReceiptRequest("/withdrawals", emptyMap<String, String>()), WithdrawalUnwindSpec.receiptRequest(saved))
        for (changed in listOf(saved.copy(path = "/withdrawals/$id/refund"), saved.copy(idempotencyKey = "another-key"), saved.copy(body = buildJsonObject { put("baseId", base) }))) {
            assertThrows(IllegalArgumentException::class.java) { WithdrawalUnwindSpec.consent(changed) }
        }
    }
    @Test fun `eligibility uses server unbonding or positive refundable failed status only`() {
        assertTrue(WithdrawalUnwindSpec.eligible(row(), WithdrawalUnwindAction.CANCEL))
        assertTrue(WithdrawalUnwindSpec.eligible(row("failed", true), WithdrawalUnwindAction.REFUND))
        for (status in listOf("processing", "sent", "cancelled", "refunded", "failed")) assertFalse(WithdrawalUnwindSpec.eligible(row(status), WithdrawalUnwindAction.CANCEL))
        assertFalse(WithdrawalUnwindSpec.eligible(row("failed"), WithdrawalUnwindAction.REFUND))
        assertFalse(WithdrawalUnwindSpec.eligible(row("processing", true), WithdrawalUnwindAction.REFUND))
        assertFalse(WithdrawalUnwindSpec.eligible(JsonObject(row("failed") + ("refundable" to JsonPrimitive("true"))), WithdrawalUnwindAction.REFUND))
    }
    @Test fun `only coupled terminal history proves the original escrow outcome`() {
        for (status in listOf("unbonding", "processing", "failed", "unknown")) assertEquals(Receipt.Unknown, WithdrawalUnwindSpec.decodeReceipt(intent(), history(row(status, true))))
        assertEquals(Receipt.Unknown, WithdrawalUnwindSpec.decodeReceipt(intent(), history()))
        assertEquals(Receipt.Unsupported, WithdrawalUnwindSpec.decodeReceipt(intent(), history(row("cancelled"), version = 2)))
        val proof = WithdrawalUnwindSpec.decodeReceipt(intent(), history(row("cancelled"))) as Receipt.Accepted
        assertTrue(proof.value.returnedToWallet); assertEquals(base, proof.value.baseId)
        assertEquals(proof.value, WithdrawalUnwindSpec.restore(intent(), proof.document))
    }
    @Test fun `a concurrent payout is observed honestly without claiming cancellation or refund`() {
        val proof = WithdrawalUnwindSpec.decodeReceipt(intent(), history(row("sent"))) as Receipt.Accepted
        assertEquals("sent", proof.value.status); assertFalse(proof.value.returnedToWallet)
        assertEquals("original-signature", proof.value.signature)
        val refund = WithdrawalUnwindSpec.decodeReceipt(intent(), history(row("refunded"))) as Receipt.Accepted
        assertEquals(WithdrawalUnwindAction.CANCEL, refund.value.action); assertEquals("refunded", refund.value.status)
    }
    @Test fun `wrong original facts and duplicate rows cannot prove a return`() {
        for ((key, value) in mapOf("amount" to "101", "feeBurned" to "11", "netAmount" to "89", "destination" to "11111111111111111111111111111111", "createdAt" to "2026-09-11T00:00:00Z", "unbondsAt" to "2026-09-14T00:00:00Z")) {
            assertThrows(ApiCompatibilityException::class.java) { WithdrawalUnwindSpec.decodeReceipt(intent(), history(JsonObject(row("cancelled") + (key to JsonPrimitive(value))))) }
        }
        assertThrows(ApiCompatibilityException::class.java) { WithdrawalUnwindSpec.decodeReceipt(intent(), history(row("cancelled"), row("cancelled"))) }
    }
    @Test fun `malformed amounts and incomplete terminal proof stay held`() {
        for (value in listOf(JsonPrimitive(100), JsonPrimitive("01"), JsonPrimitive("1e2"), JsonPrimitive("9223372036854775808"), JsonPrimitive("-1"))) {
            assertThrows(Exception::class.java) { WithdrawalUnwindTarget.from(JsonObject(row() + ("amount" to value))) }
        }
        for ((status, key) in listOf("cancelled" to "completedAt", "refunded" to "completedAt", "sent" to "txSignature")) {
            assertThrows(ApiCompatibilityException::class.java) { WithdrawalUnwindSpec.decodeReceipt(intent(), history(JsonObject(row(status) + (key to JsonNull)))) }
        }
    }
    @Test fun `post acknowledgements require the exact target action and refund gross`() {
        WithdrawalUnwindSpec.validateAcknowledgement(intent(), buildJsonObject { put("id", id); put("status", "cancelled") })
        val refund = intent(WithdrawalUnwindAction.REFUND)
        WithdrawalUnwindSpec.validateAcknowledgement(refund, buildJsonObject { put("id", id); put("status", "refunded"); put("amount", "100") })
        for (raw in listOf(buildJsonObject { put("id", base); put("status", "refunded"); put("amount", "100") },
            buildJsonObject { put("id", id); put("status", "cancelled"); put("amount", "100") },
            buildJsonObject { put("id", id); put("status", "refunded"); put("amount", "90") })) {
            assertThrows(IllegalArgumentException::class.java) { WithdrawalUnwindSpec.validateAcknowledgement(refund, raw) }
        }
        assertThrows(ApiCompatibilityException::class.java) { WithdrawalUnwindSpec.acknowledge(intent(), buildJsonObject { put("id", id); put("status", "cancelled") }) }
    }
}
