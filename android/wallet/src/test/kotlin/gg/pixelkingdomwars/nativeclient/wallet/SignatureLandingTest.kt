package gg.pixelkingdomwars.nativeclient.wallet

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The app retires a saved payment on [SignatureLanding.NOT_FOUND], so this read must never turn an error, a
 * malformed reply, a landed transaction — or the null of a node that is merely behind — into "never landed". */
class SignatureLandingTest {
    private val signature = base58(ByteArray(64) { 17 })
    private val nullStatus = """{"result":{"context":{"slot":9},"value":[null]}}"""
    /** [height] answers `getBlockHeight`; every other method gets [status]. */
    private fun rpc(status: String, height: String = """{"result":501}""", seen: (JsonObject) -> Unit = {}) = SolanaRpc { body ->
        seen(body); Json.parseToJsonElement(if (body["method"]!!.jsonPrimitive.content == "getBlockHeight") height else status).jsonObject
    }
    private fun landing(status: String, lastValid: Long? = 500L, height: String = """{"result":501}""") = runBlocking { rpc(status, height).signatureLanding(signature, lastValid) }

    /** Rewritten: this pinned "one call, a null status is NOT_FOUND". The status call is unchanged; what changed is that
     * a null is believed only from a node that has FINALIZED past the payment's last valid block height, and that
     * height is read FIRST, so the node already held every block the transaction could be in when it answered null. */
    @Test fun `it reads the finalized height first, then exactly one signature with the full transaction history searched`() = runBlocking {
        val calls = mutableListOf<String>()
        val found = rpc(nullStatus) { body ->
            val method = body["method"]!!.jsonPrimitive.content; calls += method; val params = body["params"]!!.jsonArray
            if (method == "getBlockHeight") {
                // On the session relay's allowlist with only a commitment; finalized, so a fork can never count.
                assertEquals(listOf(buildJsonObject { put("commitment", "finalized") }), params.toList())
            } else {
                assertEquals("getSignatureStatuses", method); assertEquals(2, params.size)
                assertEquals(listOf(signature), params[0].jsonArray.map { it.jsonPrimitive.content })
                // The session relay rejects any other option; this one is what makes an old signature findable.
                assertEquals(buildJsonObject { put("searchTransactionHistory", true) }, params[1])
            }
        }.signatureLanding(signature, 500L)
        assertEquals(SignatureLanding.NOT_FOUND, found); assertEquals(listOf("getBlockHeight", "getSignatureStatuses"), calls)
    }
    /** A lagging or pruned node answers null for a transaction that landed. */
    @Test fun `a null status is never-landed only when the node finalized past the payment's last valid block height`() {
        assertEquals(SignatureLanding.NOT_FOUND, landing(nullStatus, 500L, """{"result":501}"""))
        assertEquals("AT the last valid height the transaction can still be processed", SignatureLanding.UNPROVEN, landing(nullStatus, 500L, """{"result":500}"""))
        assertEquals("A node that is behind", SignatureLanding.UNPROVEN, landing(nullStatus, 500L, """{"result":12}"""))
        // A payment saved without a height (a journal of the previous version): nothing to prove the null against.
        var heights = 0
        val legacy = runBlocking { rpc(nullStatus) { if (it["method"]!!.jsonPrimitive.content == "getBlockHeight") heights++ }.signatureLanding(signature, null) }
        assertEquals(SignatureLanding.UNPROVEN, legacy); assertEquals(0, heights)
        // The height read failed or is malformed: fail closed, never "past it".
        for (height in listOf("""{"error":{"code":-32005,"message":"node is behind"}}""", """{}""", """{"result":null}""", """{"result":"501"}""",
            """{"result":-1}""", """{"result":501.5}""", """{"result":{"value":501}}""")) {
            assertEquals(height, SignatureLanding.UNPROVEN, landing(nullStatus, 500L, height))
        }
    }
    @Test fun `a landed transaction is present whether it succeeded or is not final yet`() {
        assertEquals(SignatureLanding.PRESENT, landing("""{"result":{"value":[{"slot":5,"confirmations":null,"err":null,"confirmationStatus":"finalized"}]}}"""))
        assertEquals(SignatureLanding.PRESENT, landing("""{"result":{"value":[{"slot":5,"confirmations":3,"err":null,"confirmationStatus":"confirmed"}]}}"""))
        // An error that is not final yet proves nothing: the fork carrying it may still be dropped.
        assertEquals(SignatureLanding.PRESENT, landing("""{"result":{"value":[{"slot":5,"confirmations":0,"err":{"InstructionError":[0,"Custom"]},"confirmationStatus":"processed"}]}}"""))
        assertEquals(SignatureLanding.PRESENT, landing("""{"result":{"value":[{"slot":5,"err":"AccountInUse"}]}}"""))
    }
    @Test fun `only a finalized error means nothing was transferred, and it needs no block height`() {
        val failed = """{"result":{"value":[{"slot":5,"confirmations":null,"err":{"InstructionError":[2,{"Custom":1}]},"confirmationStatus":"finalized"}]}}"""
        assertEquals(SignatureLanding.FAILED_FINALIZED, landing(failed))
        // A failed height read must not hide a status the cluster does know.
        assertEquals(SignatureLanding.FAILED_FINALIZED, landing(failed, 500L, """{"error":{"code":-32005,"message":"node is behind"}}"""))
        assertEquals(SignatureLanding.FAILED_FINALIZED, landing(failed, null))
        assertEquals(SignatureLanding.PRESENT, landing("""{"result":{"value":[{"slot":5,"err":null,"confirmationStatus":"finalized"}]}}""", 500L, """{}"""))
    }
    @Test fun `an RPC error or any malformed reply throws instead of reading as never landed`() {
        for (reply in listOf("""{"error":{"code":-32005,"message":"node is behind"}}""", """{}""", """{"result":null}""", """{"result":{"value":null}}""",
            """{"result":{"value":[]}}""", """{"result":{"value":[null,null]}}""", """{"result":{"value":["finalized"]}}""", """{"result":{"value":[{"slot":5}]}}""")) {
            assertThrows(reply, java.io.IOException::class.java) { landing(reply) }
        }
    }
    /** The height the node reports with a blockhash is what the app saves with the attempt. Callers that only need the
     * hash are unchanged, and a node that reports no height yields null — which can never retire on a null status. */
    @Test fun `the recent blockhash carries its last valid block height without changing the hash callers`() = runBlocking {
        val hash = base58(ByteArray(32) { 7 })
        fun node(value: String) = SolanaRpc { Json.parseToJsonElement("""{"result":{"context":{"slot":1},"value":$value}}""").jsonObject }
        val recent = node("""{"blockhash":"$hash","lastValidBlockHeight":4242}""").recentBlockhash()
        assertArrayEquals(ByteArray(32) { 7 }, recent.hash); assertEquals(4242L, recent.lastValidBlockHeight)
        assertArrayEquals(ByteArray(32) { 7 }, node("""{"blockhash":"$hash","lastValidBlockHeight":4242}""").latestBlockhash())
        for (absent in listOf("""{"blockhash":"$hash"}""", """{"blockhash":"$hash","lastValidBlockHeight":"4242"}""", """{"blockhash":"$hash","lastValidBlockHeight":0}""",
            """{"blockhash":"$hash","lastValidBlockHeight":null}""")) {
            val r = node(absent).recentBlockhash(); assertArrayEquals(ByteArray(32) { 7 }, r.hash); assertNull(absent, r.lastValidBlockHeight)
        }
    }
}
