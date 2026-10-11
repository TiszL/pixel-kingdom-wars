package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionBidRequest
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionPrepared
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionWithdrawRequest
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.Base64
import org.bouncycastle.math.ec.rfc8032.Ed25519

/** The application pin of the one reviewed auction deployment: its economy program and its SKR mint. It comes from
 * debug-only BuildConfig fields, never from a server response. A build without them carries "" and every
 * preparation below is refused, so the auction stays dark there. */
data class SeekerAuctionPin(val programId: String, val mint: String)

/** A server-prepared bid or withdrawal whose message was checked against the pin and the reviewed request before any
 * wallet sees it. [newTotalRaw] is the reviewed escrow total of a bid and null for a withdrawal. */
class PreparedSeekerAuction internal constructor(val wallet: String, val round: String, val spot: Int,
    val newTotalRaw: String?, message: ByteArray) {
    private val message = message.copyOf()
    /** The single-signer legacy wire `[1][64 zero bytes][message]` the shared payment rail hands to the wallet. */
    fun unsignedTransaction(): ByteArray = byteArrayOf(1) + ByteArray(64) + message
}

/** Independently rebuilds what the server's `buildBidMessage` / `buildWithdrawMessage`
 * (`packages/chain/src/seekerAuctionInstructions.ts`, IDL `shardkeep_economy.json`) may contain and refuses anything
 * else: the wallet is the fee payer and the only signer; a bid is an optional `open_bid` then `place_bid` carrying the
 * reviewed total as u64 LE; a withdrawal is an optional idempotent token-account creation then `withdraw_bid`.
 * Programs, account keys WITH their resolved signer/writable privileges, data, instruction order, the account set and
 * the quoted blockhash must all match. Key order inside the message is not compared, so any canonical compiler's
 * output passes. Nothing here is admission: the server and the program still decide whether the action is allowed. */
object SeekerAuctionTransaction {
    private const val TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    private const val ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    /** Solana packet bytes minus the one-signature prefix: a wire envelope size, not a game number. */
    private const val MAX_MESSAGE_BYTES = 1232 - 65
    private val canonicalBase64 = Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")
    private val openBid = anchorDiscriminator("open_bid")
    private val placeBid = anchorDiscriminator("place_bid")
    private val withdrawBid = anchorDiscriminator("withdraw_bid")

    suspend fun bid(prepared: SeekerAuctionPrepared, reviewed: SeekerAuctionBidRequest, pin: SeekerAuctionPin,
        wallet: String): PreparedSeekerAuction {
        val total = realmSaleLe(reviewed.newTotalRaw)
        require(total.any { it != 0.toByte() }) { "A bid total must be positive" }
        return verify(prepared, pin, wallet, reviewed.round, reviewed.spot, reviewed.newTotalRaw, total)
    }

    suspend fun withdraw(prepared: SeekerAuctionPrepared, reviewed: SeekerAuctionWithdrawRequest, pin: SeekerAuctionPin,
        wallet: String): PreparedSeekerAuction = verify(prepared, pin, wallet, reviewed.round, reviewed.spot, null, null)

    private suspend fun verify(prepared: SeekerAuctionPrepared, pin: SeekerAuctionPin, wallet: String, round: String, spot: Int,
        newTotalRaw: String?, total: ByteArray?): PreparedSeekerAuction {
        val player = key(wallet); val program = key(pin.programId); val mint = key(pin.mint)
        require(Ed25519.validatePublicKeyFull(player, 0)) { "The bidder must be a signing wallet" }
        require(setOf(wallet, pin.programId, pin.mint).size == 3) { "The wallet, auction program and mint must be distinct" }
        require(spot in 0..255) { "Invalid auction spot" } // The program's u8 seed width, not a spot count.
        val roundLe = realmSaleLe(round)
        val blockhash = key(prepared.blockhash)
        val message = decode(prepared.messageBase64)
        val parsed = unsignedSingleSignerTransaction(byteArrayOf(1) + ByteArray(64) + message, wallet)
        require(parsed.blockhash.contentEquals(blockhash)) { "The auction message is not for the quoted blockhash" }
        require(parsed.instructions.size in 1..2) { "Unexpected auction instruction count" }
        val setup = parsed.instructions.size == 2
        val config = realmSalePda(program, "auction_config").bytes
        val authority = realmSalePda(program, "seeker_authority").bytes
        val term = realmSalePda(program, "seeker_term", config, roundLe).bytes
        val auction = realmSalePda(program, "auction", config, byteArrayOf(spot.toByte()), roundLe).bytes
        val bid = realmSalePda(program, "bid", auction, player).bytes
        val source = publicKeyBytes(KeepDepositPayment.sourceAta(wallet, pin.mint))
        val vault = publicKeyBytes(KeepDepositPayment.sourceAta(base58(auction), pin.mint))
        val token = publicKeyBytes(TOKEN_PROGRAM); val system = ByteArray(32)
        fun meta(key: ByteArray, writable: Boolean = false, signer: Boolean = false) = AccountMeta(key, signer, writable)
        val instructions = buildList {
            if (total != null) {
                if (setup) add(Instruction(program, listOf(meta(player, true, true), meta(config), meta(auction), meta(bid, true),
                    meta(system)), openBid.copyOf()))
                add(Instruction(program, listOf(meta(player, signer = true), meta(authority), meta(config), meta(term),
                    meta(auction, true), meta(bid, true), meta(mint), meta(source, true), meta(vault, true), meta(token)), placeBid + total))
            } else {
                if (setup) add(Instruction(publicKeyBytes(ASSOCIATED_TOKEN_PROGRAM), listOf(meta(player, true, true), meta(source, true),
                    meta(player), meta(mint), meta(system), meta(token)), byteArrayOf(1)))
                add(Instruction(program, listOf(meta(player, signer = true), meta(config), meta(auction, true), meta(bid, true),
                    meta(mint), meta(source, true), meta(vault, true), meta(token)), withdrawBid.copyOf()))
            }
        }
        val expected = resolve(player, instructions)
        require(parsed.instructions.size == expected.size && parsed.instructions.indices.all { parsed.instructions[it].same(expected[it]) }) {
            "The auction message differs from the reviewed action"
        }
        // The parser already refused a key listed twice, so equal sets mean no unreviewed account rides along.
        val used = expected.flatMap { listOf(it.program) + it.accounts }.map { ByteBuffer.wrap(it.key) }.toSet()
        require(parsed.accounts.map { ByteBuffer.wrap(it.key) }.toSet() == used) { "The auction message carries an unreviewed account" }
        return PreparedSeekerAuction(wallet, round, spot, newTotalRaw, message)
    }

    /** Message-level privileges as a legacy compiler grants them: the union over every use of a key, the fee payer a
     * writable signer, a program id read-only. */
    private fun resolve(feePayer: ByteArray, instructions: List<Instruction>): List<ResolvedInstruction> {
        val privileges = HashMap<ByteBuffer, Pair<Boolean, Boolean>>()
        fun grant(key: ByteArray, signer: Boolean, writable: Boolean) {
            val at = ByteBuffer.wrap(key); val old = privileges[at]
            privileges[at] = if (old == null) signer to writable else (old.first || signer) to (old.second || writable)
        }
        grant(feePayer, signer = true, writable = true)
        for (ix in instructions) { grant(ix.programId, signer = false, writable = false); ix.keys.forEach { grant(it.key, it.signer, it.writable) } }
        fun account(key: ByteArray): ResolvedAccount {
            val (signer, writable) = privileges.getValue(ByteBuffer.wrap(key))
            return ResolvedAccount(key, signer, writable)
        }
        return instructions.map { ix -> ResolvedInstruction(account(ix.programId), ix.keys.map { account(it.key) }, ix.data) }
    }

    private fun key(value: String): ByteArray {
        require(value.length in 32..44) { "Invalid auction identity" }
        return publicKeyBytes(value).also { require(base58(it) == value && it.any { b -> b != 0.toByte() }) { "Noncanonical auction identity" } }
    }

    private fun decode(value: String): ByteArray {
        require(value.length % 4 == 0 && value.length <= MAX_MESSAGE_BYTES / 3 * 4 + 4 && canonicalBase64.matches(value)) {
            "Invalid auction message encoding"
        }
        val bytes = Base64.getDecoder().decode(value)
        require(bytes.size in 1..MAX_MESSAGE_BYTES && Base64.getEncoder().encodeToString(bytes) == value) { "Invalid auction message encoding" }
        return bytes
    }
}

/** Anchor's instruction discriminator, sha256("global:<name>")[0..8], computed from the reviewed name, never typed. */
private fun anchorDiscriminator(name: String): ByteArray =
    MessageDigest.getInstance("SHA-256").digest("global:$name".toByteArray(Charsets.UTF_8)).copyOf(8)
