package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.mining.*
import kotlinx.serialization.json.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MiningTaxClaimsUiTest {
    private val models = mutableListOf<MiningTaxClaimsViewModel>()
    @Before fun main() { Dispatchers.setMain(Dispatchers.Unconfined) }
    @After fun reset() { models.forEach { it.viewModelScope.cancel() }; Dispatchers.resetMain() }
    private fun op(f: MiningTaxAppFixture) = MiningTaxClaimsOperation(MiningTaxClaimsPrepareRequest(f.p.idempotencyKey, f.p.round, f.p.spot, f.p.caps),
        MiningTaxClaimsSavedTrust.from(f.independentPins), f.policy.daySec, true, f.p, emptyList(), emptyList(), false, null, null)
    private fun state(f: MiningTaxAppFixture, op: MiningTaxClaimsOperation? = op(f), held: Boolean = false) = MiningTaxClaimsState(true,
        journal = MiningTaxClaimsJournal(1, f.identity, 1, op, null, emptyList(), held))
    @Test fun `selection converts display spot once and requires explicit exact SOL caps`() { MiningTaxAppFixture().use { f ->
        val p = requireNotNull(miningTaxClaimsPolicy(f.content))
        val selected = miningTaxClaimsSelection("1", "1", "0.000005", "0.002", "0.003", p)!!
        assertEquals(0L, selected.spot); assertEquals("1", selected.round); assertEquals(MiningTaxClaimsCaps("5000", "2000000", "3000000"), selected.caps)
        for (value in listOf("", "01", "-1", "1e-3", "0.0000000001", " 1", "18446744074")) assertNull(miningTaxClaimsSelection("1", "1", value, "0", "1", p))
        for (round in listOf("", "01", "-1", "18446744073709551616")) assertNull(miningTaxClaimsSelection(round, "1", "0", "0", "0", p))
        assertNull(miningTaxClaimsSelection("1", "0", "0", "0", "0", p)); assertNull(miningTaxClaimsSelection("1", "${p.totalSpots + 1}", "0", "0", "0", p))
        assertNull(miningTaxClaimsSelection("1", "1", "0", "0", "0", null))
    } }
    @Test fun `paused or held requests keep recovery visible but never expose new effects or clearing`() { MiningTaxAppFixture().use { f ->
        val prepared = state(f); val paused = miningTaxClaimsControls(prepared, false)
        assertTrue(paused.check); assertFalse(paused.begin || paused.review || paused.sign || paused.submit || paused.archive)
        val held = miningTaxClaimsControls(state(f, held = true), true); assertFalse(held.review || held.sign || held.submit || held.archive)
        assertTrue(miningTaxClaimsEntryAvailable(prepared, false)); assertTrue(miningTaxClaimsEntryAvailable(null, false, true))
        assertFalse(miningTaxClaimsControls(prepared.copy(busy = true), true).check)
    } }
    @Test fun `review and approval identify the exact original ordinal and full immutable preparation`() { MiningTaxAppFixture().use { f ->
        val reviewed = state(f).copy(review = gg.pixelkingdomwars.nativeclient.data.MiningTaxClaimsReview(f.p, MiningTaxClaimsReviewResponse.from(f.p, f.review(0))))
        assertTrue(miningTaxClaimsControls(reviewed, true).sign)
        assertFalse(miningTaxClaimsControls(reviewed.copy(review = null), true).sign)
        assertFalse(miningTaxClaimsControls(reviewed.copy(review = reviewed.review!!.copy(preparation = f.p.copy(claimId = f.p.idempotencyKey))), true).sign)
        assertFalse(miningTaxClaimsControls(state(f, op(f).copy(transactions = listOf(MiningTaxClaimsCustody(0, true, null, false)))), true).sign)
    } }
    @Test fun `setup remains nonterminal and only its verified ordinal zero unlocks separate claim review`() { MiningTaxAppFixture("split").use { f ->
        val first = op(f); val setup = first.copy(setup = f.setup, observed = listOf(0), transactions = listOf(MiningTaxClaimsCustody(0, true, null, true)))
        val controls = miningTaxClaimsControls(state(f, setup, true), true)
        assertEquals(1, controls.ordinal); assertTrue(controls.review); assertFalse(controls.sign || controls.submit || controls.archive)
        assertEquals("SETUP VERIFIED · KEEP PAYMENT PENDING", miningTaxClaimsPhase(setup, true))
        assertFalse(miningTaxClaimsControls(state(f, setup.copy(unattributedObserved = true), true), true).review)
        assertFalse(miningTaxClaimsControls(state(f, setup.copy(observed = listOf(0, 1)), true), true).review)
    } }
    @Test fun `attempt markers prevent another approval or submit and only a full payment permits explicit archive`() { MiningTaxAppFixture().use { f ->
        val unknown = op(f).copy(transactions = listOf(MiningTaxClaimsCustody(0, true, null, false)))
        val controls = miningTaxClaimsControls(state(f, unknown), true); assertFalse(controls.review || controls.sign || controls.submit || controls.archive)
        val w = f.recovery.wires.single(); val saved = MiningTaxClaimsSavedWire(0, "saved", w.signature, w.messageSha256, w.wireSha256)
        val signed = unknown.copy(transactions = listOf(MiningTaxClaimsCustody(0, true, saved, false)))
        assertTrue(miningTaxClaimsControls(state(f, signed), true).submit)
        assertFalse(miningTaxClaimsControls(state(f, signed.copy(transactions = listOf(MiningTaxClaimsCustody(0, true, saved, true)))), true).submit)
        val paid = signed.copy(settlement = f.recovery); assertTrue(miningTaxClaimsControls(state(f, paid, true), false).archive)
        assertEquals("PAYMENT RECEIPT VERIFIED", miningTaxClaimsPhase(paid, true))
    } }
    @Test fun `view lifetime invalidates approvals on background close and disposal while keeping admission explicit`() {
        val view = MiningTaxClaimsViewLifetime(); view.start()
        fun page() = view.snapshot(true, true, "content", false)
        assertFalse(miningTaxClaimsActionsAllowed(true, page())); view.setOpen(true); assertTrue(miningTaxClaimsActionsAllowed(true, page()))
        assertFalse(miningTaxClaimsActionsAllowed(false, page())); val before = page().viewEpoch; view.stop(); assertTrue(page().viewEpoch > before)
        view.start(); view.dispose(); val disposed = page(); view.start(); view.setOpen(true); assertEquals(disposed, page()); assertFalse(page().active)
    }
    private fun model(f: MiningTaxAppFixture): MiningTaxClaimsViewModel {
        val ports = object : MiningTaxClaimsPorts by f.ports() { override fun key() = f.p.idempotencyKey }
        return MiningTaxClaimsViewModel(MiningTaxClaimsRepository(f.store, ports), ports.wallet).also { models += it }
    }
    @Test fun `foreground is GET only and explicit preparation never automatically approves or submits`() = runBlocking { MiningTaxAppFixture().use { f ->
        val m = model(f); m.foreground(); assertEquals(0, f.server.requestCount)
        m.begin(MiningTaxClaimsSelection(f.p.round, f.p.spot, f.p.caps))!!.join(); assertNotNull(f.store.read().operation!!.preparation)
        m.foreground(); assertTrue(f.store.read().operation!!.transactions.isEmpty()); assertNull(m.state.value.review)
        val requests = (0 until f.server.requestCount).map { f.server.takeRequest() }; assertEquals(1, requests.count { it.method == "POST" }); assertTrue(requests.none { it.path!!.endsWith("/submit") })
    } }
    @Test fun `foreground waits for an in flight review and dismissal cannot produce an approval`() = runBlocking { MiningTaxAppFixture().use { f ->
        val m = model(f); m.begin(MiningTaxClaimsSelection(f.p.round, f.p.spot, f.p.caps))!!.join()
        val entered = CompletableDeferred<Unit>(); val release = java.util.concurrent.CountDownLatch(1)
        f.afterReview = { entered.complete(Unit); check(release.await(3, java.util.concurrent.TimeUnit.SECONDS)) }
        val reviewing = requireNotNull(m.review(0)); withTimeout(3000) { entered.await() }; m.dismiss()
        val count = f.server.requestCount; val foreground = async { m.foreground() }; yield(); assertFalse(foreground.isCompleted); assertEquals(count, f.server.requestCount)
        release.countDown(); reviewing.join(); foreground.await(); assertNull(m.state.value.review); assertTrue(f.store.read().operation!!.transactions.isEmpty())
    } }
    @Test fun `failure observation suppresses setup continuation and paid archival while preserving check`() { MiningTaxAppFixture("split").use { f ->
        val pending = op(f).copy(setup = f.setup, observed = listOf(0), failureObserved = true)
        val controls = miningTaxClaimsControls(state(f, pending, true), true)
        assertNull(controls.ordinal); assertFalse(controls.review || controls.sign || controls.submit || controls.archive || controls.archiveFailed); assertTrue(controls.check)
        assertEquals("FAILURE OBSERVED · CHECK SAVED HISTORY", miningTaxClaimsPhase(pending, true))
        assertFalse(miningTaxClaimsControls(state(f, pending.copy(settlement = f.recovery), true), false).archive)
    } }
    @Test fun `complete atomic or setup plus failed claim exposes one explicit history action while paused`() {
        for (kind in listOf("combined", "split")) MiningTaxAppFixture(kind).use { f ->
            val ordinal = f.p.transactions.lastIndex; val setup = f.setup.takeIf { kind == "split" }
            val failure = MiningTaxClaimsFailureEnvelope.from(taxFailureFixture(f.recovery, listOf(ordinal), setup))
            val saved = op(f).copy(setup = setup, failure = failure, failureObserved = true, observed = f.p.transactions.indices.toList())
            val controls = miningTaxClaimsControls(state(f, saved, true), false)
            assertTrue(controls.archiveFailed); assertFalse(controls.archive || controls.begin || controls.review || controls.sign || controls.submit)
            assertEquals("FAILED TAX CLAIM · HISTORY VERIFIED", miningTaxClaimsPhase(saved, true))
            assertFalse(miningTaxClaimsControls(state(f, saved, true).copy(busy = true), false).archiveFailed)
            assertEquals("18446744073709551615", saved.failure!!.failures.single().receipt.feeLamports)
        }
    }
    @Test fun `partial unknown or out of plan failure histories never expose clearing or automatic next effects`() { MiningTaxAppFixture("split").use { f ->
        for (ordinals in listOf(listOf(0), listOf(1))) {
            val failure = MiningTaxClaimsFailureEnvelope.from(taxFailureFixture(f.recovery, ordinals))
            val saved = op(f).copy(failure = failure, failureObserved = true, observed = ordinals)
            val c = miningTaxClaimsControls(state(f, saved, true), true)
            assertFalse(c.archive || c.archiveFailed || c.review || c.sign || c.submit)
            assertEquals("FAILED TRANSACTION · PLAN STILL HELD", miningTaxClaimsPhase(saved, true))
        }
        val both = op(f).copy(failure = MiningTaxClaimsFailureEnvelope.from(taxFailureFixture(f.recovery, listOf(0, 1))), failureObserved = true, observed = listOf(0, 1))
        assertTrue(miningTaxClaimsControls(state(f, both, true), false).archiveFailed)
        assertFalse(miningTaxClaimsControls(state(f, both.copy(unattributedObserved = true), true), false).archiveFailed)
        assertFalse(miningTaxClaimsControls(state(f, both.copy(observed = listOf(0, 1, 2)), true), false).archiveFailed)
    } }
    private fun continuationState(): MiningTaxClaimsState {
        val envelope = MiningTaxClaimsContinuationEnvelope.from(Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax-continuation.json")).readText()).jsonObject)
        val c = envelope.continuation!!; val p = c.parentPreparation; val w = c.parentWire
        val policy = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax-journal-fixtures.json")).readText()).jsonObject.getValue("policy").jsonObject.getValue("daySec").jsonPrimitive.long
        val setup = MiningTaxClaimsRecoveryEnvelope(p.wallet, p.idempotencyKey, p.claimId, "setup", p, listOf(w), c.parentSetup, p.preparedAt)
        val trust = MiningTaxClaimsSavedTrust(p.identity.genesisHash, p.identity.programId, p.identity.configAddress, p.identity.keepMint, p.identity.reserveOwner, p.source.reviewedDeploymentSlot, p.source.reviewedProgramDataSha256)
        val op = MiningTaxClaimsOperation(MiningTaxClaimsPrepareRequest(p.idempotencyKey, p.round, p.spot, p.caps), trust, policy, true, p,
            listOf(MiningTaxClaimsCustody(0, true, MiningTaxClaimsSavedWire(0, java.util.Base64.getEncoder().encodeToString(w.signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()), w.signature, w.messageSha256, w.wireSha256), true)), listOf(0), false, setup, null,
            continuation = MiningTaxClaimsContinuationIntent(MiningTaxClaimsContinuationRequest(c.childPreparation.idempotencyKey, c.childPreparation.caps), true, envelope), continuationObserved = true)
        return MiningTaxClaimsState(true, journal = MiningTaxClaimsJournal(1, gg.pixelkingdomwars.nativeclient.starter.StarterIdentity("https://tax-cont-ui.test", "devnet", p.wallet), 1, op, null, emptyList(), true))
    }
    @Test fun `unsigned verified setup offers explicit additional preparation without inferring chain expiry`() {
        val state = continuationState(); val op = state.journal!!.operation!!.copy(continuation = null, continuationObserved = false)
        val c = miningTaxClaimsControls(state.copy(journal = state.journal.copy(operation = op)), true)
        assertTrue(c.prepareContinuation); assertFalse(c.resumeContinuation || c.activateContinuation)
        assertFalse(miningTaxClaimsControls(state.copy(journal = state.journal.copy(operation = op)), false).prepareContinuation)
    }
    @Test fun `pending attempted or crash saved continuation only exposes explicit same intent resume and checking`() {
        val state = continuationState(); val original = state.journal!!.operation!!
        for (attempted in listOf(false, true)) {
            val op = original.copy(continuation = original.continuation!!.copy(attempted = attempted, envelope = null), continuationObserved = false)
            val c = miningTaxClaimsControls(state.copy(journal = state.journal.copy(operation = op)), true)
            assertTrue(c.resumeContinuation && c.check); assertFalse(c.prepareContinuation || c.activateContinuation || c.review || c.sign || c.submit || c.archive || c.archiveFailed)
            assertEquals("CONTINUATION PREPARATION PENDING", miningTaxClaimsPhase(op, true))
        }
    }
    @Test fun `bound link offers explicit paused adoption without relabeling setup as payment or failure`() {
        val state = continuationState(); val c = miningTaxClaimsControls(state, false)
        assertTrue(c.activateContinuation && c.check); assertFalse(c.prepareContinuation || c.resumeContinuation || c.review || c.sign || c.submit || c.archive || c.archiveFailed)
        assertEquals("LINKED PREPARATION VERIFIED", miningTaxClaimsPhase(state.journal!!.operation!!, true))
    }
    @Test fun `late claim marker unknown or failure blocks every continuation action`() {
        val state = continuationState(); val op = state.journal!!.operation!!
        for (held in listOf(op.copy(unattributedObserved = true), op.copy(failureObserved = true), op.copy(observed = listOf(0, 1)),
            op.copy(transactions = op.transactions + MiningTaxClaimsCustody(1, true, null, false)))) {
            val c = miningTaxClaimsControls(state.copy(journal = state.journal.copy(operation = held)), true)
            assertFalse(c.prepareContinuation || c.resumeContinuation || c.activateContinuation || c.review || c.sign || c.submit || c.archive || c.archiveFailed); assertTrue(c.check)
        }
    }

}
