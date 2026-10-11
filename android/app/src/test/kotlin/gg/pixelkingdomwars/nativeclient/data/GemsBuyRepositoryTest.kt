package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.math.BigInteger
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class GemsBuyRepositoryTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient(); val memory = MemoryStore()
        val store = GemsBuyStore(memory, session.wallet, session.origin, "devnet")
        val key = "native-gems-purchase-1"
        val quote = GemsBuyIntent(DEPOSIT_ID, "gems_buy", session.wallet, key, DEPOSIT_REFERENCE, DEPOSIT_SOURCE,
            DEPOSIT_DEST, ChainAddresses.DEVNET.keepMint, 9, 17, 17, "2026-09-21T12:30:00Z")
        var deposit: GemsBuyDeposit? = null; var creates = 0; var prepared = 0; var hydrated = 0
        var lostCreate = false; var paused = false; var hydrationFails = false; var catalogue = true
        var expiredRecovery: Int? = 1
        var now = 0L; var wall = 1_000_000L
        val bounds = KeepDepositBounds(BigInteger("1000000000"), 9, 2500, 15000, 1200000)
        fun record(status: String = "pending", credited: String? = null, submitted: String? = null): GemsBuyDeposit {
            val receipt = credited?.let { GemsBuyReceipt(1, "00000000-0000-4000-8000-000000000018", "2026-09-21T12:01:00Z",
                session.wallet, quote.id, it, GemsBuyFunding("KEEP", "17", quote.baseUnits.toString()), GemsBuyResult("GEMS", "17", 1)) }
            return GemsBuyDeposit(quote, status, credited, submitted, receipt?.funding?.baseUnits, "2026-09-21T12:00:00Z",
                if (credited != null) "2026-09-21T12:01:00Z" else null, 17, 17, if (credited != null) "0" else null,
                receipt?.funding?.amount, receipt?.result?.amount, receipt)
        }
        fun repo() = GemsBuyRepository(session, holder, api, store, SolanaCluster.DEVNET, { quote.mint }, { bounds.takeIf { catalogue } },
            { q -> assertEquals(quote, q); prepared++; PreparedKeepDeposit(byteArrayOf(1), BigInteger.valueOf(5000), 500) },
            { hydrated++; if (hydrationFails) throw IOException("offline hydration") }, { now }, { 300_000L },
            { wall }, { key })
        init {
            api.onGet("/native/capabilities") {
                if (paused) throw IOException("paused")
                json("""{"protocolVersion":1,"simVersion":17,"economy":{"gems":{"enabled":true,"sources":["wallet-keep"],"destinationAta":"$DEPOSIT_DEST","gemsPerKeep":1,"shardsPerGem":3,"minConvertKeep":1,"maxConvertKeepPerTx":1000}}}""")
            }
            api.onGet("/gems/buy/by-key/$key") {
                assertNotNull("Identity precedes the first network request", store.read())
                Json.encodeToJsonElement(GemsBuyRecovery.serializer(), GemsBuyRecovery(1, session.wallet, key, true,
                    "2026-09-21T12:00:00Z", if (deposit == null) "unknown" else "known", deposit, expiredRecovery)).jsonObject
            }
            api.onPost("/deposits") { body ->
                creates++; assertEquals(key, store.read()!!.draft.idempotencyKey)
                assertEquals("17", body.string("keepIn")); assertEquals(key, body.string("idempotencyKey"))
                deposit = record()
                if (lostCreate) throw IOException("lost creation reply")
                JsonObject(Json.encodeToJsonElement(GemsBuyIntent.serializer(), quote).jsonObject + mapOf(
                    "status" to JsonPrimitive("pending"), "serverNow" to JsonPrimitive("2026-09-21T12:00:00Z")))
            }
            api.onPost("/deposits/$DEPOSIT_ID/paid") { body ->
                assertEquals(DEPOSIT_SIGNATURE, body.string("signature")); assertEquals(DEPOSIT_SIGNATURE, store.read()!!.signature)
                json("""{"committed":true}""")
            }
            api.onPost("/deposits/$DEPOSIT_ID/verify") { json("""{"status":"pending"}""") }
        }
        suspend fun ready() = repo().also { it.review("17") }
    }
    private suspend fun fails(block: suspend () -> Unit) { try { block(); fail("Expected failure") } catch (e: AssertionError) { throw e } catch (_: Exception) {} }

    @Test fun `creation key and body survive a lost response and restart without automatic POST`() = runBlocking {
        val f = Fixture(); f.lostCreate = true; fails { f.repo().review("17") }
        val r = f.repo(); assertNotNull(r.state.value.saved); r.open()
        assertEquals(f.quote, f.store.read()!!.quote); assertEquals(1, f.creates); assertFalse(r.state.value.fresh)
        f.lostCreate = false; r.reviewSaved(); assertEquals(2, f.creates); assertTrue(r.state.value.canPay)
    }
    @Test fun `persist attempt and signature before sender returns and never sign twice after an uncertain result`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        fails { r.pay(GemsBuySender { _, q, record ->
            assertEquals(f.quote, q); assertTrue(f.store.read()!!.attempted); assertEquals(500L, f.store.read()!!.preparedLastValidHeight)
            record(DEPOSIT_SIGNATURE, false); throw IOException("wallet sent then lost reply")
        }) }
        assertEquals(DEPOSIT_SIGNATURE, f.store.read()!!.signature); assertFalse(f.store.read()!!.signatureUsesPreparedHeight)
        fails { f.repo().pay(GemsBuySender { _, _, _ -> fail("Never sign twice"); DEPOSIT_SIGNATURE }) }
        assertEquals(1, f.prepared)
    }
    @Test fun `returned signature is durable in original journal even after same-wallet reauthentication`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        fails { r.pay(GemsBuySender { _, _, record ->
            signedIn(f.holder); record(DEPOSIT_SIGNATURE, true); DEPOSIT_SIGNATURE
        }) }
        assertEquals(DEPOSIT_SIGNATURE, f.store.read()!!.signature); assertTrue(f.store.read()!!.signatureUsesPreparedHeight)
    }
    @Test fun `original credited B can differ from submitted A and hydrates with flags and catalogue unavailable`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        fails { r.pay(GemsBuySender { _, _, record -> record(DEPOSIT_SIGNATURE, false); throw IOException("uncertain") }) }
        val actual = base58(ByteArray(64) { 18 }); f.deposit = f.record("credited", actual, DEPOSIT_SIGNATURE)
        f.paused = true; f.catalogue = false; val recovery = f.repo(); recovery.open()
        assertEquals(actual, recovery.state.value.saved!!.observed!!.receipt!!.txSignature)
        assertEquals(DEPOSIT_SIGNATURE, recovery.state.value.saved!!.signature); assertTrue(recovery.state.value.hydrated)
        recovery.finish(); assertNull(f.store.read())
    }
    @Test fun `proved credit is retained when hydration fails and restart uses saved proof without network`() = runBlocking {
        val f = Fixture(); f.ready(); f.deposit = f.record("credited", DEPOSIT_SIGNATURE)
        f.hydrationFails = true; fails { f.repo().open() }; assertNotNull(f.store.read()!!.observed!!.receipt)
        f.api.onGet("/gems/buy/by-key/${f.key}") { throw IOException("offline") }
        f.hydrationFails = false; val r = f.repo(); r.open(); assertTrue(r.state.value.hydrated)
    }
    @Test fun `wrong original reserve cannot replace frozen intent or trigger signing`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        f.deposit = f.record().copy(originalIntent = f.quote.copy(destination = "11111111111111111111111111111111"))
        fails { r.pay(GemsBuySender { _, _, _ -> fail("Wrong reserve never signs"); DEPOSIT_SIGNATURE }) }
        assertEquals(f.quote, f.store.read()!!.quote); assertEquals(0, f.prepared)
    }
    @Test fun `definitive unsigned wallet refusal keeps explicit review but an unknown failure stays attempted`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        fails { r.pay(GemsBuySender { _, _, _ -> throw WalletPaymentException("declined", true) }) }
        assertFalse(f.store.read()!!.attempted)
        fails { r.pay(GemsBuySender { _, _, _ -> throw IOException("unknown") }) }
        assertTrue(f.store.read()!!.attempted)
    }
    @Test fun `malformed encrypted journal fails closed without network`() {
        val f = Fixture(); f.memory.value = "{}"
        assertThrows(Exception::class.java) { f.repo() }; assertEquals(0, f.creates)
    }
    @Test fun `expired attempted payment without returned signature is never retired by elapsed time`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        fails { r.pay(GemsBuySender { _, _, _ -> throw IOException("wallet outcome unknown") }) }
        f.deposit = f.record("expired"); r.open()
        fails { r.abandon() }
        assertTrue(f.store.read()!!.attempted); assertNull(f.store.read()!!.signature)
    }
    @Test fun `credited response with mismatched original output cannot claim wallet purchase success`() = runBlocking {
        val f = Fixture(); f.ready()
        val valid = f.record("credited", DEPOSIT_SIGNATURE)
        f.deposit = valid.copy(receipt = valid.receipt!!.copy(result = GemsBuyResult("GEMS", "18", 1)))
        fails { f.repo().open() }; assertNull(f.store.read()!!.observed!!.receipt); assertEquals(0, f.hydrated)
    }
    @Test fun `successful wallet step records paid proof and reads original receipt before publishing a credit`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        f.api.onPost("/deposits/$DEPOSIT_ID/verify") {
            f.deposit = f.record("credited", DEPOSIT_SIGNATURE, DEPOSIT_SIGNATURE)
            json("""{"status":"credited"}""") // This POST response is insufficient; the following GET proves credit.
        }
        r.pay(GemsBuySender { _, _, record -> record(DEPOSIT_SIGNATURE, true); DEPOSIT_SIGNATURE })
        assertTrue(r.state.value.hydrated); assertEquals(1, f.hydrated)
        assertEquals(listOf("/deposits", "/deposits/$DEPOSIT_ID/paid", "/deposits/$DEPOSIT_ID/verify"), f.api.posts.map { it.first })
    }
    @Test fun `successful verify POST followed by unavailable authenticated receipt stays pending`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        f.api.onPost("/deposits/$DEPOSIT_ID/verify") {
            f.api.onGet("/gems/buy/by-key/${f.key}") { throw IOException("GET unavailable") }
            json("""{"status":"credited"}""")
        }
        fails { r.pay(GemsBuySender { _, _, record -> record(DEPOSIT_SIGNATURE, false); DEPOSIT_SIGNATURE }) }
        assertTrue(f.store.read()!!.attempted); assertNull(f.store.read()!!.observed!!.receipt); assertEquals(0, f.hydrated)
    }
    @Test fun `explicit abandonment archives original never signed quote and fresh proof without reusing its key`() = runBlocking {
        val f = Fixture(); val r = f.ready(); val original = f.store.read()!!
        r.abandon(); assertNull(f.store.read())
        val archive = f.store.archive().single(); assertEquals(original, archive.saved); assertEquals(f.quote, archive.proof.deposit!!.originalIntent)
        assertThrows(IllegalStateException::class.java) { f.store.begin(original.draft) }
        f.store.begin(original.draft.copy(idempotencyKey = f.key + "-next"))
        assertEquals(archive, f.store.archive().single())
    }
    @Test fun `uncreated draft can be abandoned only with fresh matching Unknown and retains its key forever`() = runBlocking {
        val f = Fixture(); f.paused = true; val r = f.repo(); fails { r.review("17") }
        assertNull(f.store.read()!!.quote); assertEquals(0, f.creates)
        r.abandon(); assertNull(f.store.read()); assertEquals("unknown", f.store.archive().single().proof.status)
    }
    @Test fun `fresh payment evidence or unavailable GET never permits abandoning an unattempted quote`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        f.api.onGet("/gems/buy/by-key/${f.key}") { throw IOException("unavailable") }
        fails { r.abandon() }; assertNotNull(f.store.read()); assertTrue(f.store.archive().isEmpty())
        val proof = GemsBuyRecovery(1, f.session.wallet, f.key, true, "2026-09-21T12:01:00Z", "known", f.record("credited", DEPOSIT_SIGNATURE))
        f.api.onGet("/gems/buy/by-key/${f.key}") { Json.encodeToJsonElement(GemsBuyRecovery.serializer(), proof).jsonObject }
        fails { r.abandon() }; assertNotNull(f.store.read()); assertTrue(f.store.archive().isEmpty())
    }
    @Test fun `competing attempt after abandonment GET fails CAS and preserves original payment`() = runBlocking {
        val f = Fixture(); val r = f.ready(); val original = f.store.read()!!
        val proof = GemsBuyRecovery(1, f.session.wallet, f.key, true, "2026-09-21T12:00:00Z", "known", f.deposit)
        f.api.onGet("/gems/buy/by-key/${f.key}") {
            f.store.update(original.draft) { it.copy(attempted = true, attemptedAtMs = f.wall) }
            Json.encodeToJsonElement(GemsBuyRecovery.serializer(), proof).jsonObject
        }
        fails { r.abandon() }; assertTrue(f.store.read()!!.attempted); assertTrue(f.store.archive().isEmpty())
    }
    @Test fun `old markerless server remains readable but refuses new purchase and wallet signing`() = runBlocking {
        val old = Fixture(); old.expiredRecovery = null
        fails { old.repo().review("17") }; assertEquals(0, old.creates)
        val f = Fixture(); val r = f.ready(); f.expiredRecovery = null
        fails { r.pay(GemsBuySender { _, _, _ -> fail("Old server must not admit wallet signing"); DEPOSIT_SIGNATURE }) }
        assertEquals(0, f.prepared)
        f.deposit = f.record("credited", DEPOSIT_SIGNATURE); val restored = f.repo(); restored.open()
        assertTrue(restored.state.value.hydrated)
    }
    @Test fun `explicit Check reconciles expired attempt only on server advertising positive proof recovery`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        fails { r.pay(GemsBuySender { _, _, record -> record(DEPOSIT_SIGNATURE, false); throw IOException("unknown") }) }
        f.deposit = f.record("expired"); f.expiredRecovery = null
        val posts = f.api.posts.size; r.check(); assertEquals(posts, f.api.posts.size); assertTrue(f.store.read()!!.attempted)
        f.expiredRecovery = 1
        f.api.onPost("/deposits/$DEPOSIT_ID/verify") { f.deposit = f.record("credited", DEPOSIT_SIGNATURE); json("""{"status":"credited"}""") }
        r.check(); assertTrue(r.state.value.hydrated); assertEquals(DEPOSIT_SIGNATURE, f.store.read()!!.observed!!.receipt!!.txSignature)
        assertEquals(posts + 2, f.api.posts.size)
    }
}
