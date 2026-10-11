package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import gg.pixelkingdomwars.nativeclient.realmsales.*
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64
import java.util.Collections
import org.bouncycastle.math.ec.rfc8032.Ed25519

/** Independent application pins, never learned from an untrusted preparation. */
data class RealmSaleSigningTrust(val genesisHash: String, val programId: String, val developer: String,
    val reviewedProgramDataSha256: String, val reviewedDeploymentSlot: Long, val revision: String)
/** Additional registry policy comes from the canonical generated catalogue. */
data class RealmSaleSigningPolicy(val protocol: RealmSalesProtocolPolicy, val kingSpots: Int, val regularRealmCount: Int) {
    fun validate() {
        protocol.validate()
        require(protocol.version in 1..255 && protocol.totalSpots <= 256 && protocol.realmCount in 1..8)
        require(kingSpots in 0..protocol.totalSpots && regularRealmCount in 1..protocol.realmCount)
        require(protocol.sellerBps <= 65535 && protocol.developerBps <= 65535)
    }
}
data class SignedRealmSale(val wire: String, val signature: String)

/** An opaque, already checked exact message. No live admission, wallet or send port. */
class PreparedRealmSale internal constructor(val wallet: String, message: ByteArray) {
    private val message = message.copyOf()
    fun unsignedTransaction(): ByteArray = byteArrayOf(1) + ByteArray(64) + message
    fun verifySigned(bytes: ByteArray): SignedRealmSale {
        require(bytes.size in 66..1232 && bytes.size == message.size + 65 && bytes[0] == 1.toByte()) { "Invalid realm-sale signed envelope" }
        val wire = bytes.copyOf()
        require(wire.copyOfRange(65, wire.size).contentEquals(message)) { "The wallet changed the original realm sale" }
        val signature = wire.copyOfRange(1, 65)
        require(Ed25519.verify(signature, 0, realmSaleKey(wallet), 0, message, 0, message.size)) { "Invalid realm-sale buyer signature" }
        return SignedRealmSale(Base64.getEncoder().encodeToString(wire), base58(signature))
    }
    fun verifySignedBase64(wire: String): SignedRealmSale {
        require(wire.length in 88..1644 && wire.length % 4 == 0 && wire.matches(Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")))
        val bytes = Base64.getDecoder().decode(wire)
        require(bytes.size <= 1232 && Base64.getEncoder().encodeToString(bytes) == wire)
        return verifySigned(bytes)
    }
}

/** Independently reproduces the reviewed Anchor ABI and web3 legacy-message ordering.
 * Exact history verification needs no current trust pins and grants no new action. */
object RealmSaleTransaction {
    private val openAccess = realmSaleHex("0d40bdc8b5670c2d", 8, 8)
    private val openQuota = realmSaleHex("3bf7b1c02d1c7a7b", 8, 8)
    private val buy = realmSaleHex("a4abb085b5a95183", 8, 8)

    suspend fun prepare(preparation: RealmSalePreparation, policy: RealmSaleSigningPolicy, trust: RealmSaleSigningTrust): PreparedRealmSale {
        val p = ownRealmSalePreparation(preparation, policy)
        listOf(trust.genesisHash, trust.programId, trust.developer).forEach(::realmSaleKey)
        require(trust == RealmSaleSigningTrust(p.source.genesisHash, p.source.programId, p.terms.developer,
            p.source.programDataSha256, p.source.reviewedDeploymentSlot, p.source.revision)) { "Realm-sale deployment does not match application pins" }
        return canonical(p, policy)
    }
    suspend fun verifySigned(preparation: RealmSalePreparation, policy: RealmSaleSigningPolicy, wire: String): SignedRealmSale =
        canonical(ownRealmSalePreparation(preparation, policy), policy).verifySignedBase64(wire)

    private suspend fun canonical(p: RealmSalePreparation, policy: RealmSaleSigningPolicy): PreparedRealmSale {
        val buyer = realmSaleKey(p.wallet); val program = realmSaleKey(p.source.programId)
        val seller = realmSaleKey(p.terms.seller); val developer = realmSaleKey(p.terms.developer)
        require(Ed25519.validatePublicKeyFull(buyer, 0)) { "The realm-sale buyer must be an Ed25519 wallet" }
        val rules = policy.protocol
        val mask = if (p.spot < policy.kingSpots) (1 shl rules.realmCount) - 1 else {
            var mask = 0
            repeat(policy.regularRealmCount) { i -> mask = mask or (1 shl ((p.spot.toInt() - policy.kingSpots + i) % rules.realmCount)) }; mask
        }
        require(mask and (1 shl p.realm.toInt()) != 0) { "The winning spot cannot sell this realm" }
        val saleId = realmSaleHex(p.saleId, 16, 16); val round = realmSaleLe(p.terms.round); val day = realmSaleLe(p.terms.day)
        val realm = byteArrayOf(p.realm.toByte()); val spot = byteArrayOf(p.spot.toByte())
        val authority = realmSalePda(program, "seeker_authority").bytes
        val config = realmSalePda(program, "realm_sale_config").bytes
        val auctionConfig = realmSalePda(program, "auction_config").bytes
        val registry = realmSalePda(program, "seeker_registry").bytes
        val term = realmSalePda(program, "seeker_term", auctionConfig, round).bytes
        val auction = realmSalePda(program, "auction", auctionConfig, spot, round).bytes
        val quota = realmSalePda(program, "spot_sales", spot, day).bytes
        val access = realmSalePda(program, "realm_access", buyer, realm).bytes
        val receipt = realmSalePda(program, "realm_sale", buyer, saleId).bytes
        val system = ByteArray(32)
        fun meta(key: ByteArray, writable: Boolean = false, signer: Boolean = false) = AccountMeta(key, signer, writable)
        val rents = mutableListOf<Pair<String, Long>>()
        val instructions = buildList {
            if (p.quote.needsAccess) {
                add(Instruction(program, listOf(meta(buyer, true, true), meta(config), meta(access, true), meta(system)), openAccess + buyer + realm))
                rents += base58(access) to 83L
            }
            if (p.quote.needsQuota) {
                add(Instruction(program, listOf(meta(buyer, true, true), meta(config), meta(quota, true), meta(system)), openQuota + spot + day))
                rents += base58(quota) to 20L
            }
            add(Instruction(program, listOf(meta(buyer, true, true), meta(authority), meta(config), meta(auctionConfig), meta(registry), meta(term),
                meta(auction), meta(quota, true), meta(access, true), meta(receipt, true), meta(seller, true), meta(developer, true), meta(system)),
                buy + byteArrayOf(rules.version.toByte()) + saleId + spot + realm + round + day + seller + developer + realmSaleLe("1", 2) +
                    realmSaleLe(rules.permitPriceLamports.toString()) + realmSaleLe(rules.permitDurationSec.toString()) +
                    realmSaleLe(rules.sellerBps.toString(), 2) + realmSaleLe(rules.developerBps.toString(), 2) +
                    realmSaleLe(p.terms.priorExpiry) + realmSaleLe(p.terms.validAfter) + realmSaleLe(p.terms.validUntil)))
            rents += base58(receipt) to 294L
        }
        require(p.quote.rents.map { it.address to it.space } == rents) { "Realm-sale setup account allocation changed" }
        val expected = compileRealmSaleMessage(buyer, realmSaleKey(p.quote.blockhash), instructions)
        val message = realmSaleHex(p.quote.messageHex, 1, 1167)
        require(message.contentEquals(expected) && p.quote.packetBytes == 65L + message.size && realmSaleHash(message) == p.quote.messageSha256) {
            "Realm-sale message differs from original canonical consent"
        }
        return PreparedRealmSale(p.wallet, message)
    }
}

/** Capture the only mutable collection before any PDA derivation can suspend. */
internal fun ownRealmSalePreparation(value: RealmSalePreparation, policy: RealmSaleSigningPolicy): RealmSalePreparation {
    policy.validate(); require(value.quote.rents.size in 1..3)
    return value.copy(quote = value.quote.copy(rents = Collections.unmodifiableList(ArrayList(value.quote.rents)))).also { it.validate(policy.protocol) }
}
internal fun realmSaleKey(value: String): ByteArray {
    require(value.length in 32..44)
    return publicKeyBytes(value).also { require(base58(it) == value && it.any { b -> b != 0.toByte() }) { "Noncanonical realm-sale identity" } }
}
internal fun realmSaleHex(value: String, minimumBytes: Int, maximumBytes: Int): ByteArray {
    require(value.length in minimumBytes * 2..maximumBytes * 2 && value.matches(Regex("(?:[0-9a-f]{2})+")))
    return ByteArray(value.length / 2) { value.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
internal fun realmSaleHash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
internal fun realmSaleLe(value: String, size: Int = 8): ByteArray {
    require(size == 2 || size == 8); require(value.length in 1..20 && value.matches(Regex("0|[1-9][0-9]{0,19}")))
    val n = BigInteger(value); require(n.bitLength() <= size * 8)
    return ByteArray(size) { n.shiftRight(it * 8).toByte() }
}
internal suspend fun realmSalePda(program: ByteArray, seed: String, vararg tail: ByteArray): ProgramDerivedAddress =
    ProgramDerivedAddress.find(listOf(seed.toByteArray(Charsets.UTF_8), *tail), SolanaPublicKey(program)).getOrThrow()

/** TransactionMessage.compileToLegacyMessage: first occurrence in each privilege class.
 * Role aliases union privileges without duplicating keys or dropping instruction operands. */
private fun compileRealmSaleMessage(wallet: ByteArray, blockhash: ByteArray, instructions: List<Instruction>): ByteArray {
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
        write(compactU16(ordered.size)); ordered.forEach { write(it.key) }; write(blockhash); write(compactU16(instructions.size))
        for (ix in instructions) {
            write(indices.getValue(base58(ix.programId))); write(compactU16(ix.keys.size)); ix.keys.forEach { write(indices.getValue(base58(it.key))) }
            write(compactU16(ix.data.size)); write(ix.data)
        }
    }.toByteArray()
}
