package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.mining.*
import java.util.Base64
import java.util.Collections
import kotlinx.serialization.json.*

/** Immutable owner-attested packet failure. This is neither independent chain
 * finality nor proof that an entire split plan can be cleared or replaced. */
class BoundMiningTaxClaimsFailure internal constructor(val envelope: MiningTaxClaimsFailureEnvelope) {
    val nativeFinalityVerified = false
    val currentSigningAuthorized = false
    val broadcastAuthorized = false
    val journalClearingAuthorized = false
}
object MiningTaxClaimsFailureCrypto {
    suspend fun bind(original: MiningTaxClaimsLocalEvidence, envelope: MiningTaxClaimsFailureEnvelope,
        trust: MiningTaxClaimsSigningTrust, policy: MiningTaxClaimsSigningPolicy): BoundMiningTaxClaimsFailure {
        // Every caller-owned list and pin is copied before PDA work can suspend.
        val local = ownFailureLocal(original); val failure = ownFailureEnvelope(envelope)
        val pins = trust.copy(); val rules = policy.copy().also { it.validate() }
        val p = local.preparation; val r = failure.recovery
        require(failure.failures.isNotEmpty() && r.preparation == p && r.wallet == local.wallet) { "Failure differs from original tax consent" }
        val localWires = local.wires.associateBy { it.ordinal }
        for (failed in failure.failures) require(localWires.containsKey(failed.ordinal.toInt())) { "Missing local failed tax packet" }
        for (server in r.wires) localWires[server.ordinal.toInt()]?.let { saved ->
            require(saved.wire == Base64.getEncoder().encodeToString(realmSaleHex(server.signedTransactionHex, 66, 1232)) && saved.signature == server.signature &&
                saved.messageSha256 == server.messageSha256 && saved.wireSha256 == server.wireSha256) { "Failure custody differs from saved bytes" }
        }
        // Accepted canonical ABI/PDA/privilege/hash checks cover the entire plan;
        // independent historical pins are never inferred from this receipt.
        val prepared = p.transactions.indices.map { MiningTaxClaimsCrypto.prepare(p, pins, rules, it) }
        fun verify(ordinal: Int, wire: String, signature: String, messageHash: String, wireHash: String) {
            val checked = prepared[ordinal].verifySignedBase64(wire)
            require(checked.signature == signature && checked.messageSha256 == messageHash && checked.wireSha256 == wireHash) { "Failure signature or digest differs" }
        }
        for (w in local.wires) verify(w.ordinal, w.wire, w.signature, w.messageSha256, w.wireSha256)
        // Adjacent server custody is checked even when it has no local counterpart.
        for (w in r.wires) verify(w.ordinal.toInt(), Base64.getEncoder().encodeToString(realmSaleHex(w.signedTransactionHex, 66, 1232)), w.signature, w.messageSha256, w.wireSha256)
        if (r.settlement != null) MiningTaxClaimsCrypto.bindSettlement(local, r, pins, rules)
        return BoundMiningTaxClaimsFailure(failure)
    }
}
private val failureCopyJson = Json { encodeDefaults = true }
private fun boundFailurePreparation(p: MiningTaxClaimsPreparation) {
    require(p.transactions.size in 1..2 && p.setup.accrualDays.size <= 10)
    p.transactions.forEach { require(it.newAccounts.size <= 10) }; p.validate()
}
private fun ownFailureLocal(value: MiningTaxClaimsLocalEvidence): MiningTaxClaimsLocalEvidence {
    require(value.wires.size <= 2); boundFailurePreparation(value.preparation)
    val p = MiningTaxClaimsPreparation.from(failureCopyJson.encodeToJsonElement(MiningTaxClaimsPreparation.serializer(), value.preparation).jsonObject)
    val request = value.request.copy(caps = value.request.caps.copy())
    require(value.wallet == p.wallet && request == MiningTaxClaimsPrepareRequest(p.idempotencyKey, p.round, p.spot, p.caps))
    val wires = value.wires.map { w ->
        require(w.ordinal in p.transactions.indices && w.wire.length in 88..1644 && w.signature.length in 64..88)
        require(w.messageSha256.length == 64 && w.messageSha256.matches(Regex("[0-9a-f]{64}")) && w.wireSha256.length == 64 && w.wireSha256.matches(Regex("[0-9a-f]{64}")))
        w.copy()
    }
    require(wires.zipWithNext().all { (a, b) -> a.ordinal < b.ordinal })
    return MiningTaxClaimsLocalEvidence(value.wallet, request, p, Collections.unmodifiableList(ArrayList(wires)))
}
private fun ownFailureEnvelope(value: MiningTaxClaimsFailureEnvelope): MiningTaxClaimsFailureEnvelope {
    require(value.failures.size <= 2 && value.recovery.wires.size <= 2)
    value.recovery.preparation?.let(::boundFailurePreparation)
    value.recovery.settlement?.let { require(it.receipt.transactions.size in 1..2) }
    value.validate()
    return MiningTaxClaimsFailureEnvelope.from(failureCopyJson.encodeToJsonElement(MiningTaxClaimsFailureEnvelope.serializer(), value).jsonObject)
}
