package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import gg.pixelkingdomwars.nativeclient.mining.*
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.util.Base64
import java.util.Collections
import org.bouncycastle.math.ec.rfc8032.Ed25519

/** Application configuration, never learned from an untrusted API response. */
data class MiningTaxClaimsSigningTrust(val genesisHash: String, val programId: String, val configAddress: String,
    val keepMint: String, val reserveOwner: String, val reviewedDeploymentSlot: Long, val reviewedProgramDataSha256: String)
/** Canonical epoch day unit. The caller supplies the catalogue value associated
 * with saved history, not a current duration override or a response-selected value. */
data class MiningTaxClaimsSigningPolicy(val daySec: Long) {
    fun validate() { require(daySec in 1..9_007_199_254_740_991L) }
}
data class SignedMiningTaxClaims(val ordinal: Int, val wire: String, val signature: String, val messageSha256: String, val wireSha256: String)
data class MiningTaxClaimsLocalWire(val ordinal: Int, val wire: String, val signature: String, val messageSha256: String, val wireSha256: String)
data class MiningTaxClaimsLocalEvidence(val wallet: String, val request: MiningTaxClaimsPrepareRequest,
    val preparation: MiningTaxClaimsPreparation, val wires: List<MiningTaxClaimsLocalWire>)

/** Opaque checked bytes only. This cannot establish current admission, setup
 * finality, signing permission, or relay permission, and has no wallet port. */
class PreparedMiningTaxClaims internal constructor(val wallet: String, val ordinal: Int, message: ByteArray) {
    private val message = message.copyOf()
    val signingAuthorized = false
    val broadcastAuthorized = false
    fun unsignedTransaction(): ByteArray = byteArrayOf(1) + ByteArray(64) + message
    fun verifySigned(bytes: ByteArray): SignedMiningTaxClaims {
        require(bytes.size in 66..1232 && bytes.size == message.size + 65 && bytes[0] == 1.toByte()) { "Invalid tax signed packet" }
        val wire = bytes.copyOf()
        require(wire.copyOfRange(65, wire.size).contentEquals(message)) { "The wallet changed the tax message" }
        val signature = wire.copyOfRange(1, 65)
        require(Ed25519.verify(signature, 0, realmSaleKey(wallet), 0, message, 0, message.size)) { "Invalid tax claimant signature" }
        return SignedMiningTaxClaims(ordinal, Base64.getEncoder().encodeToString(wire), base58(signature), realmSaleHash(message), realmSaleHash(wire))
    }
    fun verifySignedBase64(wire: String): SignedMiningTaxClaims {
        require(wire.length in 88..1644 && wire.length % 4 == 0 && wire.matches(Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")))
        val bytes = Base64.getDecoder().decode(wire)
        require(bytes.size in 66..1232 && Base64.getEncoder().encodeToString(bytes) == wire)
        return verifySigned(bytes)
    }
}
/** This result binds an owner assertion to saved local bytes. It is not raw
 * chain account/CPI verification or a durable journal archival decision. */
class BoundMiningTaxClaimsSettlement internal constructor(val phase: String, val recovery: MiningTaxClaimsRecoveryEnvelope) {
    val nativeFinalityVerified = false
    val currentSigningAuthorized = false
    val broadcastAuthorized = false
    val journalClearingAuthorized = false
}

object MiningTaxClaimsCrypto {
    private val token = realmSaleKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    private val ataProgram = realmSaleKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    private val system = ByteArray(32)
    // Reviewed Anchor/SPL ABI discriminators, sizes and seeds, not gameplay tuning.
    private val openPool = realmSaleHex("7e95e72e81236bff", 8, 8)
    private val openSpot = realmSaleHex("a2c9ed6e7bb1396b", 8, 8)
    private val accrue = realmSaleHex("ec79c0ddc226abcd", 8, 8)
    private val claim = realmSaleHex("fb9ef7ba9c038896", 8, 8)

    suspend fun prepare(preparation: MiningTaxClaimsPreparation, trust: MiningTaxClaimsSigningTrust,
        policy: MiningTaxClaimsSigningPolicy, ordinal: Int = 0): PreparedMiningTaxClaims {
        val p = ownPreparation(preparation); val pins = trust.copy(); val rules = policy.copy().also { it.validate() }
        checkTrust(p, pins)
        return canonical(p, rules, ordinal)
    }

    /** Historical byte integrity without fresh eligibility or quote expiry checks.
     * Call prepare/bindSettlement with independent trust for deployment binding. */
    suspend fun verifySigned(preparation: MiningTaxClaimsPreparation, wire: String,
        policy: MiningTaxClaimsSigningPolicy, ordinal: Int = 0): SignedMiningTaxClaims {
        val p = ownPreparation(preparation); val rules = policy.copy().also { it.validate() }
        require(wire.length in 88..1644)
        return canonical(p, rules, ordinal).verifySignedBase64(wire)
    }

    suspend fun bindSettlement(original: MiningTaxClaimsLocalEvidence, recovery: MiningTaxClaimsRecoveryEnvelope,
        trust: MiningTaxClaimsSigningTrust, policy: MiningTaxClaimsSigningPolicy): BoundMiningTaxClaimsSettlement {
        // Copy every collection and bound untrusted values before PDA derivation can suspend.
        val local = ownLocal(original); val r = ownRecovery(recovery); val pins = trust.copy(); val rules = policy.copy().also { it.validate() }
        val p = local.preparation; val settlement = requireNotNull(r.settlement) { "No finalized owner attestation" }
        require(r.status in setOf("setup", "settled") && r.preparation == p && r.wallet == local.wallet) { "Saved tax consent differs" }
        checkTrust(p, pins)
        val localWires = local.wires.associateBy { it.ordinal }; val serverWires = r.wires.associateBy { it.ordinal.toInt() }
        for (ordinal in 0..settlement.ordinal.toInt()) require(localWires.containsKey(ordinal) && serverWires.containsKey(ordinal)) { "Missing local signed prefix" }
        for (server in r.wires) {
            val saved = localWires[server.ordinal.toInt()] ?: continue
            require(saved.wire == Base64.getEncoder().encodeToString(realmSaleHex(server.signedTransactionHex, 66, 1232)) &&
                saved.signature == server.signature && saved.messageSha256 == server.messageSha256 && saved.wireSha256 == server.wireSha256) { "Tax custody differs from local signed bytes" }
        }
        // Canonical reconstruction checks all messages even if only setup settled.
        val messages = canonicalMessages(p, rules)
        fun verify(ordinal: Int, wire: String, signature: String, messageHash: String, wireHash: String) {
            val checked = PreparedMiningTaxClaims(p.wallet, ordinal, messages[ordinal]).verifySignedBase64(wire)
            require(checked.signature == signature && checked.messageSha256 == messageHash && checked.wireSha256 == wireHash) { "Tax signature or digest differs" }
        }
        for (w in local.wires) verify(w.ordinal, w.wire, w.signature, w.messageSha256, w.wireSha256)
        for (w in r.wires) verify(w.ordinal.toInt(), Base64.getEncoder().encodeToString(realmSaleHex(w.signedTransactionHex, 66, 1232)), w.signature, w.messageSha256, w.wireSha256)
        // The strict DTO already binds receipt counters/costs to this signed prefix.
        // Its source snapshot and finality claims remain owner attestations.
        return BoundMiningTaxClaimsSettlement(r.status, r)
    }

    private fun checkTrust(p: MiningTaxClaimsPreparation, t: MiningTaxClaimsSigningTrust) {
        listOf(t.genesisHash, t.programId, t.configAddress, t.keepMint, t.reserveOwner).forEach(::realmSaleKey)
        require(t == MiningTaxClaimsSigningTrust(p.identity.genesisHash, p.identity.programId, p.identity.configAddress,
            p.identity.keepMint, p.identity.reserveOwner, p.source.reviewedDeploymentSlot, p.source.reviewedProgramDataSha256)) { "Tax deployment does not match application pins" }
    }
    private suspend fun canonical(p: MiningTaxClaimsPreparation, policy: MiningTaxClaimsSigningPolicy, ordinal: Int): PreparedMiningTaxClaims {
        require(ordinal in p.transactions.indices)
        return PreparedMiningTaxClaims(p.wallet, ordinal, canonicalMessages(p, policy)[ordinal])
    }
    private suspend fun canonicalMessages(p: MiningTaxClaimsPreparation, policy: MiningTaxClaimsSigningPolicy): List<ByteArray> {
        val i = p.identity; val program = realmSaleKey(i.programId); val wallet = realmSaleKey(p.wallet); val mint = realmSaleKey(i.keepMint)
        require(Ed25519.validatePublicKeyFull(wallet, 0) && p.term.winnerCount <= 255) { "Invalid tax claimant or term ABI" }
        suspend fun pda(seed: String, vararg tails: ByteArray) = realmSalePda(program, seed, *tails).bytes
        suspend fun ata(owner: ByteArray) = ProgramDerivedAddress.find(listOf(owner, token, mint), SolanaPublicKey(ataProgram)).getOrThrow().bytes
        val config = pda("economy"); val auctionConfig = pda("auction_config"); val registry = pda("seeker_registry")
        val term = pda("seeker_term", auctionConfig, realmSaleLe(p.round)); val pool = pda("mining_tax_pool", config, term)
        val cursor = pda("mining_tax_spot", pool, byteArrayOf(p.spot.toByte()))
        val auction = pda("auction", auctionConfig, byteArrayOf(p.spot.toByte()), realmSaleLe(p.round))
        val destination = ata(wallet); val vault = ata(config)
        val roles = listOf(wallet, program, mint, config, auctionConfig, registry, term, pool, cursor, auction, destination, vault, system, token, ataProgram)
        require(roles.map(::base58).distinct().size == roles.size) { "Tax instruction roles may not alias" }
        // reserveOwner is not an instruction operand and may be the claimant.
        for ((saved, expected) in listOf(i.configAddress to config, i.auctionConfig to auctionConfig, i.registry to registry,
            i.term to term, i.pool to pool, i.cursor to cursor, i.auction to auction, i.claimantAta to destination))
            require(saved == base58(expected)) { "Tax PDA differs from saved identity" }
        val dayUnit = BigInteger.valueOf(policy.daySec)
        for (day in p.setup.accrualDays) {
            val start = BigInteger(day) * dayUnit; val end = start + dayUnit
            require(start.signum() > 0 && start >= BigInteger(p.term.operatingStart) && start >= BigInteger(p.term.completedAt) &&
                end <= BigInteger(p.term.operatingEnd) && end <= BigInteger(p.snapshot.unixTimestamp)) { "Tax accrual lies outside saved term" }
        }
        fun meta(key: ByteArray, writable: Boolean = false, signer: Boolean = false) = AccountMeta(key, signer, writable)
        val payer = meta(wallet, true, true); val systemMeta = meta(system)
        val common = listOf(meta(config), meta(auctionConfig), meta(registry), meta(term))
        val setup = mutableListOf<Instruction>(); val accounts = mutableListOf<Pair<String, Long>>()
        if (p.setup.needsAta) {
            setup += Instruction(ataProgram, listOf(payer, meta(destination, true), meta(wallet), meta(mint), systemMeta, meta(token)), byteArrayOf(1))
            accounts += base58(destination) to 165L
        }
        if (p.setup.needsPool) {
            setup += Instruction(program, listOf(payer) + common + listOf(meta(pool, true), systemMeta), openPool)
            accounts += base58(pool) to 125L
        }
        for (day in p.setup.accrualDays) {
            val epoch = pda("mining_epoch", realmSaleLe(day)); val accrual = pda("mining_tax_epoch", config, epoch)
            setup += Instruction(program, listOf(payer) + common + listOf(meta(pool, true), meta(epoch), meta(accrual, true), systemMeta), accrue)
            accounts += base58(accrual) to 123L
        }
        if (p.setup.needsCursor) {
            setup += Instruction(program, listOf(payer) + common + listOf(meta(pool), meta(auction), meta(cursor, true), systemMeta), openSpot)
            accounts += base58(cursor) to 116L
        }
        // claim_mining_tax has no amount argument. Static crypto does not audit the
        // server snapshot's economic truth; current payout facts require fresh admission.
        val claimInstruction = Instruction(program, listOf(meta(wallet, signer = true), meta(config, true)) + common.drop(1) +
            listOf(meta(pool, true), meta(auction), meta(cursor, true), meta(vault, true), meta(destination, true), meta(mint), meta(token)), claim)
        val blockhash = realmSaleKey(p.blockhash)
        val combined = compileTaxMessage(wallet, blockhash, setup + claimInstruction)
        val messages = if (combined.size + 65 > 1232) listOf(compileTaxMessage(wallet, blockhash, setup), compileTaxMessage(wallet, blockhash, listOf(claimInstruction))) else listOf(combined)
        require(messages.size == p.transactions.size) { "Tax packet splitting changed" }
        messages.forEachIndexed { ordinal, message ->
            val tx = p.transactions[ordinal]; val expectedAccounts = if (ordinal == 0) accounts else emptyList()
            require(message.size + 65 <= 1232 && tx.packetBytes == message.size + 65L &&
                realmSaleHex(tx.messageHex, 1, 1167).contentEquals(message) && tx.messageSha256 == realmSaleHash(message)) { "Tax message differs from canonical ABI" }
            require(tx.newAccounts.map { it.address to it.space } == expectedAccounts) { "Tax allocation roster changed" }
        }
        return messages
    }
}

private fun <T> ownedTax(values: List<T>): List<T> = Collections.unmodifiableList(ArrayList(values))
private fun ownPreparation(p: MiningTaxClaimsPreparation): MiningTaxClaimsPreparation {
    require(p.transactions.size in 1..2 && p.setup.accrualDays.size <= 10)
    for (tx in p.transactions) require(tx.newAccounts.size <= 10)
    return p.copy(setup = p.setup.copy(accrualDays = ownedTax(p.setup.accrualDays)),
        transactions = ownedTax(p.transactions.map { it.copy(newAccounts = ownedTax(it.newAccounts)) })).also { it.validate() }
}
private fun ownRecovery(r: MiningTaxClaimsRecoveryEnvelope): MiningTaxClaimsRecoveryEnvelope {
    require(r.wires.size <= 2); r.settlement?.let { require(it.receipt.transactions.size in 1..2) }
    return r.copy(preparation = r.preparation?.let(::ownPreparation), wires = ownedTax(r.wires),
        settlement = r.settlement?.let { it.copy(receipt = it.receipt.copy(transactions = ownedTax(it.receipt.transactions))) }).also { it.validate() }
}
private fun ownLocal(value: MiningTaxClaimsLocalEvidence): MiningTaxClaimsLocalEvidence {
    require(value.wires.size <= 2)
    val p = ownPreparation(value.preparation); val request = value.request.copy(caps = value.request.caps.copy())
    require(value.wallet == p.wallet && request == MiningTaxClaimsPrepareRequest(p.idempotencyKey, p.round, p.spot, p.caps)) { "Saved local tax intent differs" }
    val wires = ownedTax(value.wires.map { w ->
        require(w.ordinal in p.transactions.indices && w.wire.length in 88..1644 && w.signature.length in 64..88)
        require(w.messageSha256.matches(Regex("[0-9a-f]{64}")) && w.wireSha256.matches(Regex("[0-9a-f]{64}")))
        w.copy()
    })
    require(wires.zipWithNext().all { (a, b) -> a.ordinal < b.ordinal }) { "Local tax custody must be an ordered set" }
    return MiningTaxClaimsLocalEvidence(value.wallet, request, p, wires)
}

/** web3 TransactionMessage legacy ordering: first occurrence per privilege class. */
private fun compileTaxMessage(wallet: ByteArray, blockhash: ByteArray, instructions: List<Instruction>): ByteArray {
    val keys = linkedMapOf<String, AccountMeta>()
    fun add(meta: AccountMeta) {
        val key = base58(meta.key); val old = keys[key]
        keys[key] = if (old == null) meta else old.copy(signer = old.signer || meta.signer, writable = old.writable || meta.writable)
    }
    add(AccountMeta(wallet, true, true))
    for (ix in instructions) { add(AccountMeta(ix.programId, false, false)); ix.keys.forEach(::add) }
    val ordered = keys.values.sortedWith(compareByDescending<AccountMeta> { it.signer }.thenByDescending { it.writable })
    require(ordered.size <= 255 && ordered.count { it.signer } == 1 && ordered.first().key.contentEquals(wallet) && ordered.first().writable)
    val indices = ordered.mapIndexed { index, key -> base58(key.key) to index }.toMap()
    return ByteArrayOutputStream().apply {
        write(1); write(0); write(ordered.count { !it.signer && !it.writable }); write(compactU16(ordered.size)); ordered.forEach { write(it.key) }
        write(blockhash); write(compactU16(instructions.size))
        for (ix in instructions) {
            write(indices.getValue(base58(ix.programId))); write(compactU16(ix.keys.size)); ix.keys.forEach { write(indices.getValue(base58(it.key))) }
            write(compactU16(ix.data.size)); write(ix.data)
        }
    }.toByteArray()
}
