package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import org.junit.Assert.*
import org.junit.Test

/** Public preparation/signature vectors; receipt variants below test presentation, not chain acceptance. */
class MiningClaimsPresentationTest {
    private val f = MiningClaimsWalletFixture()
    private val p = f.preparation
    private val identity = StarterIdentity("https://fixture.test", "devnet", p.wallet)
    private fun operation() = MiningClaimsOperation(MiningClaimPrepareRequest(p.idempotencyKey), f.policy,
        prepareAttempted = true, preparation = p)
    private fun state(op: MiningClaimsOperation? = null) = MiningClaimsState(loaded = true,
        journal = MiningClaimsJournal(1, identity, 1, op, emptyList()))
    private fun status(amount: String = "40") = MiningClaimStatusView(MiningClaimFeatures(MiningClaimFeature(1, 1)), p.wallet,
        "shardkeep-economy", p.identity.programId, p.identity.keepMint, "ready", null, p.rootSequence,
        p.leaf.cumulativeKeepBaseUnits, "40", amount, f.policy.tokenDecimals, 200, "7200", "7200", p.needsAta,
        false, true, false, p.serverNow)
    private fun paid(amount: String = "40") = MiningClaimView(1, p.wallet, p.claimId, "settled", "finalized", f.signed.signature, amount,
        listOf(MiningClaimLanding(0, "combined", f.signed.signature, "finalized", amount, p.serverNow, p.serverNow)), p.serverNow, false)

    @Test fun `unavailable allocation stays unknown while a real zero allocation stays zero`() {
        val unknown = miningClaimsAllocation(state())
        assertNull(unknown.amount); assertEquals("UNAVAILABLE", unknown.pill.label)
        val zero = miningClaimsAllocation(state().copy(status = status("0").copy(state = "no_allocation", preparationAllowed = false)))
        assertEquals("0", zero.amount); assertEquals("NO ALLOCATION", zero.pill.label)
    }
    @Test fun `current allocation is independent of the cumulative prepared entitlement and archived payout`() {
        val archived = operation().copy(claim = paid("20"))
        val current = state(operation()).copy(status = status("40"), journal = state(operation()).journal!!.copy(archives = listOf(archived)))
        assertEquals("0.00000004", miningClaimsAllocation(current).amount)
        assertNull(miningClaimsPaidKeep(current.journal!!.operation!!))
        assertEquals("0.00000002", miningClaimsPaidKeep(archived))
        assertNotEquals(miningClaimsKeepAmount(p.leaf.cumulativeKeepBaseUnits, f.policy.tokenDecimals), miningClaimsAllocation(current).amount)
    }
    @Test fun `only finalized receipt payout is shown as paid using the saved originals precision`() {
        val original = operation().copy(preparation = p.copy(needsMinerRecords = false), claim = paid())
        assertEquals("0.00000004", miningClaimsPaidKeep(original))
        assertEquals("FINALIZED", miningClaimsSavedPill(original).label)
        assertEquals(PaymentTone.DONE, miningClaimsSavedPill(original).tone)
        val changedCurrent = state(original).copy(status = status().copy(decimals = 4))
        assertEquals("0.00000004", miningClaimsPaidKeep(changedCurrent.journal!!.operation!!))
        assertNull(miningClaimsPaidKeep(original.copy(claim = paid().copy(landing = "pending"))))
    }
    @Test fun `wallet approval submission uncertainty and recorded signature never appear paid`() {
        val prepared = operation()
        val approved = prepared.copy(signingStarted = true, signed = f.saved)
        val submitted = approved.copy(submitAttempted = true)
        val recorded = submitted.copy(claim = paid().copy(state = "retained", landing = "pending", settledBaseUnits = null,
            transactions = paid().transactions.map { it.copy(landing = "pending", settledBaseUnits = null, settledAt = null) }))
        assertEquals(listOf("REVIEW", "APPROVED", "CHECKING", "RECORDED"), listOf(prepared, approved, submitted, recorded).map { miningClaimsSavedPill(it).label })
        for (op in listOf(prepared, approved, submitted, recorded)) {
            assertNull(miningClaimsPaidKeep(op)); assertNotEquals(PaymentTone.DONE, miningClaimsSavedPill(op).tone)
        }
    }
    @Test fun `failed and refused claims retain recovery details without a payout or success badge`() {
        val failed = operation().copy(claim = paid().copy(state = "failed", landing = "failed", settledBaseUnits = null,
            transactions = paid().transactions.map { it.copy(landing = "failed", settledBaseUnits = null) }))
        val refused = operation().copy(preparation = null, prepareRefusal = MiningClaimPrepareRefusal(503, "PHASE_E_DISABLED"))
        assertEquals("FAILED", miningClaimsSavedPill(failed).label)
        assertEquals("REFUSED", miningClaimsSavedPill(refused).label)
        for (op in listOf(failed, refused)) {
            assertNull(miningClaimsPaidKeep(op)); assertNotEquals(PaymentTone.DONE, miningClaimsSavedPill(op).tone)
            assertTrue(miningClaimsSavedDetails(op).contains(PaymentDetail("Request", p.idempotencyKey)))
        }
        assertTrue(miningClaimsSavedDetails(refused).contains(PaymentDetail("Refusal", "PHASE_E_DISABLED")))
    }
    @Test fun `original wallet claim and signature remain available for copying after current availability disappears`() {
        val original = operation().copy(signingStarted = true, signed = f.saved, claim = paid())
        val historical = state().copy(journal = state().journal!!.copy(archives = listOf(original)))
        val recovered = historical.journal!!.archives.single()
        assertNull(miningClaimsAllocation(historical).amount)
        assertEquals(listOf(PaymentDetail("Request", p.idempotencyKey), PaymentDetail("Original wallet", p.wallet),
            PaymentDetail("Claim", p.claimId), PaymentDetail("Signature", f.signed.signature)), miningClaimsSavedDetails(recovered))
        assertEquals("0.00000004", miningClaimsPaidKeep(recovered))
    }
    @Test fun `paused or withdrawn current allocations cannot relabel an original finalized receipt`() {
        val original = operation().copy(claim = paid())
        for ((statusName, badge) in listOf("paused" to "PAUSED", "delayed" to "WAITING", "revoked" to "WITHDRAWN")) {
            val observed = state(original).copy(status = status().copy(state = statusName, preparationAllowed = false))
            assertEquals(badge, miningClaimsAllocation(observed).pill.label)
            assertEquals("FINALIZED", miningClaimsSavedPill(observed.journal!!.operation!!).label)
            assertEquals("0.00000004", miningClaimsPaidKeep(observed.journal!!.operation!!))
        }
    }
}
