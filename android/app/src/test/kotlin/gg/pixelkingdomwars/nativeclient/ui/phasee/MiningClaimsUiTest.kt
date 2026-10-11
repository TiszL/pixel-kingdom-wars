package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.PreparedMiningClaim
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class MiningClaimsUiTest {
    private val models = mutableListOf<MiningClaimsViewModel>()
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { models.forEach { it.viewModelScope.cancel() }; Dispatchers.resetMain() }
    private val f = MiningClaimsWalletFixture()
    private val p = f.preparation
    private val identity = StarterIdentity("https://fixture.test", "devnet", p.wallet)
    private fun status() = MiningClaimStatusView(MiningClaimFeatures(MiningClaimFeature(1, 1)), p.wallet, "shardkeep-economy", p.identity.programId, p.identity.keepMint,
        "ready", null, p.rootSequence, p.leaf.cumulativeKeepBaseUnits, "0", p.leaf.cumulativeKeepBaseUnits, f.policy.tokenDecimals,
        200, "7200", "7200", p.needsAta, p.needsMinerRecords, true, false, p.serverNow)
    private fun operation() = MiningClaimsOperation(MiningClaimPrepareRequest(p.idempotencyKey), f.policy, prepareAttempted = true, preparation = p)
    private fun state(op: MiningClaimsOperation? = null) = MiningClaimsState(loaded = true, journal = MiningClaimsJournal(1, identity, 1, op, emptyList()), status = status())
    private fun paid() = MiningClaimView(1, p.wallet, p.claimId, "settled", "finalized", f.signed.signature, p.leaf.cumulativeKeepBaseUnits,
        listOf(MiningClaimLanding(0, "combined", f.signed.signature, "finalized", p.leaf.cumulativeKeepBaseUnits, p.serverNow, p.serverNow)), p.serverNow, false)

    @Test fun `visible registration discovers history but new actions need open pane and independent configuration`() {
        val lifetime = MiningClaimsViewLifetime(); lifetime.start()
        fun page() = lifetime.snapshot(true, true, "admitted-content", false)
        assertTrue(page().active && page().visible)
        assertFalse(miningClaimsActionsAllowed(true, page()))
        lifetime.setOpen(true)
        assertFalse(miningClaimsActionsAllowed(false, page()))
        assertTrue(miningClaimsActionsAllowed(true, page()))
        assertFalse(miningClaimsActionsAllowed(true, lifetime.snapshot(false, true, "admitted-content", false)))
        assertFalse(miningClaimsActionsAllowed(true, lifetime.snapshot(true, false, "admitted-content", false)))
        assertFalse(miningClaimsActionsAllowed(true, lifetime.snapshot(true, true, null, false)))
        assertFalse(miningClaimsActionsAllowed(true, lifetime.snapshot(true, true, "admitted-content", true)))
    }
    @Test fun `close background and disposal invalidate captured view while disposed identities never resume`() {
        val lifetime = MiningClaimsViewLifetime(); lifetime.start(); lifetime.setOpen(true)
        fun page() = lifetime.snapshot(true, true, "admitted-content", false)
        val approved = page(); lifetime.setOpen(false)
        assertTrue(page().viewEpoch > approved.viewEpoch); assertFalse(page().actionsAllowed)
        lifetime.setOpen(true); val reopened = page(); lifetime.stop()
        assertTrue(page().viewEpoch > reopened.viewEpoch); assertFalse(page().visible)
        lifetime.start(); assertTrue(miningClaimsActionsAllowed(true, page()))
        val foreground = page(); lifetime.invalidate(); assertTrue(page().viewEpoch > foreground.viewEpoch)
        lifetime.dispose(); val disposed = page(); lifetime.start(); lifetime.setOpen(true)
        assertFalse(page().active || page().visible || page().actionsAllowed)
        assertEquals(disposed, page()); assertFalse(miningClaimsActionsAllowed(true, page()))
    }

    @Test fun `entry discovers known availability while saved history and storage errors survive disabled discovery`() {
        assertFalse(miningClaimsEntryAvailable(MiningClaimsState()))
        assertTrue(miningClaimsEntryAvailable(null, storageUnavailable = true))
        assertTrue(miningClaimsEntryAvailable(state()))
        assertTrue(miningClaimsEntryAvailable(state(operation()).copy(status = null)))
        assertTrue(miningClaimsEntryAvailable(state().copy(status = null, journal = state().journal!!.copy(archives = listOf(operation().copy(claim = paid()))))))
    }
    @Test fun `paused parent disables every new action but keeps recovery and finalized history controls`() {
        val unsigned = state(operation()).copy(review = p)
        assertTrue(miningClaimsControls(unsigned, true).sign)
        val held = miningClaimsControls(unsigned, false)
        assertFalse(held.begin || held.review || held.sign || held.submit); assertTrue(held.check)
        val paid = miningClaimsControls(state(operation().copy(claim = paid())), false)
        assertTrue(paid.finish && paid.check)
        val refusal = operation().copy(preparation = null, prepareRefusal = MiningClaimPrepareRefusal(503, "PHASE_E_DISABLED"))
        assertTrue(miningClaimsControls(state(refusal), false).archiveRefusal)
        assertFalse(miningClaimsControls(unsigned.copy(busy = true), true).check)
    }
    @Test fun `approval submission and finalized evidence are distinct and submitted original never gets another submit control`() {
        val signed = operation().copy(signingStarted = true, signed = f.saved)
        assertEquals("WALLET APPROVED · NOT SUBMITTED", miningClaimsPhase(signed))
        assertTrue(miningClaimsControls(state(signed), true).submit)
        val sent = signed.copy(submitAttempted = true)
        assertEquals("SUBMISSION OUTCOME PENDING", miningClaimsPhase(sent))
        assertFalse(miningClaimsControls(state(sent), true).submit)
        val completed = sent.copy(claim = paid())
        assertEquals("CLAIM FINALIZED", miningClaimsPhase(completed))
        assertFalse(miningClaimsControls(state(completed), true).review)
        assertTrue(miningClaimsControls(state(completed), false).finish)
        val retained = paid().copy(state = "retained", landing = "pending", settledBaseUnits = null,
            transactions = paid().transactions.map { it.copy(landing = "pending", settledBaseUnits = null, settledAt = null) })
        assertFalse(miningClaimsControls(state(operation().copy(claim = retained)), true).review)
    }
    @Test fun `unknown availability is never displayed as zero and saved policy owns token precision`() {
        assertNull(miningClaimsKeepAmount(null, f.policy.tokenDecimals))
        assertNull(miningClaimsKeepAmount("0", null))
        assertEquals("0", miningClaimsKeepAmount("0", 4))
        assertEquals("1.2345", miningClaimsKeepAmount("12345", 4))
        val current = state().copy(status = status().copy(decimals = 4))
        assertEquals(4, miningClaimsDecimals(current))
        assertEquals(f.policy.tokenDecimals, miningClaimsDecimals(current.copy(journal = state(operation()).journal)))
    }
    @Test fun `failed claim exposes explicit single transaction archive even when paused and never another approval or submit`() {
        val receipt = paid().copy(state = "failed", landing = "failed", settledBaseUnits = null,
            transactions = paid().transactions.map { it.copy(landing = "failed", settledBaseUnits = null) })
        val failed = operation().copy(signingStarted = true, signed = f.saved, claim = receipt)
        assertEquals("CLAIM FAILED · NO KEEP PAID", miningClaimsPhase(failed))
        val controls = miningClaimsControls(state(failed).copy(review = p), true)
        assertFalse(controls.begin || controls.review || controls.sign || controls.submit || controls.finish)
        assertTrue(controls.archiveFailed && controls.check)
        assertTrue(miningClaimsControls(state(failed), false).archiveFailed)
        assertFalse(miningClaimsControls(state(failed), false, running = true).archiveFailed)
        val split = failed.copy(preparation = p.copy(transactions = p.transactions + p.transactions.single().copy(ordinal = 1)))
        assertFalse(miningClaimsControls(state(split), false).archiveFailed)
        assertFalse(miningClaimsControls(state(operation().copy(submitAttempted = true)), false).archiveFailed)
    }

    private inner class Controller {
        val store = MiningClaimsStore(MemoryStore(), identity)
        var available = true; var prepared = false; var reads = 0; var posts = 0; var approvals = 0; var submits = 0; var cancelled = false
        var signAction: suspend ((MiningClaimSavedWire) -> Unit) -> Unit = { it(f.saved) }
        private val ports = object : MiningClaimsPorts {
            override fun capture(newAction: Boolean): () -> Unit = { if (newAction) check(available) }
            override fun policy() = f.policy
            override fun trust() = if (available) f.trust else null
            override fun key() = p.idempotencyKey
            override fun clockMs() = 0L
            override suspend fun status(guard: () -> Unit) = status().also { reads++; guard() }
            override suspend fun prepare(request: MiningClaimPrepareRequest, guard: () -> Unit, retain: (MiningClaimPreparationView) -> Unit,
                refusal: (MiningClaimPrepareRefusal) -> Unit): MiningClaimPreparationView {
                posts++; prepared = true; retain(p); guard(); return p
            }
            override suspend fun preparation(key: String, guard: () -> Unit, retain: (MiningClaimPreparationEnvelope) -> Unit): MiningClaimPreparationEnvelope {
                reads++; val response = MiningClaimPreparationEnvelope(p.wallet, key, if (prepared) "prepared" else "unknown", if (prepared) p else null, p.serverNow)
                retain(response); guard(); return response
            }
            override suspend fun claim(id: String, guard: () -> Unit, retain: (MiningClaimView) -> Unit): MiningClaimView {
                reads++; val response = MiningClaimView(1, p.wallet, id, "prepared", "pending", null, null,
                    listOf(MiningClaimLanding(0, "combined", null, "pending", null, null, null)), p.serverNow, false)
                retain(response); guard(); return response
            }
            override suspend fun live(preparation: MiningClaimPreparationView, guard: () -> Unit) { guard() }
            override suspend fun sign(prepared: PreparedMiningClaim, guard: () -> Unit, retain: (MiningClaimSavedWire) -> Unit) {
                approvals++; if (cancelled) throw IOException("Wallet cancelled")
                signAction(retain); guard()
            }
            override suspend fun submit(request: MiningClaimSubmitRequest, guard: () -> Unit): MiningClaimSubmitResponse {
                submits++; guard(); return MiningClaimSubmitResponse(p.claimId, f.signed.signature, p.serverNow, "held")
            }
        }
        val repository = MiningClaimsRepository(store, ports)
        val model = MiningClaimsViewModel(repository).also { models += it }
        suspend fun review() { model.foreground(); model.begin()?.join(); model.review()?.join() }
    }
    @Test fun `foreground opens by GET while preparing approval and submission require separate explicit actions`() = runTest {
        val c = Controller(); c.model.foreground()
        assertEquals(1, c.reads); assertEquals(0, c.posts + c.approvals + c.submits)
        c.model.begin()?.join(); assertEquals(1, c.posts); assertEquals(0, c.approvals + c.submits)
        c.model.review()?.join(); assertNotNull(c.model.state.value.review); assertEquals(0, c.approvals + c.submits)
        c.model.sign()?.join(); assertEquals(1, c.approvals); assertEquals(0, c.submits)
        c.model.foreground(); assertEquals(0, c.submits)
        c.model.submit()?.join(); assertEquals(1, c.submits)
        c.model.foreground(); assertEquals(1, c.posts); assertEquals(1, c.approvals); assertEquals(1, c.submits)
    }
    @Test fun `dismissal keeps durable callback alive and foreground waits for it before GET recovery`() = runTest {
        val c = Controller(); c.review()
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        c.signAction = { retain -> entered.complete(Unit); release.await(); retain(f.saved) }
        val signing = requireNotNull(c.model.sign()); entered.await(); val reads = c.reads
        assertNull(c.model.sign())
        c.model.dismiss(); assertNull(c.model.state.value.review)
        val foreground = async { c.model.foreground() }; runCurrent()
        assertFalse(foreground.isCompleted); assertEquals(reads, c.reads)
        release.complete(Unit); signing.join(); foreground.await()
        assertEquals(f.saved, c.store.read().operation!!.signed)
        assertTrue(c.reads > reads); assertEquals(0, c.submits); assertNull(c.model.state.value.review)
    }
    @Test fun `wallet cancellation and foreground cannot reapprove until a fresh explicit review`() = runTest {
        val c = Controller(); c.review(); c.cancelled = true; c.model.sign()?.join()
        assertEquals(1, c.approvals); assertNull(c.model.state.value.review); assertNull(c.store.read().operation!!.signed)
        c.model.foreground(); c.model.sign()?.join(); assertEquals(1, c.approvals)
        c.cancelled = false; c.model.review()?.join(); c.model.sign()?.join()
        assertEquals(2, c.approvals); assertEquals(1, c.posts); assertEquals(0, c.submits)
    }
}
