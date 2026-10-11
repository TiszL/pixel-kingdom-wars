package gg.pixelkingdomwars.nativeclient.mining

import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import java.math.BigInteger
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.Collections
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val failureJson = Json { encodeDefaults = true }
private fun failureCount(value: Long) { require(value in 0..9_007_199_254_740_991L) }
private fun failureFee(value: String) {
    require(value.length in 1..20 && value.matches(Regex("0|[1-9][0-9]{0,19}")))
    require(value.toBigInteger() <= BigInteger.ONE.shiftLeft(64) - BigInteger.ONE)
}
private fun failureInstant(value: String) {
    require(value.length == 27 && value.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z")))
    require(DateTimeFormatterBuilder().appendInstant(6).toFormatter().format(Instant.parse(value)) == value)
}
@Serializable data class MiningTaxClaimsFailureSource(val trust: String, val genesisHash: String, val programId: String,
    val configAddress: String, val reviewedDeploymentSlot: Long, val reviewedProgramDataSha256: String,
    val snapshotSha256: String, val snapshotSlot: Long, val blockhashSlot: Long, val observedAccountSlot: Long)
@Serializable data class MiningTaxClaimsFailureReceipt(val version: Int, val wallet: String, val idempotencyKey: String,
    val claimId: String, val round: String, val spot: Long, val ordinal: Long, val kind: String, val signature: String,
    val messageSha256: String, val signedTransactionSha256: String, val slot: Long, val blockTime: Long,
    val feeLamports: String, val rentLamports: String, val paidKeepBaseUnits: String, val source: MiningTaxClaimsFailureSource,
    val outcome: String, val finalityAuthenticated: Boolean, val paymentAuthorized: Boolean, val signingAuthorized: Boolean,
    val broadcastAuthorized: Boolean, val journalClearingAuthorized: Boolean)
@Serializable data class MiningTaxClaimsFailure(val wallet: String, val idempotencyKey: String, val claimId: String,
    val ordinal: Long, val receipt: MiningTaxClaimsFailureReceipt, val verifiedAt: String,
    val transactionFailed: Boolean, val claimFinalized: Boolean)

/** Exact owner-attestation grammar only. Failure fees are historical facts, not
 * signing estimates; no packet failure grants whole-plan closure or finality. */
@Serializable data class MiningTaxClaimsFailureEnvelope(val recovery: MiningTaxClaimsRecoveryEnvelope,
    val failures: List<MiningTaxClaimsFailure>) {
    fun validate() {
        require(failures.size <= 2); recovery.validate()
        val p = recovery.preparation
        if (p == null) { require(failures.isEmpty()); return }
        var previous = -1L
        for (f in failures) {
            require(f.ordinal in 0..1 && f.ordinal > previous); previous = f.ordinal
            val w = requireNotNull(recovery.wires.find { it.ordinal == f.ordinal }); require(p.transactions.getOrNull(f.ordinal.toInt()) != null)
            val r = f.receipt; val s = r.source
            require(f.wallet == p.wallet && f.idempotencyKey == p.idempotencyKey && f.claimId == p.claimId)
            failureInstant(f.verifiedAt); require(f.transactionFailed && !f.claimFinalized)
            require(r.version == 1 && r.wallet == f.wallet && r.idempotencyKey == f.idempotencyKey && r.claimId == f.claimId && r.ordinal == f.ordinal && r.round == p.round && r.spot == p.spot)
            require(r.kind == w.kind && r.signature == w.signature && r.messageSha256 == w.messageSha256 && r.signedTransactionSha256 == w.wireSha256)
            failureCount(r.slot); failureCount(r.blockTime); failureFee(r.feeLamports)
            require(r.rentLamports == "0" && r.paidKeepBaseUnits == "0" && r.outcome == "failed" && r.finalityAuthenticated &&
                !r.paymentAuthorized && !r.signingAuthorized && !r.broadcastAuthorized && !r.journalClearingAuthorized)
            listOf(s.reviewedDeploymentSlot, s.snapshotSlot, s.blockhashSlot, s.observedAccountSlot).forEach(::failureCount)
            require(s.trust == "trusted-finalized-rpc-reviewed-program" && s.genesisHash == p.identity.genesisHash && s.programId == p.identity.programId && s.configAddress == p.identity.configAddress &&
                s.reviewedDeploymentSlot == p.source.reviewedDeploymentSlot && s.reviewedProgramDataSha256 == p.source.reviewedProgramDataSha256 && s.snapshotSha256 == p.source.snapshotSha256 &&
                s.snapshotSlot == p.source.snapshotSlot && s.blockhashSlot == p.source.blockhashSlot)
            require(r.slot > p.source.reviewedDeploymentSlot && r.slot >= maxOf(p.source.snapshotSlot, p.source.blockhashSlot) && s.observedAccountSlot >= r.slot)
            require(BigInteger.valueOf(r.blockTime) >= p.snapshot.unixTimestamp.toBigInteger())
            recovery.settlement?.let { require(it.ordinal < f.ordinal) }
        }
    }
    companion object {
        fun from(raw: JsonObject): MiningTaxClaimsFailureEnvelope {
            var nodes = 0
            fun bound(value: JsonElement, depth: Int, field: String?) {
                require(++nodes <= 1024 && depth <= 11)
                when (value) {
                    is JsonObject -> { require(value.size <= 40); value.forEach { (key, child) -> require(key.length <= 64); bound(child, depth + 1, key) } }
                    is JsonArray -> { require(value.size <= when (field) { "failures", "transactions", "wires" -> 2; "newAccounts", "accrualDays" -> 10; else -> 0 }); value.forEach { bound(it, depth + 1, null) } }
                    is JsonPrimitive -> require(value.content.length <= 2464)
                }
            }
            bound(raw, 0, null); strictPrimitives(raw, serializer().descriptor)
            val decoded = failureJson.decodeFromJsonElement(serializer(), raw).also { it.validate() }
            return decoded.copy(recovery = MiningTaxClaimsRecoveryEnvelope.from(raw.getValue("recovery").jsonObject),
                failures = Collections.unmodifiableList(ArrayList(decoded.failures)))
        }
    }
}
