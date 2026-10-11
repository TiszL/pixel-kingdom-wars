package gg.pixelkingdomwars.nativeclient.wallet

import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Exact shared public fixtures; no signing keys or implementation-produced expectations. */
class CharterTransactionTest {
    private val fixture = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charter-client.json")).readText()).jsonObject
    private val rows = fixture.getValue("rows").jsonArray.map { it.jsonObject }
    private val trust = CharterSigningTrust.from(fixture.getValue("trust").jsonObject)
    // Canonical constants.ts PHASE_E_CHARTER_PREPARATION / ADMISSION / SEEKER_AUCTION / POLICY.
    private val policy = CharterCryptoPolicy(400000, 600, 540, "1500000", 500, 10000)
    private fun JsonObject.obj(k: String) = getValue(k).jsonObject
    private fun JsonObject.str(k: String) = getValue(k).jsonPrimitive.content
    private fun change(o: JsonObject, path: String, value: JsonElement): JsonObject {
        val parts = path.split('.', limit=2)
        return JsonObject(o + (parts[0] to if (parts.size == 1) value else change(o.obj(parts[0]), parts[1], value)))
    }
    private fun bytes(s: String) = Base64.getDecoder().decode(s)

    @Test fun `two maximum metadata clans reconstruct through one preprovisioned table`() = runBlocking {
        assertEquals(2, rows.size)
        assertEquals(1, rows.map { it.obj("creation").obj("lookupPin") }.distinct().size)
        for (row in rows) {
            val p = CharterTransaction.prepare(row.obj("creation"), trust, row.str("creator"), policy)
            assertEquals(1228, p.unsignedTransaction().size)
            assertEquals(row.obj("creationWire").str("signedTransaction"), p.verifySignedBase64(row.obj("creationWire").str("signedTransaction")).wire)
            CharterTransaction.verifyWire(row.obj("creation"), trust, row.obj("creationWire"), policy)
        }
    }
    @Test fun `stay and leave SQL jsonb terms hash and both independent signer slots match`() = runBlocking {
        for (row in rows) {
            val sale = row.obj("sale")
            assertEquals(row.str("termsText"), CharterTransaction.termsText(sale.obj("original").obj("terms")))
            for (actor in listOf("buyer", "creator")) {
                val p = CharterTransaction.prepare(sale, trust, row.str(actor), policy)
                val checked = p.verifySignedBase64(row.obj("saleWire").str("signedTransaction"))
                assertEquals(row.obj(if (actor=="buyer") "buyerContribution" else "sellerContribution").str("signature"), checked.signature)
                assertEquals(row.obj("saleWire").str("signature"), checked.transactionSignature)
            }
            CharterTransaction.verifyWire(sale, trust, row.obj("saleWire"), policy)
            CharterTransaction.verifyContribution(sale, trust, row.obj("buyerContribution"), policy)
            CharterTransaction.verifyContribution(sale, trust, row.obj("sellerContribution"), policy)
        }
    }
    @Test fun `partial sale records own signature without full delivery authority`() = runBlocking {
        val row = rows.first(); val sale = row.obj("sale")
        for (actor in listOf("buyer", "creator")) {
            val p = CharterTransaction.prepare(sale, trust, row.str(actor), policy)
            val wire = bytes(row.obj("saleWire").str("signedTransaction")); val other = if(actor=="buyer") 65 else 1
            wire.fill(0, other, other+64)
            assertNull(p.verifySigned(wire).transactionSignature)
            assertThrows(IllegalArgumentException::class.java) { runBlocking {
                CharterTransaction.verifyWire(sale, trust, JsonObject(row.obj("saleWire") + ("signedTransaction" to JsonPrimitive(Base64.getEncoder().encodeToString(wire)))), policy)
            } }
        }
    }
    @Test fun `existing other party signature cannot be erased by wallet`() = runBlocking {
        val row=rows.first(); val p=CharterTransaction.prepare(row.obj("sale"),trust,row.str("buyer"),policy)
        val full=bytes(row.obj("saleWire").str("signedTransaction")); val sellerOnly=full.copyOf().also{it.fill(0,1,65)}
        val retained=p.withRetainedTransaction(sellerOnly)
        assertArrayEquals(sellerOnly,retained.unsignedTransaction())
        val buyerOnly=full.copyOf().also{it.fill(0,65,129)}
        assertThrows(IllegalArgumentException::class.java){retained.verifySigned(buyerOnly)}
        assertNotNull(retained.verifySigned(full).transactionSignature)
    }
    @Test fun `independent pins reject server supplied replacement trust and altered economics`() {
        val row=rows.first()
        val patches=listOf("deployment.economy.reviewedDeploymentSlot" to JsonPrimitive(89),
            "policy.signer" to JsonPrimitive(row.str("buyer")), "costs.coreCreateFeeLamports" to JsonPrimitive("1"),
            "costs.totalLamports" to JsonPrimitive("1"), "costLimits.maxTotalLamports" to JsonPrimitive("1"),
            "original.chain.charter" to JsonPrimitive(row.str("buyer")), "context.feeSlot" to JsonPrimitive(0),
            "original.metadata.name" to JsonPrimitive("changed"), "packet.nativeInstructionIndex" to JsonPrimitive(0),
            "costs.networkFeeLamports" to JsonPrimitive("18446744073709551616"))
        for((path,value) in patches) assertThrows(path,IllegalArgumentException::class.java){runBlocking{
            CharterTransaction.prepare(change(row.obj("creation"),path,value),trust,row.str("creator"),policy)
        }}
    }
    @Test fun `term and policy changes cannot preserve original consent`() {
        val row=rows.first()
        for((path,value) in listOf("original.terms.sellerLeaves" to JsonPrimitive(false),
            "original.terms.priceLamports" to JsonPrimitive("101000004"), "original.terms.expectedRevision" to JsonPrimitive(1),
            "original.terms.fenceId" to JsonPrimitive("12345678-1234-4678-9abc-000000000999"),
            "original.terms.epochId" to JsonPrimitive("12345678-1234-4678-9abc-000000000999"),
            "original.terms.domain.treasury" to JsonPrimitive(row.str("creator")),
            "policy.signatureHex" to JsonPrimitive("00".repeat(64)))) {
            assertThrows(path,IllegalArgumentException::class.java){runBlocking{CharterTransaction.prepare(change(row.obj("sale"),path,value),trust,row.str("buyer"),policy)}}
        }
    }
    @Test fun `wallet cannot change recipient message signatures compact encoding or trailing bytes`() = runBlocking {
        val row=rows.first();val p=CharterTransaction.prepare(row.obj("sale"),trust,row.str("buyer"),policy)
        val wire=bytes(row.obj("saleWire").str("signedTransaction"))
        val wrong=listOf(wire+byteArrayOf(0), byteArrayOf(0x82.toByte(),0)+wire.drop(1),wire.copyOf().also{it[1]=(it[1].toInt() xor 1).toByte()},
            wire.copyOf().also{it[130]=(it[130].toInt() xor 1).toByte()},wire.copyOf().also{it[65]=(it[65].toInt() xor 1).toByte()},ByteArray(1233))
        wrong.forEach{assertThrows(IllegalArgumentException::class.java){p.verifySigned(it)}}
    }
    @Test fun `retained original pins verify expired historical proof without fresh approval authority`() = runBlocking {
        val row=rows.first();val old=trust.toJson()
        val other=CharterSigningTrust.from(change(old,"deployment.economy.reviewedDeploymentSlot",JsonPrimitive(91)))
        assertThrows(IllegalArgumentException::class.java){runBlocking{CharterTransaction.prepare(row.obj("creation"),other,row.str("creator"),policy)}}
        CharterTransaction.verifyWire(row.obj("creation"),CharterSigningTrust.from(old),row.obj("creationWire"),policy)
        Unit
    }
    @Test fun `canonical envelope preparations independently match their separate operator pins`() = runBlocking {
        val pins=CharterSigningTrust.from(fixture.obj("envelopeTrust"))
        for(envelope in fixture.obj("envelopes").values){
            val e=envelope.jsonObject
            val p=CharterTransaction.prepare(e.obj("signing"),pins,e.str("actor"),policy)
            assertEquals(e.obj("signing").obj("packet").str("messageSha256"),p.messageSha256)
            assertTrue(p.expiryUnixTimestamp>p.observedUnixTimestamp)
            assertThrows(IllegalArgumentException::class.java){runBlocking{CharterTransaction.prepare(e.obj("signing"),trust,e.str("actor"),policy)}}
        }
    }
    private fun hex(bytes:ByteArray)=bytes.joinToString(""){"%02x".format(it.toInt() and 255)}
    private fun fromHex(value:String)=value.chunked(2).map{it.toInt(16).toByte()}.toByteArray()
    private fun sha(bytes:ByteArray)=hex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes))
    private fun packetWith(v:JsonObject,message:ByteArray):JsonObject{
        val count=if(v.str("kind")=="creation")1 else 2
        var result=change(v,"packet.messageHex",JsonPrimitive(hex(message)))
        result=change(result,"packet.messageSha256",JsonPrimitive(sha(message)))
        result=change(result,"packet.unsignedTransactionHex",JsonPrimitive(hex(byteArrayOf(count.toByte())+ByteArray(count*64)+message)))
        return change(result,"packet.packetBytes",JsonPrimitive(1+count*64+message.size))
    }
    @Test fun `bounded v0 decoder rejects nonminimal account count extra bytes and privilege changes even with coherent packet hashes`() {
        val row=rows.first();val sale=row.obj("sale");val message=fromHex(sale.obj("packet").str("messageHex"))
        val mutations=listOf(message+byteArrayOf(0),message.copyOf().also{it[2]=1},
            message.copyOfRange(0,4)+byteArrayOf((message[4].toInt() or 128).toByte(),0)+message.copyOfRange(5,message.size),
            message.copyOf().also{it[3]=(it[3].toInt()+1).toByte()},message.copyOf().also{it[0]=0})
        for(m in mutations)assertThrows(IllegalArgumentException::class.java){runBlocking{CharterTransaction.prepare(packetWith(sale,m),trust,row.str("buyer"),policy)}}
    }
    @Test fun `a trusted table hash cannot authorize writable authority unexpected accounts or extensible state`() {
        val row=rows.first();val sale=row.obj("sale");val raw=fromHex(sale.obj("lookupTable").str("dataHex"))
        val invalid=listOf(raw.copyOf().also{it[21]=1},raw.copyOf().also{it[4]=0},
            raw.copyOf().also{it[56]=(it[56].toInt() xor 1).toByte()},raw.copyOf().also{it[12]=sale.obj("lookupTable").getValue("slot").jsonPrimitive.int.toByte()})
        for(bytes in invalid){
            var v=change(sale,"lookupTable.dataHex",JsonPrimitive(hex(bytes)))
            v=change(v,"lookupPin.dataSha256",JsonPrimitive(sha(bytes)))
            val pinned=JsonObject(trust.toJson()+("lookupTables" to JsonArray(listOf(v.obj("lookupPin")))))
            assertThrows(IllegalArgumentException::class.java){runBlocking{CharterTransaction.prepare(v,CharterSigningTrust.from(pinned),row.str("buyer"),policy)}}
        }
    }
    @Test fun `contributions bind wallet attempt message and canonical detached signature`() {
        val row=rows.first();val c=row.obj("buyerContribution")
        for((path,value)in listOf("wallet" to JsonPrimitive(row.str("creator")),"attemptId" to JsonPrimitive("12345678-1234-4678-9abc-000000000999"),
            "messageSha256" to JsonPrimitive("00".repeat(32)),"signature" to JsonPrimitive(Base64.getEncoder().encodeToString(ByteArray(64))))){
            assertThrows(IllegalArgumentException::class.java){runBlocking{CharterTransaction.verifyContribution(row.obj("sale"),trust,change(c,path,value),policy)}}
        }
        assertThrows(IllegalArgumentException::class.java){runBlocking{CharterTransaction.verifyContribution(row.obj("creation"),trust,c,policy)}}
    }
    @Test fun `quoted allocation sums exact account layouts and royalty floor cannot be changed`() {
        val row=rows.first();val sale=row.obj("sale")
        for((path,value)in listOf("costs.royaltyLamports" to JsonPrimitive("5050001"),"costs.sellerLamports" to JsonPrimitive("0"),
            "costs.rentLamports" to JsonPrimitive("0"),"costLimits.maxAdditionalLamports" to JsonPrimitive("1"),
            "costs.priceLamports" to JsonPrimitive("101000004"),"costs.priceLamports" to JsonPrimitive("0101000003"))){
            assertThrows(IllegalArgumentException::class.java){runBlocking{CharterTransaction.prepare(change(sale,path,value),trust,row.str("buyer"),policy)}}
        }
        val allocations=sale.obj("costs").getValue("allocations").jsonArray
        for(field in listOf("bytes","address","kind")){
            val value=when(field){"bytes"->JsonPrimitive(337);"address"->JsonPrimitive(row.str("buyer"));else->JsonPrimitive("asset")}
            val v=change(sale,"costs.allocations",JsonArray(listOf(JsonObject(allocations[0].jsonObject+(field to value)),allocations[1])))
            assertThrows(IllegalArgumentException::class.java){runBlocking{CharterTransaction.prepare(v,trust,row.str("buyer"),policy)}}
        }
    }
    @Test fun `opaque preparation owns bytes and its independently captured pins`() = runBlocking {
        val row=rows.first();val p=CharterTransaction.prepare(row.obj("creation"),trust,row.str("creator"),policy)
        val first=p.unsignedTransaction();val unchanged=first.copyOf();first.fill(1)
        assertArrayEquals(unchanged,p.unsignedTransaction())
        assertEquals(trust,CharterSigningTrust.from(trust.toJson()))
        assertThrows(IllegalArgumentException::class.java){runBlocking{CharterTransaction.prepare(JsonObject(row.obj("creation")+("authority" to JsonPrimitive(true))),trust,row.str("creator"),policy)}}
        Unit
    }

}
