package gg.pixelkingdomwars.nativeclient.mining

import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import java.math.BigInteger
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.Base64
import java.util.Collections
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val taxJson = Json { encodeDefaults = true }
private val taxU64 = BigInteger.ONE.shiftLeft(64) - BigInteger.ONE
private val taxI64 = BigInteger.valueOf(Long.MAX_VALUE)
private const val taxSafeInteger = 9_007_199_254_740_991L
private const val taxAlphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

private fun count(v: Long) { require(v in 0..taxSafeInteger) }
private fun amount(v: String, maximum: BigInteger = taxU64): BigInteger {
    require(v.length in 1..20 && v.matches(Regex("0|[1-9][0-9]{0,19}")))
    return v.toBigInteger().also { require(it <= maximum) }
}
private fun timestamp(v: String) = amount(v, taxI64)
private fun base58Hex(v: String, size: Int): String {
    require(v.length in size..(if (size == 32) 44 else 88))
    var n = BigInteger.ZERO
    for (c in v) { val digit = taxAlphabet.indexOf(c); require(digit >= 0); n = n * BigInteger.valueOf(58) + BigInteger.valueOf(digit.toLong()) }
    var hex = if (n.signum() == 0) "" else n.toString(16)
    if (hex.length % 2 != 0) hex = "0$hex"
    hex = "00".repeat(v.takeWhile { it == '1' }.length) + hex
    require(hex.length == size * 2 && n.signum() > 0)
    return hex
}
private fun address(v: String) { base58Hex(v, 32) }
private fun signature(v: String) { base58Hex(v, 64) }
private fun hash(v: String) { require(v.length == 64 && v.matches(Regex("[0-9a-f]{64}"))) }
private fun uuid(v: String) {
    require(v.length == 36 && (v.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) ||
        v == "00000000-0000-0000-0000-000000000000" || v == "ffffffff-ffff-ffff-ffff-ffffffffffff"))
}
private fun hex(v: String, minimum: Int, maximum: Int) { require(v.length in minimum..maximum && v.matches(Regex("(?:[0-9a-f]{2})+"))) }
private fun instant(v: String, digits: Int): Instant {
    require(v.length == 21 + digits && v.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{$digits}Z")))
    return Instant.parse(v).also { require(DateTimeFormatterBuilder().appendInstant(digits).toFormatter().format(it) == v) }
}
private fun kind(v: String) { require(v in setOf("combined", "setup", "claim")) }
private fun <T> owned(values: List<T>): List<T> = Collections.unmodifiableList(ArrayList(values))

/** These bounds constrain the public wire format, never gameplay periods or prices.
 * Check the parsed tree before descriptor walking or allocating decoded lists. */
private fun <T> decode(raw: JsonObject, serializer: DeserializationStrategy<T>): T {
    var nodes = 0
    fun bound(value: JsonElement, depth: Int, field: String?) {
        require(++nodes <= 1024 && depth <= 10)
        when (value) {
            is JsonObject -> { require(value.size <= 40); value.forEach { (key, child) -> require(key.length <= 64); bound(child, depth + 1, key) } }
            is JsonArray -> {
                require(value.size <= when (field) { "transactions", "wires" -> 2; "newAccounts", "accrualDays" -> 10; else -> 0 })
                value.forEach { bound(it, depth + 1, null) }
            }
            is JsonPrimitive -> require(value.content.length <= 2464)
        }
    }
    bound(raw, 0, null); strictPrimitives(raw, serializer.descriptor)
    return taxJson.decodeFromJsonElement(serializer, raw)
}

@Serializable data class MiningTaxClaimsCaps(val maxFeeLamports: String, val maxRentLamports: String, val maxTotalLamports: String) {
    fun validate() { listOf(maxFeeLamports, maxRentLamports, maxTotalLamports).forEach { amount(it) } }
}
@Serializable data class MiningTaxClaimsPrepareRequest(val idempotencyKey: String, val round: String, val spot: Long, val caps: MiningTaxClaimsCaps) {
    /** Current admission bounds come from the canonical catalogue, not this request. */
    fun validate(totalSpots: Int) { require(totalSpots > 0); uuid(idempotencyKey); amount(round); count(spot); require(spot < totalSpots); caps.validate() }
    companion object { fun from(raw: JsonObject, totalSpots: Int) = decode(raw, serializer()).also { it.validate(totalSpots) } }
}
@Serializable data class MiningTaxClaimsIdentity(val genesisHash: String, val programId: String, val configAddress: String,
    val keepMint: String, val reserveOwner: String, val auctionConfig: String, val term: String, val registry: String,
    val registryHash: String, val pool: String, val cursor: String, val auction: String, val claimantAta: String, val originalWinner: String) {
    fun validate() { listOf(genesisHash, programId, configAddress, keepMint, reserveOwner, auctionConfig, term, registry, pool, cursor, auction, claimantAta, originalWinner).forEach(::address); hash(registryHash) }
}
@Serializable data class MiningTaxClaimsTerm(val auctionStart: String, val auctionEnd: String, val operatingStart: String,
    val operatingEnd: String, val completedAt: String, val completedSlot: String, val winnerCount: Long, val distributionVersion: Int) {
    fun validate() { listOf(auctionStart, auctionEnd, operatingStart, operatingEnd, completedAt).forEach(::timestamp); amount(completedSlot); require(winnerCount in 1..65535 && distributionVersion == 1) }
}
@Serializable data class MiningTaxClaimsSource(val genesisHash: String, val programId: String, val reviewedDeploymentSlot: Long,
    val reviewedProgramDataSha256: String, val firstSnapshotSlot: Long, val snapshotSlot: Long, val blockhashSlot: Long,
    val feeSlot: Long, val snapshotSha256: String) {
    fun validate() {
        address(genesisHash); address(programId); hash(reviewedProgramDataSha256); hash(snapshotSha256)
        val slots = listOf(reviewedDeploymentSlot, firstSnapshotSlot, blockhashSlot, feeSlot, snapshotSlot)
        slots.forEach(::count); require(slots.zipWithNext().all { (a, b) -> a <= b })
    }
}
@Serializable data class MiningTaxClaimsSnapshot(val unixTimestamp: String, val claimedBaseUnits: String, val poolAccruedBaseUnits: String) {
    fun validate() { timestamp(unixTimestamp); amount(claimedBaseUnits); amount(poolAccruedBaseUnits) }
}
@Serializable data class MiningTaxClaimsIntended(val claimBaseUnits: String, val cumulativeBaseUnits: String, val dustBaseUnits: String) {
    fun validate() { require(amount(claimBaseUnits).signum() > 0 && amount(cumulativeBaseUnits).signum() > 0); amount(dustBaseUnits) }
}
@Serializable data class MiningTaxClaimsSetup(val needsAta: Boolean, val needsPool: Boolean, val needsCursor: Boolean, val accrualDays: List<String>) {
    fun validate() { require(accrualDays.size <= 10); accrualDays.forEach { amount(it) }; require(accrualDays.zipWithNext().all { (a, b) -> amount(a) < amount(b) }) }
}
@Serializable data class MiningTaxClaimsFees(val feeLamports: String, val rentLamports: String, val totalLamports: String, val payerBalanceLamports: String) {
    fun validate() { listOf(feeLamports, rentLamports, totalLamports, payerBalanceLamports).forEach { amount(it) } }
}
@Serializable data class MiningTaxClaimsNewAccount(val address: String, val space: Long, val rentLamports: String) {
    fun validate() { address(address); require(space in 1..1232); amount(rentLamports) }
}
@Serializable data class MiningTaxClaimsTransaction(val ordinal: Long, val kind: String, val messageHex: String,
    val messageSha256: String, val packetBytes: Long, val feeLamports: String, val rentLamports: String, val newAccounts: List<MiningTaxClaimsNewAccount>) {
    fun validate() {
        require(ordinal in 0..1); kind(kind); hex(messageHex, 2, 2334); hash(messageSha256)
        require(packetBytes in 66..1232 && packetBytes == 65L + messageHex.length / 2 && messageHex.startsWith("01"))
        amount(feeLamports); amount(rentLamports); require(newAccounts.size <= 10); newAccounts.forEach { it.validate() }
        require(newAccounts.fold(BigInteger.ZERO) { n, a -> n + amount(a.rentLamports) } == amount(rentLamports))
        if (kind == "claim") require(newAccounts.isEmpty() && rentLamports == "0")
    }
}
/** Historical consistency only. No hash, signature, PDA, legacy ABI, or finality
 * verification occurs here; a decoded preparation never authorizes signing. */
@Serializable data class MiningTaxClaimsPreparation(val version: Int, val wallet: String, val idempotencyKey: String,
    val claimId: String, val round: String, val spot: Long, val caps: MiningTaxClaimsCaps, val quoteVersion: Int,
    val quoteTtlSec: Long, val preparedAt: String, val expiresAt: String, val identity: MiningTaxClaimsIdentity,
    val term: MiningTaxClaimsTerm, val source: MiningTaxClaimsSource, val snapshot: MiningTaxClaimsSnapshot,
    val intended: MiningTaxClaimsIntended, val setup: MiningTaxClaimsSetup, val blockhash: String, val lastValidBlockHeight: Long,
    val blockHeight: Long, val fees: MiningTaxClaimsFees, val transactions: List<MiningTaxClaimsTransaction>,
    val state: String, val currentSigningAuthorized: Boolean, val submissionAuthorized: Boolean) {
    fun validate() {
        require(version == 1 && quoteVersion == 1 && state == "prepared" && !currentSigningAuthorized && !submissionAuthorized)
        address(wallet); uuid(idempotencyKey); uuid(claimId); amount(round); require(spot in 0..255); caps.validate()
        count(quoteTtlSec); require(quoteTtlSec > 0)
        val start = instant(preparedAt, 3); val end = instant(expiresAt, 3)
        require(end > start && BigInteger.valueOf(end.toEpochMilli()) - BigInteger.valueOf(start.toEpochMilli()) == BigInteger.valueOf(quoteTtlSec) * BigInteger.valueOf(1000))
        identity.validate(); term.validate(); source.validate(); snapshot.validate(); intended.validate(); setup.validate(); fees.validate()
        address(blockhash); count(lastValidBlockHeight); count(blockHeight); require(blockHeight <= lastValidBlockHeight)
        val i = identity; val t = term; val s = source; val n = snapshot; val a = intended
        require(i.originalWinner == wallet && s.genesisHash == i.genesisHash && s.programId == i.programId)
        require(timestamp(t.auctionStart) < timestamp(t.auctionEnd) && t.auctionEnd == t.operatingStart && timestamp(t.operatingStart) < timestamp(t.operatingEnd))
        require(timestamp(t.completedAt) >= timestamp(t.auctionEnd) && timestamp(t.completedAt) <= timestamp(n.unixTimestamp))
        require(amount(t.completedSlot) > BigInteger.valueOf(s.reviewedDeploymentSlot) && amount(t.completedSlot) <= BigInteger.valueOf(s.firstSnapshotSlot))
        val claim = amount(a.claimBaseUnits); val cumulative = amount(a.cumulativeBaseUnits); val dust = amount(a.dustBaseUnits)
        val winners = BigInteger.valueOf(t.winnerCount); val accrued = cumulative * winners + dust
        require(amount(n.claimedBaseUnits) + claim == cumulative && dust < winners && accrued <= taxU64 && accrued >= amount(n.poolAccruedBaseUnits))
        if (setup.accrualDays.isEmpty()) require(accrued == amount(n.poolAccruedBaseUnits))
        if (setup.needsPool) require(setup.needsCursor && n.poolAccruedBaseUnits == "0")
        if (setup.needsCursor) require(n.claimedBaseUnits == "0")
        require(transactions.size in 1..2); transactions.forEach { it.validate() }
        val needsSetup = setup.needsAta || setup.needsPool || setup.needsCursor || setup.accrualDays.isNotEmpty()
        if (transactions.size == 1) require(transactions[0].kind == if (needsSetup) "combined" else "claim")
        else require(needsSetup && transactions[0].kind == "setup" && transactions[1].kind == "claim")
        transactions.forEachIndexed { j, tx -> require(tx.ordinal == j.toLong()) }
        require(transactions.map { it.messageHex }.distinct().size == transactions.size && transactions.map { it.messageSha256 }.distinct().size == transactions.size)
        val accounts = transactions.flatMap { it.newAccounts }
        val expected = (if (setup.needsAta) 1 else 0) + (if (setup.needsPool) 1 else 0) + (if (setup.needsCursor) 1 else 0) + setup.accrualDays.size
        require(accounts.size == expected && accounts.size <= 10 && accounts.map { it.address }.distinct().size == accounts.size)
        var index = 0
        if (setup.needsAta) require(accounts[index++].address == i.claimantAta)
        if (setup.needsPool) require(accounts[index++].address == i.pool)
        index += setup.accrualDays.size
        if (setup.needsCursor) require(accounts[index].address == i.cursor)
        val fee = transactions.fold(BigInteger.ZERO) { total, tx -> total + amount(tx.feeLamports) }
        val rent = transactions.fold(BigInteger.ZERO) { total, tx -> total + amount(tx.rentLamports) }
        require(fee == amount(fees.feeLamports) && rent == amount(fees.rentLamports) && fee + rent == amount(fees.totalLamports))
        require(fee <= amount(caps.maxFeeLamports) && rent <= amount(caps.maxRentLamports) && fee + rent <= amount(caps.maxTotalLamports) && fee + rent <= amount(fees.payerBalanceLamports))
    }
    internal fun owned() = copy(setup = setup.copy(accrualDays = owned(setup.accrualDays)), transactions = owned(transactions.map { it.copy(newAccounts = owned(it.newAccounts)) }))
    companion object { fun from(raw: JsonObject) = decode(raw, serializer()).also { it.validate() }.owned() }
}
@Serializable data class MiningTaxClaimsPreparationEnvelope(val wallet: String, val idempotencyKey: String,
    val status: String, val preparation: MiningTaxClaimsPreparation?, val serverNow: String) {
    fun validate() {
        address(wallet); uuid(idempotencyKey); instant(serverNow, 3); require(status in setOf("unknown", "prepared"))
        require((status == "unknown") == (preparation == null)); preparation?.let { it.validate(); require(it.wallet == wallet && it.idempotencyKey == idempotencyKey) }
    }
    companion object { fun from(raw: JsonObject) = decode(raw, serializer()).also { it.validate() }.let { it.copy(preparation = it.preparation?.owned()) } }
}
@Serializable data class MiningTaxClaimsSignedWire(val wallet: String, val idempotencyKey: String, val claimId: String,
    val ordinal: Long, val kind: String, val signature: String, val signedTransactionHex: String, val wireSha256: String,
    val messageSha256: String, val acceptedAt: String, val currentSigningAuthorized: Boolean, val relayAuthorized: Boolean, val settlementAuthorized: Boolean) {
    fun validate() {
        address(wallet); uuid(idempotencyKey); uuid(claimId); require(ordinal in 0..1); kind(kind); signature(signature)
        hex(signedTransactionHex, 132, 2464); hash(wireSha256); hash(messageSha256); instant(acceptedAt, 6)
        require(!currentSigningAuthorized && !relayAuthorized && !settlementAuthorized)
        require(signedTransactionHex.startsWith("01") && signedTransactionHex.substring(2, 130) == base58Hex(signature, 64))
    }
    companion object { fun from(raw: JsonObject) = decode(raw, serializer()).also { it.validate() } }
}
@Serializable data class MiningTaxClaimsObservation(val kind: String, val signature: String, val slot: Long, val blockTime: Long,
    val observedAccountSlot: Long, val messageSha256: String, val signedTransactionSha256: String, val paidKeepBaseUnits: String,
    val feeLamports: String, val rentLamports: String, val currentPoolAccrued: String, val currentPoolPaid: String,
    val currentClaimedTotal: String, val currentGlobalTaxPaid: String, val claimedCumulativeBaseUnits: String?,
    val poolPaidAfterClaimBaseUnits: String?, val globalTaxPaidAfterClaimBaseUnits: String?) {
    fun validate() {
        kind(kind); signature(signature); listOf(slot, blockTime, observedAccountSlot).forEach(::count); hash(messageSha256); hash(signedTransactionSha256)
        listOf(paidKeepBaseUnits, feeLamports, rentLamports, currentPoolAccrued, currentPoolPaid, currentClaimedTotal, currentGlobalTaxPaid,
            claimedCumulativeBaseUnits, poolPaidAfterClaimBaseUnits, globalTaxPaidAfterClaimBaseUnits).filterNotNull().forEach { amount(it) }
        require(amount(currentPoolPaid) <= amount(currentPoolAccrued) && amount(currentClaimedTotal) <= amount(currentPoolPaid) && amount(currentPoolPaid) <= amount(currentGlobalTaxPaid))
        if (kind == "setup") require(paidKeepBaseUnits == "0" && claimedCumulativeBaseUnits == null && poolPaidAfterClaimBaseUnits == null && globalTaxPaidAfterClaimBaseUnits == null)
        else {
            val claimed = amount(requireNotNull(claimedCumulativeBaseUnits)); val pool = amount(requireNotNull(poolPaidAfterClaimBaseUnits)); val global = amount(requireNotNull(globalTaxPaidAfterClaimBaseUnits))
            require(amount(paidKeepBaseUnits).signum() > 0 && amount(paidKeepBaseUnits) <= claimed && claimed <= pool && pool <= global)
            require(claimed <= amount(currentClaimedTotal) && pool <= amount(currentPoolPaid) && global <= amount(currentGlobalTaxPaid))
        }
    }
}
@Serializable data class MiningTaxClaimsReceiptSource(val trust: String, val genesisHash: String, val programId: String,
    val reviewedDeploymentSlot: Long, val reviewedProgramDataSha256: String, val originalTermContextSlot: Long,
    val observedAccountSlot: Long, val observedClockUnixTimestamp: String) {
    fun validate() {
        require(trust == "trusted-finalized-rpc-reviewed-program"); address(genesisHash); address(programId); hash(reviewedProgramDataSha256)
        listOf(reviewedDeploymentSlot, originalTermContextSlot, observedAccountSlot).forEach(::count); timestamp(observedClockUnixTimestamp)
        require(originalTermContextSlot in reviewedDeploymentSlot..observedAccountSlot)
    }
}
/** finalityAuthenticated is the server's assertion. Parsing only binds declared
 * evidence; independent client cryptography and archival permission remain absent. */
@Serializable data class MiningTaxClaimsFinalizedReceipt(val version: Int, val phase: String, val wallet: String, val round: String,
    val spot: Long, val term: String, val pool: String, val cursor: String, val paidKeepBaseUnits: String, val feeLamports: String,
    val rentLamports: String, val transactions: List<MiningTaxClaimsObservation>, val source: MiningTaxClaimsReceiptSource,
    val finalityAuthenticated: Boolean, val currentClaimsAuthorized: Boolean, val signingAuthorized: Boolean,
    val broadcastAuthorized: Boolean, val journalClearingAuthorized: Boolean) {
    fun validate() {
        require(version == 1 && phase in setOf("setup", "settled") && finalityAuthenticated && !currentClaimsAuthorized && !signingAuthorized && !broadcastAuthorized && !journalClearingAuthorized)
        listOf(wallet, term, pool, cursor).forEach(::address); amount(round); require(spot in 0..255)
        listOf(paidKeepBaseUnits, feeLamports, rentLamports).forEach { amount(it) }; source.validate()
        require(transactions.size in 1..2); transactions.forEach { it.validate() }
        require(transactions.map { it.signature }.distinct().size == transactions.size)
        var previousSlot = 0L
        for (tx in transactions) {
            require(tx.slot >= previousSlot && tx.slot > source.reviewedDeploymentSlot && tx.observedAccountSlot == source.observedAccountSlot && tx.observedAccountSlot >= tx.slot)
            require(BigInteger.valueOf(tx.blockTime) <= timestamp(source.observedClockUnixTimestamp)); previousSlot = tx.slot
        }
        val fee = transactions.fold(BigInteger.ZERO) { sum, tx -> sum + amount(tx.feeLamports) }
        val rent = transactions.fold(BigInteger.ZERO) { sum, tx -> sum + amount(tx.rentLamports) }
        val paid = transactions.fold(BigInteger.ZERO) { sum, tx -> sum + amount(tx.paidKeepBaseUnits) }
        require(fee == amount(feeLamports) && rent == amount(rentLamports) && paid == amount(paidKeepBaseUnits) && fee + rent <= taxU64)
        if (phase == "setup") require(transactions.size == 1 && transactions[0].kind == "setup" && paid.signum() == 0)
        else {
            require(paid.signum() > 0)
            if (transactions.size == 1) require(transactions[0].kind != "setup")
            else require(transactions[0].kind == "setup" && transactions[1].kind == "claim")
        }
    }
    internal fun owned() = copy(transactions = owned(transactions))
    companion object { fun from(raw: JsonObject) = decode(raw, serializer()).also { it.validate() }.owned() }
}
@Serializable data class MiningTaxClaimsSettlement(val wallet: String, val idempotencyKey: String, val claimId: String,
    val ordinal: Long, val receipt: MiningTaxClaimsFinalizedReceipt, val settledAt: String, val claimFinalized: Boolean) {
    fun validate() {
        address(wallet); uuid(idempotencyKey); uuid(claimId); require(ordinal in 0..1); receipt.validate(); instant(settledAt, 6)
        require(wallet == receipt.wallet && ordinal == receipt.transactions.size.toLong() - 1 && claimFinalized == (receipt.phase == "settled"))
    }
    internal fun owned() = copy(receipt = receipt.owned())
    companion object { fun from(raw: JsonObject) = decode(raw, serializer()).also { it.validate() }.owned() }
}
@Serializable data class MiningTaxClaimsRecoveryEnvelope(val wallet: String, val idempotencyKey: String, val claimId: String?,
    val status: String, val preparation: MiningTaxClaimsPreparation?, val wires: List<MiningTaxClaimsSignedWire>,
    val settlement: MiningTaxClaimsSettlement?, val serverNow: String) {
    fun validate() {
        address(wallet); uuid(idempotencyKey); claimId?.let(::uuid); instant(serverNow, 3)
        require(status in setOf("unknown", "prepared", "signed", "setup", "settled") && wires.size <= 2)
        wires.forEach { it.validate() }; settlement?.validate()
        val p = preparation
        if (p == null) { require(claimId == null && status == "unknown" && wires.isEmpty() && settlement == null); return }
        p.validate(); require(p.wallet == wallet && p.idempotencyKey == idempotencyKey && p.claimId == claimId)
        require(status == (settlement?.receipt?.phase ?: if (wires.isNotEmpty()) "signed" else "prepared"))
        var previousOrdinal = -1L
        for (w in wires) {
            val tx = requireNotNull(p.transactions.getOrNull(w.ordinal.toInt()))
            require(w.wallet == wallet && w.idempotencyKey == idempotencyKey && w.claimId == claimId && tx.kind == w.kind && w.ordinal > previousOrdinal)
            require(w.messageSha256 == tx.messageSha256 && w.signedTransactionHex.length.toLong() == tx.packetBytes * 2 && w.signedTransactionHex.substring(130) == tx.messageHex)
            previousOrdinal = w.ordinal
        }
        val s = settlement ?: return; val r = s.receipt; val source = r.source
        require(s.wallet == wallet && s.idempotencyKey == idempotencyKey && s.claimId == claimId && r.wallet == p.wallet && r.round == p.round && r.spot == p.spot)
        require(r.term == p.identity.term && r.pool == p.identity.pool && r.cursor == p.identity.cursor)
        require(source.genesisHash == p.source.genesisHash && source.programId == p.source.programId && source.reviewedDeploymentSlot == p.source.reviewedDeploymentSlot && source.reviewedProgramDataSha256 == p.source.reviewedProgramDataSha256)
        if (r.phase == "setup") require(p.transactions.size == 2 && s.ordinal == 0L) else require(r.transactions.size == p.transactions.size)
        r.transactions.forEachIndexed { ordinal, t ->
            val tx = p.transactions[ordinal]; val w = requireNotNull(wires.find { it.ordinal == ordinal.toLong() })
            require(t.kind == tx.kind && t.signature == w.signature && t.messageSha256 == tx.messageSha256 && t.signedTransactionSha256 == w.wireSha256)
            require(t.slot >= p.source.snapshotSlot && t.slot >= p.source.blockhashSlot && BigInteger.valueOf(t.blockTime) >= timestamp(p.snapshot.unixTimestamp))
            if (t.kind != "setup") require(t.paidKeepBaseUnits == p.intended.claimBaseUnits && t.claimedCumulativeBaseUnits == p.intended.cumulativeBaseUnits)
        }
        // Quoted costs are measurements. Finalized costs may rise within explicit saved consent.
        val fee = amount(r.feeLamports); val rent = amount(r.rentLamports)
        require(fee <= amount(p.caps.maxFeeLamports) && rent <= amount(p.caps.maxRentLamports) && fee + rent <= amount(p.caps.maxTotalLamports))
        require(r.paidKeepBaseUnits == if (r.phase == "setup") "0" else p.intended.claimBaseUnits)
    }
    companion object { fun from(raw: JsonObject) = decode(raw, serializer()).also { it.validate() }.let {
        it.copy(preparation = it.preparation?.owned(), wires = owned(it.wires), settlement = it.settlement?.owned())
    } }
}
@Serializable data class MiningTaxClaimsSubmitRequest(val idempotencyKey: String, val signedTransaction: String) {
    fun validate() {
        uuid(idempotencyKey)
        require(signedTransaction.length in 88..1644 && signedTransaction.length % 4 == 0)
        require(signedTransaction.matches(Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")))
        val bytes = Base64.getDecoder().decode(signedTransaction)
        require(bytes.size in 66..1232 && Base64.getEncoder().encodeToString(bytes) == signedTransaction)
    }
    companion object { fun from(raw: JsonObject) = decode(raw, serializer()).also { it.validate() } }
}
