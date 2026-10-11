package gg.pixelkingdomwars.nativeclient.wallet

import java.math.BigInteger
import java.util.Base64
import java.util.concurrent.atomic.AtomicLong
import kotlinx.serialization.json.*

class SolanaRpcException(message: String, val code: Long? = null) : java.io.IOException(message)

/** What the cluster knows about one payment signature, with its full transaction history searched.
 *  - [NOT_FOUND]: the cluster has never processed it AND the node that says so has FINALIZED past the last block
 *    height the payment's blockhash was valid for, so it can never land and the node is not merely behind.
 *  - [UNPROVEN]: the status is null, but that expiry is not proven: no last-valid height was recorded with the
 *    payment, the node's finalized height has not passed it, or the height read failed. A lagging or pruned node
 *    answers null for a transaction that landed, so this never retires a payment.
 *  - [FAILED_FINALIZED]: it is finalized WITH an error. A Solana transaction is atomic, so none of its transfers
 *    happened (only the network fee was spent), and a processed signature can never run again.
 *  - [PRESENT]: anything else — it succeeded, or it is not final yet. Money may have moved. */
enum class SignatureLanding { NOT_FOUND, FAILED_FINALIZED, PRESENT, UNPROVEN }

/** A recent blockhash and the last block height a transaction naming it can still be processed at. The height is
 * null only when the node did not report one; a payment prepared without it can never be retired on a null status. */
class RecentBlockhash(val hash: ByteArray, val lastValidBlockHeight: Long?)

/** The few JSON-RPC reads the land checkout needs, over a caller-supplied transport (the session
 * relay or a public cluster endpoint). Every value is exact: lamports as [BigInteger], never a float. */
class SolanaRpc(private val call: suspend (JsonObject) -> JsonObject) {
    private val sequence = AtomicLong(1)

    private suspend fun invoke(method: String, params: JsonArray): JsonElement {
        val response = call(buildJsonObject { put("jsonrpc", "2.0"); put("id", sequence.getAndIncrement()); put("method", method); put("params", params) })
        (response["error"] as? JsonObject)?.let { error ->
            throw SolanaRpcException(error.string("message") ?: "RPC $method failed", (error["code"] as? JsonPrimitive)?.longOrNull)
        }
        return response["result"] ?: throw SolanaRpcException("RPC $method returned no result")
    }
    private fun JsonObject.string(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull
    private fun lamports(element: JsonElement?): BigInteger {
        val text = (element as? JsonPrimitive)?.contentOrNull ?: throw SolanaRpcException("SOL funding estimate unavailable")
        require(text.matches(Regex("0|[1-9][0-9]*"))) { "SOL funding estimate unavailable" }
        return BigInteger(text)
    }

    suspend fun latestBlockhash(): ByteArray = recentBlockhash().hash
    suspend fun genesisHash(): String {
        val value = invoke("getGenesisHash", buildJsonArray {}) as? JsonPrimitive
        require(value?.isString == true) { "Network identity unavailable" }
        return value.content.also { publicKeyBytes(it) }
    }
    suspend fun confirmedBlockHeight(): Long {
        val value = invoke("getBlockHeight", buildJsonArray { add(buildJsonObject { put("commitment", "confirmed") }) }) as? JsonPrimitive
        return value?.takeUnless { it.isString }?.longOrNull?.takeIf { it >= 0 } ?: throw SolanaRpcException("Block height unavailable")
    }
    suspend fun recentBlockhash(): RecentBlockhash {
        val result = invoke("getLatestBlockhash", buildJsonArray { add(buildJsonObject { put("commitment", "confirmed") }) }) as? JsonObject
        val value = result?.get("value") as? JsonObject
        val hash = publicKeyBytes(value?.string("blockhash") ?: throw SolanaRpcException("Recent blockhash unavailable"))
        val lastValid = (value?.get("lastValidBlockHeight") as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull?.takeIf { it > 0 }
        return RecentBlockhash(hash, lastValid)
    }
    /** FINALIZED block height: every block at or below it is final on the answering node. */
    suspend fun finalizedBlockHeight(): Long {
        val result = invoke("getBlockHeight", buildJsonArray { add(buildJsonObject { put("commitment", "finalized") }) })
        return (result as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull?.takeIf { it >= 0 } ?: throw SolanaRpcException("Block height unavailable")
    }
    suspend fun balanceLamports(address: String): BigInteger {
        val result = invoke("getBalance", buildJsonArray { add(address); add(buildJsonObject { put("commitment", "confirmed") }) }) as? JsonObject
        return lamports(result?.get("value"))
    }
    suspend fun accountExists(address: String): Boolean {
        val result = invoke("getAccountInfo", buildJsonArray { add(address); add(buildJsonObject { put("commitment", "confirmed"); put("encoding", "base64") }) }) as? JsonObject
            ?: throw SolanaRpcException("Account lookup unavailable")
        return result["value"] is JsonObject
    }
    suspend fun minimumBalanceForRentExemption(bytes: Int): BigInteger =
        lamports(invoke("getMinimumBalanceForRentExemption", buildJsonArray { add(bytes); add(buildJsonObject { put("commitment", "confirmed") }) }))
    suspend fun feeForMessage(message: ByteArray): BigInteger {
        val encoded = Base64.getEncoder().encodeToString(message)
        val result = invoke("getFeeForMessage", buildJsonArray { add(encoded); add(buildJsonObject { put("commitment", "confirmed") }) }) as? JsonObject
        return lamports(result?.get("value"))
    }

    suspend fun tokenBalance(address: String, expectedDecimals: Int): BigInteger {
        val result = invoke("getTokenAccountBalance", buildJsonArray { add(address); add(buildJsonObject { put("commitment", "confirmed") }) }) as? JsonObject
        val value = result?.get("value") as? JsonObject ?: throw SolanaRpcException("KEEP token balance unavailable")
        require((value["decimals"] as? JsonPrimitive)?.intOrNull == expectedDecimals) { "KEEP mint decimals changed" }
        return lamports(value["amount"])
    }

    /** Read-only `getSignatureStatuses` with `searchTransactionHistory`, so an old signature is not reported missing
     * just because it left the recent-status cache. Every unexpected shape throws: a caller that retires a payment
     * on [SignatureLanding.NOT_FOUND] must never read a malformed reply as "never landed".
     *
     * A null status alone proves nothing (a lagging or pruned node says null for a landed transaction), so it is
     * [SignatureLanding.NOT_FOUND] only when the node has FINALIZED past [lastValidBlockHeight], the height recorded
     * with the payment's blockhash. The height is read BEFORE the status: a node already final past that height has
     * every block the transaction could be in, so its later null is an answer about all of them. A failed height
     * read does not hide a status the cluster does know; it only leaves a null one [SignatureLanding.UNPROVEN]. */
    suspend fun signatureLanding(signature: String, lastValidBlockHeight: Long?): SignatureLanding {
        val expired = lastValidBlockHeight != null && try { finalizedBlockHeight() > lastValidBlockHeight }
            catch (e: kotlin.coroutines.cancellation.CancellationException) { throw e }
            catch (_: Exception) { false }
        val result = invoke("getSignatureStatuses", buildJsonArray {
            add(buildJsonArray { add(signature) }); add(buildJsonObject { put("searchTransactionHistory", true) })
        }) as? JsonObject
        val statuses = result?.get("value") as? JsonArray ?: throw SolanaRpcException("Signature status unavailable")
        if (statuses.size != 1) throw SolanaRpcException("Signature status unavailable")
        val status = statuses[0]
        if (status is JsonNull) return if (expired) SignatureLanding.NOT_FOUND else SignatureLanding.UNPROVEN
        if (status !is JsonObject || "err" !in status) throw SolanaRpcException("Signature status unavailable")
        val failed = status["err"] !is JsonNull
        return if (failed && status.string("confirmationStatus") == "finalized") SignatureLanding.FAILED_FINALIZED else SignatureLanding.PRESENT
    }

    /** One explicit broadcast, no RPC retries. A lost/error reply is uncertain even with skipPreflight=false. */
    suspend fun sendTransaction(signed: ByteArray, expectedSignature: String): String {
        val result = invoke("sendTransaction", buildJsonArray {
            add(Base64.getEncoder().encodeToString(signed))
            add(buildJsonObject { put("encoding", "base64"); put("skipPreflight", false); put("preflightCommitment", "confirmed"); put("maxRetries", 0) })
        })
        val signature = (result as? JsonPrimitive)?.contentOrNull
        require(signature == expectedSignature) { "The RPC returned a different payment signature" }
        return expectedSignature
    }
}
