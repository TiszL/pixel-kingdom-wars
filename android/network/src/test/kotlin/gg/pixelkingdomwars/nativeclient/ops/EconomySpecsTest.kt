package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class EconomySpecsTest {
    private val base = "8d04db9d-1949-405a-8279-a4f9a8ca75f5"
    private fun receipt(spec: EconomySpec, intent: PendingIntent) = buildJsonObject {
        put("version", 1); put("status", "accepted"); put("wallet", intent.wallet); put("baseId", intent.baseId?.let(::JsonPrimitive) ?: JsonNull)
        put("request", intent.body); put("receiptId", "2f79773d-dfbf-4c5e-84fc-28d29076eaed"); put("acceptedAt", "2026-09-12T00:00:00.000Z")
        put("funding", buildJsonObject { put("currency", if (spec == KeepConversionSpec) "KEEP" else "SHARDS"); put("amount", "10") })
        put("result", if (spec == KeepConversionSpec) buildJsonObject { put("converted", "10"); put("shards", "30"); put("rate", 3) }
            else buildJsonObject { put("day", "2026-09-13"); put("contributedShards", "10") })
    }
    @Test fun `exact receipts bind original base wallet key amounts and currency without current balances`() {
        for (spec in listOf(KeepConversionSpec, ForgeContributionSpec)) {
            val intent = spec.intent("wallet", base.uppercase(), "economy-key", "10")
            val raw = receipt(spec, intent); val accepted = spec.decodeReceipt(intent, raw) as Receipt.Accepted
            assertEquals(base, accepted.value.baseId)
            assertEquals("receipt", ReceiptDocument.source(accepted.document))
            assertEquals(accepted.value, spec.restore(intent, spec.acknowledgementDocument(raw)))
            val changedRequest = JsonObject(intent.body + ("baseId" to JsonPrimitive("9d04db9d-1949-405a-8279-a4f9a8ca75f5")))
            for (changed in listOf(raw + ("wallet" to JsonPrimitive("other")), raw + ("baseId" to JsonNull), raw + ("request" to changedRequest),
                raw + ("funding" to buildJsonObject { put("currency", "SOL"); put("amount", "10") }),
                raw + ("funding" to buildJsonObject { put("currency", if (spec == KeepConversionSpec) "KEEP" else "SHARDS"); put("amount", "9") }))) {
                assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(intent, JsonObject(changed)) }
            }
        }
    }
    @Test fun `conversion records accepted historical output and rate with strict arithmetic`() {
        val intent = KeepConversionSpec.intent("wallet", null, "economy-key", "10"); val raw = receipt(KeepConversionSpec, intent)
        val value = (KeepConversionSpec.decodeReceipt(intent, raw) as Receipt.Accepted).value
        assertEquals("30", value.outputShards); assertEquals(3L, value.rate)
        for (result in listOf(buildJsonObject { put("converted", "10"); put("shards", "29"); put("rate", 3) },
            buildJsonObject { put("converted", "9"); put("shards", "27"); put("rate", 3) },
            buildJsonObject { put("converted", "10"); put("shards", "90071992547409920"); put("rate", 9007199254740992L) },
            buildJsonObject { put("converted", "10"); put("shards", "30"); put("rate", "3") })) {
            assertThrows(ApiCompatibilityException::class.java) { KeepConversionSpec.decodeReceipt(intent, JsonObject(raw + ("result" to result))) }
        }
    }
    @Test fun `contribution proves returned acceptance day not a client frozen day or cumulative myShards`() {
        val intent = ForgeContributionSpec.intent("wallet", base, "economy-key", "10")
        assertFalse(intent.body.containsKey("day"))
        val value = (ForgeContributionSpec.decodeReceipt(intent, receipt(ForgeContributionSpec, intent)) as Receipt.Accepted).value
        assertEquals("2026-09-13", value.day)
        val invalidDay = JsonObject(receipt(ForgeContributionSpec, intent) + ("result" to buildJsonObject { put("day", "+12026-09-13"); put("contributedShards", "10") }))
        assertThrows(ApiCompatibilityException::class.java) { ForgeContributionSpec.decodeReceipt(intent, invalidDay) }
        assertThrows(ApiCompatibilityException::class.java) { ForgeContributionSpec.acknowledge(intent, buildJsonObject { put("day", "2026-09-13"); put("myShards", "99") }) }
    }
    @Test fun `unknown unsupported and legacy post documents cannot retire an attempted operation`() {
        val intent = KeepConversionSpec.intent("wallet", base, "economy-key", "10")
        assertEquals(Receipt.Unknown, KeepConversionSpec.decodeReceipt(intent, buildJsonObject { put("version", 1); put("status", "unknown"); put("idempotencyKey", intent.idempotencyKey) }))
        assertEquals(Receipt.Unsupported, KeepConversionSpec.decodeReceipt(intent, buildJsonObject { put("version", 2) }))
        assertThrows(ApiCompatibilityException::class.java) { KeepConversionSpec.decodeReceipt(intent, buildJsonObject { put("version", 1); put("status", "unknown"); put("idempotencyKey", "different-key") }) }
        assertThrows(IllegalArgumentException::class.java) { KeepConversionSpec.restore(intent, ReceiptDocument.fromPost(receipt(KeepConversionSpec, intent))) }
        assertFalse(InterruptedIntent(intent.copy(attempted = true)).retryable)
        assertFalse(InterruptedIntent(intent.copy(attempted = true), Receipt.Unknown).closable)
    }
    @Test fun `new intent rejects fractional negative noncanonical amounts and invalid base`() {
        for (amount in listOf("0", "01", "1.5", "-1", "1e2", "9".repeat(33))) assertThrows(IllegalArgumentException::class.java) {
            KeepConversionSpec.intent("wallet", base, "economy-key", amount)
        }
        assertThrows(IllegalArgumentException::class.java) { ForgeContributionSpec.intent("wallet", "not-base", "economy-key", "10") }
    }
}
