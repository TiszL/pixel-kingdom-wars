package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.ops.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.time.Instant

class WithdrawalMoneyTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val fake = FakeApiClient()
        val disk = MemoryStore(); val intents = PendingIntentStore(disk)
        var base: String? = BASE_ID; var land = true; var support = true; var accepted = false; var visible = true
        var lifecycle = "unbonding"; var signing = 0; var postedQuote: WithdrawalQuote? = null
        val authCalls = mutableListOf<Pair<String, JsonObject>>()
        val api = object : ApiClient by fake {
            override suspend fun postWithRecentAuth(path: String, body: JsonObject, grant: String): JsonObject {
                assertEquals("grant-secret", grant)
                val pending = requireNotNull(intents.get(IntentKind.WITHDRAWAL, session.wallet))
                assertTrue(pending.attempted); assertNotNull(disk.value)
                for (secret in listOf("grant-secret", "challenge-secret", "signature-secret", "123456", "authorization", "method")) assertFalse(requireNotNull(disk.value).contains(secret))
                authCalls += path to body
                return fake.post(path, body)
            }
        }
        var onAccount: suspend () -> Unit = {}
        val repository = LiveEconomyRepository(session, holder, api, { base }, { land }, intents, ReceiptObserver(intents), refreshAccount = { onAccount() })
        init {
            fake.onGet("/balances") { balancesJson("0", "0") }
            fake.onGet("/2fa/status") { json("""{"instantEligible":true,"instantWithdrawalsEnabled":true}""") }
            fake.onGet("/withdrawals") { history() }
            fake.onPost("/withdrawals/prepare") { body ->
                assertNull(intents.get(IntentKind.WITHDRAWAL, session.wallet))
                buildJsonObject {
                    put("version", 1); put("grossAmount", body["amount"]!!); put("feeBurned", "10"); put("netAmount", "90")
                    put("destination", body["destination"]!!); put("cluster", "devnet"); put("keepMint", "11111111111111111111111111111111")
                    put("idempotencyKey", body["idempotencyKey"]!!); val instant = body["instant"] == JsonPrimitive(true)
                    put("mode", if (instant) "instant" else "standard"); put("unbondingHours", if (instant) 0 else 24)
                }
            }
            fake.onPost("/withdrawals") { accepted = true; json("""{"status":"pending","id":"not-a-proof"}""") }
            fake.onGet("/withdrawals/receipt") { query -> receipt(query) }
        }
        fun proof(intent: JsonObject): WithdrawalAuthorization {
            signing++; postedQuote = WithdrawalQuote(intent)
            return WithdrawalAuthorization("grant-secret", json("""{"challengeToken":"challenge-secret","signature":"signature-secret"}"""), Instant.now().plusSeconds(60))
        }
        fun history() = buildJsonObject {
            if (support) put("features", json("""{"withdrawalReceipts":{"version":1}}"""))
            put("withdrawals", buildJsonArray { if (accepted && visible) add(buildJsonObject {
                put("id", "64ee967a-bf89-4e01-bcae-52a48ffdc768"); put("status", lifecycle)
                put("amount", "100"); put("feeBurned", "10"); put("netAmount", "90"); put("destination", WALLET)
                put("createdAt", "2026-09-12T00:00:00.000Z"); put("unbondsAt", "2026-09-13T00:00:00.000Z"); put("refundable", lifecycle == "failed")
            }) })
        }
        fun receipt(query: Map<String, String>) = buildJsonObject {
            put("version", 1); put("status", "accepted"); put("wallet", session.wallet)
            put("request", JsonObject(query.mapValues { JsonPrimitive(it.value) })); put("receiptId", "65ae967a-bf89-4e01-bcae-52a48ffdc768")
            put("acceptedAt", "2026-09-12T00:00:00.000Z"); put("funding", json("""{"currency":"KEEP","amount":"100"}"""))
            put("result", json("""{"withdrawalId":"64ee967a-bf89-4e01-bcae-52a48ffdc768","unbondsAt":"2026-09-13T00:00:00.000Z"}"""))
        }
        suspend fun review(instant: Boolean = false) = repository.prepareWithdrawal("100", WALLET, instant)
        suspend fun confirm(review: WithdrawalReview, code: String = "") = repository.confirmWithdrawal(review, code, ::proof)
    }
    @Test fun `old server or capability loss never opens signer or creates money request`() = runBlocking {
        val f = Fixture(); f.support = false
        assertThrows(IllegalStateException::class.java) { runBlocking { f.review() } }; assertTrue(f.fake.posts.isEmpty())
        f.support = true; val review = f.review(); f.support = false
        assertThrows(IllegalStateException::class.java) { runBlocking { f.confirm(review) } }
        assertEquals(0, f.signing); assertTrue(f.authCalls.isEmpty()); assertNull(f.disk.value)
    }
    @Test fun `standard and instant send exact fresh proof once and never persist authorization or TOTP`() = runBlocking {
        for (instant in listOf(false, true)) {
            val f = Fixture(); val review = f.review(instant); assertNull(f.disk.value); assertEquals(0, f.signing)
            f.confirm(review, if (instant) "123456" else "")
            assertEquals(review.quote, f.postedQuote); assertEquals(1, f.authCalls.size); assertEquals(1, f.signing)
            val sent = f.authCalls.single().second
            assertEquals(review.quote.body(), JsonObject(sent - "authorization" - "method" - "code"))
            assertEquals(if (instant) JsonPrimitive("123456") else null, sent["code"])
            assertEquals(if (instant) JsonPrimitive("totp") else null, sent["method"])
            assertEquals("64ee967a-bf89-4e01-bcae-52a48ffdc768", f.repository.state.value.confirmedWithdrawal!!.withdrawalId)
            assertNull(f.disk.value)
        }
    }
    /** Owner 2026-09-18 (stale Home chips after an economy mutation): an accepted withdrawal moves KEEP into escrow, so
     * the state the Home HUD renders must equal the server's new balance at once. Wired as AppGraph does. */
    @Test fun `an accepted withdrawal refreshes the Home HUD balances through the account hook`() = runBlocking {
        val f = Fixture(); var keep = "250"
        f.fake.onGet("/balances") { balancesJson("0", keep) }; f.fake.onGet("/base") { baseJson() }; f.fake.onGet("/tutorial") { tutorialJson() }
        f.fake.onPost("/withdrawals") { f.accepted = true; keep = "150"; json("""{"status":"pending","id":"not-a-proof"}""") }
        val homeIntents = PendingIntentStore(MemoryStore())
        val home = LiveBaseRepository(f.session, f.holder, f.fake, homeIntents, ReceiptObserver(homeIntents), { f.base })
        home.refresh(); assertEquals("250", home.state.value.balances!!.keep)
        f.onAccount = homeHudRefresh { home.refresh() }
        f.confirm(f.review())
        assertNotNull(f.repository.state.value.confirmedWithdrawal); assertNull(f.disk.value)
        assertEquals("The escrowed KEEP left the Home chip without a relaunch", "150", home.state.value.balances!!.keep)
    }
    @Test fun `401 or 404 receipt GET after successful POST is unknown never a definitive refusal`() = runBlocking {
        for (status in listOf(401, 404)) {
            val f = Fixture(); f.fake.onGet("/withdrawals/receipt") { throw ApiException(status, null, "unavailable") }
            assertThrows(IOException::class.java) { runBlocking { f.confirm(f.review()) } }
            val saved = requireNotNull(f.intents.get(IntentKind.WITHDRAWAL, WALLET)); assertTrue(saved.attempted); assertNull(saved.receipt)
            f.fake.onGet("/withdrawals/receipt") { json("""{"version":1,"status":"unknown","idempotencyKey":"${saved.idempotencyKey}"}""") }
            assertEquals(Receipt.Unknown, f.repository.check(IntentKind.WITHDRAWAL))
            assertThrows(IllegalStateException::class.java) { runBlocking { f.review() } }
            assertEquals(1, f.authCalls.size); assertNotNull(f.disk.value)
        }
    }
    @Test fun `lost response reconstructs with original network and GET only after selling all land`() = runBlocking {
        val f = Fixture(); f.fake.onPost("/withdrawals") { f.accepted = true; throw IOException("lost reply") }
        assertThrows(IOException::class.java) { runBlocking { f.confirm(f.review()) } }
        f.base = null; f.land = false; f.lifecycle = "sent"
        f.fake.onGet("/balances") { throw ApiException(409, "BASE_ID_REQUIRED", "No selected base") }
        val reopenedStore = PendingIntentStore(f.disk)
        val reopened = LiveEconomyRepository(f.session, f.holder, f.api, { f.base }, { f.land }, reopenedStore, ReceiptObserver(reopenedStore))
        f.fake.onGet("/withdrawals/receipt") { q -> assertEquals("devnet", q["cluster"]); assertEquals("11111111111111111111111111111111", q["keepMint"]); f.receipt(q) }
        reopened.check(IntentKind.WITHDRAWAL)
        assertEquals("sent", reopened.state.value.withdrawals!!.single().status)
        assertNotNull(reopened.state.value.confirmedWithdrawal); assertEquals(1, f.authCalls.size); assertEquals(1, f.signing); assertNull(f.disk.value)
        assertFalse(f.fake.gets.any { it.first == "/withdrawals/status" })
    }
    @Test fun `failed history refresh keeps proof and hydration retry never refetches receipt or resends`() = runBlocking {
        val f = Fixture(); f.visible = false
        f.fake.onGet("/withdrawals") { if (f.accepted && !f.visible) throw IOException("history offline"); f.history() }
        assertThrows(IOException::class.java) { runBlocking { f.confirm(f.review()) } }
        val pending = requireNotNull(f.intents.get(IntentKind.WITHDRAWAL, WALLET)); assertNotNull(pending.receipt)
        val receiptReads = f.fake.gets.count { it.first == "/withdrawals/receipt" }
        f.visible = true; f.lifecycle = "failed"; f.repository.check(IntentKind.WITHDRAWAL)
        assertTrue(f.repository.state.value.withdrawals!!.single().refundable)
        assertEquals(receiptReads, f.fake.gets.count { it.first == "/withdrawals/receipt" }); assertEquals(1, f.authCalls.size); assertNull(f.disk.value)
    }
    @Test fun `absent capped terminal history cannot undo escrow acceptance after state refresh`() = runBlocking {
        val f = Fixture(); f.visible = false
        f.confirm(f.review())
        assertNotNull(f.repository.state.value.confirmedWithdrawal)
        assertEquals(emptyList<Any>(), f.repository.state.value.withdrawals)
        assertNotNull("Current balances were refreshed independently of acceptance", f.repository.state.value.balances)
        assertNull(f.disk.value); assertEquals(1, f.authCalls.size)
    }
    @Test fun `definitive POST refusal permits only a fresh review and new key`() = runBlocking {
        val f = Fixture(); f.fake.onPost("/withdrawals") { throw ApiException(422, null, "refused") }
        val first = f.review(); assertThrows(ApiException::class.java) { runBlocking { f.confirm(first) } }; assertNull(f.disk.value)
        val second = f.review(); assertNotEquals(first.quote.key, second.quote.key)
        f.fake.onPost("/withdrawals") { f.accepted = true; json("{}") }; f.confirm(second)
        assertEquals(2, f.signing); assertEquals(2, f.authCalls.size)
    }
    @Test fun `wrong identity or base after signing never sends the money request`() = runBlocking {
        for (switchWallet in listOf(false, true)) {
            val f = Fixture(); val review = f.review()
            assertThrows(Exception::class.java) { runBlocking { f.repository.confirmWithdrawal(review, "") { intent ->
                val proof = f.proof(intent); if (switchWallet) signedIn(f.holder, "other") else f.base = null; proof
            } } }
            assertTrue(f.authCalls.isEmpty()); assertNull(f.disk.value)
        }
    }
    @Test fun `fresh instant eligibility and manual PKW TOTP are checked before signing`() = runBlocking {
        val f = Fixture(); val review = f.review(true)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.confirm(review) } }
        f.fake.onGet("/2fa/status") { json("""{"instantEligible":false,"instantWithdrawalsEnabled":true}""") }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.confirm(review, "123456") } }
        assertEquals(0, f.signing); assertTrue(f.authCalls.isEmpty()); assertNull(f.disk.value)
    }
}
