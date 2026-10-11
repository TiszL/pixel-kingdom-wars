package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class WithdrawalSpecTest {
    private val wallet = "DnF3JgFtAEdF7Gkcdne5DMtwyLE1S25Uyb9ip4FEfVUX"
    private val quote = WithdrawalQuote(buildJsonObject {
        put("version", 1); put("grossAmount", "100"); put("feeBurned", "10"); put("netAmount", "90")
        put("destination", wallet); put("cluster", "devnet"); put("keepMint", "11111111111111111111111111111111")
        put("idempotencyKey", "withdrawal-key"); put("mode", "standard"); put("unbondingHours", 24)
    })
    private val intent get() = WithdrawalSpec.intent(wallet, null, quote)
    private fun receipt() = buildJsonObject {
        put("version", 1); put("status", "accepted"); put("wallet", wallet); put("request", quote.receiptQuery())
        put("receiptId", "65ae967a-bf89-4e01-bcae-52a48ffdc768"); put("acceptedAt", "2026-09-12T00:00:00.000Z")
        put("funding", buildJsonObject { put("currency", "KEEP"); put("amount", "100") })
        put("result", buildJsonObject { put("withdrawalId", "64ee967a-bf89-4e01-bcae-52a48ffdc768"); put("unbondsAt", "2026-09-13T00:00:00.000Z") })
    }
    @Test fun `journal contains only public signed intent and receipt query never claims proof of hold hours`() {
        assertEquals(setOf("amount", "destination", "idempotencyKey", "instant"), intent.body.keys)
        assertFalse(WithdrawalSpec.receiptRequest(intent).query.containsKey("unbondingHours"))
        assertEquals(quote.intent, intent.quote)
        assertThrows(IllegalArgumentException::class.java) { WithdrawalQuote(JsonObject(quote.intent + ("unbondingHours" to JsonPrimitive(0)))) }
        for ((key, value) in mapOf("challengeToken" to JsonPrimitive("secret"), "grossAmount" to JsonPrimitive("01"),
            "cluster" to JsonPrimitive("testnet"), "unbondingHours" to JsonPrimitive(9007199254740992L), "mode" to JsonPrimitive("instant"))) {
            assertThrows(IllegalArgumentException::class.java) { WithdrawalQuote(JsonObject(quote.intent + (key to value))) }
        }
    }
    @Test fun `receipt binds actor key amounts currency destination mode and original network`() {
        val raw = receipt(); val accepted = WithdrawalSpec.decodeReceipt(intent, raw) as Receipt.Accepted
        assertEquals("64ee967a-bf89-4e01-bcae-52a48ffdc768", accepted.value.withdrawalId)
        assertEquals(accepted.value, WithdrawalSpec.restore(intent, WithdrawalSpec.acknowledgementDocument(raw)))
        for ((key, value) in mapOf("idempotencyKey" to "another-key", "grossAmount" to "101", "feeBurned" to "11", "netAmount" to "89",
            "destination" to "11111111111111111111111111111111", "mode" to "instant", "cluster" to "mainnet-beta", "keepMint" to wallet)) {
            val changed = JsonObject(raw + ("request" to JsonObject(quote.receiptQuery() + (key to JsonPrimitive(value)))))
            assertThrows(ApiCompatibilityException::class.java) { WithdrawalSpec.decodeReceipt(intent, changed) }
        }
        for (changed in listOf(raw + ("wallet" to JsonPrimitive("other")), raw + ("funding" to buildJsonObject { put("currency", "SHARDS"); put("amount", "100") }))) {
            assertThrows(ApiCompatibilityException::class.java) { WithdrawalSpec.decodeReceipt(intent, JsonObject(changed)) }
        }
    }
    @Test fun `unknown and legacy acknowledgements cannot retire or replay the withdrawal`() {
        assertEquals(Receipt.Unknown, WithdrawalSpec.decodeReceipt(intent, buildJsonObject { put("version", 1); put("status", "unknown"); put("idempotencyKey", quote.key) }))
        assertEquals(Receipt.Unsupported, WithdrawalSpec.decodeReceipt(intent, buildJsonObject { put("version", 2) }))
        assertThrows(IllegalArgumentException::class.java) { WithdrawalSpec.restore(intent, ReceiptDocument.fromPost(receipt())) }
        assertThrows(ApiCompatibilityException::class.java) { WithdrawalSpec.acknowledge(intent, buildJsonObject { put("status", "pending"); put("id", "some-id") }) }
        assertFalse(InterruptedIntent(intent.copy(attempted = true)).retryable)
        assertFalse(InterruptedIntent(intent.copy(attempted = true), Receipt.Unknown).closable)
    }
    @Test fun `original maturity is returned without deriving payout or checking elapsed time`() {
        val raw = receipt(); val historical = JsonObject(raw + ("result" to buildJsonObject {
            put("withdrawalId", "64ee967a-bf89-4e01-bcae-52a48ffdc768"); put("unbondsAt", "2020-01-01T00:00:00.000Z")
        }))
        val accepted = WithdrawalSpec.decodeReceipt(intent, historical) as Receipt.Accepted
        assertEquals("2020-01-01T00:00:00.000Z", accepted.value.unbondsAt)
        assertEquals(quote, accepted.value.quote)
    }
}
