package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class HeroReceiptTest {
    private val until = "2026-09-12T10:00:00.000Z"
    private val upgrade = HeroUpgradeSpec.intent(WALLET, BASE, "vex", "hero-level-receipt", 2, "2500").copy(attempted = true)
    private val recovery = HeroRecoverySpec.intent(WALLET, BASE, "vex", "hero-episode-receipt", "7", until).copy(attempted = true)

    private fun receipt(intent: PendingIntent, upgrade: Boolean): JsonObject = buildJsonObject {
        put("version", 1); put("status", "accepted"); put("wallet", WALLET); put("baseId", BASE)
        put("receiptId", BASE); put("acceptedAt", "2026-09-12T09:59:50.000Z")
        put("request", buildJsonObject {
            put("hero", "vex"); put("baseId", BASE); put("idempotencyKey", intent.idempotencyKey)
            if (upgrade) { put("expectedLevel", 1); put("maxCostKeep", "2500") }
            else { put("recoveryUntil", until); put("maxCostKeep", "7") }
        })
        put("funding", buildJsonObject { put("currency", "KEEP"); put("amount", if (upgrade) "2500" else "5") })
        put("result", buildJsonObject { if (upgrade) { put("fromLevel", 1); put("toLevel", 2) } else put("recoveryUntil", until) })
    }
    private fun JsonObject.changed(key: String, value: JsonElement) = JsonObject(this + (key to value))

    @Test fun `matching ledger evidence retires the original level and injury independent of today's roster`() {
        val paidLevel = HeroUpgradeSpec.decodeReceipt(upgrade, receipt(upgrade, true)) as Receipt.Accepted
        assertEquals(2, paidLevel.value.level); assertEquals("2500", paidLevel.value.spentKeep); assertTrue(paidLevel.value.replayed)
        assertEquals(paidLevel.value, HeroUpgradeSpec.restore(upgrade, paidLevel.document))
        val paidInjury = HeroRecoverySpec.decodeReceipt(recovery, receipt(recovery, false)) as Receipt.Accepted
        assertEquals("5", paidInjury.value.spentKeep); assertTrue(paidInjury.value.replayed)
        assertEquals(paidInjury.value, HeroRecoverySpec.restore(recovery, paidInjury.document))
        val equivalentTime = receipt(recovery, false).changed("result", buildJsonObject { put("recoveryUntil", "2026-09-12T10:00:00Z") })
        assertTrue(HeroRecoverySpec.decodeReceipt(recovery, equivalentTime) is Receipt.Accepted)
    }

    @Test fun `another payer base key hero or approved intent can never be used as our receipt`() {
        for ((intent, isUpgrade) in listOf(upgrade to true, recovery to false)) {
            val good = receipt(intent, isUpgrade)
            val request = good.getValue("request").jsonObject
            val mismatches = listOf(
                good.changed("wallet", JsonPrimitive("another-wallet")), good.changed("baseId", JsonNull),
                good.changed("receiptId", JsonPrimitive("not-a-uuid")), good.changed("acceptedAt", JsonPrimitive("yesterday")),
                good.changed("request", request.changed("idempotencyKey", JsonPrimitive("different-key"))),
                good.changed("request", request.changed("hero", JsonPrimitive("theodor"))),
                good.changed("request", request.changed("baseId", JsonNull)),
                good.changed("request", request.changed("maxCostKeep", JsonPrimitive("999999"))),
            )
            for (bad in mismatches) assertThrows(ApiCompatibilityException::class.java) {
                if (isUpgrade) HeroUpgradeSpec.decodeReceipt(intent, bad) else HeroRecoverySpec.decodeReceipt(intent, bad)
            }
        }
    }

    @Test fun `a receipt must identify the bought level or exact recovery episode and bounded KEEP debit`() {
        for ((intent, isUpgrade) in listOf(upgrade to true, recovery to false)) {
            val good = receipt(intent, isUpgrade)
            for (amount in listOf("0", "-1", "01", "1.5", "2501", "9".repeat(33))) {
                val bad = good.changed("funding", buildJsonObject { put("currency", "KEEP"); put("amount", amount) })
                assertThrows(ApiCompatibilityException::class.java) { if (isUpgrade) HeroUpgradeSpec.decodeReceipt(intent, bad) else HeroRecoverySpec.decodeReceipt(intent, bad) }
            }
            val wrongCurrency = good.changed("funding", buildJsonObject { put("currency", "SHARDS"); put("amount", "1") })
            assertThrows(ApiCompatibilityException::class.java) { if (isUpgrade) HeroUpgradeSpec.decodeReceipt(intent, wrongCurrency) else HeroRecoverySpec.decodeReceipt(intent, wrongCurrency) }
        }
        val nextLevel = receipt(upgrade, true).changed("result", buildJsonObject { put("fromLevel", 2); put("toLevel", 3) })
        assertThrows(ApiCompatibilityException::class.java) { HeroUpgradeSpec.decodeReceipt(upgrade, nextLevel) }
        val laterInjury = receipt(recovery, false).changed("result", buildJsonObject { put("recoveryUntil", "2026-09-13T10:00:00Z") })
        assertThrows(ApiCompatibilityException::class.java) { HeroRecoverySpec.decodeReceipt(recovery, laterInjury) }
    }

    @Test fun `unknown and unsupported receipts never enable a replacement payment or a POST retry`() = runBlocking {
        for ((intent, isUpgrade) in listOf(upgrade to true, recovery to false)) {
            val store = PendingIntentStore(MemoryStore()); store.create(intent)
            val transport = ScriptedTransport(onGet = { _, _ -> buildJsonObject { put("version", 1); put("status", "unknown"); put("idempotencyKey", intent.idempotencyKey) } })
            val op = if (isUpgrade) MoneyOp(HeroUpgradeSpec, store, transport) else MoneyOp(HeroRecoverySpec, store, transport)
            assertEquals(Receipt.Unknown, op.observe(WALLET) {})
            assertNotNull(store.get(intent.kind, WALLET)); assertFalse(InterruptedIntent(intent).retryable)
            transport.onGet = { _, _ -> throw ApiException(404, null, "route missing") }
            assertEquals(Receipt.Unsupported, op.observe(WALLET) {})
            assertNotNull(store.get(intent.kind, WALLET)); assertTrue(transport.posts.isEmpty())
        }
    }

    @Test fun `process restart recovers a lost payment by GET and persists proof before hydration`() = runBlocking {
        val store = PendingIntentStore(MemoryStore())
        val transport = ScriptedTransport(onPost = { _, _ -> throw IOException("lost response") })
        assertThrows(IOException::class.java) { runBlocking { MoneyOp(HeroRecoverySpec, store, transport).submit(recovery.copy(attempted = false)) {} } }
        val postedBody = transport.posts.single().second
        assertEquals(buildJsonObject { put("recoveryUntil", until); put("maxCostKeep", "7") }, postedBody["consent"])
        transport.onGet = { path, query ->
            assertEquals("/heroes/vex/recovery/speedup/receipt", path)
            assertEquals(until, query["recoveryUntil"]); assertEquals("hero-episode-receipt", query["idempotencyKey"])
            receipt(recovery, false)
        }
        val restarted = MoneyOp(HeroRecoverySpec, store, transport)
        assertThrows(IOException::class.java) { runBlocking { restarted.observe(WALLET) { throw IOException("offline hydration") } } }
        assertNotNull(store.get(IntentKind.HERO_RECOVERY, WALLET)!!.receipt)
        transport.onGet = { _, _ -> error("Saved acceptance must hydrate without another network receipt") }
        assertTrue(restarted.observe(WALLET) {} is Receipt.Accepted)
        assertNull(store.get(IntentKind.HERO_RECOVERY, WALLET)); assertEquals(1, transport.posts.size)
    }

    @Test fun `old persisted bodies gain read-only receipt observation without being rewritten`() {
        for ((intent, isUpgrade) in listOf(upgrade to true, recovery to false)) {
            val legacy = intent.copy(body = JsonObject(intent.body - "consent"))
            if (isUpgrade) {
                assertEquals(HeroUpgradeSpec.receiptRequest(intent), HeroUpgradeSpec.receiptRequest(legacy))
                assertTrue(HeroUpgradeSpec.decodeReceipt(legacy, receipt(intent, true)) is Receipt.Accepted)
            } else {
                assertEquals(HeroRecoverySpec.receiptRequest(intent), HeroRecoverySpec.receiptRequest(legacy))
                assertTrue(HeroRecoverySpec.decodeReceipt(legacy, receipt(intent, false)) is Receipt.Accepted)
            }
            assertFalse(legacy.body.containsKey("consent")); assertFalse(InterruptedIntent(legacy).retryable)
        }
    }

    @Test fun `exact Hero commands require their frozen currency and original level or injury proof`() {
        for ((original, isUpgrade) in listOf(upgrade to true, recovery to false)) {
            val exact = original.copy(expectedCurrency = "GEMS")
            val gems = receipt(exact, isUpgrade).changed("funding", buildJsonObject {
                put("currency", "GEMS"); put("amount", if (isUpgrade) "2500" else "5")
            })
            if (isUpgrade) {
                assertEquals("GEMS", (HeroUpgradeSpec.decodeReceipt(exact, gems) as Receipt.Accepted).value.currency)
                assertThrows(ApiCompatibilityException::class.java) { HeroUpgradeSpec.decodeReceipt(exact, receipt(exact, true)) }
                assertThrows(ApiCompatibilityException::class.java) { HeroUpgradeSpec.decodeReceipt(original, gems) }
            } else {
                assertEquals("GEMS", (HeroRecoverySpec.decodeReceipt(exact, gems) as Receipt.Accepted).value.currency)
                assertThrows(ApiCompatibilityException::class.java) { HeroRecoverySpec.decodeReceipt(exact, receipt(exact, false)) }
                assertThrows(ApiCompatibilityException::class.java) { HeroRecoverySpec.decodeReceipt(original, gems) }
            }
            assertEquals("GEMS", Json.decodeFromString<PendingIntent>(Json.encodeToString(PendingIntent.serializer(), exact)).expectedCurrency)
            val legacyJson = Json.encodeToJsonElement(PendingIntent.serializer(), original).jsonObject
            assertNull(Json.decodeFromJsonElement<PendingIntent>(JsonObject(legacyJson - "expectedCurrency")).expectedCurrency)
        }
    }

    @Test fun `durable exact consent reaches POST and only original GET evidence can finish it`() = runBlocking {
        val memory = MemoryStore(); val store = PendingIntentStore(memory)
        val exact = upgrade.copy(attempted = false, expectedCurrency = "GEMS")
        var posted = 0
        val evidence = receipt(exact, true).changed("funding", buildJsonObject { put("currency", "GEMS"); put("amount", "2500") })
        val reads = ScriptedTransport(); reads.onGet = { _, _ -> evidence }
        val transport = HeroCurrencyTransport(reads) { saved, _ ->
            posted++; assertTrue(saved.attempted); assertEquals(saved, store.get(saved.kind, saved.wallet))
            assertEquals("GEMS", saved.expectedCurrency); assertEquals(exact.body, saved.body)
        }
        val op = MoneyOp(HeroUpgradeSpec, store, transport)
        assertThrows(IOException::class.java) { runBlocking { op.submit(exact) { throw IOException("balance read offline") } } }
        assertEquals(ReceiptDocument.SOURCE_RECEIPT, ReceiptDocument.source(store.get(exact.kind, WALLET)!!.receipt!!))
        reads.onGet = { _, _ -> error("Original receipt already persisted") }
        val accepted = op.observe(WALLET) {} as Receipt.Accepted
        assertEquals("GEMS", accepted.value.currency); assertEquals(1, posted); assertNull(store.get(exact.kind, WALLET))
    }

    @Test fun `POST success followed by receipt 404 remains pending and legacy transport cannot drop exact consent`() = runBlocking {
        val exact = recovery.copy(attempted = false, expectedCurrency = "KEEP")
        val store = PendingIntentStore(MemoryStore()); val reads = ScriptedTransport()
        reads.onGet = { _, _ -> throw ApiException(404, null, "receipt unavailable") }
        val op = MoneyOp(HeroRecoverySpec, store, HeroCurrencyTransport(reads) { _, _ -> })
        assertThrows(IOException::class.java) { runBlocking { op.submit(exact) {} } }
        assertEquals("KEEP", store.get(exact.kind, WALLET)!!.expectedCurrency)
        assertTrue(store.get(exact.kind, WALLET)!!.attempted)
        assertThrows(IllegalStateException::class.java) { runBlocking { reads.post(exact) } }
        assertTrue(reads.posts.isEmpty())
        assertThrows(IllegalArgumentException::class.java) {
            HeroRecoverySpec.validateSend(exact.copy(body = JsonObject(exact.body - "consent")))
        }
        Unit
    }
    private fun exactRefusals(currency: String, kind: String) = listOf(
        ApiException(409, "HERO_CONSENT_STALE", "stale"),
        ApiException(409, "HERO_PRICE_CHANGED", "price"),
        ApiException(409, "CURRENCY_CONSENT_CHANGED", "currency", details = buildJsonObject { put("expectedCurrency", currency) }),
        ApiException(404, "BASE_NOT_OWNED", "ownership"),
        ApiException(409, "BASE_ID_REQUIRED", "base"),
        ApiException(409, "DEED_OWNERSHIP_CHANGED", "deed"),
        ApiException(423, "BASE_BEING_RAIDED", "raid"),
        ApiException(503, "DEED_AUTHORITY_UNAVAILABLE", "authority"),
    ) + if (kind == IntentKind.HERO_RECOVERY) listOf(ApiException(409, "HERO_NOT_RECOVERING", "expired"))
        else listOf(ApiException(422, "HERO_NOT_RECRUITED", "altar removed"))

    @Test fun `exact Hero initial typed refusals retire the key but the same errors after lost reply never do`() = runBlocking<Unit> {
        for (original in listOf(upgrade, recovery)) for (currency in listOf("GEMS", "KEEP")) for (refusal in exactRefusals(currency, original.kind)) {
            for (ambiguousFirst in listOf(false, true)) {
                val exact = original.copy(attempted = false, expectedCurrency = currency)
                val store = PendingIntentStore(MemoryStore())
                var attempts = 0
                val transport = HeroCurrencyTransport(ScriptedTransport()) { _, _ ->
                    attempts++
                    if (ambiguousFirst && attempts == 1) throw IOException("reply lost")
                    throw refusal
                }
                val op = if (original.kind == IntentKind.HERO_UPGRADE) MoneyOp(HeroUpgradeSpec, store, transport)
                    else MoneyOp(HeroRecoverySpec, store, transport)
                if (ambiguousFirst) {
                    assertThrows(IOException::class.java) { runBlocking { op.submit(exact) {} } }
                    val saved = requireNotNull(store.get(exact.kind, WALLET))
                    assertThrows(ApiException::class.java) { runBlocking { op.retry(WALLET) {} } }
                    assertEquals("Later authority or price refusals cannot disprove the earlier debit", saved!!.nextAttempt(), store.get(exact.kind, WALLET))
                } else {
                    assertThrows(ApiException::class.java) { runBlocking { op.submit(exact) {} } }
                    assertNull("A typed first refusal is proven not to debit: ${refusal.code}", store.get(exact.kind, WALLET))
                }
            }
        }
    }

    @Test fun `generic auth collision and wrong-currency errors never retire exact Hero commands`() = runBlocking<Unit> {
        val errors = listOf(400, 401, 403, 404, 409, 422, 429, 500, 503).map { ApiException(it, null, "generic") } + listOf(
            ApiException(409, "IDEMPOTENCY_BODY_MISMATCH", "collision"),
            ApiException(409, "IDEMPOTENCY_KEY_COLLISION", "collision"),
            ApiException(401, "UNAUTHORIZED", "auth"),
            ApiException(409, "CURRENCY_CONSENT_CHANGED", "missing details"),
            ApiException(409, "CURRENCY_CONSENT_CHANGED", "wrong currency", details = buildJsonObject { put("expectedCurrency", "KEEP") }),
            ApiException(422, "HERO_PRICE_CHANGED", "wrong status"),

        )
        for (original in listOf(upgrade, recovery)) for (error in errors) {
            val exact = original.copy(attempted = false, expectedCurrency = "GEMS")
            val store = PendingIntentStore(MemoryStore())
            val transport = HeroCurrencyTransport(ScriptedTransport()) { _, _ -> throw error }
            val op = if (original.kind == IntentKind.HERO_UPGRADE) MoneyOp(HeroUpgradeSpec, store, transport)
                else MoneyOp(HeroRecoverySpec, store, transport)
            assertThrows(ApiException::class.java) { runBlocking { op.submit(exact) {} } }
            assertEquals(exact.nextAttempt(), store.get(exact.kind, WALLET))
        }
    }

    @Test fun `typed refusal from receipt GET after successful POST is never no-debit evidence`() = runBlocking<Unit> {
        for (original in listOf(upgrade, recovery)) for (error in exactRefusals("GEMS", original.kind)) {
            val exact = original.copy(attempted = false, expectedCurrency = "GEMS")
            val store = PendingIntentStore(MemoryStore())
            val reads = ScriptedTransport(onGet = { _, _ -> throw error })
            var sends = 0
            val transport = HeroCurrencyTransport(reads) { _, _ -> sends++ }
            val op = if (original.kind == IntentKind.HERO_UPGRADE) MoneyOp(HeroUpgradeSpec, store, transport)
                else MoneyOp(HeroRecoverySpec, store, transport)
            assertThrows(IOException::class.java) { runBlocking { op.submit(exact) {} } }
            assertEquals(1, sends); assertEquals(exact.nextAttempt(), store.get(exact.kind, WALLET))
        }
    }

    @Test fun `new no-debit Hero reasons are terminal only for their exact operation and status`() {
        val exactUpgrade = upgrade.copy(expectedCurrency = "GEMS")
        val exactRecovery = recovery.copy(expectedCurrency = "KEEP")
        assertTrue(HeroUpgradeSpec.definitiveInitialRejection(exactUpgrade, ApiException(422, "HERO_NOT_RECRUITED", "removed")))
        assertTrue(HeroRecoverySpec.definitiveInitialRejection(exactRecovery, ApiException(409, "HERO_NOT_RECOVERING", "expired")))
        for (error in listOf(ApiException(409, "HERO_NOT_RECOVERING", "wrong operation"), ApiException(409, "HERO_NOT_RECRUITED", "wrong status")))
            assertFalse(HeroUpgradeSpec.definitiveInitialRejection(exactUpgrade, error))
        for (error in listOf(ApiException(422, "HERO_NOT_RECRUITED", "wrong operation"), ApiException(422, "HERO_NOT_RECOVERING", "wrong status")))
            assertFalse(HeroRecoverySpec.definitiveInitialRejection(exactRecovery, error))
    }

    @Test fun `legacy Hero commands preserve their original initial rejection policy`() = runBlocking<Unit> {
        for (original in listOf(upgrade, recovery)) {
            val store = PendingIntentStore(MemoryStore())
            val reads = ScriptedTransport(onPost = { _, _ -> throw ApiException(409, null, "legacy refusal") })
            val op = if (original.kind == IntentKind.HERO_UPGRADE) MoneyOp(HeroUpgradeSpec, store, reads)
                else MoneyOp(HeroRecoverySpec, store, reads)
            assertThrows(ApiException::class.java) { runBlocking { op.submit(original.copy(attempted = false)) {} } }
            assertNull(store.get(original.kind, WALLET))
        }
    }

}
