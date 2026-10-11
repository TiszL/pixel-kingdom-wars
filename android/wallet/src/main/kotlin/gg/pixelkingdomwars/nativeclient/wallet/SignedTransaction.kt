package gg.pixelkingdomwars.nativeclient.wallet

import java.math.BigInteger
import java.nio.ByteBuffer

/** The SDK may add only this wallet's signature to the reviewed transaction.
 * Economic intent and blockhash expiry are checked by the eventual payment flow. */
private data class TransactionEnvelope(val signaturesOffset: Int, val messageOffset: Int, val signer: Int)
private fun transactionEnvelope(bytes: ByteArray, wallet: String): TransactionEnvelope {
    var offset=0
    fun byte(): Int { require(offset<bytes.size) { "Truncated transaction" }; return bytes[offset++].toInt() and 255 }
    fun compact(): Int {
        var result=0
        for(i in 0..2) {
            val b=byte(); require(i<2 || b<=3) { "Invalid compact length" }
            result=result or ((b and 127) shl (i*7))
            if(b<128) { require(i==0 || b!=0) { "Noncanonical compact length" }; return result }
        }
        error("Invalid compact length")
    }
    val signatures=compact(); require(signatures in 1..255)
    val signaturesOffset=offset
    require(signatures*64 <= bytes.size-offset)
    offset+=signatures*64
    val messageOffset=offset
    val header=byte()
    val required=if(header and 128 != 0) { require(header==128) { "Unsupported transaction version" }; byte() } else header
    require(required==signatures)
    val readOnlySigned=byte(); val readOnlyUnsigned=byte()
    val accounts=compact()
    require(accounts>=required && readOnlySigned<=required && readOnlyUnsigned<=accounts-required)
    require(accounts*32<=bytes.size-offset && bytes.size-offset-accounts*32>=33)
    val matches=(0 until required).filter { base58(bytes.copyOfRange(offset+it*32,offset+(it+1)*32))==wallet }
    require(matches.size==1) { "The game wallet is not a unique required signer" }
    return TransactionEnvelope(signaturesOffset,messageOffset,matches.single())
}
internal fun validateTransactionSigner(bytes: ByteArray, wallet: String) { transactionEnvelope(bytes,wallet) }
internal fun validateSignedTransaction(original: ByteArray, signed: ByteArray, wallet: String) {
    val before=transactionEnvelope(original,wallet); val after=transactionEnvelope(signed,wallet)
    require(before.signaturesOffset==after.signaturesOffset && before.messageOffset==after.messageOffset && before.signer==after.signer)
    require(original.copyOfRange(before.messageOffset,original.size).contentEquals(signed.copyOfRange(after.messageOffset,signed.size))) { "The wallet changed the reviewed transaction" }
    val own=before.signaturesOffset+before.signer*64
    for(i in before.signaturesOffset until before.messageOffset) {
        if(i !in own until own+64) require(original[i]==signed[i]) { "The wallet changed another signature" }
    }
    require(signed.copyOfRange(own,own+64).any { it!=0.toByte() }) { "The wallet did not sign" }
}

/** Only a validated, unchanged transaction's fee-payer signature may be recorded as payment identity. */
fun paymentTransactionSignature(original: ByteArray, signed: ByteArray, wallet: String): ByteArray {
    validateSignedTransaction(original, signed, wallet)
    val envelope = transactionEnvelope(signed, wallet)
    require(envelope.signer == 0 && envelope.messageOffset - envelope.signaturesOffset == 64) { "Payment must have one fee-payer signature" }
    return signed.copyOfRange(envelope.signaturesOffset, envelope.signaturesOffset + 64)
}

/** What a wallet did to the reviewed message before signing it in the sign-only fallback. */
enum class TransactionMutation { NONE, COMPUTE_BUDGET_ADDED }

/** The signed reply failed the semantic check; [kind] names exactly which part of the payment changed. */
class SignedTransactionRejected(val kind: WalletFailureKind, message: String) : IllegalArgumentException(message)

/** A validated sign-only reply: the fee-payer [signature] of the RETURNED message and what the wallet added. */
class SignedPayment(val signature: ByteArray, val mutation: TransactionMutation)

private val COMPUTE_BUDGET_PROGRAM = publicKeyBytes("ComputeBudget111111111111111111111111111111")
/** The only ComputeBudget instructions a wallet may add, by their one-byte tag: SetComputeUnitLimit(u32) and
 * SetComputeUnitPrice(u64 micro-lamports per unit). Tag 0 (deprecated RequestUnits) carries a fee of its own. */
private const val SET_COMPUTE_UNIT_LIMIT = 2
private const val SET_COMPUTE_UNIT_PRICE = 3
/** Solana's per-transaction compute ceiling: what a price with no declared limit is judged against. */
private const val MAX_COMPUTE_UNITS = 1_400_000L
private const val MICRO_LAMPORTS_PER_LAMPORT = 1_000_000L
/** The most priority fee, in lamports (0.01 SOL), a wallet may add to a payment this app then relays. This is a
 * WALLET-SAFETY bound, not a game number: no game price or server response defines it, and it exists only so a
 * signed reply cannot spend the player's SOL on fees. Honest wallets sit far below it — the owner's adds 75,000
 * lamports (375000 µlamports × 200000 units) or 40,000 (100000 × 400000). */
internal const val MAX_ADDED_PRIORITY_FEE_LAMPORTS = 10_000_000L

/** One account reference resolved through the message header: the key, and the privileges its POSITION grants. */
internal class ResolvedAccount(val key: ByteArray, val signer: Boolean, val writable: Boolean) {
    fun same(other: ResolvedAccount) = key.contentEquals(other.key) && signer == other.signer && writable == other.writable
}
internal class ResolvedInstruction(val program: ResolvedAccount, val accounts: List<ResolvedAccount>, val data: ByteArray) {
    fun same(other: ResolvedInstruction) = program.same(other.program) && data.contentEquals(other.data) &&
        accounts.size == other.accounts.size && accounts.indices.all { accounts[it].same(other.accounts[it]) }
}
internal class LegacyPayment(val signatures: List<ByteArray>, val message: ByteArray, val accounts: List<ResolvedAccount>,
                            val blockhash: ByteArray, val instructions: List<ResolvedInstruction>) {
    val signature: ByteArray get() = signatures[0]
    val feePayer: ByteArray get() = accounts[0].key
}

/** Parses a legacy transaction completely (no trailing bytes), defaulting to the existing single signer.
 * The faucet variant requires two signers and one read-only signer. [reject] decides how a violation
 * is reported: the reviewed original is this app's own bytes, the signed reply is the wallet's. Every account is
 * resolved with the signer/writable privileges the header gives its position, because a reply can keep all keys
 * and all instruction bytes and still make the fee payer or a payee read-only: it would pass a key-only check, be
 * relayed, and fail on chain as an "uncertain" payment. The fee payer is index 0 and must be the one writable signer. */
private fun legacyPayment(bytes: ByteArray, requiredSigners: Int = 1, readOnlySigners: Int = 0,
    reject: (WalletFailureKind, String) -> Nothing): LegacyPayment {
    var offset = 0
    fun malformed(): Nothing = reject(WalletFailureKind.INVALID_RESPONSE, "Malformed transaction")
    fun byte(): Int { if (offset >= bytes.size) malformed(); return bytes[offset++].toInt() and 255 }
    fun take(n: Int): ByteArray { if (n < 0 || n > bytes.size - offset) malformed(); return bytes.copyOfRange(offset, offset + n).also { offset += n } }
    fun compact(): Int {
        var result = 0
        for (i in 0..2) {
            val b = byte()
            if (requiredSigners == 2 && (i == 2 && b > 3 || i > 0 && b == 0)) malformed()
            result = result or ((b and 127) shl (i * 7)); if (b < 128) return result
        }
        malformed()
    }
    if (requiredSigners == 2 && bytes.size > 1232) malformed()
    if (compact() != requiredSigners) reject(WalletFailureKind.TX_SIGNERS_CHANGED, "Unexpected payment signature slots")
    val signatures = List(requiredSigners) { take(64) }; val messageOffset = offset
    val required = byte()
    if (required and 128 != 0) reject(WalletFailureKind.TX_VERSION_CHANGED, "Payment must stay a legacy transaction")
    if (required != requiredSigners) reject(WalletFailureKind.TX_SIGNERS_CHANGED, "Unexpected required payment signers")
    val readOnlySigned = byte(); val readOnlyUnsigned = byte()
    val accountCount = compact()
    if (requiredSigners == 2 && (accountCount !in required..256 || accountCount > (bytes.size - offset) / 32)) malformed()
    val accountKeys = List(accountCount) { take(32) }
    if (accountKeys.size < required || readOnlySigned > required || readOnlyUnsigned > accountKeys.size - required) malformed()
    // A key listed twice has no single privilege, and the runtime refuses it after the relay ("account loaded twice").
    if (accountKeys.map { ByteBuffer.wrap(it) }.toSet().size != accountKeys.size) malformed()
    if (readOnlySigned != readOnlySigners) reject(WalletFailureKind.TX_SIGNERS_CHANGED, "Unexpected writable payment signers")
    val accounts = accountKeys.mapIndexed { index, key ->
        val signer = index < required
        ResolvedAccount(key, signer, writable = if (signer) index < required - readOnlySigned else index < accountKeys.size - readOnlyUnsigned)
    }
    val blockhash = take(32)
    val instructions = List(compact()) {
        val program = accounts.getOrNull(byte()) ?: malformed()
        val keys = List(compact()) { accounts.getOrNull(byte()) ?: malformed() }
        ResolvedInstruction(program, keys, take(compact()))
    }
    if (offset != bytes.size) malformed()
    return LegacyPayment(signatures, bytes.copyOfRange(messageOffset, bytes.size), accounts, blockhash, instructions)
}

/** What a wallet may add: at most one SetComputeUnitLimit and one SetComputeUnitPrice, exact data, no accounts
 * (the runtime refuses duplicates and unknown data after the relay). The priority fee they buy is paid by the fee
 * payer — the player — so its maximum, ceil(price × limit / 1,000,000) lamports with the DECLARED limit (or the
 * runtime's ceiling when only a price is present), must stay within [MAX_ADDED_PRIORITY_FEE_LAMPORTS]. */
private fun requireSafeComputeBudget(added: List<ResolvedInstruction>, requireExecutableLimit: Boolean = false) {
    fun changed(): Nothing = throw SignedTransactionRejected(WalletFailureKind.TX_INSTRUCTIONS_CHANGED, "The wallet added an unsupported ComputeBudget instruction")
    var limit: Long? = null; var price: BigInteger? = null
    for (instruction in added) {
        val data = instruction.data
        fun unsignedLe(): BigInteger = BigInteger(1, data.copyOfRange(1, data.size).reversedArray())
        when {
            instruction.accounts.isNotEmpty() -> changed()
            data.size == 5 && data[0].toInt() == SET_COMPUTE_UNIT_LIMIT && limit == null -> limit = unsignedLe().toLong()
            data.size == 9 && data[0].toInt() == SET_COMPUTE_UNIT_PRICE && price == null -> price = unsignedLe()
            else -> changed()
        }
    }
    if (requireExecutableLimit && limit != null && limit !in 1..MAX_COMPUTE_UNITS) changed()
    val microLamports = (price ?: return) * BigInteger.valueOf(limit ?: MAX_COMPUTE_UNITS)
    val lamports = (microLamports + BigInteger.valueOf(MICRO_LAMPORTS_PER_LAMPORT - 1)) / BigInteger.valueOf(MICRO_LAMPORTS_PER_LAMPORT)
    if (lamports > BigInteger.valueOf(MAX_ADDED_PRIORITY_FEE_LAMPORTS))
        throw SignedTransactionRejected(WalletFailureKind.TX_PRIORITY_FEE_TOO_HIGH, "The wallet added a priority fee above this app's safety limit")
}

/** The sign-only fallback's check. Wallets such as the owner's prepend their own ComputeBudget (priority fee)
 * instructions to everything they sign, so demanding identical bytes rejected an honest signature. The payment
 * itself must be untouched instead: the same fee payer as the only, writable signer, the same recent blockhash
 * (this app's expiry logic stays truthful), and the reviewed instructions present in order with identical
 * program, resolved account keys WITH their signer/writable privileges, and data. Only ComputeBudget limit and
 * price instructions may be added ([requireSafeComputeBudget]): they move nothing to anyone, but the priority fee
 * they buy comes out of the fee payer, so it is bounded. The game builds no ComputeBudget instruction itself. The
 * fee-payer signature is verified with ed25519 over the RETURNED message, which is what this app relays and
 * what the server settles by reference and balance deltas. */
fun semanticPaymentSignature(original: ByteArray, signed: ByteArray, wallet: String): SignedPayment {
    val feePayer = publicKeyBytes(wallet)
    val before = legacyPayment(original) { _, message -> throw IllegalArgumentException(message) }
    require(before.feePayer.contentEquals(feePayer)) { "The game wallet is not the fee payer" }
    val after = legacyPayment(signed) { kind, message -> throw SignedTransactionRejected(kind, message) }
    if (!after.feePayer.contentEquals(feePayer)) throw SignedTransactionRejected(WalletFailureKind.TX_SIGNERS_CHANGED, "The wallet changed the fee payer")
    if (!after.blockhash.contentEquals(before.blockhash)) throw SignedTransactionRejected(WalletFailureKind.TX_BLOCKHASH_CHANGED, "The wallet changed the recent blockhash")
    var reviewed = 0; val added = mutableListOf<ResolvedInstruction>()
    for (instruction in after.instructions) {
        if (reviewed < before.instructions.size && instruction.same(before.instructions[reviewed])) reviewed++
        else if (instruction.program.key.contentEquals(COMPUTE_BUDGET_PROGRAM)) added += instruction
        else throw SignedTransactionRejected(WalletFailureKind.TX_INSTRUCTIONS_CHANGED, "The wallet changed the reviewed instructions")
    }
    if (reviewed != before.instructions.size) throw SignedTransactionRejected(WalletFailureKind.TX_INSTRUCTIONS_CHANGED, "The wallet removed a reviewed instruction")
    requireSafeComputeBudget(added)
    if (!org.bouncycastle.math.ec.rfc8032.Ed25519.verify(after.signature, 0, feePayer, 0, after.message, 0, after.message.size))
        throw SignedTransactionRejected(WalletFailureKind.TX_BAD_SIGNATURE, "The wallet's signature does not verify")
    return SignedPayment(after.signature, if (added.isNotEmpty()) TransactionMutation.COMPUTE_BUDGET_ADDED else TransactionMutation.NONE)
}

/** Shared parser for faucet preflight; both signatures are absent until the player's explicit approval. */
internal fun unsignedCosignedTransaction(bytes: ByteArray, wallet: String): LegacyPayment {
    val parsed = legacyPayment(bytes, 2, 1) { _, message -> throw IllegalArgumentException(message) }
    require(parsed.feePayer.contentEquals(publicKeyBytes(wallet))) { "The game wallet is not the fee payer" }
    require(parsed.signatures.all { signature -> signature.all { it == 0.toByte() } }) { "The server wire must be unsigned" }
    return parsed
}

/** Shared parser for a server-prepared single-signer message (Seeker auction preflight): [wallet] is the fee payer
 * and the only, writable signer, every account carries the privileges its position grants, and the one signature
 * slot is still empty because only the wallet signs, after the player's review. */
internal fun unsignedSingleSignerTransaction(bytes: ByteArray, wallet: String): LegacyPayment {
    val parsed = legacyPayment(bytes) { _, message -> throw IllegalArgumentException(message) }
    require(parsed.feePayer.contentEquals(publicKeyBytes(wallet))) { "The game wallet is not the fee payer" }
    require(parsed.signature.all { it == 0.toByte() }) { "The server wire must be unsigned" }
    return parsed
}

/** Faucet-last check: keep both signer identities, all resolved privileges, blockhash, and reviewed instructions.
 * Only bounded ComputeBudget additions may change the message; the faucet slot must remain empty. */
fun semanticCosignedSignature(original: ByteArray, signed: ByteArray, wallet: String, cosigner: String): SignedPayment {
    val before = unsignedCosignedTransaction(original, wallet)
    val authority = publicKeyBytes(cosigner)
    require(before.accounts[1].key.contentEquals(authority) && !authority.contentEquals(before.feePayer)) { "Unexpected faucet authority" }
    val after = legacyPayment(signed, 2, 1) { kind, message -> throw SignedTransactionRejected(kind, message) }
    fun reject(kind: WalletFailureKind, message: String): Nothing = throw SignedTransactionRejected(kind, message)
    if (!after.feePayer.contentEquals(before.feePayer) || !after.accounts[1].key.contentEquals(authority))
        reject(WalletFailureKind.TX_SIGNERS_CHANGED, "The wallet changed the payment signers")
    if (!after.blockhash.contentEquals(before.blockhash)) reject(WalletFailureKind.TX_BLOCKHASH_CHANGED, "The wallet changed the recent blockhash")
    val originalKeys = before.accounts.associateBy { ByteBuffer.wrap(it.key) }
    for (account in after.accounts) {
        val expected = originalKeys[ByteBuffer.wrap(account.key)]
        if (expected != null) {
            if (!account.same(expected)) reject(WalletFailureKind.TX_INSTRUCTIONS_CHANGED, "The wallet changed account privileges")
        } else if (!account.key.contentEquals(COMPUTE_BUDGET_PROGRAM) || account.signer || account.writable)
            reject(WalletFailureKind.TX_INSTRUCTIONS_CHANGED, "The wallet added an unreviewed account")
    }
    if (!before.accounts.all { expected -> after.accounts.any { it.same(expected) } })
        reject(WalletFailureKind.TX_INSTRUCTIONS_CHANGED, "The wallet removed a reviewed account")
    var reviewed = 0; val added = mutableListOf<ResolvedInstruction>()
    for (instruction in after.instructions) {
        if (reviewed < before.instructions.size && instruction.same(before.instructions[reviewed])) reviewed++
        else if (instruction.program.key.contentEquals(COMPUTE_BUDGET_PROGRAM)) added += instruction
        else reject(WalletFailureKind.TX_INSTRUCTIONS_CHANGED, "The wallet changed the reviewed instructions")
    }
    if (reviewed != before.instructions.size) reject(WalletFailureKind.TX_INSTRUCTIONS_CHANGED, "The wallet removed a reviewed instruction")
    if (after.accounts.size != before.accounts.size + (if (added.isEmpty()) 0 else 1))
        reject(WalletFailureKind.TX_INSTRUCTIONS_CHANGED, "The wallet added an unused account")
    requireSafeComputeBudget(added, requireExecutableLimit = true)
    if (after.signatures[1].any { it != 0.toByte() }) reject(WalletFailureKind.TX_SIGNERS_CHANGED, "The faucet must sign last")
    if (!org.bouncycastle.math.ec.rfc8032.Ed25519.verify(after.signature, 0, before.feePayer, 0, after.message, 0, after.message.size))
        reject(WalletFailureKind.TX_BAD_SIGNATURE, "The wallet's signature does not verify")
    return SignedPayment(after.signature, if (added.isEmpty()) TransactionMutation.NONE else TransactionMutation.COMPUTE_BUDGET_ADDED)
}
