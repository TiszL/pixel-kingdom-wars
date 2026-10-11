package gg.pixelkingdomwars.nativeclient.realmsales

import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import java.math.BigInteger
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.Collections
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val realmSalesJson = Json { encodeDefaults = true }
private val u64Max = BigInteger.ONE.shiftLeft(64) - BigInteger.ONE
private val i64Max = BigInteger.valueOf(Long.MAX_VALUE)
private const val safeInteger = 9_007_199_254_740_991L
private const val loader = "BPFLoaderUpgradeab1e11111111111111111111111"
private const val clock = "SysvarC1ock11111111111111111111111111111111"
private const val sysvar = "Sysvar1111111111111111111111111111111111111"

/** Supplied by the canonical generated catalogue, never by the document being checked.
 * These are historical consistency checks, not signing, finality, or archival authority. */
@Serializable data class RealmSalesProtocolPolicy(val version: Int, val quoteTtlSec: Long, val daySec: Long,
    val totalSpots: Int, val realmCount: Int, val quotaMax: Int, val permitDurationSec: Long,
    val permitPriceLamports: Long, val basisPoints: Int, val sellerBps: Int, val developerBps: Int) {
    fun validate() {
        require(version > 0 && totalSpots > 0 && realmCount > 0 && quotaMax > 0 && basisPoints > 0)
        listOf(quoteTtlSec, daySec, permitDurationSec, permitPriceLamports).forEach { count(it); require(it > 0) }
        require(sellerBps >= 0 && developerBps >= 0 && sellerBps.toLong() + developerBps == basisPoints.toLong())
    }
    companion object { fun from(raw: JsonObject) = decode(raw, serializer()).also { it.validate() } }
}

private fun count(v: Long) { require(v in 0..safeInteger) }
private fun amount(v: String, maximum: BigInteger = u64Max): BigInteger {
    require(v.length in 1..20 && v.matches(Regex("0|[1-9][0-9]{0,19}")))
    return v.toBigInteger().also { require(it <= maximum) }
}
private fun timestamp(v: String) = amount(v, i64Max)
private fun address(v: String) { require(v.length in 32..44 && v.matches(Regex("[1-9A-HJ-NP-Za-km-z]+"))) }
private fun hash(v: String) { require(v.length == 64 && v.matches(Regex("[0-9a-f]{64}"))) }
private fun saleId(v: String) { require(v.length == 32 && v.matches(Regex("[0-9a-f]{32}")) && v != "00".repeat(16)) }
private fun uuid(v: String) {
    require(v.length == 36 && (v.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) ||
        v == "00000000-0000-0000-0000-000000000000" || v == "ffffffff-ffff-ffff-ffff-ffffffffffff"))
}
private fun signature(v: String) { require(v.length in 64..88 && v != "1".repeat(64) && v.matches(Regex("[1-9A-HJ-NP-Za-km-z]+"))) }
private fun hex(v: String, minimum: Int, maximum: Int) { require(v.length in minimum..maximum && v.matches(Regex("(?:[0-9a-f]{2})+"))) }
private fun instant(v: String) {
    require(v.length == 27 && v.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z")))
    require(DateTimeFormatterBuilder().appendInstant(6).toFormatter().format(Instant.parse(v)) == v)
}
private fun revision(v: String) { require(v.length in 1..128) }
private fun spotRealm(spot: Long, realm: Long, policy: RealmSalesProtocolPolicy) {
    count(spot); count(realm); require(spot < policy.totalSpots && realm < policy.realmCount)
}
private fun <T> owned(values: List<T>): List<T> = Collections.unmodifiableList(ArrayList(values))

/** Bound the parsed JSON tree before descriptor walking or allocating decoded lists.
 * Wire sizes/cardinalities are protocol limits, not duplicated gameplay tuning. */
private fun <T> decode(raw: JsonObject, serializer: DeserializationStrategy<T>): T {
    var nodes = 0
    fun bound(value: JsonElement, depth: Int, field: String?) {
        require(++nodes <= 512 && depth <= 8)
        when (value) {
            is JsonObject -> { require(value.size <= 40); value.forEach { (key, child) -> require(key.length <= 64); bound(child, depth + 1, key) } }
            is JsonArray -> {
                require(when (field) { "rents", "accountRentIncreases" -> value.size in 1..3; "accounts" -> value.size == 6; else -> value.size <= 6 })
                value.forEach { bound(it, depth + 1, null) }
            }
            is JsonPrimitive -> require(value.content.length <= 2464)
        }
    }
    bound(raw, 0, null); strictPrimitives(raw, serializer.descriptor)
    return realmSalesJson.decodeFromJsonElement(serializer, raw)
}

@Serializable data class RealmSalePrepareRequest(val idempotencyKey: String, val spot: Long, val realm: Long) {
    fun validate(policy: RealmSalesProtocolPolicy) { policy.validate(); uuid(idempotencyKey); spotRealm(spot, realm, policy) }
    companion object { fun from(raw: JsonObject, policy: RealmSalesProtocolPolicy) = decode(raw, serializer()).also { it.validate(policy) } }
}
@Serializable data class RealmSaleTerms(val round: String, val day: String, val seller: String, val developer: String,
    val priorExpiry: String, val validAfter: String, val validUntil: String) {
    fun validate() { amount(round); amount(day); address(seller); address(developer); listOf(priorExpiry, validAfter, validUntil).forEach(::timestamp) }
}
@Serializable data class RealmSaleSource(val revision: String, val genesisHash: String, val programId: String,
    val programDataSha256: String, val reviewedDeploymentSlot: Long, val termProofHash: String, val snapshotHash: String,
    val termSlot: Long, val initialSlot: Long, val blockhashSlot: Long, val feeSlot: Long, val costSlot: Long, val admissionSlot: Long) {
    fun validate() {
        revision(revision); address(genesisHash); address(programId); listOf(programDataSha256, termProofHash, snapshotHash).forEach(::hash)
        val slots = listOf(reviewedDeploymentSlot, termSlot, initialSlot, blockhashSlot, feeSlot, costSlot, admissionSlot)
        slots.forEach(::count); require(slots.zipWithNext().all { (a, b) -> a <= b })
    }
}
@Serializable data class RealmSaleRentCap(val address: String, val space: Long, val minimumBalanceLamports: String,
    val existingLamports: String, val maxIncreaseLamports: String) {
    fun validate() {
        address(address); require(space in 1..1232)
        require((amount(minimumBalanceLamports) - amount(existingLamports)).max(BigInteger.ZERO) == amount(maxIncreaseLamports))
    }
}
@Serializable data class RealmSaleQuote(val blockhash: String, val lastValidBlockHeight: Long, val unixTimestamp: String,
    val needsAccess: Boolean, val needsQuota: Boolean, val quotaRemaining: Long, val messageHex: String, val messageSha256: String,
    val packetBytes: Long, val rents: List<RealmSaleRentCap>, val feeLamports: String, val rentLamports: String,
    val paymentDebitLamports: String, val requiredLamports: String, val payerLamports: String) {
    fun validate(policy: RealmSalesProtocolPolicy) {
        address(blockhash); count(lastValidBlockHeight); timestamp(unixTimestamp); require(quotaRemaining in 1..policy.quotaMax.toLong())
        hex(messageHex, 2, 2334); hash(messageSha256); require(packetBytes in 66..1232 && packetBytes == 65L + messageHex.length / 2 && messageHex.startsWith("01"))
        require(rents.size in 1..3 && rents.size == 1 + (if (needsAccess) 1 else 0) + (if (needsQuota) 1 else 0))
        require(rents.map { it.address }.distinct().size == rents.size); rents.forEach { it.validate() }
        listOf(feeLamports, rentLamports, paymentDebitLamports, requiredLamports, payerLamports).forEach { amount(it) }
    }
}
@Serializable data class RealmSalePreparation(val version: Int, val wallet: String, val idempotencyKey: String, val saleId: String,
    val spot: Long, val realm: Long, val terms: RealmSaleTerms, val source: RealmSaleSource, val quote: RealmSaleQuote,
    val state: String, val currentSigningAuthorized: Boolean, val submissionAuthorized: Boolean) {
    fun validate(policy: RealmSalesProtocolPolicy) {
        policy.validate(); require(version == policy.version && state == "prepared" && !currentSigningAuthorized && !submissionAuthorized)
        address(wallet); uuid(idempotencyKey); saleId(saleId); spotRealm(spot, realm, policy); terms.validate(); source.validate(); quote.validate(policy)
        val day = amount(terms.day); val after = timestamp(terms.validAfter); val until = timestamp(terms.validUntil)
        val prior = timestamp(terms.priorExpiry); val now = timestamp(quote.unixTimestamp); val daySeconds = policy.daySec.toBigInteger()
        val dayEnd = (day + BigInteger.ONE) * daySeconds - BigInteger.ONE; val latest = until.min(dayEnd)
        require(dayEnd <= i64Max && until >= after && until - after <= policy.quoteTtlSec.toBigInteger() && after <= dayEnd && until >= day * daySeconds && now in after..until)
        require(prior.max(latest) + policy.permitDurationSec.toBigInteger() <= i64Max)
        val rent = quote.rents.fold(BigInteger.ZERO) { n, r -> n + amount(r.maxIncreaseLamports) }
        val price = policy.permitPriceLamports.toBigInteger(); val seller = price * policy.sellerBps.toBigInteger() / policy.basisPoints.toBigInteger()
        val developer = price * policy.developerBps.toBigInteger() / policy.basisPoints.toBigInteger()
        val payment = price - (if (terms.seller == wallet) seller else BigInteger.ZERO) - (if (terms.developer == wallet) developer else BigInteger.ZERO)
        val required = payment + rent + amount(quote.feeLamports)
        require(rent == amount(quote.rentLamports) && payment == amount(quote.paymentDebitLamports) && required == amount(quote.requiredLamports) && required <= amount(quote.payerLamports))
    }
    private fun owned() = copy(quote = quote.copy(rents = owned(quote.rents)))
    companion object { fun from(raw: JsonObject, policy: RealmSalesProtocolPolicy) = decode(raw, serializer()).also { it.validate(policy) }.owned() }
}
@Serializable data class RealmSalePreparationEnvelope(val wallet: String, val idempotencyKey: String, val preparation: RealmSalePreparation?) {
    companion object { fun from(raw: JsonObject, policy: RealmSalesProtocolPolicy): RealmSalePreparationEnvelope {
        val value = decode(raw, serializer()); address(value.wallet); uuid(value.idempotencyKey)
        val preparation = raw["preparation"]?.takeUnless { it == JsonNull }?.let { RealmSalePreparation.from(it.jsonObject, policy) }
        require(preparation == null || preparation.wallet == value.wallet && preparation.idempotencyKey == value.idempotencyKey)
        return value.copy(preparation = preparation)
    } }
}
@Serializable data class RealmSaleSignedWire(val wallet: String, val idempotencyKey: String, val saleId: String,
    val signature: String, val signedTransactionHex: String, val wireSha256: String, val messageSha256: String,
    val acceptedAt: String, val currentSigningAuthorized: Boolean, val relayAuthorized: Boolean) {
    fun validate() {
        address(wallet); uuid(idempotencyKey); saleId(saleId); signature(signature); hex(signedTransactionHex, 132, 2464)
        hash(wireSha256); hash(messageSha256); instant(acceptedAt); require(!currentSigningAuthorized && !relayAuthorized)
        require(signedTransactionHex.startsWith("01") && signedTransactionHex.substring(130, 132) == "01" && signedTransactionHex.substring(2, 130) != "00".repeat(64))
    }
    companion object { fun from(raw: JsonObject) = decode(raw, serializer()).also { it.validate() } }
}
@Serializable data class RealmSaleObservedRent(val address: String, val lamports: String) {
    fun validate() { address(address); amount(lamports) }
}
@Serializable data class RealmSaleReview(val version: Int, val saleId: String, val wallet: String, val idempotencyKey: String,
    val messageSha256: String, val sourceRevision: String, val snapshotHash: String, val quoteSlot: Long, val unixTimestamp: String,
    val validUntil: String, val feeSlot: Long, val bracketSlot: Long, val blockHeight: Long, val feeLamports: String,
    val rentLamports: String, val paymentDebitLamports: String, val requiredLamports: String, val payerLamports: String,
    val quotaRemaining: Long, val rents: List<RealmSaleObservedRent>, val admissionEligible: Boolean, val signingAuthorized: Boolean,
    val paymentAuthorized: Boolean, val submissionAuthorized: Boolean, val reservation: Boolean) {
    fun validate(preparation: RealmSalePreparation, policy: RealmSalesProtocolPolicy) {
        preparation.validate(policy); require(version == policy.version && admissionEligible && !signingAuthorized && !paymentAuthorized && !submissionAuthorized && !reservation)
        saleId(saleId); address(wallet); uuid(idempotencyKey); hash(messageSha256); hash(snapshotHash); revision(sourceRevision)
        listOf(quoteSlot, feeSlot, bracketSlot, blockHeight).forEach(::count); require(quoteSlot <= feeSlot && feeSlot <= bracketSlot)
        require(timestamp(unixTimestamp) <= timestamp(validUntil) && quotaRemaining in 1..policy.quotaMax.toLong())
        require(rents.size in 1..3 && rents.map { it.address }.distinct().size == rents.size); rents.forEach { it.validate() }
        val rent = rents.fold(BigInteger.ZERO) { n, r -> n + amount(r.lamports) }; val required = rent + amount(feeLamports) + amount(paymentDebitLamports)
        require(rent == amount(rentLamports) && required == amount(requiredLamports) && required <= amount(payerLamports))
        val p = preparation; val q = p.quote; val now = timestamp(unixTimestamp)
        require(wallet == p.wallet && idempotencyKey == p.idempotencyKey && saleId == p.saleId && messageSha256 == q.messageSha256 && sourceRevision == p.source.revision && validUntil == p.terms.validUntil)
        require(now / policy.daySec.toBigInteger() == amount(p.terms.day) && now in timestamp(p.terms.validAfter)..timestamp(p.terms.validUntil) && quoteSlot >= p.source.admissionSlot && blockHeight <= q.lastValidBlockHeight)
        val caps = q.rents.associate { it.address to amount(it.maxIncreaseLamports) }; require(rents.size == caps.size)
        rents.forEach { require(amount(it.lamports) <= requireNotNull(caps[it.address])) }
        require(paymentDebitLamports == q.paymentDebitLamports && amount(feeLamports) <= amount(q.feeLamports) && rent <= amount(q.rentLamports) && required <= amount(q.requiredLamports))
    }
    companion object { fun from(preparation: RealmSalePreparation, raw: JsonObject, policy: RealmSalesProtocolPolicy) =
        decode(raw, serializer()).also { it.validate(preparation, policy) }.let { it.copy(rents = owned(it.rents)) } }
}
@Serializable data class RealmSaleProofAccount(val address: String, val exists: Boolean, val owner: String, val executable: Boolean, val dataSha256: String) {
    fun validate() { address(address); require(exists); address(owner); hash(dataSha256) }
}
@Serializable data class RealmSaleSettlementSource(val trust: String, val stateProvenance: String, val genesisHash: String,
    val programId: String, val reviewedDeploymentSlot: Long, val reviewedProgramDataSha256: String, val upgradeAuthority: String?, val accounts: List<RealmSaleProofAccount>) {
    fun validate() {
        require(trust == "trusted-finalized-rpc-reviewed-program" && stateProvenance == "fresh-reviewed-deployment")
        address(genesisHash); address(programId); count(reviewedDeploymentSlot); hash(reviewedProgramDataSha256); upgradeAuthority?.let(::address)
        require(accounts.size == 6); accounts.forEach { it.validate() }
    }
}
@Serializable data class RealmSaleSettlementReceipt(val version: Int, val signature: String, val slot: Long, val blockTime: Long?,
    val originalMessageSha256: String, val signedTransactionSha256: String, val receiptAccountHex: String, val feeLamports: String,
    val actualRentLamports: String, val buyerNetPaymentLamports: String, val accountRentIncreases: List<RealmSaleObservedRent>,
    val observedAccountSlot: Long, val proofClockUnixTimestamp: String, val source: RealmSaleSettlementSource) {
    fun validate() {
        require(version == 1); signature(signature); count(slot); blockTime?.let { require(it in -safeInteger..safeInteger) }
        hash(originalMessageSha256); hash(signedTransactionSha256); hex(receiptAccountHex, 588, 588)
        listOf(feeLamports, actualRentLamports, buyerNetPaymentLamports).forEach { amount(it) }
        require(accountRentIncreases.size in 1..3); accountRentIncreases.forEach { it.validate() }
        count(observedAccountSlot); timestamp(proofClockUnixTimestamp); source.validate()
    }
}
@Serializable data class RealmSalePurchase(val address: String, val buyer: String, val seller: String, val developer: String,
    val spot: Long, val realm: Long, val round: String, val day: String, val acceptedAt: String, val priorExpiry: String,
    val coverageStart: String, val expiresAt: String, val priceLamports: String, val sellerLamports: String, val developerLamports: String) {
    fun validate(policy: RealmSalesProtocolPolicy) {
        listOf(address, buyer, seller, developer).forEach(::address); spotRealm(spot, realm, policy)
        listOf(round, day, priceLamports, sellerLamports, developerLamports).forEach { amount(it) }
        listOf(acceptedAt, priorExpiry, coverageStart, expiresAt).forEach(::timestamp)
    }
}
/** The owner asserts purchaseFinalized. This DTO only binds that assertion to original
 * declared bytes/hashes and consent. It never verifies signatures, hashes, PDAs, receipt ABI,
 * or independent chain finality; parsing it cannot authorize journal clearing. */
@Serializable data class RealmSaleSettlement(val wallet: String, val idempotencyKey: String, val saleId: String, val signature: String,
    val receipt: RealmSaleSettlementReceipt, val purchase: RealmSalePurchase, val settledAt: String, val purchaseFinalized: Boolean,
    val admissionAuthorized: Boolean, val relayAuthorized: Boolean, val signingAuthorized: Boolean) {
    fun validate(preparation: RealmSalePreparation, wire: RealmSaleSignedWire, policy: RealmSalesProtocolPolicy) {
        preparation.validate(policy); wire.validate(); address(wallet); uuid(idempotencyKey); saleId(saleId); signature(signature)
        receipt.validate(); purchase.validate(policy); instant(settledAt); require(purchaseFinalized && !admissionAuthorized && !relayAuthorized && !signingAuthorized)
        val p = preparation; val w = wire; val r = receipt; val t = r.source; val q = p.quote; val b = purchase
        require(wallet == p.wallet && idempotencyKey == p.idempotencyKey && saleId == p.saleId && w.wallet == p.wallet && w.idempotencyKey == p.idempotencyKey && w.saleId == p.saleId)
        require(signature == w.signature && r.signature == w.signature && w.messageSha256 == q.messageSha256 && r.originalMessageSha256 == q.messageSha256 && r.signedTransactionSha256 == w.wireSha256 && w.signedTransactionHex.substring(130) == q.messageHex)
        require(t.genesisHash == p.source.genesisHash && t.programId == p.source.programId && t.reviewedDeploymentSlot == p.source.reviewedDeploymentSlot && t.reviewedProgramDataSha256 == p.source.programDataSha256)
        require(r.slot > t.reviewedDeploymentSlot && r.slot >= p.source.admissionSlot && r.observedAccountSlot >= r.slot)
        require(b.buyer == p.wallet && b.seller == p.terms.seller && b.developer == p.terms.developer && b.spot == p.spot && b.realm == p.realm && b.round == p.terms.round && b.day == p.terms.day && b.priorExpiry == p.terms.priorExpiry)
        val accepted = timestamp(b.acceptedAt); val start = accepted.max(timestamp(b.priorExpiry)); val expiry = start + policy.permitDurationSec.toBigInteger()
        require(accepted in timestamp(p.terms.validAfter)..timestamp(p.terms.validUntil) && accepted / policy.daySec.toBigInteger() == amount(p.terms.day) && accepted <= timestamp(r.proofClockUnixTimestamp))
        require(timestamp(b.coverageStart) == start && expiry <= i64Max && timestamp(b.expiresAt) == expiry)
        val price = policy.permitPriceLamports.toBigInteger(); val seller = price * policy.sellerBps.toBigInteger() / policy.basisPoints.toBigInteger(); val developer = price * policy.developerBps.toBigInteger() / policy.basisPoints.toBigInteger()
        require(amount(b.priceLamports) == price && amount(b.sellerLamports) == seller && amount(b.developerLamports) == developer && seller + developer == price && r.buyerNetPaymentLamports == q.paymentDebitLamports)
        require(r.accountRentIncreases.size == q.rents.size && r.accountRentIncreases.map { it.address }.distinct().size == r.accountRentIncreases.size)
        var rent = BigInteger.ZERO
        r.accountRentIncreases.forEachIndexed { i, entry -> val cap = q.rents[i]; require(entry.address == cap.address && amount(entry.lamports) <= amount(cap.maxIncreaseLamports)); rent += amount(entry.lamports) }
        require(rent == amount(r.actualRentLamports) && rent <= amount(q.rentLamports) && amount(r.feeLamports) <= amount(q.feeLamports) && rent + amount(r.feeLamports) + amount(r.buyerNetPaymentLamports) <= amount(q.requiredLamports))
        require(t.accounts.map { it.address }.distinct().size == t.accounts.size)
        t.accounts.forEachIndexed { i, a -> require(a.owner == (if (i < 2) loader else if (i == 4) sysvar else t.programId) && a.executable == (i == 0)) }
        val accounts = t.accounts
        require(accounts[0].address == p.source.programId && accounts[1].dataSha256 == p.source.programDataSha256 && accounts[4].address == clock && accounts[5].address == b.address && b.address == q.rents.last().address)
        require(!q.needsAccess || accounts[3].address == q.rents[0].address)
    }
    companion object { fun from(preparation: RealmSalePreparation, wire: RealmSaleSignedWire, raw: JsonObject, policy: RealmSalesProtocolPolicy) =
        decode(raw, serializer()).also { it.validate(preparation, wire, policy) }.let { it.copy(receipt = it.receipt.copy(
            accountRentIncreases = owned(it.receipt.accountRentIncreases), source = it.receipt.source.copy(accounts = owned(it.receipt.source.accounts)))) } }
}
