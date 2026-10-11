package gg.pixelkingdomwars.nativeclient.wallet

import java.math.BigInteger
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class KeepDepositPaymentTest {
    private val wallet = "DnF3JgFtAEdF7Gkcdne5DMtwyLE1S25Uyb9ip4FEfVUX"
    private val source = "D37fYaEdaF9BcUJ65gojUC4ChS9r9k9fVRHK2fdxvbk8"
    private val destination = "6Ckm2BrnXxsSjyG5b17kQQRjoECVrts92RKXVGT8XeqS"
    private val reference = "6ws1bVyu3F8wGy1fPHhrc2v8UyWiGbRAAuek8SwikKPD"
    private val amount = BigInteger("17000000000")
    private val mint = ChainAddresses.DEVNET.keepMint
    // Produced with canonical source6d69d675's @solana/web3.js and web buildKeepDepositTx accounts/data.
    private val golden = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAMGveNBGjjf2RYtW6hJE5sW9pK8gHeOt66j4rbm9jfmIexNTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTbLW8Lxba5LX5w4xJUY5XxOQQskIjjIFtrqDFyoKUHXFP2E/jRHkoWFW2QviX6Wcbwx5r60u3tCBGKMI9Gam4FFYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWAbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2MBBQUCAwEABAoMAGpH9QMAAAAJ"
    private fun rpc(calls: MutableList<String> = mutableListOf(), sol: Long = 5000, token: String = amount.toString(), decimals: Int = 9): SolanaRpc = SolanaRpc { body ->
        val method = body["method"]!!.jsonPrimitive.content; calls += method
        val value = when (method) {
            "getLatestBlockhash" -> buildJsonObject { put("value", buildJsonObject { put("blockhash", base58(ByteArray(32) { 99 })); put("lastValidBlockHeight", 4242) }) }
            "getFeeForMessage" -> buildJsonObject { put("value", 5000) }
            "getBalance" -> buildJsonObject { put("value", sol) }
            "getTokenAccountBalance" -> buildJsonObject { put("value", buildJsonObject { put("amount", token); put("decimals", decimals) }) }
            else -> error("Unexpected RPC $method")
        }
        buildJsonObject { put("result", value) }
    }
    @Test fun `SPL transfer matches web account privileges instruction bytes and complete legacy wire vector`() = runBlocking {
        assertEquals(source, KeepDepositPayment.sourceAta(wallet, mint))
        val ix = KeepDepositPayment.instruction(wallet, source, destination, mint, reference, amount, 9)
        assertArrayEquals(byteArrayOf(12, 0, 106, 71, -11, 3, 0, 0, 0, 9), ix.data)
        assertEquals(listOf(source, mint, destination, wallet, reference), ix.keys.map { base58(it.key) })
        assertEquals(listOf(false, false, false, true, false), ix.keys.map { it.signer })
        assertEquals(listOf(true, false, true, false, false), ix.keys.map { it.writable })
        val calls = mutableListOf<String>()
        val payment = KeepDepositPayment.prepare(rpc(calls), wallet, source, destination, mint, reference, amount, 9)
        assertArrayEquals(Base64.getDecoder().decode(golden), payment.transaction)
        assertEquals(listOf("getLatestBlockhash", "getFeeForMessage", "getBalance", "getTokenAccountBalance"), calls)
        assertEquals(BigInteger.valueOf(5000), payment.feeLamports)
        assertEquals("Saved with the attempt: it is what later proves a null signature status final", 4242L, payment.lastValidBlockHeight)
    }
    @Test fun `wrong ATA insufficient SOL insufficient KEEP changed decimals and u64 overflow never reach wallet`() = runBlocking {
        suspend fun prepare(rpc: SolanaRpc, source: String = this@KeepDepositPaymentTest.source) = KeepDepositPayment.prepare(rpc, wallet, source, destination, mint, reference, amount, 9)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { prepare(rpc(), reference) } }
        assertThrows(IllegalStateException::class.java) { runBlocking { prepare(rpc(sol = 4999)) } }
        assertThrows(IllegalStateException::class.java) { runBlocking { prepare(rpc(token = "16999999999")) } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { prepare(rpc(decimals = 6)) } }
        assertThrows(IllegalArgumentException::class.java) { KeepDepositPayment.instruction(wallet, source, destination, mint, reference, BigInteger.ONE.shiftLeft(64), 9) }
        assertThrows(IllegalArgumentException::class.java) { KeepDepositPayment.instruction(wallet, source, destination, mint, reference, BigInteger.ZERO, 9) }
        Unit
    }
    @Test fun `only the unchanged singly signed payment yields a durable signature`() {
        val original = Base64.getDecoder().decode(golden)
        val signed = original.copyOf().apply { (1..64).forEach { this[it] = 17 } }
        assertArrayEquals(ByteArray(64) { 17 }, paymentTransactionSignature(original, signed, wallet))
        assertThrows(IllegalArgumentException::class.java) { paymentTransactionSignature(original, original, wallet) }
        assertThrows(IllegalArgumentException::class.java) { paymentTransactionSignature(original, signed.copyOf().apply { this[lastIndex] = 8 }, wallet) }
        assertThrows(IllegalArgumentException::class.java) { paymentTransactionSignature(original, signed, reference) }
    }
    @Test fun `broadcast has exact signed bytes no retries and cannot accept another transaction ID`() = runBlocking {
        val signed = byteArrayOf(1,2,3); val signature = base58(ByteArray(64) { 17 }); var calls = 0
        val rpc = SolanaRpc { body ->
            calls++; assertEquals("sendTransaction", body["method"]!!.jsonPrimitive.content)
            val params = body["params"]!!.jsonArray
            assertEquals(Base64.getEncoder().encodeToString(signed), params[0].jsonPrimitive.content)
            val options = params[1].jsonObject
            assertEquals(0, options["maxRetries"]!!.jsonPrimitive.int); assertFalse(options["skipPreflight"]!!.jsonPrimitive.boolean)
            buildJsonObject { put("result", "another signature") }
        }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { rpc.sendTransaction(signed, signature) } }; assertEquals(1, calls)
        assertTrue(KeepDepositPayment.validSignature(signature)); assertFalse(KeepDepositPayment.validSignature("missing"))
    }
}
