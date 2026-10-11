package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ClanCommandSpecTest {
    private val wallet = "11111111111111111111111111111111"
    private val target = "22222222222222222222222222222222"
    private val key = "00000000-0000-4000-8000-000000000001"
    private val clan = "00000000-0000-4000-8000-000000000002"
    private val base = "00000000-0000-4000-8000-000000000003"
    private val ledger = "00000000-0000-4000-8000-000000000004"
    private val leave = ClanCommandSpec(IntentKind.CLAN_LEAVE, "devnet")
    private val kick = ClanCommandSpec(IntentKind.CLAN_KICK, "devnet")
    private fun intent() = leave.intent(wallet, key, clan, "Crown", base, null)
    private fun proof(kind: String = "leave", state: String = "disbanded", payout: String = "777") = buildJsonObject {
        put("version", 1); put("actor", wallet); put("idempotencyKey", key); put("kind", kind); put("clanId", clan)
        put("baseId", if (kind == "leave") JsonPrimitive(base) else JsonNull)
        put("target", if (kind == "kick") JsonPrimitive(target) else JsonNull); put("state", state)
        put("payoutShards", payout); put("ledgerTransactionId", if (payout == "0") JsonNull else JsonPrimitive(ledger))
        put("refusalCode", if (state == "refused") JsonPrimitive("CLAN_CHANGED") else JsonNull)
        put("createdAt", "2026-09-13T00:00:00.000Z")
    }
    private fun status(receipt: JsonElement = JsonNull) = buildJsonObject {
        put("version", 1); put("wallet", wallet); put("idempotencyKey", key); put("receipt", receipt)
    }
    private fun JsonObject.change(key: String, value: JsonElement) = JsonObject(this + (key to value))

    @Test fun `exact expected clan and original payout base are sent with the durable command key`() {
        val i = intent()
        assertEquals(setOf("idempotencyKey", "clanId", "baseId"), i.body.keys)
        assertEquals(JsonPrimitive(base), i.body["baseId"])
        assertEquals("/clans/v1/commands/$key", leave.receiptRequest(i).path)
        assertEquals("777", leave.acknowledge(i, proof()).payoutShards)
        assertEquals(ledger, leave.acknowledge(i, proof()).ledgerTransactionId)
    }
    @Test fun `missing receipt is unknown and never a zero payout or permission to replace consent`() {
        assertEquals(Receipt.Unknown, leave.decodeReceipt(intent(), status()))
        assertThrows(ApiCompatibilityException::class.java) { leave.decodeReceipt(intent(), JsonObject(status() - "receipt")) }
    }
    @Test fun `POST and matching GET persist distinct proof envelopes and restore the same immutable result`() {
        val i = intent(); val expected = leave.acknowledge(i, proof())
        assertEquals(expected, leave.restore(i, ReceiptDocument.fromPost(proof())))
        val accepted = leave.decodeReceipt(i, status(proof())) as Receipt.Accepted
        assertEquals(expected, accepted.value); assertEquals(expected, leave.restore(i, accepted.document))
        assertThrows(IllegalStateException::class.java) { leave.restore(i, ReceiptDocument.fromRejection(proof())) }
    }
    @Test fun `wallet key clan payout base and target must each match original consent`() {
        for (field in listOf("actor", "idempotencyKey", "clanId", "baseId")) {
            val wrong = if (field == "actor") target else ledger
            assertThrows(ApiCompatibilityException::class.java) { leave.decodeReceipt(intent(), status(proof().change(field, JsonPrimitive(wrong)))) }
        }
        assertThrows(ApiCompatibilityException::class.java) { leave.decodeReceipt(intent(), status(proof()).change("wallet", JsonPrimitive(target))) }
        val i = kick.intent(wallet, key, clan, "Crown", null, target)
        assertEquals(target, kick.acknowledge(i, proof("kick", "kicked", "0")).target)
        assertThrows(IllegalArgumentException::class.java) { kick.acknowledge(i, proof("kick", "kicked", "0").change("target", JsonPrimitive(wallet))) }
    }
    @Test fun `durable refusal is terminal exact no-effect evidence even if current clan could later permit it`() {
        val r = leave.decodeReceipt(intent(), status(proof(state = "refused", payout = "0"))) as Receipt.Accepted
        assertEquals("refused", r.value.state); assertEquals("CLAN_CHANGED", r.value.refusalCode)
        assertEquals("0", r.value.payoutShards); assertNull(r.value.ledgerTransactionId)
    }
    @Test fun `zero and exact maximum amounts require canonical ledger correspondence and decimal strings`() {
        assertEquals("0", leave.acknowledge(intent(), proof(payout = "0")).payoutShards)
        assertEquals(Long.MAX_VALUE.toString(), leave.acknowledge(intent(), proof(payout = Long.MAX_VALUE.toString())).payoutShards)
        for (amount in listOf("-1", "01", "1.0", "1e3", "9223372036854775808")) {
            assertThrows(IllegalArgumentException::class.java) { leave.acknowledge(intent(), proof(payout = amount)) }
        }
        for (invalid in listOf(proof().change("ledgerTransactionId", JsonNull), proof(payout = "0").change("ledgerTransactionId", JsonPrimitive(ledger)),
            proof(state = "left"), proof(state = "refused"), proof().change("target", JsonPrimitive(target)))) {
            assertThrows(IllegalArgumentException::class.java) { leave.acknowledge(intent(), invalid) }
        }
    }
    @Test fun `legacy requests and cross-cluster records cannot enter versioned recovery`() {
        val i = intent()
        assertThrows(IllegalArgumentException::class.java) { leave.receiptRequest(i.copy(path = "/clans/leave")) }
        assertThrows(IllegalArgumentException::class.java) { ClanCommandSpec(IntentKind.CLAN_LEAVE, "mainnet-beta").receiptRequest(i) }
        assertThrows(IllegalArgumentException::class.java) { leave.receiptRequest(i.copy(body = JsonObject(i.body - "idempotencyKey"))) }
    }
    @Test fun `wallet mode preserves explicit null and never derives a deed from a later selection`() {
        val i = leave.intent(wallet, key, clan, "Crown", null, null)
        assertEquals(JsonNull, i.body["baseId"])
        assertNull(leave.acknowledge(i, proof().change("baseId", JsonNull)).baseId)
        assertThrows(IllegalArgumentException::class.java) { leave.acknowledge(i, proof()) }
    }
    @Test fun `wire version extra fields missing fields and uppercase UUID aliases are refused`() {
        for (r in listOf(proof().change("version", JsonPrimitive(2)), proof().change("version", JsonPrimitive("1")),
            proof().change("payoutShards", JsonPrimitive(777)), proof().change("extra", JsonPrimitive(true)), JsonObject(proof() - "baseId"))) {
            assertThrows(Exception::class.java) { ClanCommandReceipt.from(r) }
        }
        assertThrows(IllegalArgumentException::class.java) { leave.intent(wallet, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", clan, "Crown", base, null) }
    }
}
