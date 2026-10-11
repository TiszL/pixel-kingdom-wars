package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import java.math.BigInteger

private const val ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

internal fun base58Decode(text: String): ByteArray {
    require(text.isNotEmpty()) { "Empty base58 value" }
    var n = BigInteger.ZERO
    for (c in text) { val digit = ALPHABET.indexOf(c); require(digit >= 0) { "Invalid base58 character" }; n = n.multiply(BigInteger.valueOf(58)).add(BigInteger.valueOf(digit.toLong())) }
    val magnitude = n.toByteArray().let { if (it.size > 1 && it[0] == 0.toByte()) it.copyOfRange(1, it.size) else if (n.signum() == 0) ByteArray(0) else it }
    val leading = text.takeWhile { it == '1' }.length
    return ByteArray(leading) + magnitude
}
internal fun publicKeyBytes(address: String): ByteArray = base58Decode(address).also { require(it.size == 32) { "Invalid Solana address" } }

/** Solana short-vec length prefix (compact-u16). */
internal fun compactU16(n: Int): ByteArray {
    require(n in 0..0xFFFF)
    return when {
        n < 0x80 -> byteArrayOf(n.toByte())
        n < 0x4000 -> byteArrayOf(((n and 0x7F) or 0x80).toByte(), (n shr 7).toByte())
        else -> byteArrayOf(((n and 0x7F) or 0x80).toByte(), (((n shr 7) and 0x7F) or 0x80).toByte(), (n shr 14).toByte())
    }
}

data class AccountMeta(val key: ByteArray, val signer: Boolean, val writable: Boolean) {
    init { require(key.size == 32) }
}
data class Instruction(val programId: ByteArray, val keys: List<AccountMeta>, val data: ByteArray) {
    init { require(programId.size == 32) }
}

/** Legacy (non-versioned) transaction encoding equal to `@solana/web3.js` `Transaction.serialize`
 * with `requireAllSignatures: false`: one zeroed signature slot for the fee payer, then the
 * compiled message. Account ordering reproduces `compileMessage` (signers, then writable, then a
 * locale string sort within each class) so the bytes match the web's transaction for the same
 * inputs; the wallet fills the single signature. */
object LegacyTransaction {
    fun message(feePayer: ByteArray, recentBlockhash: ByteArray, instructions: List<Instruction>): ByteArray {
        require(feePayer.size == 32 && recentBlockhash.size == 32 && instructions.isNotEmpty())
        val metas = mutableListOf<AccountMeta>()
        for (instruction in instructions) metas += instruction.keys
        val programs = mutableListOf<ByteArray>()
        for (instruction in instructions) if (programs.none { it.contentEquals(instruction.programId) }) programs += instruction.programId
        for (program in programs) metas += AccountMeta(program, signer = false, writable = false)
        val unique = mutableListOf<AccountMeta>()
        for (meta in metas) {
            val index = unique.indexOfFirst { it.key.contentEquals(meta.key) }
            if (index >= 0) unique[index] = unique[index].copy(signer = unique[index].signer || meta.signer, writable = unique[index].writable || meta.writable)
            else unique += meta
        }
        val sorted = unique.sortedWith(Comparator { x, y ->
            if (x.signer != y.signer) return@Comparator if (x.signer) -1 else 1
            if (x.writable != y.writable) return@Comparator if (x.writable) -1 else 1
            collate(base58(x.key), base58(y.key))
        }).toMutableList()
        val payerIndex = sorted.indexOfFirst { it.key.contentEquals(feePayer) }
        val payer = if (payerIndex >= 0) sorted.removeAt(payerIndex).copy(signer = true, writable = true) else AccountMeta(feePayer, signer = true, writable = true)
        sorted.add(0, payer)
        val signers = sorted.count { it.signer }
        val readonlySigned = sorted.count { it.signer && !it.writable }
        val readonlyUnsigned = sorted.count { !it.signer && !it.writable }
        require(signers in 1..255 && sorted.size <= 255)
        val out = java.io.ByteArrayOutputStream()
        out.write(signers); out.write(readonlySigned); out.write(readonlyUnsigned)
        out.write(compactU16(sorted.size)); sorted.forEach { out.write(it.key) }
        out.write(recentBlockhash)
        out.write(compactU16(instructions.size))
        for (instruction in instructions) {
            out.write(sorted.indexOfFirst { it.key.contentEquals(instruction.programId) })
            out.write(compactU16(instruction.keys.size))
            instruction.keys.forEach { out.write(sorted.indexOfFirst { meta -> meta.key.contentEquals(it.key) }) }
            out.write(compactU16(instruction.data.size)); out.write(instruction.data)
        }
        return out.toByteArray()
    }
    /** Unsigned transaction: the wallet signs over [message] and fills the zero slot. */
    fun unsigned(feePayer: ByteArray, recentBlockhash: ByteArray, instructions: List<Instruction>): ByteArray =
        compactU16(1) + ByteArray(64) + message(feePayer, recentBlockhash, instructions)

    /** ICU-style `localeCompare('en', {sensitivity: 'variant', caseFirst: 'lower'})` for base58 text:
     * case-insensitive alphanumeric order first, then lowercase before uppercase at the first case difference. */
    internal fun collate(a: String, b: String): Int {
        val primary = a.lowercase().compareTo(b.lowercase())
        if (primary != 0) return primary
        for (i in a.indices) { if (a[i] != b[i]) return if (a[i].isLowerCase()) -1 else 1 }
        return 0
    }
}

/** Anchor instruction discriminators of shardkeep-core (`packages/chain/src/idl/shardkeep_core.json`,
 * hand-encoded exactly as the web's `lib/chain.ts`). */
object ShardkeepCore {
    private val DISC_PAY_ENTRY = byteArrayOf(187.toByte(), 10, 90, 67, 83, 172.toByte(), 196.toByte(), 207.toByte())
    private val DISC_BUY_SINK = byteArrayOf(220.toByte(), 121, 168.toByte(), 150.toByte(), 121, 25, 213.toByte(), 14)
    /** `buy_sink` wire kinds in lib.rs PAYMENT_KIND_*; these are ABI tags, not game prices. */
    const val SINK_KIND_DEED = 9
    private const val SINK_KIND_BUILDER = 8
    private val SYSTEM_PROGRAM = ByteArray(32)

    /** Mirrors `packages/chain` `playerPda`: seeds `['player', wallet]` on the core program. */
    suspend fun playerPda(wallet: ByteArray, addresses: ChainAddresses): ByteArray {
        val derived = ProgramDerivedAddress.find(listOf("player".toByteArray(Charsets.UTF_8), wallet.copyOf()), SolanaPublicKey(publicKeyBytes(addresses.coreProgram)))
        return derived.getOrThrow().bytes.also { require(it.size == 32) }
    }
    private fun u64le(value: BigInteger): ByteArray {
        require(value.signum() >= 0 && value.bitLength() <= 64) { "amount does not fit in an unsigned 64-bit integer" }
        return ByteArray(8) { i -> value.shiftRight(8 * i).and(BigInteger.valueOf(0xFF)).toInt().toByte() }
    }
    /** `pay_entry`: the first land payment (split on-chain), initialising the one-per-wallet Player PDA. */
    fun payEntry(wallet: ByteArray, playerPda: ByteArray, reference: ByteArray, addresses: ChainAddresses): Instruction = Instruction(
        publicKeyBytes(addresses.coreProgram), listOf(
            AccountMeta(publicKeyBytes(addresses.config), false, false), AccountMeta(wallet, true, true), AccountMeta(playerPda, false, true),
            AccountMeta(publicKeyBytes(addresses.treasuryLiquidity), false, true), AccountMeta(publicKeyBytes(addresses.treasuryDev), false, true),
            AccountMeta(publicKeyBytes(addresses.treasuryOps), false, true), AccountMeta(reference, false, false), AccountMeta(SYSTEM_PROGRAM, false, false),
        ), DISC_PAY_ENTRY.copyOf())
    /** `buy_sink(kind = deed, amount)`: an additional land deed, priced by the server-frozen lamports. */
    fun buyDeed(wallet: ByteArray, reference: ByteArray, amountLamports: BigInteger, addresses: ChainAddresses): Instruction =
        buySink(wallet, reference, amountLamports, addresses, SINK_KIND_DEED)
    /** Current web builder purchases use generic buy_sink, without a Player PDA. */
    fun buyBuilder(wallet: ByteArray, reference: ByteArray, amountLamports: BigInteger, addresses: ChainAddresses): Instruction =
        buySink(wallet, reference, amountLamports, addresses, SINK_KIND_BUILDER)
    /** Existing shield ABI kinds in canonical web lib/chain.ts; prices remain server/catalogue data. */
    fun buyShield(wallet: ByteArray, reference: ByteArray, amountLamports: BigInteger, addresses: ChainAddresses): Instruction =
        buySink(wallet, reference, amountLamports, addresses, 4)
    fun buyWarzoneShield(wallet: ByteArray, reference: ByteArray, amountLamports: BigInteger, addresses: ChainAddresses): Instruction =
        buySink(wallet, reference, amountLamports, addresses, 6)
    /** Canonical energy SKU ABI3/7; quantity is an off-chain frozen receipt term. */
    fun buyEnergy(wallet: ByteArray, reference: ByteArray, amountLamports: BigInteger, addresses: ChainAddresses): Instruction =
        buySink(wallet, reference, amountLamports, addresses, 3)
    fun buyEnergyPack(wallet: ByteArray, reference: ByteArray, amountLamports: BigInteger, addresses: ChainAddresses): Instruction =
        buySink(wallet, reference, amountLamports, addresses, 7)
    private fun buySink(wallet: ByteArray, reference: ByteArray, amountLamports: BigInteger, addresses: ChainAddresses, kind: Int): Instruction = Instruction(
        publicKeyBytes(addresses.coreProgram), listOf(
            AccountMeta(publicKeyBytes(addresses.config), false, false), AccountMeta(wallet, true, true),
            AccountMeta(publicKeyBytes(addresses.treasuryLiquidity), false, true), AccountMeta(publicKeyBytes(addresses.treasuryDev), false, true),
            AccountMeta(publicKeyBytes(addresses.treasuryOps), false, true), AccountMeta(reference, false, false), AccountMeta(SYSTEM_PROGRAM, false, false),
        ), DISC_BUY_SINK + byteArrayOf(kind.toByte()) + u64le(amountLamports))
}
