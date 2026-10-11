package gg.pixelkingdomwars.nativeclient.wallet

import java.math.BigInteger
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ShieldPaymentTest {
    private val fixture = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/shield-purchase-wire.json")).readText()).jsonObject
    private val wallet = fixture.getValue("wallet").jsonPrimitive.content
    private val reference = fixture.getValue("reference").jsonPrimitive.content
    private val addresses = ChainAddresses.DEVNET
    private fun JsonObject.amount(key: String) = getValue(key).jsonPrimitive.contentOrNull?.toBigInteger()

    @Test fun `both shield transactions match actual current web bytes and ordered accounts`() = runBlocking {
        val vectors = fixture.getValue("vectors").jsonArray.map { it.jsonObject }
        assertEquals(listOf("shield", "warzone_shield"), vectors.map { it.getValue("kind").jsonPrimitive.content })
        for (row in vectors) {
            val kind = BasePurchaseKind.entries.single { it.wire == row.getValue("kind").jsonPrimitive.content }
            val amount = requireNotNull(row.amount("amountLamports")); val calls = mutableListOf<String>()
            val rpc = SolanaRpc { request ->
                val method = request.getValue("method").jsonPrimitive.content; calls += method
                buildJsonObject { put("result", when (method) {
                    "getLatestBlockhash" -> buildJsonObject { put("value", buildJsonObject { put("blockhash", fixture.getValue("blockhash")) }) }
                    "getFeeForMessage" -> buildJsonObject { put("value", 5000) }
                    "getBalance" -> buildJsonObject { put("value", JsonPrimitive(amount + 5000.toBigInteger())) }
                    else -> error("Preparation cannot broadcast or split wallet approvals")
                }) }
            }
            val destination = row.getValue("destination").jsonPrimitive.contentOrNull
            val prepared = BasePurchasePayment.prepare(rpc, addresses, kind, wallet, reference, amount, destination,
                row.amount("directLamports"), row.amount("splitLamports"))
            assertArrayEquals(Base64.getDecoder().decode(row.getValue("unsigned").jsonPrimitive.content), prepared.transaction)
            assertEquals(listOf("getLatestBlockhash", "getFeeForMessage", "getBalance"), calls)
            val instructions = BasePurchasePayment.instructions(addresses, kind, wallet, reference, amount, destination,
                row.amount("directLamports"), row.amount("splitLamports"))
            val actual = JsonArray(instructions.map { ix -> buildJsonObject {
                put("program", base58(ix.programId)); put("data", ix.data.joinToString("") { "%02x".format(it.toInt() and 255) })
                put("keys", JsonArray(ix.keys.map { k -> buildJsonObject {
                    put("address", base58(k.key)); put("signer", k.signer); put("writable", k.writable)
                } }))
            } })
            assertEquals(row.getValue("instructions"), actual)
        }
    }

    @Test fun `Warzone cannot be prepared as one leg or redirect direct liquidity`() {
        assertThrows(IllegalArgumentException::class.java) {
            BasePurchasePayment.instruction(addresses, BasePurchaseKind.WARZONE_SHIELD, wallet, reference, BigInteger.TEN, addresses.treasuryLiquidity)
        }
        for (destination in listOf(null, wallet, reference, addresses.treasuryDev)) {
            assertThrows(IllegalArgumentException::class.java) {
                BasePurchasePayment.instructions(addresses, BasePurchaseKind.WARZONE_SHIELD, wallet, reference, BigInteger.TEN, destination,
                    4.toBigInteger(), 6.toBigInteger())
            }
        }
    }

    @Test fun `partial extra or zero shield legs fail before RPC or wallet use`(): Unit = runBlocking {
        val rpc = SolanaRpc { error("Invalid payment must fail before RPC") }
        for ((direct, split) in listOf(null to 10.toBigInteger(), BigInteger.ZERO to BigInteger.TEN,
            4.toBigInteger() to 5.toBigInteger(), 4.toBigInteger() to 7.toBigInteger())) {
            assertThrows(IllegalArgumentException::class.java) { runBlocking {
                BasePurchasePayment.prepare(rpc, addresses, BasePurchaseKind.WARZONE_SHIELD, wallet, reference, BigInteger.TEN,
                    addresses.treasuryLiquidity, direct, split)
            } }
        }
        assertThrows(IllegalArgumentException::class.java) {
            BasePurchasePayment.instructions(addresses, BasePurchaseKind.SHIELD, wallet, reference, BigInteger.TEN, null,
                4.toBigInteger(), 6.toBigInteger())
        }
    }

    @Test fun `two leg total remains an unsigned u64 without truncation`() {
        val max = BigInteger.ONE.shiftLeft(64) - BigInteger.ONE
        val ix = BasePurchasePayment.instructions(addresses, BasePurchaseKind.WARZONE_SHIELD, wallet, reference, max,
            addresses.treasuryLiquidity, max - BigInteger.ONE, BigInteger.ONE)
        assertArrayEquals(byteArrayOf(0xfe.toByte()) + ByteArray(7) { 0xff.toByte() }, ix[0].data.takeLast(8).toByteArray())
        assertArrayEquals(byteArrayOf(1) + ByteArray(7), ix[1].data.takeLast(8).toByteArray())
        assertThrows(IllegalArgumentException::class.java) {
            BasePurchasePayment.instructions(addresses, BasePurchaseKind.WARZONE_SHIELD, wallet, reference, max + BigInteger.ONE,
                addresses.treasuryLiquidity, max, BigInteger.ONE)
        }
    }
}
