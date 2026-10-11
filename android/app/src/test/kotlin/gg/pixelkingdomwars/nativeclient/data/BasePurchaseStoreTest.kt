package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.wallet.SignatureLanding
import gg.pixelkingdomwars.nativeclient.wallet.base58
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BasePurchaseStoreTest {
    private fun store(memory: MemoryStore, wallet: String = WALLET, origin: String = "https://localhost:18443", cluster: String = "devnet") =
        BasePurchaseStore(memory, wallet, origin, cluster)
    private fun quoted(memory: MemoryStore = MemoryStore(), kind: String = "builder"): BasePurchaseStore = store(memory).also {
        val offer = paidOffer(kind); it.draft(offer.request(PAID_KEY), offer); it.adopt(paidState(paidQuote(offer.request(PAID_KEY))))
    }

    @Test fun `every purchase preserves complete original consent and quote across storage reconstruction`() {
        for (kind in listOf("builder", "expansion", "mine", "shield", "warzone_shield", "energy", "energy_pack")) {
            val memory = MemoryStore(); val s = quoted(memory, kind); val original = requireNotNull(s.read())
            assertEquals(original, store(memory).read())
            assertEquals(original.offer.request(PAID_KEY), original.request)
            assertThrows(IllegalArgumentException::class.java) { s.draft(paidOffer().request(PAID_OTHER), paidOffer()) }
            assertEquals(original, s.read())
        }
    }

    @Test fun `origin wallet cluster and corrupt journals never become empty storage for another payment`() {
        val memory = MemoryStore(); val s = quoted(memory)
        for (wrong in listOf(store(memory, wallet = PAID_REFERENCE), store(memory, origin = "https://play.pixelkingdomwars.com"), store(memory, cluster = "mainnet-beta"))) {
            assertThrows(IllegalArgumentException::class.java) { wrong.read() }
        }
        val raw = Json.parseToJsonElement(requireNotNull(memory.value)).jsonObject
        for (bad in listOf("broken", JsonObject(raw + ("purchase" to JsonPrimitive("missing"))).toString(),
            JsonObject(raw + ("request" to paidOffer().request(PAID_OTHER).raw)).toString())) {
            memory.value = bad
            assertThrows(Exception::class.java) { s.read() }
            assertThrows(Exception::class.java) { s.draft(paidOffer().request(PAID_KEY), paidOffer()) }
            assertEquals(bad, memory.value)
        }
    }

    @Test fun `changed quote accounts amounts or original key cannot replace frozen consent`() {
        for ((field, replacement) in listOf("reference" to JsonPrimitive(WALLET), "depositId" to JsonPrimitive(PAID_OTHER), "amountLamports" to JsonPrimitive("1"))) {
            val s = quoted(); val original = requireNotNull(s.read()); val q = requireNotNull(original.purchase).quote
            val changed = BasePurchaseQuote.from(JsonObject(q.raw + (field to replacement)))
            assertThrows(IllegalArgumentException::class.java) { s.adopt(paidState(changed)) }
            assertEquals(original, s.read())
        }
        val s = quoted(); val original = requireNotNull(s.read())
        assertThrows(IllegalArgumentException::class.java) { s.adopt(paidState(paidQuote(paidOffer().request(PAID_OTHER)))) }
        assertEquals(original, s.read())
    }

    @Test fun `attempt and signature survive stale pending reads and forbid second signatures or unpaid clearing`() {
        val s = quoted(); val q = requireNotNull(s.read()?.purchase).quote
        s.attempted(q, 0L); s.recordSignature(q, PAID_SIGNATURE, 0L); s.adopt(paidState(q))
        assertTrue(requireNotNull(s.read()).attempted); assertEquals(PAID_SIGNATURE, s.read()?.signature)
        assertThrows(IllegalArgumentException::class.java) { s.recordSignature(q, base58(ByteArray(64) { 22 }), 0L) }
        assertThrows(IllegalArgumentException::class.java) { s.refusedBeforeSignature(q) }
        assertThrows(IllegalArgumentException::class.java) { s.finish(PAID_KEY, true) }
    }

    @Test fun `unpaid pending quote retains target reservation until positive terminal expiration`() {
        val s = quoted(); val q = requireNotNull(s.read()?.purchase).quote
        assertThrows(IllegalArgumentException::class.java) { s.finish(PAID_KEY, false) }
        assertEquals(q, s.read()?.purchase?.quote)
        s.adopt(paidState(q, "expired")); s.finish(PAID_KEY, false); assertNull(s.read())
    }

    /** Rewritten 2026-09-18 ("4b"): this test pinned "an attempted expired OR failed purchase stays saved forever".
     * That rule locked a player out of every base purchase after a mere wallet timeout. What it protected is kept:
     * Finish never closes an attempted unpaid purchase, and `failed` (funds the server RECEIVED) never retires. The new
     * rule: an attempted `expired` purchase leaves only through retireUnpaidAttempt, and only with every proof. */
    @Test fun `Finish never closes an attempted purchase, failed never retires, and expired retires only with every proof`() {
        val margin = UnpaidAttempt.MARGIN_MS
        for (status in listOf("expired", "failed")) {
            val s = quoted(); val q = requireNotNull(s.read()?.purchase).quote; s.attempted(q, 1_000L)
            val latest = s.adopt(paidState(q, status)).purchase!!
            assertThrows(IllegalArgumentException::class.java) { s.finish(PAID_KEY, true) }
            assertTrue(requireNotNull(s.read()).attempted)
            // Before the transport margin nothing retires, whatever the server says.
            assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, 1_000L + margin - 1, null) }
            if (status == "failed") {
                // Funds received: never an unpaid dismissal, however old and whatever the cluster says.
                for (landing in listOf(null, SignatureLanding.NOT_FOUND, SignatureLanding.FAILED_FINALIZED))
                    assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, Long.MAX_VALUE / 2, landing) }
                assertNotNull(s.read())
            } else {
                // A different receipt than the saved one, or a verdict for a signature that was never recorded, is refused.
                assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(paidState(q), 1_000L + margin, null) }
                assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, 1_000L + margin, SignatureLanding.NOT_FOUND) }
                s.retireUnpaidAttempt(latest, 1_000L + margin, null); assertNull(s.read())
                // The rail accepts a new purchase immediately.
                val offer = paidOffer(); assertNotNull(s.draft(offer.request(PAID_OTHER), offer))
            }
        }
    }

    @Test fun `a pending or credited purchase never retires however old the attempt`() {
        val s = quoted(); val q = requireNotNull(s.read()?.purchase).quote; s.attempted(q, 0L)
        assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(requireNotNull(s.read()?.purchase), Long.MAX_VALUE / 2, null) }
        val credited = s.adopt(paidState(q, "credited", PAID_SIGNATURE)).purchase!!
        assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(credited, Long.MAX_VALUE / 2, SignatureLanding.NOT_FOUND) }
        assertEquals("credited", s.read()?.purchase?.status)
    }

    /** Rewritten with the rule it now pins: NOT_FOUND used to mean "the status is null". A lagging or pruned node
     * says null for a payment that landed, so NOT_FOUND now means "null AND the node finalized past the saved last-valid
     * block height"; a null that is not proven ([SignatureLanding.UNPROVEN]) never retires, and neither does a
     * NOT_FOUND for a purchase that saved no height to prove it against (a journal of the previous version). */
    @Test fun `a recorded signature retires only on a null status proven final or a finalized error`() {
        for ((landing, retires) in listOf(null to false, SignatureLanding.PRESENT to false, SignatureLanding.UNPROVEN to false,
            SignatureLanding.NOT_FOUND to true, SignatureLanding.FAILED_FINALIZED to true)) {
            val s = quoted(); val q = requireNotNull(s.read()?.purchase).quote; s.attempted(q, 0L, 500L); s.recordSignature(q, PAID_SIGNATURE, 0L)
            val latest = s.adopt(paidState(q, "expired")).purchase!!
            if (retires) { s.retireUnpaidAttempt(latest, UnpaidAttempt.MARGIN_MS, landing); assertNull(s.read()) }
            else { assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, UnpaidAttempt.MARGIN_MS, landing) }; assertEquals(PAID_SIGNATURE, s.read()?.signature) }
        }
        for ((landing, retires) in listOf(SignatureLanding.NOT_FOUND to false, SignatureLanding.UNPROVEN to false, SignatureLanding.FAILED_FINALIZED to true)) {
            val s = quoted(); val q = requireNotNull(s.read()?.purchase).quote; s.attempted(q, 0L); s.recordSignature(q, PAID_SIGNATURE, 0L)
            val latest = s.adopt(paidState(q, "expired")).purchase!!; assertNull(s.read()?.lastValidBlockHeight)
            if (retires) { s.retireUnpaidAttempt(latest, UnpaidAttempt.MARGIN_MS, landing); assertNull(s.read()) }
            else { assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, UnpaidAttempt.MARGIN_MS, landing) }; assertNotNull(s.read()) }
        }
    }

    /** The margin runs from the END of the wallet step: a wallet may broadcast with a fresh blockhash at any moment
     * until it answers, so an attempt whose wallet step ended late is young however long ago it began. */
    @Test fun `the margin is counted from the latest of the attempt start and the end of its wallet step`() {
        val margin = UnpaidAttempt.MARGIN_MS; val memory = MemoryStore()
        val s = quoted(memory); val q = requireNotNull(s.read()?.purchase).quote; s.attempted(q, 1_000L, 900L)
        assertFalse(requireNotNull(memory.value).contains("walletEndedAtMs"))
        assertEquals(211_000L, s.walletEnded(q, 211_000L).walletEndedAtMs)
        assertEquals("The stamp never moves back", 211_000L, s.walletEnded(q, 5_000L).walletEndedAtMs)
        val latest = s.adopt(paidState(q, "expired")).purchase!!
        val rebuilt = requireNotNull(store(memory).read()); assertEquals(211_000L, rebuilt.walletEndedAtMs); assertEquals(900L, rebuilt.lastValidBlockHeight)
        assertThrows("Past the margin from the START only", IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, 1_000L + margin, null) }
        assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, 211_000L + margin - 1, null) }
        val raw = Json.parseToJsonElement(requireNotNull(memory.value)).jsonObject
        for (key in listOf("walletEndedAtMs", "lastValidBlockHeight")) for (bad in listOf(JsonPrimitive("77"), JsonNull, JsonPrimitive(-1))) {
            memory.value = JsonObject(raw + (key to bad)).toString(); assertThrows("$key=$bad", Exception::class.java) { s.read() }
        }
        memory.value = raw.toString(); s.retireUnpaidAttempt(latest, 211_000L + margin, null); assertNull(s.read())
    }

    @Test fun `a purchase saved before the attempt time existed is old only by its own payable-until deadline`() {
        val memory = MemoryStore(); val s = quoted(memory); val q = requireNotNull(s.read()?.purchase).quote; s.attempted(q, 5L)
        val latest = s.adopt(paidState(q, "expired")).purchase!!
        // The journal as the previous app version wrote it: no attemptedAtMs key at all.
        memory.value = JsonObject(Json.parseToJsonElement(requireNotNull(memory.value)).jsonObject - "attemptedAtMs").toString()
        val legacy = requireNotNull(s.read()); assertTrue(legacy.attempted); assertNull(legacy.attemptedAtMs)
        val deadline = java.time.Instant.parse(q.payableUntil).toEpochMilli()
        assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, deadline + UnpaidAttempt.MARGIN_MS, null) }
        assertNotNull(s.read())
        s.retireUnpaidAttempt(latest, deadline + UnpaidAttempt.MARGIN_MS + 1, null); assertNull(s.read())
    }

    @Test fun `the attempt time survives storage reconstruction, is dropped by a refusal and a malformed one fails closed`() {
        val memory = MemoryStore(); val s = quoted(memory); val q = requireNotNull(s.read()?.purchase).quote
        s.attempted(q, 42L); assertEquals(42L, store(memory).read()?.attemptedAtMs)
        assertNull(s.refusedBeforeSignature(q).attemptedAtMs); s.attempted(q, 77L); assertEquals(77L, s.read()?.attemptedAtMs)
        val raw = Json.parseToJsonElement(requireNotNull(memory.value)).jsonObject
        for (bad in listOf(JsonPrimitive("77"), JsonNull, JsonPrimitive(-1))) {
            memory.value = JsonObject(raw + ("attemptedAtMs" to bad)).toString(); assertThrows(Exception::class.java) { s.read() }
        }
    }

    @Test fun `accepted exact receipt is immutable and cannot finish before original hydration`() {
        val s = quoted(kind = "mine"); val q = requireNotNull(s.read()?.purchase).quote
        val accepted = s.adopt(paidState(q, "credited", PAID_SIGNATURE))
        assertTrue(accepted.attempted); assertEquals(PAID_SIGNATURE, accepted.signature)
        assertThrows(IllegalArgumentException::class.java) { s.adopt(paidState(q)) }
        assertThrows(IllegalArgumentException::class.java) { s.finish(PAID_KEY, false) }
        assertEquals(accepted, s.read()); s.finish(PAID_KEY, true); assertNull(s.read())
    }

    @Test fun `unknown quote and wrong Finish key cannot discard the sole durable request`() {
        val s = store(MemoryStore()); val offer = paidOffer(); val original = s.draft(offer.request(PAID_KEY), offer)
        assertThrows(IllegalArgumentException::class.java) { s.finish(PAID_KEY, true) }
        assertThrows(IllegalArgumentException::class.java) { s.finish(PAID_OTHER, true) }
        assertEquals(original, s.read())
    }

    @Test fun `malformed terminal or pending evidence cannot replace the original payment state`() {
        val s = quoted(); val original = requireNotNull(s.read()); val q = requireNotNull(original.purchase).quote
        val failed = paidState(q, "failed").raw
        val pending = paidState(q).raw
        val expired = paidState(q, "expired").raw
        val invalid = listOf("txSignature", "amount", "finalizedAt").map { JsonObject(failed + (it to JsonNull)) } + listOf(
            JsonObject(pending + ("txSignature" to JsonPrimitive(PAID_SIGNATURE))),
            JsonObject(expired + ("paymentSignature" to JsonPrimitive(PAID_SIGNATURE))),
            JsonObject(failed + ("paymentSignature" to JsonPrimitive(base58(ByteArray(64) { 22 }))))
        )
        for (raw in invalid) {
            assertThrows(IllegalArgumentException::class.java) { s.adopt(BasePurchaseState.from(raw)) }
            assertEquals(original, s.read())
        }
    }
}
