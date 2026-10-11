package gg.pixelkingdomwars.nativeclient.wallet

import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Public backend vectors are independently reconstructed; no private key is stored here. */
class TournamentTransactionTest {
    private val fixture = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charter-tournament-signing.json")).readText()).jsonObject
    private val rows = fixture.getValue("rows").jsonArray.map { it.jsonObject }
    // Admitted constants.ts PHASE_E_CHARTER_PREPARATION / ADMISSION / TRANSFER.
    private val policy = CharterCryptoPolicy(400000,600,540,"1500000",500,10000)
    private fun JsonObject.obj(k: String) = getValue(k).jsonObject
    private fun JsonObject.str(k: String) = getValue(k).jsonPrimitive.content
    private fun trust(row: JsonObject) = CharterSigningTrust.from(row.obj("trust"))
    private fun change(o: JsonObject, path: String, value: JsonElement): JsonObject {
        val p = path.split('.',limit=2)
        return JsonObject(o + (p[0] to if (p.size == 1) value else change(o.obj(p[0]),p[1],value)))
    }
    private suspend fun rejects(block: suspend () -> Unit) { assertNotNull("Contradictory evidence must be held",runCatching { block() }.exceptionOrNull()) }
    private suspend fun prepare(row: JsonObject, operation: JsonObject = row.obj("operation"), pins: CharterSigningTrust = trust(row), rules: CharterCryptoPolicy = policy) =
        TournamentTransaction.prepare(operation,pins,row.str("leader"),rules)
    private fun flip(hex: String) = (if (hex.startsWith("00")) "01" else "00") + hex.substring(2)

    private suspend fun positive(action: String) {
        val row = rows.single { it.str("action") == action }; val operation = row.obj("operation"); val wire = row.obj("wire")
        val prepared = prepare(row)
        assertEquals("tournament",prepared.kind)
        assertEquals(operation.obj("attempt").str("id"),prepared.attemptId)
        assertEquals(733,prepared.unsignedTransaction().size)
        assertEquals(row.str("termsText"),TournamentTransaction.termsText(operation.obj("operationTerms")))
        assertEquals(row.str("termsHash"),TournamentTransaction.termsHash(operation.obj("operationTerms")))
        assertEquals(row.str("termsUtf8Hex"),TournamentTransaction.termsText(operation.obj("operationTerms")).toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it.toInt() and 255) })
        assertEquals(wire,TournamentTransaction.verifyWire(operation,trust(row),wire,policy))
        val signed = prepared.verifySigned(cHex(wire.str("signedTransactionHex"),66,1232))
        assertEquals(wire,TournamentTransaction.toWire(prepared,signed))
    }
    @Test fun `set freezes exactly the saved clan and original captain`() = runBlocking { positive("set") }
    @Test fun `clear binds the fixed terminal and advances the saved revision`() = runBlocking { positive("clear") }

    @Test fun `SQL terms preserve arrays null and UTF8 key order`() {
        val input = Json.parseToJsonElement("""{"é":[null,{"😀":"\n","z":true}],"aa":2,"b":1}""").jsonObject
        assertEquals("""{"b": 1, "aa": 2, "é": [null, {"z": true, "😀": "\n"}]}""",TournamentTransaction.termsText(input))
        assertNotNull(runCatching { TournamentTransaction.termsText(buildJsonObject { put("bad", "\uD800") }) }.exceptionOrNull())
    }

    @Test fun `installed pins cannot be replaced by the response`() = runBlocking {
        val row = rows.first()
        for ((path,value) in listOf(
            "policySigner" to JsonPrimitive(row.str("leader")), "treasury" to JsonPrimitive(row.str("leader")),
            "deployment.economy.reviewedProgramDataSha256" to JsonPrimitive("11".repeat(32)),
            "deployment.core.upgradeAuthority" to JsonPrimitive(row.str("leader")),
            "deployment.expectedGenesisHash" to JsonPrimitive(row.str("leader")), "royaltyBps" to JsonPrimitive(499))) {
            rejects { prepare(row,pins=CharterSigningTrust.from(change(row.obj("trust"),path,value))) }
        }
        val alteredPin = change(row.obj("trust").getValue("lookupTables").jsonArray.single().jsonObject,"dataSha256",JsonPrimitive("22".repeat(32)))
        rejects { prepare(row,pins=CharterSigningTrust.from(change(row.obj("trust"),"lookupTables",JsonArray(listOf(alteredPin))))) }
        rejects { TournamentTransaction.prepare(row.obj("operation"),trust(row),row.obj("trust").str("policySigner"),policy) }
    }

    @Test fun `terms changes cannot borrow an earlier policy signature`() = runBlocking {
        for (row in rows) {
            val o = row.obj("operation")
            for ((path,value) in listOf("operationTerms.epochId" to JsonPrimitive("99999999-9999-4999-8999-999999999999"),
                "operationTerms.event.budget.frostglass" to JsonPrimitive("99"),
                "operationTerms.roster" to JsonArray(listOf(row.str("leader"),row.obj("trust").str("policySigner")).sorted().map(::JsonPrimitive)))) {
                rejects { prepare(row,change(o,path,value)) }
            }
        }
    }

    @Test fun `original Charter metadata and addresses must reconstruct`() = runBlocking {
        val row = rows.first(); val o = row.obj("operation")
        for ((path,value) in listOf("chain.asset" to JsonPrimitive(row.str("leader")), "metadata.uri" to JsonPrimitive("https://invalid.example/other.json"))) {
            var altered = change(o,"original.creation.$path",value)
            altered = change(altered,"attempt.quote.packetInput.original",altered.getValue("original"))
            rejects { prepare(row,altered) }
        }
    }

    @Test fun `issued TTL compute budget and observation clocks are independently enforced`() = runBlocking {
        val row = rows.first(); val o = row.obj("operation")
        rejects { prepare(row,rules=policy.copy(issuedPermitTtlSec=539)) }
        rejects { prepare(row,rules=policy.copy(maxPolicyPermitTtlSec=539)) }
        rejects { prepare(row,rules=policy.copy(computeUnitLimit=399999)) }
        rejects { prepare(row,change(o,"attempt.quote.observation.unixTimestamp",JsonPrimitive("1800000011"))) }
        rejects { prepare(row,change(o,"attempt.quote.packetInput.currentBlockHeight",JsonPrimitive(301))) }
        rejects { prepare(row,change(o,"attempt.quote.context.closingSlot",JsonPrimitive(149))) }
    }

    @Test fun `fee rent and total ceilings do not silently change`() = runBlocking {
        val row = rows.first(); val o = row.obj("operation")
        for ((path,value) in listOf("costs.totalLamports" to "11536", "costs.rentLamports" to "1536",
            "costLimits.maxNetworkFeeLamports" to "9999", "costLimits.maxRentLamports" to "1534", "costLimits.maxAdditionalLamports" to "11534")) {
            rejects { prepare(row,change(o,"attempt.quote.$path",JsonPrimitive(value))) }
        }
        val allocation = o.obj("attempt").obj("quote").obj("costs").getValue("allocations").jsonArray.single().jsonObject
        rejects { prepare(row,change(o,"attempt.quote.costs.allocations",JsonArray(listOf(change(allocation,"address",JsonPrimitive(row.str("leader"))))))) }
    }

    @Test fun `lookup table hash owner address and activation cannot drift`() = runBlocking {
        val row = rows.first(); val o = row.obj("operation"); val table = o.obj("attempt").obj("quote").obj("packetInput").obj("lookupTable")
        for ((field,value) in listOf("dataHex" to JsonPrimitive(flip(table.str("dataHex"))), "owner" to JsonPrimitive(row.str("leader")),
            "address" to JsonPrimitive(row.str("leader")), "slot" to JsonPrimitive(100), "executable" to JsonPrimitive(true))) {
            rejects { prepare(row,change(o,"attempt.quote.packetInput.lookupTable.$field",value)) }
        }
        // A separately pinned but mutable table is still forbidden by the static ALT contract.
        val bytes = cHex(table.str("dataHex"),440,440); bytes[21]=1
        val hash = cHash(bytes); val hex = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
        var altered = change(o,"attempt.quote.packetInput.lookupTable.dataHex",JsonPrimitive(hex))
        altered = change(altered,"attempt.quote.packetInput.expectedLookupTable.dataSha256",JsonPrimitive(hash))
        val pin = change(row.obj("trust").getValue("lookupTables").jsonArray.single().jsonObject,"dataSha256",JsonPrimitive(hash))
        rejects { prepare(row,altered,CharterSigningTrust.from(change(row.obj("trust"),"lookupTables",JsonArray(listOf(pin))))) }
    }

    @Test fun `both final message and unsigned policy template must match reconstruction`() = runBlocking {
        val row = rows.first(); val o = row.obj("operation")
        for (path in listOf("preparation.packet.messageHex","attempt.quote.template.messageHex","preparation.packet.unsignedTransactionHex",
            "attempt.quote.template.unsignedTransactionHex","preparation.policySignatureHex")) {
            val source = path.split('.').fold(o as JsonElement) { value,key -> value.jsonObject.getValue(key) }.jsonPrimitive.content
            rejects { prepare(row,change(o,path,JsonPrimitive(flip(source)))) }
        }
        rejects { prepare(row,change(o,"attempt.quote.template.messageSha256",JsonPrimitive("00".repeat(32)))) }
    }

    @Test fun `leader signature and wire hashes cannot be forged`() = runBlocking {
        for (row in rows) {
            val wire = row.obj("wire"); val raw = cHex(wire.str("signedTransactionHex"),66,1232)
            for (offset in listOf(1,65,raw.lastIndex)) {
                val bad = raw.copyOf(); bad[offset]=(bad[offset].toInt() xor 1).toByte()
                rejects { prepare(row).verifySigned(bad) }
            }
            for (field in listOf("wireSha256","messageSha256")) rejects {
                TournamentTransaction.verifyWire(row.obj("operation"),trust(row),change(wire,field,JsonPrimitive("00".repeat(32))),policy)
            }
            val wrong = rows.first { it != row }.obj("wire").str("signature")
            rejects { TournamentTransaction.verifyWire(row.obj("operation"),trust(row),change(wire,"signature",JsonPrimitive(wrong)),policy) }
        }
    }

    @Test fun `saved signatures survive terminal reconstruction without acquiring new authority`() = runBlocking {
        for (row in rows) {
            val wire = row.obj("wire")
            var operation = change(row.obj("operation"),"signed",wire)
            operation = change(operation,"status",JsonPrimitive("signed"))
            val signed = prepare(row,operation)
            val bytes = cHex(wire.str("signedTransactionHex"),66,1232)
            assertArrayEquals(bytes,signed.unsignedTransaction())
            val returned = signed.unsignedTransaction(); returned[1]=0
            assertArrayEquals(bytes,signed.unsignedTransaction())
            rejects { signed.withRetainedTransaction(byteArrayOf(1)+ByteArray(64)+bytes.copyOfRange(65,bytes.size)) }
            val terminal = buildJsonObject { put("id","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");put("outcome","completed");put("record",buildJsonObject {}) }
            operation = change(change(operation,"terminal",terminal),"status",JsonPrimitive("completed"))
            assertArrayEquals(bytes,prepare(row,operation).unsignedTransaction())
            assertEquals(wire,TournamentTransaction.verifyWire(operation,trust(row),wire,policy))
        }
    }

    @Test fun `wire conversion verifies all signed metadata and bounded grammar`() = runBlocking {
        val row = rows.first(); val prepared = prepare(row)
        val signed = prepared.verifySigned(cHex(row.obj("wire").str("signedTransactionHex"),66,1232))
        rejects { TournamentTransaction.toWire(prepared,signed.copy(signature=Base64.getEncoder().encodeToString(ByteArray(64)))) }
        rejects { TournamentTransaction.toWire(prepared,signed.copy(transactionSignature=null)) }
        rejects { prepare(row,JsonObject(row.obj("operation")+("signingAuthorized" to JsonPrimitive(true)))) }
        rejects { TournamentTransaction.verifyWire(row.obj("operation"),trust(row),JsonObject(row.obj("wire")+("replacementBlockhash" to JsonPrimitive(row.str("leader")))),policy) }
    }
}
