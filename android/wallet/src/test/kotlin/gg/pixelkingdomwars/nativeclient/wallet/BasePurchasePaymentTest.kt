package gg.pixelkingdomwars.nativeclient.wallet

import java.math.BigInteger
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BasePurchasePaymentTest {
    private val fixture = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/base-purchase-wire.json")).readText()).jsonObject
    private val wallet = fixture["wallet"]!!.jsonPrimitive.content
    private val reference = fixture["reference"]!!.jsonPrimitive.content
    private val addresses = ChainAddresses.DEVNET
    private val vectors = fixture["vectors"]!!.jsonArray.map { it.jsonObject }
    private fun kind(row: JsonObject) = BasePurchaseKind.entries.single { it.wire == row["kind"]!!.jsonPrimitive.content }
    private fun destination(row: JsonObject) = row["destination"]!!.jsonPrimitive.contentOrNull
    private fun amount(row: JsonObject) = row["amountLamports"]!!.jsonPrimitive.content.toBigInteger()
    private fun rpc(balance: BigInteger, calls: MutableList<String>) = SolanaRpc { request ->
        val method = request["method"]!!.jsonPrimitive.content; calls += method
        val result = when (method) {
            "getLatestBlockhash" -> buildJsonObject { put("value", buildJsonObject { put("blockhash", fixture["blockhash"]!!); put("lastValidBlockHeight", 4242) }) }
            "getFeeForMessage" -> buildJsonObject { put("value", 5000) }
            "getBalance" -> buildJsonObject { put("value", JsonPrimitive(balance)) }
            else -> error("Preparation must never sign, broadcast, create or verify a deposit")
        }
        buildJsonObject { put("result", result) }
    }

    @Test fun `builder expansion Mine and Gold Forge bytes match actual current web builders`() = runBlocking {
        assertEquals(listOf("builder", "expansion", "mine", "goldforge"), vectors.map { it["label"]!!.jsonPrimitive.content })
        for (row in vectors) {
            val calls = mutableListOf<String>()
            val prepared = BasePurchasePayment.prepare(rpc(amount(row) + BigInteger.valueOf(5000), calls),
                addresses, kind(row), wallet, reference, amount(row), destination(row))
            assertArrayEquals(row["label"]!!.jsonPrimitive.content, Base64.getDecoder().decode(row["unsigned"]!!.jsonPrimitive.content), prepared.transaction)
            assertEquals(BigInteger.valueOf(5000), prepared.feeLamports)
            assertEquals("Saved with the attempt: it is what later proves a null signature status final", 4242L, prepared.lastValidBlockHeight)
            assertEquals(listOf("getLatestBlockhash", "getFeeForMessage", "getBalance"), calls)
            val ix = BasePurchasePayment.instruction(addresses, kind(row), wallet, reference, amount(row), destination(row))
            val actual = buildJsonObject {
                put("program", base58(ix.programId)); put("data", ix.data.joinToString("") { "%02x".format(it.toInt() and 255) })
                put("keys", JsonArray(ix.keys.map { key -> buildJsonObject {
                    put("address", base58(key.key)); put("signer", key.signer); put("writable", key.writable)
                } }))
            }
            assertEquals(row["instructions"]!!.jsonArray.single(), actual)
        }
    }

    @Test fun `network fee must be affordable without silently reducing the server quote`() = runBlocking {
        for (row in vectors) {
            val calls = mutableListOf<String>()
            assertThrows(IllegalStateException::class.java) { runBlocking {
                BasePurchasePayment.prepare(rpc(amount(row) + BigInteger.valueOf(4999), calls),
                    addresses, kind(row), wallet, reference, amount(row), destination(row))
            } }
            assertEquals(listOf("getLatestBlockhash", "getFeeForMessage", "getBalance"), calls)
        }
    }

    @Test fun `direct purchases cannot substitute recipients or use the historical program expansion rail`() {
        for (kind in listOf(BasePurchaseKind.EXPANSION, BasePurchaseKind.MINE)) {
            for (wrong in listOf(null, wallet, reference, addresses.treasuryDev)) {
                assertThrows(IllegalArgumentException::class.java) {
                    BasePurchasePayment.instruction(addresses, kind, wallet, reference, BigInteger.ONE, wrong)
                }
            }
            val ix = BasePurchasePayment.instruction(addresses, kind, wallet, reference, BigInteger.ONE, addresses.treasuryLiquidity)
            assertArrayEquals(ByteArray(32), ix.programId)
            assertEquals(3, ix.keys.size)
            assertEquals(reference, base58(ix.keys.last().key))
            assertFalse(ix.keys.last().signer); assertFalse(ix.keys.last().writable)
        }
        assertThrows(IllegalArgumentException::class.java) {
            BasePurchasePayment.instruction(addresses, BasePurchaseKind.BUILDER, wallet, reference, BigInteger.ONE, addresses.treasuryLiquidity)
        }
    }

    @Test fun `invalid amounts and account overlap fail before any RPC or wallet request`() = runBlocking {
        for (invalid in listOf(BigInteger.ZERO, BigInteger.valueOf(-1), BigInteger.ONE.shiftLeft(64))) {
            val calls = mutableListOf<String>()
            assertThrows(IllegalArgumentException::class.java) { runBlocking {
                BasePurchasePayment.prepare(rpc(BigInteger.TEN, calls), addresses, BasePurchaseKind.BUILDER, wallet, reference, invalid, null)
            } }
            assertTrue(calls.isEmpty())
        }
        for ((payer, ref) in listOf(wallet to wallet, wallet to addresses.config, addresses.treasuryLiquidity to reference,
            wallet to "bad", "bad" to reference)) {
            assertThrows(IllegalArgumentException::class.java) {
                BasePurchasePayment.instruction(addresses, BasePurchaseKind.BUILDER, payer, ref, BigInteger.ONE, null)
            }
        }
    }

    @Test fun `energy uses exact canonical buy_sink ABI3 or ABI7 accounts with quoted amount and no direct transfer`() {
        for ((kind, abi) in listOf(BasePurchaseKind.ENERGY to 3, BasePurchaseKind.ENERGY_PACK to 7)) {
            val amount = BigInteger("123456789012345")
            val ix = BasePurchasePayment.instruction(addresses, kind, wallet, reference, amount, null)
            assertEquals(addresses.coreProgram, base58(ix.programId))
            assertEquals(listOf(addresses.config, wallet, addresses.treasuryLiquidity, addresses.treasuryDev,
                addresses.treasuryOps, reference, "11111111111111111111111111111111"), ix.keys.map { base58(it.key) })
            assertEquals(listOf(false, true, false, false, false, false, false), ix.keys.map { it.signer })
            assertEquals(listOf(false, true, true, true, true, false, false), ix.keys.map { it.writable })
            val discriminator = java.security.MessageDigest.getInstance("SHA-256").digest("global:buy_sink".toByteArray()).take(8).toByteArray()
            assertArrayEquals(discriminator, ix.data.take(8).toByteArray()); assertEquals(17, ix.data.size)
            assertEquals(abi, ix.data[8].toInt())
            assertEquals(amount, BigInteger(1, ix.data.takeLast(8).reversed().toByteArray()))
            assertEquals(1, BasePurchasePayment.instructions(addresses, kind, wallet, reference, amount, null).size)
            assertThrows(IllegalArgumentException::class.java) { BasePurchasePayment.instruction(addresses, kind, wallet, reference, amount, addresses.treasuryLiquidity) }
        }
    }

    @Test fun `unsigned u64 encoding preserves its maximum exactly`() {
        val maximum = BigInteger.ONE.shiftLeft(64) - BigInteger.ONE
        for (kind in BasePurchaseKind.entries.filter { it != BasePurchaseKind.WARZONE_SHIELD }) {
            val ix = BasePurchasePayment.instruction(addresses, kind, wallet, reference, maximum,
                if (kind in setOf(BasePurchaseKind.BUILDER, BasePurchaseKind.SHIELD, BasePurchaseKind.ENERGY, BasePurchaseKind.ENERGY_PACK)) null else addresses.treasuryLiquidity)
            assertArrayEquals(ByteArray(8) { 0xff.toByte() }, ix.data.takeLast(8).toByteArray())
        }
    }
}
