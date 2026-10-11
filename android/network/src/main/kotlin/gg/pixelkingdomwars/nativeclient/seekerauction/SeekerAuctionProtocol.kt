@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
package gg.pixelkingdomwars.nativeclient.seekerauction

import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import java.math.BigInteger
import java.util.Base64
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** Inject ONLY from the admitted generated constants catalogue, not the response being validated.
 * No auction layout, page size, token identity, time or economic default lives in this package.
 */
data class SeekerAuctionProtocolPolicy(val totalSpots: Int, val kingSpots: Int, val realmCount: Int,
    val regularRealmCount: Int, val refundPageSize: Int) {
    fun validate() {
        require(totalSpots > 0 && kingSpots in 0..totalSpots)
        require(realmCount in 1..30 && regularRealmCount in 1..realmCount) // Signed Int mask representation.
        require(refundPageSize > 0)
    }
    fun spot(value: Int) { require(value in 0 until totalSpots) }
    fun realmMask(index: Int): Int {
        spot(index)
        if (index < kingSpots) return (1 shl realmCount) - 1
        var mask = 0
        repeat(regularRealmCount) { n -> mask = mask or (1 shl ((index.toLong() - kingSpots + n) % realmCount).toInt()) }
        return mask
    }
}

@Serializable data class SeekerAuctionConfig(val programId: String, val address: String, val mint: String,
    val prizeOwner: String, val prizeAta: String, val decimals: Int, val openingBidRaw: String,
    val firstOperatingStart: String, val termSec: String, val auctionSec: String, val graceSec: String)
@Serializable data class SeekerAuctionSpot(val spot: Int, @SerialName("class") val spotClass: String,
    val realmMask: Int, val opened: Boolean, val highBidRaw: String, val highBidder: String?,
    val settled: Boolean, val yourBidRaw: String, val refundable: Boolean)
@Serializable data class SeekerAuctionSourcedRoundView(val version: Int, val source: String, val chainUnixTime: String,
    val walletSkrRaw: String?, val wallet: String, val observedSlot: String, val round: String, val biddingRound: String,
    val admissionPaused: Boolean, val config: SeekerAuctionConfig, val auctionStart: String, val auctionEnd: String,
    val operatingStart: String, val operatingEnd: String, val openedCount: Int, val completedCount: Int,
    val winnerCount: Int, val completedAt: String?, val spots: List<SeekerAuctionSpot>) {
    /** An observed window only, not canTransact or a signing grant. Future N2 must bind registry identity,
     * current session and Seal and let the server recheck the exact amount at prepare/submit.
     */
    fun bidWindowOpen(spot: Int): Boolean {
        val row = spots.singleOrNull { it.spot == spot } ?: return false
        return source == "chain" && round == biddingRound && !admissionPaused && openedCount == spots.size &&
            row.opened && !row.settled && auctionI64(chainUnixTime) >= auctionI64(auctionStart) &&
            auctionI64(chainUnixTime) < auctionI64(auctionEnd)
    }
}
@Serializable data class SeekerAuctionPrepared(val messageBase64: String, val blockhash: String,
    val lastValidBlockHeight: String, val incrementRaw: String, val networkFeeLamports: String, val newAccountRentLamports: String)
@Serializable data class SeekerAuctionTxStatus(val signature: String, val status: String, val slot: String?, val error: String?,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val found: Boolean? = null,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val finalizedBlockHeight: String? = null) {
    fun validate() {
        auctionSignature(signature); slot?.let(::auctionU64); finalizedBlockHeight?.let(::auctionU64)
        require((found == null) == (finalizedBlockHeight == null))
        when (status) {
            "pending" -> require(slot == null && error == null)
            "finalized" -> require(slot != null && error == null && found != false)
            "failed" -> require(slot != null && error == "CHAIN_TRANSACTION_FAILED" && found != false)
            else -> throw IllegalArgumentException("Unknown auction observation")
        }
    }
}
@Serializable data class SeekerAuctionRefundCursor(val round: String, val spot: Int)
@Serializable data class SeekerAuctionRefundEntry(val bid: String, val auction: String, val round: String,
    val spot: Int, val amountRaw: String)
@Serializable data class SeekerAuctionRefundsPage(val version: Int, val source: String, val wallet: String,
    val observedSlot: String, val chainUnixTime: String, val programId: String, val config: String,
    val mint: String, val decimals: Int, val entries: List<SeekerAuctionRefundEntry>, val nextCursor: SeekerAuctionRefundCursor?)

/** Strict S2/S4 transport parity at 8a18d143. Parsing is shape/provenance validation, not chain attestation. */
class SeekerAuctionProtocol(val policy: SeekerAuctionProtocolPolicy) {
    init { policy.validate() }
    private val json = Json { ignoreUnknownKeys = false; isLenient = false; coerceInputValues = false }
    private fun <T> decode(raw: JsonObject, serializer: DeserializationStrategy<T>): T {
        strictPrimitives(raw, serializer.descriptor)
        return json.decodeFromJsonElement(serializer, raw)
    }
    fun round(raw: JsonObject): SeekerAuctionSourcedRoundView = decode(raw, SeekerAuctionSourcedRoundView.serializer()).also { v ->
        require(v.version == 1 && v.source in setOf("chain", "fixture")); auctionAddress(v.wallet)
        auctionI64(v.chainUnixTime); v.walletSkrRaw?.let(::auctionU64)
        listOf(v.observedSlot, v.round, v.biddingRound).forEach(::auctionU64)
        val c = v.config
        listOf(c.programId, c.address, c.mint, c.prizeOwner, c.prizeAta).forEach(::auctionAddress)
        require(c.decimals in 0..255)
        listOf(c.openingBidRaw, c.termSec, c.auctionSec, c.graceSec).forEach(::auctionU64)
        listOf(c.firstOperatingStart, v.auctionStart, v.auctionEnd, v.operatingStart, v.operatingEnd).forEach(::auctionI64)
        v.completedAt?.let(::auctionI64)
        require(auctionU64(c.openingBidRaw) > 0uL && auctionU64(c.termSec) > 0uL && auctionU64(c.auctionSec) > 0uL &&
            auctionU64(c.auctionSec) <= auctionU64(c.termSec))
        // Wide intermediate arithmetic detects calendars that cannot fit the canonical I64 fields.
        val start = c.firstOperatingStart.toBigInteger() + v.round.toBigInteger() * c.termSec.toBigInteger()
        require(v.operatingStart.toBigInteger() == start && v.auctionEnd.toBigInteger() == start &&
            v.auctionStart.toBigInteger() == start - c.auctionSec.toBigInteger() &&
            v.operatingEnd.toBigInteger() == start + c.termSec.toBigInteger())
        require(v.spots.size == policy.totalSpots)
        require(listOf(v.openedCount, v.completedCount, v.winnerCount).all { it in 0..policy.totalSpots })
        require(v.openedCount == v.spots.count { it.opened } && v.completedCount == v.spots.count { it.settled } &&
            v.winnerCount == v.spots.count { it.settled && it.highBidder != null })
        require((v.completedAt != null) == (v.completedCount == policy.totalSpots))
        v.completedAt?.let { require(auctionI64(it) >= auctionI64(v.auctionEnd)) }
        v.spots.forEachIndexed { index, s ->
            require(s.spot == index && s.spotClass == (if (index < policy.kingSpots) "king" else "regular"))
            require(s.realmMask == policy.realmMask(index))
            val high = auctionU64(s.highBidRaw); val own = auctionU64(s.yourBidRaw); s.highBidder?.let(::auctionAddress)
            require((high == 0uL) == (s.highBidder == null))
            if (s.highBidder != null) require(high >= auctionU64(c.openingBidRaw))
            if (!s.opened) require(!s.settled && high == 0uL && own == 0uL)
            require(s.refundable == (own > 0uL && s.highBidder != v.wallet))
        }
    }
    fun prepared(raw: JsonObject): SeekerAuctionPrepared = decode(raw, SeekerAuctionPrepared.serializer()).also {
        auctionBase64(it.messageBase64); auctionAddress(it.blockhash)
        listOf(it.lastValidBlockHeight, it.incrementRaw, it.networkFeeLamports, it.newAccountRentLamports).forEach(::auctionU64)
    }
    fun status(raw: JsonObject): SeekerAuctionTxStatus {
        // Optional means absent, not explicit null; this distinction carries lost-POST uncertainty.
        require(("found" in raw) == ("finalizedBlockHeight" in raw))
        if ("found" in raw) require(raw["found"] != JsonNull && raw["finalizedBlockHeight"] != JsonNull)
        return decode(raw, SeekerAuctionTxStatus.serializer()).also { it.validate() }
    }
    fun cursor(value: SeekerAuctionRefundCursor) { auctionU64(value.round); policy.spot(value.spot) }
    fun refunds(raw: JsonObject): SeekerAuctionRefundsPage = decode(raw, SeekerAuctionRefundsPage.serializer()).also { v ->
        require(v.version == 1 && v.source == "chain" && v.decimals in 0..19)
        listOf(v.wallet, v.programId, v.config, v.mint).forEach(::refundAddress)
        auctionU64(v.observedSlot); auctionI64(v.chainUnixTime); require(v.entries.size <= policy.refundPageSize)
        val bids = mutableSetOf<String>(); val auctions = mutableSetOf<String>()
        v.entries.forEachIndexed { i, row ->
            refundAddress(row.bid); refundAddress(row.auction); cursor(SeekerAuctionRefundCursor(row.round, row.spot))
            require(auctionU64(row.amountRaw) > 0uL && bids.add(row.bid) && auctions.add(row.auction))
            if (i > 0) { val prior = v.entries[i - 1]; require(auctionKeyAfter(row.round, row.spot, SeekerAuctionRefundCursor(prior.round, prior.spot))) }
        }
        v.nextCursor?.let { next ->
            cursor(next); require(v.entries.size == policy.refundPageSize)
            val last = v.entries.last(); require(next.round == last.round && next.spot == last.spot)
        }
    }
}

internal fun auctionU64(value: String): ULong {
    require(value.length <= 20 && value.matches(Regex("0|[1-9][0-9]*")))
    return requireNotNull(value.toULongOrNull())
}
internal fun auctionI64(value: String): Long {
    require(value.length <= 20 && value.matches(Regex("0|-?[1-9][0-9]*")))
    return requireNotNull(value.toLongOrNull())
}
internal fun auctionAddress(value: String) { require(value.length in 32..44); auctionBase58(value, 32) }
internal fun auctionSignature(value: String) { auctionSignatureBytes(value) }
internal fun auctionSignatureBytes(value: String): ByteArray {
    require(value.length in 64..88 && value.any { it != '1' })
    return auctionBase58(value, 64)
}
private fun auctionBase58(value: String, bytes: Int): ByteArray {
    val alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    var n = BigInteger.ZERO
    value.forEach { c -> val digit = alphabet.indexOf(c); require(digit >= 0); n = n * BigInteger.valueOf(58) + BigInteger.valueOf(digit.toLong()) }
    require((n.bitLength() + 7) / 8 + value.takeWhile { it == '1' }.length == bytes)
    val signedMagnitude = n.toByteArray()
    val magnitude = if (signedMagnitude.first() == 0.toByte()) signedMagnitude.copyOfRange(1, signedMagnitude.size) else signedMagnitude
    return ByteArray(bytes - magnitude.size) + magnitude
}
private fun refundAddress(value: String) { auctionAddress(value); require(value != "1".repeat(32)) }
internal fun auctionBase64(value: String, minimumBytes: Int = 1): ByteArray {
    // Solana wire/message envelope size from S2, not an economy/game parameter.
    require(value.length <= 1644 && value.length % 4 == 0)
    require(value.matches(Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")))
    val bytes = Base64.getDecoder().decode(value)
    require(bytes.size in minimumBytes..1232 && Base64.getEncoder().encodeToString(bytes) == value)
    return bytes
}
internal fun auctionKeyAfter(round: String, spot: Int, cursor: SeekerAuctionRefundCursor): Boolean =
    auctionU64(round) > auctionU64(cursor.round) || round == cursor.round && spot > cursor.spot
