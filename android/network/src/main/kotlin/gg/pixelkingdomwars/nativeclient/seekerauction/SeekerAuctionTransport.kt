package gg.pixelkingdomwars.nativeclient.seekerauction

import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.serialization.json.*

/** PORT ONLY: no HTTP implementation, cookie store, wallet call, polling, retry or generic API fallback.
 * The future application binding must use one authenticated session, private/no-store transport, no redirects,
 * and bounded strict JSON. It must drain an owned response through retain BEFORE changed-session/cancellation
 * publication checks. The callback is idempotent. Exceptions keep their original HTTP/code semantics.
 */
interface SeekerAuctionAuthenticatedPort {
    val identity: StarterIdentity
    suspend fun request(method: String, path: String, query: Map<String, String>, body: JsonObject?,
        guard: () -> Unit, retain: suspend (JsonObject) -> Unit): JsonObject
}

data class SeekerAuctionBidRequest(val round: String, val spot: Int, val newTotalRaw: String)
data class SeekerAuctionWithdrawRequest(val round: String, val spot: Int)
sealed interface SeekerAuctionSubmission {
    /** expectedSignature is local retained identity, never sent as an extra body field. N2's verifier must derive it
     * from the unchanged wallet-signed bytes and persist those bytes/intent before invoking this port.
     */
    data class SignedWire(val signedTransaction: String, val expectedSignature: String) : SeekerAuctionSubmission
    data class ObserveSignature(val signature: String) : SeekerAuctionSubmission
}

class SeekerAuctionTransport(private val port: SeekerAuctionAuthenticatedPort, policy: SeekerAuctionProtocolPolicy) {
    val identity = port.identity.copy().also { it.validate(); require(it.origin.startsWith("https://")) }
    private val protocol = SeekerAuctionProtocol(policy)
    private suspend fun <T> call(method: String, path: String, query: Map<String, String> = emptyMap(), body: JsonObject? = null,
        guard: () -> Unit, parse: (JsonObject) -> T, retain: suspend (T) -> Unit): T {
        val current = { guard(); check(port.identity == identity) { "Auction session changed; keep original evidence." } }
        current()
        var retained: Pair<JsonObject, T>? = null
        suspend fun record(raw: JsonObject): T {
            retained?.let {
                check(it.first == raw) { "Auction port changed its drained response; keep original evidence." }
                return it.second
            }
            val value = parse(raw)
            retain(value)
            retained = raw to value
            return value
        }
        val raw = port.request(method, path, query, body, current) { record(it) }
        check(retained?.first?.let { it == raw } != false) { "Auction port returned a different response; keep original evidence." }
        val value = record(raw) // Also retains when the port returns without an early drain.
        current()
        return value
    }
    suspend fun current(guard: () -> Unit = {}): SeekerAuctionSourcedRoundView =
        call("GET", "/seeker/auctions/current", guard = guard,
            parse = { protocol.round(it).also { v -> require(v.wallet == identity.wallet) } }, retain = {})

    suspend fun round(round: String, guard: () -> Unit = {}): SeekerAuctionSourcedRoundView {
        auctionU64(round)
        return call("GET", "/seeker/auctions/round/$round", guard = guard,
            parse = { protocol.round(it).also { v -> require(v.wallet == identity.wallet && v.round == round) } }, retain = {})
    }
    suspend fun refunds(after: SeekerAuctionRefundCursor? = null, guard: () -> Unit = {}): SeekerAuctionRefundsPage {
        after?.let(protocol::cursor)
        val query = after?.let { mapOf("round" to it.round, "spot" to it.spot.toString()) } ?: emptyMap()
        return call("GET", "/seeker/auctions/refunds", query, guard = guard,
            parse = { protocol.refunds(it).also { v ->
                require(v.wallet == identity.wallet)
                if (after != null) require(v.entries.all { row -> auctionKeyAfter(row.round, row.spot, after) })
            } }, retain = {})
    }
    suspend fun status(signature: String, guard: () -> Unit = {}, retain: suspend (SeekerAuctionTxStatus) -> Unit = {}): SeekerAuctionTxStatus {
        auctionSignature(signature)
        return call("GET", "/seeker/auctions/tx/$signature", guard = guard,
            parse = { protocol.status(it).also { v -> require(v.signature == signature) } }, retain = retain)
    }
    suspend fun prepareBid(request: SeekerAuctionBidRequest, guard: () -> Unit = {},
        retain: suspend (SeekerAuctionPrepared) -> Unit = {}): SeekerAuctionPrepared {
        auctionU64(request.round); protocol.policy.spot(request.spot); require(auctionU64(request.newTotalRaw) > 0uL)
        val body = buildJsonObject { put("round", request.round); put("spot", request.spot); put("newTotalRaw", request.newTotalRaw) }
        return call("POST", "/seeker/auctions/bids/prepare", body = body, guard = guard, parse = protocol::prepared, retain = retain)
    }
    suspend fun prepareWithdrawal(request: SeekerAuctionWithdrawRequest, guard: () -> Unit = {},
        retain: suspend (SeekerAuctionPrepared) -> Unit = {}): SeekerAuctionPrepared {
        auctionU64(request.round); protocol.policy.spot(request.spot)
        val body = buildJsonObject { put("round", request.round); put("spot", request.spot) }
        return call("POST", "/seeker/auctions/withdrawals/prepare", body = body, guard = guard, parse = protocol::prepared, retain = retain)
    }
    suspend fun submit(request: SeekerAuctionSubmission, guard: () -> Unit = {},
        retain: suspend (SeekerAuctionTxStatus) -> Unit = {}): SeekerAuctionTxStatus {
        val signature: String
        val body = when (request) {
            is SeekerAuctionSubmission.SignedWire -> {
                val wire = auctionBase64(request.signedTransaction, minimumBytes = 66)
                signature = request.expectedSignature
                // One canonical shortvec signature; bind the retained identity BEFORE any possible relay.
                require(wire[0] == 0x01.toByte() && wire.copyOfRange(1, 65).contentEquals(auctionSignatureBytes(signature))) {
                    "Signed auction bytes do not match the retained signature."
                }
                buildJsonObject { put("signedTransaction", request.signedTransaction) }
            }
            is SeekerAuctionSubmission.ObserveSignature -> {
                signature = request.signature; buildJsonObject { put("signature", signature) }
            }
        }
        auctionSignature(signature)
        return call("POST", "/seeker/auctions/submit", body = body, guard = guard,
            parse = { protocol.status(it).also { v -> require(v.signature == signature) } }, retain = retain)
    }
}
