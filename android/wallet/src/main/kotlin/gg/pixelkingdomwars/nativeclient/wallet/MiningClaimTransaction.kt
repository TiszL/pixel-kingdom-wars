package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import org.bouncycastle.math.ec.rfc8032.Ed25519
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.util.Base64

/** Application pins, injected independently of the server's preparation response. */
data class MiningClaimSigningTrust(val genesisHash: String, val programId: String, val configAddress: String,
    val keepMint: String, val reserveOwner: String, val orderedLookupTable: MiningClaimOrderedPin? = null)
data class MiningClaimProofNode(val hash: String, val sumBaseUnits: String, val isLeft: Boolean)
data class MiningClaimSigningMessage(val ordinal: Int, val kind: String, val version: String, val message: String,
    val lookupTables: List<String>, val feePayer: String, val blockhash: String)
/** The network layer validates the full quote, fees and timestamps before mapping this signing-only view. */
data class MiningClaimSigningInput(val wallet: String, val identity: MiningClaimSigningTrust, val rootSequence: String,
    val leafWallet: String, val leafRootSequence: String, val cumulativeKeepBaseUnits: String,
    val cumulativeRenown: String, val cumulativeDays: String, val proof: List<MiningClaimProofNode>,
    val needsAta: Boolean, val needsMinerRecords: Boolean, val transactions: List<MiningClaimSigningMessage>,
    val orderedFormat: MiningClaimOrderedFormat? = null)

/** Strings retain the full original wire without exposing a mutable byte buffer. */
data class SignedMiningClaim(val wire: String, val signature: String, val ordinal: Int = 0)

class PreparedMiningClaim internal constructor(val wallet: String, message: ByteArray, val ordinal: Int = 0) {
    private val message = message.copyOf()
    fun unsignedTransaction(): ByteArray = byteArrayOf(1) + ByteArray(64) + message

    /** Recovery checks historical bytes; current quote/height admission belongs to the repository. */
    fun verifySigned(bytes: ByteArray): SignedMiningClaim {
        // Bound before copying, slicing, parsing or invoking crypto on wallet-controlled input.
        require(bytes.size in 66..1232 && bytes.size == 65 + message.size && bytes[0] == 1.toByte()) { "Invalid mining claim wire" }
        val wire = bytes.copyOf()
        require(wire.copyOfRange(65, wire.size).contentEquals(message)) { "The wallet changed the mining claim" }
        val signature = wire.copyOfRange(1, 65)
        require(Ed25519.verify(signature, 0, publicKeyBytes(wallet), 0, message, 0, message.size)) { "Invalid mining claim signature" }
        return SignedMiningClaim(Base64.getEncoder().encodeToString(wire), base58(signature), ordinal)
    }
    fun verifySignedBase64(wire: String): SignedMiningClaim = verifySigned(miningBase64(wire, 1232))
}

/** Canonical legacy claimant plan. No RPC, signing, broadcast, or local award calculation. */
object MiningClaimTransaction {
    private val token = publicKeyBytes("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    private val ataProgram = publicKeyBytes("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    private val system = ByteArray(32)
    // Anchor discriminators and seed strings are ABI, not game tuning.
    private val claim = byteArrayOf(222.toByte(), 36, 64, 123, 32, 17, 219.toByte(), 8)
    private val open = byteArrayOf(119, 14, 190.toByte(), 166.toByte(), 208.toByte(), 181.toByte(), 158.toByte(), 100)

    suspend fun prepare(input: MiningClaimSigningInput, trust: MiningClaimSigningTrust, ordinal: Int = 0, computeUnitLimit: Int? = null): PreparedMiningClaim {
        require(input.identity == trust.copy(orderedLookupTable = null)) { "Mining deployment does not match application pins" }
        if(input.orderedFormat!=null) return prepareOrderedMiningClaim(input, requireNotNull(trust.orderedLookupTable), ordinal, requireNotNull(computeUnitLimit))
        require(ordinal==0); return canonical(input)
    }

    /** Historical journal integrity only. This never grants an approval token or current authority;
     * deployment pins may be unavailable while an original signed claim still needs recovery. */
    suspend fun verifySigned(input: MiningClaimSigningInput, wire: String): SignedMiningClaim =
        canonical(input).verifySignedBase64(wire)

    private suspend fun canonical(input: MiningClaimSigningInput): PreparedMiningClaim {
        require(input.transactions.size == 1 && input.proof.size <= 16) { "Split mining claims are unsupported" }
        require(input.transactions.single().lookupTables.isEmpty()) { "Mining lookup tables are unsupported" }
        // Copy lists before PDA derivation suspends; callers cannot rewrite the prepared intent.
        val p = input.copy(proof = input.proof.toList(), transactions = input.transactions.map { it.copy(lookupTables = it.lookupTables.toList()) })
        val trust = p.identity
        val tx = p.transactions.single()
        require(tx.ordinal == 0 && tx.version == "legacy" && tx.lookupTables.isEmpty()) { "Unsupported mining claim transaction" }
        require(tx.kind == if (p.needsAta || p.needsMinerRecords) "combined" else "claim") { "Invalid mining setup plan" }
        require(p.wallet == p.leafWallet && p.wallet == tx.feePayer && p.rootSequence == p.leafRootSequence) { "Mining claimant changed" }
        listOf(trust.genesisHash, trust.programId, trust.configAddress, trust.keepMint, trust.reserveOwner).forEach(::miningKey)
        val wallet = miningKey(p.wallet)
        require(Ed25519.validatePublicKeyFull(wallet, 0)) { "Mining claimant must be an Ed25519 wallet" }
        val program = miningKey(trust.programId); val mint = miningKey(trust.keepMint)
        val sequence = miningU64(p.rootSequence, positive = true)
        val keep = miningU64(p.cumulativeKeepBaseUnits, positive = true)
        val renown = miningU64(p.cumulativeRenown); val days = miningU64(p.cumulativeDays)
        require(BigInteger(p.cumulativeRenown) <= BigInteger(p.cumulativeDays)) { "Invalid mining leaf" }
        val message = miningBase64(tx.message, 1167)
        require(message.firstOrNull() == 1.toByte()) { "Only one-signer legacy mining claims are supported" }
        val blockhash = miningKey(tx.blockhash)
        val proof = p.proof.map { n ->
            require(n.hash.matches(Regex("[0-9a-f]{64}"))) { "Invalid mining proof hash" }
            n.hash.chunked(2).map { it.toInt(16).toByte() }.toByteArray() + miningU64(n.sumBaseUnits) + byteArrayOf(if (n.isLeft) 1 else 0)
        }
        suspend fun pda(seed: String, tail: ByteArray? = null): ByteArray = ProgramDerivedAddress.find(
            listOfNotNull(seed.toByteArray(Charsets.UTF_8), tail), SolanaPublicKey(program)).getOrThrow().bytes
        suspend fun ata(owner: ByteArray): ByteArray = ProgramDerivedAddress.find(listOf(owner, token, mint), SolanaPublicKey(ataProgram)).getOrThrow().bytes
        val config = pda("economy"); require(base58(config) == trust.configAddress) { "Invalid mining config PDA" }
        val miner = pda("miner", wallet); val renownRecord = pda("renown", wallet); val root = pda("alloc", sequence)
        val destination = ata(wallet); val vault = ata(config)
        fun meta(key: ByteArray, writable: Boolean = false, signer: Boolean = false) = AccountMeta(key, signer, writable)
        val instructions = buildList {
            if (p.needsAta) add(Instruction(ataProgram, listOf(meta(wallet, true, true), meta(destination, true), meta(wallet), meta(mint), meta(system), meta(token)), byteArrayOf(1)))
            if (p.needsMinerRecords) add(Instruction(program, listOf(meta(wallet, true, true), meta(miner, true), meta(renownRecord, true), meta(system)), open + wallet))
            add(Instruction(program, listOf(meta(wallet, signer = true), meta(config, true), meta(root, true), meta(miner, true), meta(renownRecord, true),
                meta(vault, true), meta(destination, true), meta(mint), meta(token)),
                claim + sequence + keep + renown + days + byteArrayOf(proof.size.toByte(), 0, 0, 0) + proof.fold(ByteArray(0)) { a, b -> a + b }))
        }
        require(message.contentEquals(compileMiningMessage(wallet, blockhash, instructions))) { "Mining instructions do not match the reviewed plan" }
        return PreparedMiningClaim(p.wallet, message)
    }
}

private fun miningKey(value: String): ByteArray {
    require(value.length in 32..44) { "Invalid mining address" }
    return publicKeyBytes(value).also { require(base58(it) == value) { "Noncanonical mining address" } }
}
private fun miningU64(value: String, positive: Boolean = false): ByteArray {
    require(value.length in 1..20 && value.matches(Regex("0|[1-9][0-9]*"))) { "Invalid mining integer" }
    val n = BigInteger(value)
    require(n.bitLength() <= 64 && (!positive || n.signum() > 0)) { "Invalid mining integer" }
    return ByteArray(8) { n.shiftRight(it * 8).toByte() }
}
private fun miningBase64(value: String, maximum: Int): ByteArray {
    require(value.length in 4..((maximum + 2) / 3 * 4) && value.length % 4 == 0) { "Invalid mining base64 size" }
    return Base64.getDecoder().decode(value).also {
        require(it.size <= maximum && Base64.getEncoder().encodeToString(it) == value) { "Invalid mining base64" }
    }
}

/** web3 TransactionMessage.compileToLegacyMessage ordering: first occurrence within each privilege class.
 * The older native payment compiler intentionally follows Transaction's locale ordering instead. */
internal fun compileMiningMessage(wallet: ByteArray, blockhash: ByteArray, instructions: List<Instruction>): ByteArray {
    val keys = linkedMapOf<String, AccountMeta>()
    fun add(meta: AccountMeta) {
        val key = base58(meta.key); val old = keys[key]
        keys[key] = if (old == null) meta else old.copy(signer = old.signer || meta.signer, writable = old.writable || meta.writable)
    }
    add(AccountMeta(wallet, true, true))
    for (ix in instructions) { add(AccountMeta(ix.programId, false, false)); ix.keys.forEach(::add) }
    val ordered = keys.values.sortedWith(compareByDescending<AccountMeta> { it.signer }.thenByDescending { it.writable })
    require(ordered.count { it.signer } == 1 && ordered.first().key.contentEquals(wallet) && ordered.first().writable)
    val indices = ordered.mapIndexed { i, meta -> base58(meta.key) to i }.toMap()
    return ByteArrayOutputStream().apply {
        write(1); write(0); write(ordered.count { !it.signer && !it.writable })
        write(compactU16(ordered.size)); ordered.forEach { write(it.key) }; write(blockhash)
        write(compactU16(instructions.size))
        for (ix in instructions) {
            write(indices.getValue(base58(ix.programId))); write(compactU16(ix.keys.size))
            ix.keys.forEach { write(indices.getValue(base58(it.key))) }; write(compactU16(ix.data.size)); write(ix.data)
        }
    }.toByteArray()
}

/** One MWA sign-only request. The callback owns durable evidence even if the session changes during approval. */
internal suspend fun AdapterOperations.signMiningClaimInSession(prepared: PreparedMiningClaim, authorizedAccount: ByteArray?,
    guard: () -> Unit, onSigned: (SignedMiningClaim) -> Unit): SignedMiningClaim {
    guard()
    require(authorizedAccount != null && authorizedAccount.contentEquals(publicKeyBytes(prepared.wallet))) { "Approve with the mining claimant wallet" }
    val reply = signTransactions(arrayOf(prepared.unsignedTransaction()))
    require(reply.signedPayloads.size == 1) { "Invalid mining wallet reply" }
    val checked = prepared.verifySigned(reply.signedPayloads.single())
    onSigned(checked)
    guard()
    return checked
}
