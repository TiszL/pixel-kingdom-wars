package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.mining.*
import java.util.Collections
import kotlinx.serialization.json.*

/** Historical consistency only. Marker absence, fresh authenticated recovery,
 * durable parent retirement and child admission belong to the caller. */
class BoundMiningTaxClaimsContinuation internal constructor(val envelope: MiningTaxClaimsContinuationEnvelope) {
    val nativeFinalityVerified = false
    val currentSigningAuthorized = false
    val broadcastAuthorized = false
    val relayAuthorized = false
    val settlementAuthorized = false
    val journalClearingAuthorized = false
}
object MiningTaxClaimsContinuationCrypto {
    suspend fun bind(original: MiningTaxClaimsLocalEvidence, savedSetup: MiningTaxClaimsRecoveryEnvelope,
        pendingRequest: MiningTaxClaimsContinuationRequest, envelope: MiningTaxClaimsContinuationEnvelope,
        trust: MiningTaxClaimsSigningTrust, policy: MiningTaxClaimsSigningPolicy): BoundMiningTaxClaimsContinuation {
        // Own every nested caller collection and historical pin before PDA work
        // can suspend. No clock, provider or wallet is consulted by this binder.
        val local = ownContinuationLocal(original); val setup = ownContinuationSetup(savedSetup)
        val request = pendingRequest.copy(caps = pendingRequest.caps.copy()).also { it.validate() }
        val owned = ownContinuationEnvelope(envelope); val pins = trust.copy(); val rules = policy.copy().also { it.validate() }
        val c = requireNotNull(owned.continuation) { "No saved continuation" }
        require(owned.status == "continued" && local.wallet == owned.wallet && local.request.idempotencyKey == owned.parentIdempotencyKey && local.preparation == c.parentPreparation)
        require(request.idempotencyKey == c.childPreparation.idempotencyKey && request.caps == c.childPreparation.caps) { "Additional tax consent differs" }
        require(setup.status == "setup" && setup.preparation == c.parentPreparation && setup.settlement == c.parentSetup && setup.wires.find { it.ordinal == 0L } == c.parentWire) { "Saved setup differs" }
        MiningTaxClaimsCrypto.bindSettlement(local, setup, pins, rules)
        // The accepted verifier reconstructs the complete child plan even when
        // only ordinal0 is selected. It grants no fresh signing capability here.
        MiningTaxClaimsCrypto.prepare(c.childPreparation, pins, rules)
        return BoundMiningTaxClaimsContinuation(owned)
    }
}
private val continuationCopyJson = Json { encodeDefaults = true }
private fun <T> ownContinuationList(v: List<T>) = Collections.unmodifiableList(ArrayList(v))
private fun ownContinuationPreparation(p: MiningTaxClaimsPreparation): MiningTaxClaimsPreparation {
    require(p.transactions.size in 1..2 && p.setup.accrualDays.size <= 10)
    p.transactions.forEach { require(it.newAccounts.size <= 10) }
    return p.copy(setup = p.setup.copy(accrualDays = ownContinuationList(p.setup.accrualDays)),
        transactions = ownContinuationList(p.transactions.map { it.copy(newAccounts = ownContinuationList(it.newAccounts)) })).also { it.validate() }
}
private fun ownContinuationSetup(r: MiningTaxClaimsRecoveryEnvelope): MiningTaxClaimsRecoveryEnvelope {
    require(r.wires.size <= 2); r.settlement?.let { require(it.receipt.transactions.size in 1..2) }
    return r.copy(preparation = r.preparation?.let(::ownContinuationPreparation), wires = ownContinuationList(r.wires),
        settlement = r.settlement?.let { it.copy(receipt = it.receipt.copy(transactions = ownContinuationList(it.receipt.transactions))) }).also { it.validate() }
}
private fun ownContinuationEnvelope(v: MiningTaxClaimsContinuationEnvelope): MiningTaxClaimsContinuationEnvelope {
    val c = v.continuation
    if (c != null) { ownContinuationPreparation(c.parentPreparation); ownContinuationPreparation(c.childPreparation); require(c.parentSetup.receipt.transactions.size in 1..2) }
    v.validate()
    return MiningTaxClaimsContinuationEnvelope.from(continuationCopyJson.encodeToJsonElement(MiningTaxClaimsContinuationEnvelope.serializer(), v).jsonObject)
}
private fun ownContinuationLocal(v: MiningTaxClaimsLocalEvidence): MiningTaxClaimsLocalEvidence {
    require(v.wires.size <= 2)
    val p = ownContinuationPreparation(v.preparation); val request = v.request.copy(caps = v.request.caps.copy())
    require(v.wallet == p.wallet && request == MiningTaxClaimsPrepareRequest(p.idempotencyKey, p.round, p.spot, p.caps))
    val wires = v.wires.map { w ->
        require(w.ordinal in p.transactions.indices && w.wire.length in 88..1644 && w.signature.length in 64..88)
        require(w.messageSha256.length == 64 && w.messageSha256.matches(Regex("[0-9a-f]{64}")) && w.wireSha256.length == 64 && w.wireSha256.matches(Regex("[0-9a-f]{64}")))
        w.copy()
    }
    require(wires.zipWithNext().all { (a, b) -> a.ordinal < b.ordinal })
    return MiningTaxClaimsLocalEvidence(v.wallet, request, p, ownContinuationList(wires))
}
