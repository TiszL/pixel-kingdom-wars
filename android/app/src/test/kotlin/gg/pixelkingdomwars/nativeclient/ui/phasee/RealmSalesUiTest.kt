package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.realmsales.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.Base64
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RealmSalesUiTest {
    companion object { private val ids = java.util.concurrent.atomic.AtomicInteger() }
    private val models = mutableListOf<RealmSalesViewModel>()
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { models.forEach { it.viewModelScope.cancel() }; Dispatchers.resetMain() }
    private val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/realm-sale-repository-fixture.json")).readText()).jsonObject
    private val policy = RealmSalesSavedPolicy.from(raw.getValue("policy").jsonObject)
    private val p = RealmSalePreparation.from(raw.getValue("preparation").jsonObject, policy.protocol)
    private val wire = RealmSaleSignedWire.from(raw.getValue("wire").jsonObject)
    private val signed = Base64.getEncoder().encodeToString(wire.signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
    private val review = RealmSalesReview(p, RealmSaleReview.from(p, raw.getValue("review").jsonObject, policy.protocol))
    private fun operation() = RealmSalesOperation(RealmSalePrepareRequest(p.idempotencyKey, p.spot, p.realm), policy, true, p, false, null, false, false, null)
    private fun state(op: RealmSalesOperation? = null, held: Boolean = false) = RealmSalesState(true, journal = RealmSalesJournal(1,
        StarterIdentity("https://ui.test", "devnet", p.wallet), 1, op, null, emptyList(), held))
    @Test fun `refused history is never paid and its explicit archive remains available with new purchases paused`() {
        for (code in listOf("INSUFFICIENT_SOL", "REALM_SALE_NO_QUOTA", "REALM_SALE_UNSOLD", "REALM_SALE_REALM_UNAVAILABLE")) {
            val declined = operation().copy(preparation = null, prepareRefusal = RealmSalePrepareRefusal(422, code))
            val controls = realmSalesControls(state(declined), false)
            assertTrue(controls.archiveRefusal); assertFalse(controls.archive); assertFalse(controls.review || controls.sign || controls.submit)
            assertEquals("PREPARATION REFUSED · CHECK BEFORE ARCHIVING", realmSalesPhase(declined, false))
            assertEquals("PREPARATION REFUSED · NO PURCHASE RECORDED", realmSalesPhase(declined.copy(refusalConfirmedAbsent = true), false))
            assertFalse(realmSalesControls(state(declined, held = true), false).archiveRefusal)
            assertFalse(realmSalesControls(state(declined.copy(preparation = p)), true).review)
            assertFalse(realmSalesControls(state(declined.copy(preparation = p)), false).archiveRefusal)
            assertFalse(realmSalesControls(state(operation().copy(preparation = null)), false).archiveRefusal)
        }
    }
    @Test fun `lifetime admission needs configured open visible current content and no battle`() {
        val lifetime = RealmSalesViewLifetime(); lifetime.start()
        fun page() = lifetime.snapshot(true, true, "content", false)
        assertFalse(realmSalesActionsAllowed(true, page())); lifetime.setOpen(true)
        assertTrue(realmSalesActionsAllowed(true, page())); assertFalse(realmSalesActionsAllowed(false, page()))
        assertFalse(realmSalesActionsAllowed(true, lifetime.snapshot(false, true, "content", false)))
        assertFalse(realmSalesActionsAllowed(true, lifetime.snapshot(true, false, "content", false)))
        assertFalse(realmSalesActionsAllowed(true, lifetime.snapshot(true, true, null, false)))
        assertFalse(realmSalesActionsAllowed(true, lifetime.snapshot(true, true, "content", true)))
        val old = page(); lifetime.stop(); assertTrue(page().viewEpoch > old.viewEpoch); assertFalse(page().visible)
        lifetime.start(); lifetime.dispose(); val disposed = page(); lifetime.start(); lifetime.setOpen(true)
        assertEquals(disposed, page()); assertFalse(page().active || page().actionsAllowed)
    }
    @Test fun `selectors accept only canonical injected ranges and never infer an offer or price`() {
        val bounds = policy.protocol
        assertEquals(RealmSalesSelection(0, 0), realmSalesSelection("0", "0", policy))
        assertEquals(RealmSalesSelection(bounds.totalSpots.toLong() - 1, bounds.realmCount.toLong() - 1), realmSalesSelection("${bounds.totalSpots - 1}", "${bounds.realmCount - 1}", policy))
        for ((spot, realm) in listOf("${bounds.totalSpots}" to "0", "0" to "${bounds.realmCount}", "-1" to "0", "01" to "0", "" to "0", "1.0" to "0", "9".repeat(30) to "0"))
            assertNull(realmSalesSelection(spot, realm, policy))
        assertNull(realmSalesSelection("0", "0", null))
    }
    @Test fun `history storage errors and original requests remain discoverable with admission disabled`() {
        assertFalse(realmSalesEntryAvailable(RealmSalesState(), false))
        assertTrue(realmSalesEntryAvailable(null, false, storageUnavailable = true))
        assertTrue(realmSalesEntryAvailable(RealmSalesState(error = "Saved storage is locked"), false))
        assertTrue(realmSalesEntryAvailable(state(), true))
        assertTrue(realmSalesEntryAvailable(state(operation()), false))
        assertTrue(realmSalesEntryAvailable(state().copy(journal = state().journal!!.copy(archiveKeys = listOf(p.idempotencyKey))), false))
    }
    @Test fun `named selection preserves stable realm mapping and one based spot conversion with original price split`() {
        val catalogue = buildJsonObject { putJsonObject("modules") { putJsonObject("baseVisual") { putJsonObject("REALM_NAMES") {
            put("crownlands", "Crownlands"); put("frostveil", "Frostveil"); put("seeker-reach", "Solana Reach")
        } } } }
        val names = realmSalesRealmNames(catalogue)
        assertEquals("Frostveil", names[0]); assertEquals("Crownlands", names[3]); assertEquals("Solana Reach", names[4])
        assertEquals(RealmSalesSelection(0, 3), realmSalesDisplaySelection("1", 3, policy))
        assertEquals(RealmSalesSelection(policy.protocol.totalSpots.toLong() - 1, 3), realmSalesDisplaySelection(policy.protocol.totalSpots.toString(), 3, policy))
        assertNull(realmSalesDisplaySelection("0", 3, policy)); assertNull(realmSalesDisplaySelection("01", 3, policy)); assertNull(realmSalesDisplaySelection("1", null, policy))
        assertTrue(realmSalesRealmNames(null).isEmpty())
        val purchase = raw.getValue("settlement").jsonObject.getValue("purchase").jsonObject; val split = realmSalesPrice(policy)
        assertEquals(purchase.getValue("priceLamports").jsonPrimitive.content, split.gross)
        assertEquals(purchase.getValue("sellerLamports").jsonPrimitive.content, split.seller)
        assertEquals(purchase.getValue("developerLamports").jsonPrimitive.content, split.developer)
    }
    @Test fun `spot feedback uses policy bounds without treating a valid number as available`() {
        val limit = policy.protocol.totalSpots
        assertNull(realmSalesSpotError("", policy))
        assertNull(realmSalesSpotError("1", policy))
        assertNull(realmSalesSpotError(limit.toString(), policy))
        for (invalid in listOf("0", "01", "-1", "1.5", " ", (limit + 1).toString(), "9".repeat(19))) {
            assertEquals("Enter a whole spot number from 1 to $limit.", realmSalesSpotError(invalid, policy))
            assertNull(realmSalesDisplaySelection(invalid, 0, policy))
        }
        // Missing policy is a configuration state, not an invented range or proof of availability.
        assertNull(realmSalesSpotError("1", null))
        assertNull(realmSalesDisplaySelection("1", 0, null))
        assertNull(realmSalesDisplaySelection("1", null, policy))
    }
    @Test fun `history promotes retained latest key instead of mistaking sorted identifiers for dates`() {
        val keys = listOf("a", "m", "z")
        val journal = state().journal!!.copy(lastArchivedKey = "m", archiveKeys = keys)
        assertEquals(listOf("m", "a", "z"), realmSalesHistoryKeys(journal))
        assertEquals(keys, journal.archiveKeys)
        assertEquals(keys.toSet(), realmSalesHistoryKeys(journal).toSet())
    }
    @Test fun `history without a known last record neither invents nor duplicates an original`() {
        val keys = listOf("a", "m", "z")
        val journal = state().journal!!.copy(archiveKeys = keys)
        assertEquals(keys, realmSalesHistoryKeys(journal))
        assertEquals(keys, realmSalesHistoryKeys(journal.copy(lastArchivedKey = "missing")))
        assertTrue(realmSalesHistoryKeys(state().journal!!).isEmpty())
    }
    @Test fun `paused and held originals expose recovery but no new prepare sign submit or unverified archive`() {
        val unsigned = state(operation()).copy(review = review)
        assertTrue(realmSalesControls(unsigned, true).sign)
        val paused = realmSalesControls(unsigned, false)
        assertFalse(paused.begin || paused.review || paused.sign || paused.submit || paused.archive); assertTrue(paused.check)
        val held = realmSalesControls(unsigned.copy(journal = unsigned.journal!!.copy(settlementHeld = true)), true)
        assertFalse(held.begin || held.review || held.sign || held.submit || held.archive); assertTrue(held.check)
        assertFalse(realmSalesControls(unsigned.copy(busy = true), true).check)
        assertFalse(realmSalesControls(unsigned, true, true).check)
    }
    @Test fun `unknown wallet outcome never reopens approval and a marked submit is never offered again`() {
        val unknown = operation().copy(signingStarted = true)
        val unknownControls = realmSalesControls(state(unknown).copy(review = review), true)
        assertFalse(unknownControls.review || unknownControls.sign || unknownControls.submit || unknownControls.archive)
        val approved = unknown.copy(signed = RealmSalesSavedSignature(signed, wire.signature))
        assertTrue(realmSalesControls(state(approved), true).submit)
        assertFalse(realmSalesControls(state(approved.copy(submitAttempted = true)), true).submit)
        assertEquals("WALLET OUTCOME UNKNOWN", realmSalesPhase(unknown, false))
        assertEquals("WALLET APPROVED · NOT SUBMITTED", realmSalesPhase(approved, false))
        assertEquals("SUBMISSION OUTCOME PENDING", realmSalesPhase(approved.copy(submitAttempted = true), false))
        assertEquals("SETTLEMENT NEEDS VERIFICATION", realmSalesPhase(approved, true))
    }
    @Test fun `only review of the complete original preparation can open wallet approval`() {
        val original = state(operation()).copy(review = review)
        assertTrue(realmSalesControls(original, true).sign)
        assertFalse(realmSalesControls(original.copy(review = review.copy(preparation = p.copy(saleId = "aa".repeat(16)))), true).sign)
        assertFalse(realmSalesControls(original.copy(review = null), true).sign)
        assertFalse(realmSalesControls(RealmSalesState(), true).begin)
    }
    @Test fun `bound failed original exposes only explicit failed archive while purchases are paused`() = runTest {
        val f = RealmFailureFixture(); val original = f.failed().read().operation!!
        val controls = realmSalesControls(state(original, held = true), false)
        assertTrue(controls.check && controls.archiveFailed)
        assertFalse(controls.begin || controls.review || controls.sign || controls.submit || controls.archive || controls.archiveRefusal)
        assertFalse(realmSalesControls(state(original), true, true).archiveFailed)
        assertEquals("FAILED PURCHASE RECEIPT VERIFIED", realmSalesPhase(original, true))
        assertEquals("FAILED PURCHASE NEEDS VERIFICATION", realmSalesPhase(original.copy(failure = null), true))
    }
    @Test fun `failed receipt displays the actual charged fee and never the old purchase quote`() = runTest {
        val f = RealmFailureFixture(); val failed = f.failed().read().operation!!
        val amount = realmSalesReceiptAmount(failed)!!
        assertEquals(f.failure.receipt.feeLamports, amount.lamports)
        assertEquals("Actual network fee · spent", amount.label)
        assertNull(realmSalesReceiptAmount(failed.copy(failure = null)))
        assertNull(realmSalesReceiptAmount(failed.copy(settlementObserved = true)))
        val pending = realmSalesReceiptAmount(operation())!!
        assertEquals(p.quote.requiredLamports, pending.lamports)
        assertEquals("Original maximum total", pending.label)
    }
    @Test fun `a contradicted refusal never offers a verified outcome or archival`() = runTest {
        val f = RealmFailureFixture(); val failed = f.failed().read().operation!!
        val contradicted = failed.copy(prepareRefusal = RealmSalePrepareRefusal(422, "INSUFFICIENT_SOL"), refusalContradicted = true)
        val controls = realmSalesControls(state(contradicted, held = true), false)
        assertFalse(controls.archive || controls.archiveFailed || controls.archiveRefusal || controls.sign || controls.submit)
        assertNull(realmSalesReceiptAmount(contradicted))
        assertEquals("PURCHASE OUTCOME HAS CONTRADICTORY EVIDENCE", realmSalesPhase(contradicted, true))
    }
    @Test fun `opposite observed outcome suppresses both archives and never labels a contradictory receipt verified`() = runTest {
        val f = RealmFailureFixture(); val failed = f.failed().read().operation!!
        val paid = operation().copy(settlementObserved = true,
            settlement = RealmSalesSavedSettlement(wire, RealmSaleSettlement.from(p, wire, raw.getValue("settlement").jsonObject, policy.protocol)))
        for (op in listOf(failed.copy(settlementObserved = true), paid.copy(failureObserved = true))) {
            val controls = realmSalesControls(state(op, held = true), true)
            assertFalse(controls.archive || controls.archiveFailed || controls.archiveRefusal || controls.sign || controls.submit)
            assertTrue(controls.check)
            assertEquals("PURCHASE OUTCOME HAS CONTRADICTORY EVIDENCE", realmSalesPhase(op, true))
        }
    }
    @Test fun `explicit failed history action fresh checks GET only and preserves original actual fee without access claims`() = runTest {
        val f = RealmFailureFixture(); val store = f.failed(); val calls = mutableListOf<String>()
        val port = object : RealmSalesAuthenticatedPort {
            override val identity = f.identity
            override suspend fun request(method: String, path: String, body: JsonObject?, guard: () -> Unit,
                refusal: (suspend (RealmSalePrepareRefusal) -> Unit)?, retain: suspend (JsonObject) -> Unit): JsonObject {
                assertEquals("GET", method); assertNull(body); guard(); calls += path
                val response = buildJsonObject {
                    put("wallet", f.p.wallet); put("idempotencyKey", f.key)
                    when {
                        path.contains("/failures/") -> put("failure", f.raw.getValue("failure"))
                        path.contains("/prepare/") -> put("preparation", f.raw.getValue("preparation"))
                        else -> { put("preparation", f.raw.getValue("preparation")); put("wire", f.raw.getValue("wire")); put("settlement", JsonNull) }
                    }
                }
                retain(response); guard(); return response
            }
        }
        val repository = RealmSalesRepository(store, object : RealmSalesPorts {
            override val transport = RealmSalesTransport(port)
            override fun capture(newAction: Boolean): () -> Unit = { check(!newAction) }
            override fun policy(): RealmSalesSavedPolicy? = null
            override fun trust(): RealmSaleSigningTrust? = null
            override fun key(): String = error("History creates no key")
            override fun clockMs(): Long = error("History needs no clock")
            override suspend fun readyToSign(guard: () -> Unit) = error("No wallet")
            override suspend fun live(preparation: RealmSalePreparation, guard: () -> Unit) = error("No live provider")
            override suspend fun sign(prepared: PreparedRealmSale, guard: () -> Unit, retain: suspend (SignedRealmSale) -> Unit) = error("No signature")
        })
        val model = RealmSalesViewModel(repository).also { models += it }; model.foreground()
        assertNotNull(store.read().operation); calls.clear(); model.archiveFailed()?.join()
        assertNull(store.read().operation); assertTrue(calls.any { it.contains("/failures/") })
        assertTrue(calls.any { it.contains("/realm-sales/by-key/") })
        model.history(f.key)?.join(); val archived = model.history.value!!.operation
        assertEquals(f.failure, archived.failure!!.value); assertEquals(f.failure.receipt.feeLamports, archived.failure.value.receipt.feeLamports)
        assertNull(archived.settlement); assertEquals(f.signed, archived.signed!!.wire)
        assertEquals("FAILED PURCHASE RECEIPT VERIFIED", realmSalesPhase(archived, false))
    }
    private inner class Controller {
        val identity = StarterIdentity("https://ui-${ids.incrementAndGet()}.test", "devnet", p.wallet)
        val store = RealmSalesStore(MemoryStore(), identity)
        var prepared = false; var approved = false; var settled = false; var allowed = true
        var posts = 0; var reads = 0; var signs = 0; var submits = 0
        var signAction: suspend (suspend (SignedRealmSale) -> Unit) -> Unit = { it(SignedRealmSale(signed, wire.signature)) }
        val port = object : RealmSalesAuthenticatedPort {
            override val identity = this@Controller.identity
            override suspend fun request(method: String, path: String, body: JsonObject?, guard: () -> Unit, refusal: (suspend (RealmSalePrepareRefusal) -> Unit)?, retain: suspend (JsonObject) -> Unit): JsonObject {
                guard(); if (method == "GET") reads++ else posts++
                if (path.endsWith("/prepare")) prepared = true
                if (path.endsWith("/submit")) submits++
                val response = if (path.contains("/review/by-key/")) raw.getValue("review").jsonObject else buildJsonObject {
                    put("wallet", p.wallet); put("idempotencyKey", p.idempotencyKey)
                    if (path.contains("/failures/")) put("failure", JsonNull)
                    else {
                    if (!path.endsWith("/submit")) put("preparation", if (prepared) raw.getValue("preparation") else JsonNull)
                    if (!path.contains("/prepare")) {
                        put("wire", if (approved) raw.getValue("wire") else JsonNull); put("settlement", if (settled) raw.getValue("settlement") else JsonNull)
                        if (path.endsWith("/submit")) put("delivery", "submitted")
                    }
                    }
                }
                retain(response); guard(); return response
            }
        }
        val repository = RealmSalesRepository(store, object : RealmSalesPorts {
            override val transport = RealmSalesTransport(port)
            override fun capture(newAction: Boolean): () -> Unit = { if (newAction) check(allowed) }
            override fun policy() = this@RealmSalesUiTest.policy
            override fun trust() = RealmSaleSigningTrust(p.source.genesisHash, p.source.programId, p.terms.developer, p.source.programDataSha256, p.source.reviewedDeploymentSlot, p.source.revision)
            override fun key() = p.idempotencyKey
            override fun clockMs() = 0L
            override suspend fun readyToSign(guard: () -> Unit) { guard() }
            override suspend fun live(preparation: RealmSalePreparation, guard: () -> Unit) { guard() }
            override suspend fun sign(prepared: PreparedRealmSale, guard: () -> Unit, retain: suspend (SignedRealmSale) -> Unit) {
                guard(); signs++; signAction { retain(it); approved = true }; guard()
            }
        })
        val model = RealmSalesViewModel(repository).also { models += it }
        suspend fun prepare() { model.foreground(); model.begin(RealmSalesSelection(p.spot, p.realm))?.join(); model.review()?.join() }
    }
    @Test fun `foreground recovery cannot prepare sign or submit without the separate explicit controls`() = runTest {
        val c = Controller(); c.model.foreground(); assertEquals(0, c.posts + c.signs + c.submits)
        c.prepare(); assertEquals(1, c.posts); assertEquals(0, c.signs + c.submits); assertNotNull(c.model.state.value.review)
        c.model.sign()?.join(); assertEquals(1, c.signs); assertEquals(0, c.submits)
        c.model.foreground(); assertEquals(0, c.submits)
        c.model.submit()?.join(); c.model.foreground(); assertEquals(1, c.submits); assertEquals(2, c.posts); assertEquals(1, c.signs)
    }
    @Test fun `dismissal keeps late signed evidence alive and foreground joins it before GET recovery`() = runTest {
        val c = Controller(); c.prepare(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        c.signAction = { retain -> entered.complete(Unit); release.await(); retain(SignedRealmSale(signed, wire.signature)) }
        val signing = requireNotNull(c.model.sign()); entered.await(); assertNull(c.model.sign()); val reads = c.reads
        c.model.dismiss(); val foreground = async { c.model.foreground() }; runCurrent()
        assertFalse(foreground.isCompleted); assertEquals(reads, c.reads)
        release.complete(Unit); signing.join(); foreground.await()
        assertEquals(signed, c.store.read().operation!!.signed!!.wire); assertTrue(c.reads > reads); assertEquals(0, c.submits)
    }
    @Test fun `verified archive details remain original and cannot modify or clear a newer active request`() = runTest {
        val c = Controller(); c.prepare(); c.model.sign()?.join(); c.settled = true; c.model.foreground()
        assertTrue(realmSalesControls(c.model.state.value, false).archive); c.allowed = false; c.model.archive()?.join()
        val original = c.store.archived(p.idempotencyKey)!!
        c.store.begin(c.store.read(), RealmSalePrepareRequest("00000000-0000-4000-8000-000000000099", p.spot, p.realm), policy)
        val before = c.store.read(); c.model.history(p.idempotencyKey)?.join()
        assertEquals(original, c.model.history.value); assertEquals(before, c.store.read())
        assertEquals(original, c.repository.archived(p.idempotencyKey)); assertEquals(before, c.store.read())
        c.model.closeHistory(); assertNull(c.model.history.value); assertEquals(before, c.store.read())
    }
}
