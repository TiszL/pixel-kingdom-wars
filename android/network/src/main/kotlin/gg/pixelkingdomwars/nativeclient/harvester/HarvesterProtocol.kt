package gg.pixelkingdomwars.nativeclient.harvester

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.quantity
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.timestamp
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionHome
import gg.pixelkingdomwars.nativeclient.starter.starterResourceRealms
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopIdentity
import gg.pixelkingdomwars.nativeclient.workshop.count
import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import java.math.BigInteger
import java.time.Duration
import java.time.ZoneOffset
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl

internal val harvesterJson = Json { encodeDefaults = true }
@Serializable data class HarvesterIdentity(val origin: String, val cluster: String, val wallet: String) {
    fun validate() { WorkshopIdentity(origin, cluster, wallet).validate(); require(origin.toHttpUrl().toString().removeSuffix("/") == origin) }
}
@Serializable data class HarvesterFeature(val version: Int, val receipts: Int)
@Serializable data class HarvesterFeatures(val harvesters: HarvesterFeature)
/** These are server values frozen into review and receipt, never Kotlin gameplay constants. */
@Serializable data class HarvesterPolicy(val policyVersion: Int, val producingSourcesPerWallet: Int,
    val grossPerWalletUtcDay: String, val grossPerCadence: String, val cadenceSec: Long, val maxLeaseSec: Long,
    val taxPolicyVersion: Int, val taxBasisPoints: Long, val islandPoolBps: Long) {
    fun validate() {
        require(policyVersion == 1 && taxPolicyVersion == 1 && producingSourcesPerWallet > 0)
        require(quantity(grossPerWalletUtcDay, true) >= quantity(grossPerCadence, true))
        count(cadenceSec, true); count(maxLeaseSec, true); require(maxLeaseSec >= cadenceSec)
        count(taxBasisPoints, true); count(islandPoolBps); require(islandPoolBps <= taxBasisPoints)
    }
}
@Serializable data class HarvesterSummary(val sourceId: String, val baseId: String, val harvesterId: String,
    val policyVersion: Int, val realmId: String, val resourceId: String, val admittedAt: String, val leaseExpiresAt: String) {
    fun validate() {
        uuid(sourceId); uuid(baseId); uuid(harvesterId); require(policyVersion > 0)
        require(starterResourceRealms[resourceId] == realmId && resourceId in starterResourceRealms)
        require(timestamp(admittedAt) < timestamp(leaseExpiresAt))
    }
}
@Serializable data class HarvesterFacility(val baseId: String, val harvesterId: String, val completedBuildJobId: String, val harvesterCompletedAt: String) {
    fun validate() { uuid(baseId); uuid(harvesterId); uuid(completedBuildJobId); timestamp(harvesterCompletedAt) }
}
@Serializable data class HarvesterTerm(val termId: String, val termHash: String, val startsAt: String, val endsAt: String) {
    fun validate() { uuid(termId); require(termHash.matches(Regex("[0-9a-f]{64}"))); require(timestamp(startsAt) < timestamp(endsAt)) }
}
@Serializable data class HarvesterSource(val sourceId: String, val baseId: String, val harvesterId: String,
    val policyVersion: Int, val realmId: String, val resourceId: String, val admittedAt: String, val leaseExpiresAt: String,
    val completedBuildJobId: String, val harvesterCompletedAt: String, val term: HarvesterTerm, val terms: HarvesterPolicy) {
    fun summary() = HarvesterSummary(sourceId, baseId, harvesterId, policyVersion, realmId, resourceId, admittedAt, leaseExpiresAt)
    fun facility() = HarvesterFacility(baseId, harvesterId, completedBuildJobId, harvesterCompletedAt)
    fun validate() {
        summary().validate(); facility().validate(); term.validate(); terms.validate(); require(policyVersion == terms.policyVersion)
        val admitted = timestamp(admittedAt); require(timestamp(harvesterCompletedAt) <= admitted)
        require(timestamp(term.startsAt) <= admitted && admitted < timestamp(term.endsAt))
        require(timestamp(leaseExpiresAt) == minOf(admitted.plusSeconds(terms.maxLeaseSec), timestamp(term.endsAt)))
    }
}
@Serializable data class HarvesterView(val wallet: String, val baseId: String, val serverNow: String,
    val features: HarvesterFeatures, val acceptingSelections: Boolean, val home: StarterExpeditionHome?,
    val facilities: List<HarvesterFacility>, val source: HarvesterSummary?, val walletSource: HarvesterSummary?,
    val policy: HarvesterPolicy, val rawStock: List<OrdinaryRawStock>) {
    fun validate() {
        wallet(wallet); uuid(baseId); val now = timestamp(serverNow); require(features.harvesters == HarvesterFeature(1, 1))
        home?.validate(); policy.validate(); facilities.forEach { it.validate(); require(it.baseId == baseId && timestamp(it.harvesterCompletedAt) <= now) }
        require(facilities.map { it.harvesterId }.distinct().size == facilities.size && facilities.map { it.completedBuildJobId }.distinct().size == facilities.size)
        walletSource?.let { it.validate(); require(timestamp(it.admittedAt) <= now) }
        require(source == walletSource?.takeIf { it.baseId == baseId }) // Expired retained heads are still selected.
        require(rawStock.map { it.resourceId }.toSet() == starterResourceRealms.keys && rawStock.size == starterResourceRealms.size)
        rawStock.forEach { it.validate() }
    }
    companion object { fun from(raw: JsonObject): HarvesterView { strictPrimitives(raw, serializer().descriptor); return harvesterJson.decodeFromJsonElement<HarvesterView>(raw).also { it.validate() } } }
}
@Serializable data class HarvesterRequest(val idempotencyKey: String, val baseId: String, val harvesterId: String,
    val expectedSourceId: String?, val policyVersion: Int) {
    fun validate() { uuid(idempotencyKey); uuid(baseId); uuid(harvesterId); expectedSourceId?.let(::uuid); require(policyVersion > 0 && expectedSourceId != idempotencyKey) }
    fun body(): JsonObject = harvesterJson.encodeToJsonElement(serializer(), this).jsonObject
}
@Serializable data class HarvesterCommand(val request: HarvesterRequest, val facility: HarvesterFacility,
    val realmId: String, val policy: HarvesterPolicy, val replacedSource: HarvesterSummary?) {
    val key get() = request.idempotencyKey
    val receiptPath get() = "/harvesters/sources/by-key/" + key
    fun validate() {
        request.validate(); facility.validate(); policy.validate(); replacedSource?.validate()
        require(request.baseId == facility.baseId && request.harvesterId == facility.harvesterId && request.policyVersion == policy.policyVersion)
        require(realmId in starterResourceRealms.values && request.expectedSourceId == replacedSource?.sourceId)
    }
    fun admit(identity: HarvesterIdentity, view: HarvesterView) {
        identity.validate(); validate(); view.validate()
        require(view.wallet == identity.wallet && view.baseId == request.baseId && view.acceptingSelections)
        require(view.home?.realmId == realmId && view.policy == policy && view.walletSource == replacedSource)
        require(view.facilities.single { it.harvesterId == request.harvesterId } == facility)
    }
    companion object { fun review(identity: HarvesterIdentity, view: HarvesterView, key: String, harvesterId: String): HarvesterCommand =
        HarvesterCommand(HarvesterRequest(key, view.baseId, harvesterId, view.walletSource?.sourceId, view.policy.policyVersion),
            view.facilities.single { it.harvesterId == harvesterId }, requireNotNull(view.home).realmId, view.policy, view.walletSource).also { it.admit(identity, view) } }
}
@Serializable data class HarvesterReceipt(val wallet: String, val request: HarvesterRequest, val source: HarvesterSource) {
    fun validate(identity: HarvesterIdentity, command: HarvesterCommand) {
        identity.validate(); command.validate(); source.validate()
        require(wallet == identity.wallet && request == command.request && source.sourceId == command.key)
        require(source.facility() == command.facility && source.realmId == command.realmId && source.terms == command.policy)
    }
}
@Serializable data class HarvesterEvent(val sourceId: String, val ordinal: Int, val walletSequence: String,
    val resourceId: String, val policyVersion: Int, val earnedAt: String, val settledAt: String, val utcDay: String,
    val grossQuantity: String, val netQuantity: String, val islandPoolQuantity: String,
    val taxPolicyVersion: Int, val taxBasisPoints: Long, val islandPoolBps: Long, val carryBefore: String, val carryAfter: String) {
    fun validate(source: HarvesterSource, serverNow: String) {
        val terms = source.terms; quantity(walletSequence, true)
        require(sourceId == source.sourceId && resourceId == source.resourceId && policyVersion == source.policyVersion)
        require(ordinal > 0 && ordinal.toLong() <= terms.maxLeaseSec / terms.cadenceSec)
        require(taxPolicyVersion == terms.taxPolicyVersion && taxBasisPoints == terms.taxBasisPoints && islandPoolBps == terms.islandPoolBps)
        val gross = quantity(grossQuantity); val net = quantity(netQuantity); val pool = quantity(islandPoolQuantity)
        val before = quantity(carryBefore); val after = quantity(carryAfter); val basis = BigInteger.valueOf(taxBasisPoints)
        require((gross == BigInteger.ZERO || gross == quantity(terms.grossPerCadence, true)) && before < basis)
        val numerator = gross * BigInteger.valueOf(islandPoolBps) + before
        require(pool == numerator / basis && net + pool == gross && after == numerator % basis)
        val earned = timestamp(earnedAt); val settled = timestamp(settledAt)
        require(earned == timestamp(source.admittedAt).plusSeconds(Math.multiplyExact(ordinal.toLong(), terms.cadenceSec)))
        require(earned <= timestamp(source.leaseExpiresAt) && earned < timestamp(source.term.endsAt))
        require(settled >= earned && settled <= timestamp(serverNow))
        require(timestamp(utcDay) == earned.atOffset(ZoneOffset.UTC).toLocalDate().atStartOfDay().toInstant(ZoneOffset.UTC))
    }
}
@Serializable data class HarvesterClosure(val sourceId: String, val reason: String, val cutoffAt: String, val processedOrdinal: Int)
@Serializable data class HarvesterCustodyStop(val sourceId: String, val cutoffAt: String, val checkedAt: String, val auditHash: String)
@Serializable data class HarvesterSettlement(val events: List<HarvesterEvent>, val closure: HarvesterClosure?, val custodyStop: HarvesterCustodyStop?) {
    fun validate(source: HarvesterSource, serverNow: String) {
        val admitted = timestamp(source.admittedAt); val now = timestamp(serverNow)
        require(events.size.toLong() <= source.terms.maxLeaseSec / source.terms.cadenceSec)
        events.forEachIndexed { index, event ->
            event.validate(source, serverNow); require(event.ordinal == index + 1)
            events.getOrNull(index - 1)?.let { prior ->
                require(quantity(event.walletSequence) > quantity(prior.walletSequence) && event.carryBefore == prior.carryAfter)
            }
        }
        custodyStop?.let { stop ->
            require(stop.sourceId == source.sourceId && stop.auditHash.matches(Regex("[0-9a-f]{64}")))
            val cutoff = timestamp(stop.cutoffAt); require(cutoff in admitted..now && timestamp(stop.checkedAt) <= cutoff)
            require(events.all { timestamp(it.earnedAt) <= cutoff })
        }
        closure?.let { closed ->
            require(closed.sourceId == source.sourceId && closed.reason in setOf("replacement", "custody_change", "deactivation", "facility_removed", "realm_change", "lease_expired"))
            val cutoff = timestamp(closed.cutoffAt); require(cutoff in admitted..now && closed.processedOrdinal == events.size)
            if (closed.reason == "lease_expired") require(cutoff >= timestamp(source.leaseExpiresAt))
            val lastEarnable = minOf(cutoff, timestamp(source.leaseExpiresAt), timestamp(source.term.endsAt).minusMillis(1))
            val complete = maxOf(0L, Duration.between(admitted, lastEarnable).seconds / source.terms.cadenceSec)
            require(closed.processedOrdinal.toLong() == complete)
            custodyStop?.let { require(closed.reason == "custody_change" && closed.cutoffAt == it.cutoffAt) }
        }
    }
    /** Original observations may append. An out-of-order reply never erases already durable evidence. */
    fun preserves(original: HarvesterSettlement): Boolean = events.take(original.events.size) == original.events
        && (original.closure == null || closure == original.closure)
        && (original.custodyStop == null || custodyStop == original.custodyStop)
}
@Serializable data class HarvesterProof(val wallet: String, val idempotencyKey: String, val serverNow: String, val status: String,
    val originalReceipt: HarvesterReceipt?, val settlement: HarvesterSettlement?) {
    fun validate(identity: HarvesterIdentity, command: HarvesterCommand) {
        identity.validate(); command.validate(); require(wallet == identity.wallet && idempotencyKey == command.key); val now = timestamp(serverNow)
        if (status == "unknown") { require(originalReceipt == null && settlement == null); return }; require(status == "accepted")
        val receipt = requireNotNull(originalReceipt); receipt.validate(identity, command); require(timestamp(receipt.source.admittedAt) <= now)
        requireNotNull(settlement).validate(receipt.source, serverNow)
    }
    companion object { fun from(raw: JsonObject, identity: HarvesterIdentity, command: HarvesterCommand): HarvesterProof {
        strictPrimitives(raw, serializer().descriptor); return harvesterJson.decodeFromJsonElement<HarvesterProof>(raw).also { it.validate(identity, command) }
    } }
}
