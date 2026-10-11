package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.vehicle.VehiclePolicy
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

internal fun vehicleFixture(name: String) = Json.parseToJsonElement(requireNotNull(VehicleTransactionTest::class.java.getResource(name)).readText()).jsonObject
internal fun vehicleChange(o: JsonObject, path: String, value: JsonElement): JsonObject {
    val p = path.split('.',limit=2)
    return JsonObject(o + (p[0] to if(p.size==1)value else vehicleChange(o.charterObject(p[0]),p[1],value)))
}

class VehicleTransactionTest {
    private val fixture = vehicleFixture("/vehicle-client-vectors.json")
    private val rows = fixture.getValue("vectors").jsonArray.map { it.jsonObject }
    private val policy = VehiclePolicy.from(fixture.charterObject("constants"))
    private fun rejected(block: ()->Unit) = assertNotNull("Contradictory consent must hold",runCatching(block).exceptionOrNull())
    private fun prepared(row: JsonObject, client: JsonObject = row.charterObject("client"),
        pins: JsonObject = row.charterObject("trust")) = VehicleTransaction.prepare(client,VehicleSigningTrust.from(pins),policy)
    private fun vector(kind: String) {
        val row = rows.single { it.charterText("kind") == kind }; val c = row.charterObject("client"); val wire = row.charterObject("wire")
        val p = prepared(row)
        assertEquals(wire,VehicleTransaction.verifyWire(c,wire,policy))
        assertEquals(wire,p.verifySigned(vehicleHex(wire.charterText("signedTransactionHex"),66,1232)))
        assertEquals(wire.charterText("messageSha256"),p.messageSha256)
        val unsigned = p.unsignedTransaction()
        assertEquals(1,unsigned[0].toInt()); assertTrue(unsigned.copyOfRange(1,65).all { it == 0.toByte() })
        assertEquals(c.charterObject("record").charterObject("preparation").charterText("messageHex"),vehicleHex(unsigned.copyOfRange(65,unsigned.size)))
        if(kind != "installation") assertEquals(row.charterText("serviceJson"),policy.serviceEffect(c.charterObject("record").charterObject("intent").charterObject("state")).toString())
        VehicleTransaction.verifyHistory(c,policy)
    }
    @Test fun `initial fixture independently reconstructs exact Core burn and reservation memo`() = vector("installation")
    @Test fun `upgrade fixture binds original state fixed JSON effect and real signature`() = vector("upgrade")
    @Test fun `exhausted restore fixture binds counter reset and real signature`() = vector("restore_uses")

    @Test fun `installed pins cannot come from changed response`() {
        val row = rows.first()
        for ((path,value) in listOf("core.expectedGenesisHash" to JsonPrimitive(row.charterObject("client").charterObject("record").charterText("wallet")),
            "core.reviewedDeploymentSlot" to JsonPrimitive(11),"core.reviewedProgramDataSha256" to JsonPrimitive("b".repeat(64)),
            "operationalPolicyVersion" to JsonPrimitive(2))) rejected { prepared(row,pins=vehicleChange(row.charterObject("trust"),path,value)) }
    }
    @Test fun `same message cannot be moved to another original asset actor hash or service effect`() {
        for (row in rows) {
            val c = row.charterObject("client")
            rejected { prepared(row,vehicleChange(c,"record.wallet",row.charterObject("trust").charterObject("core").getValue("expectedGenesisHash"))) }
            rejected { prepared(row,vehicleChange(c,"record.preparation.blockhash",c.charterObject("record").getValue("wallet"))) }
            rejected { prepared(row,vehicleChange(c,"record.preparation.messageSha256",JsonPrimitive("b".repeat(64)))) }
            val source = if(row.charterText("kind")=="installation")"reservation" else "intent"
            rejected { prepared(row,vehicleChange(c,"record.$source.identity.assetId",c.charterObject("record").getValue("wallet"))) }
            if(source=="intent") rejected { prepared(row,vehicleChange(c,"record.intent.state.baseId",JsonPrimitive("10000000-0000-4000-8000-000000000099"))) }
        }
    }
    @Test fun `arbitrary v0 changed program instruction and memo bytes are refused even with recomputed hash`() {
        val row = rows.first(); val c = row.charterObject("client"); val p = c.charterObject("record").charterObject("preparation")
        val original = vehicleHex(p.charterText("messageHex"),1,1167)
        for (index in listOf(0,4,original.lastIndex)) {
            val bytes = original.copyOf(); bytes[index] = (bytes[index].toInt() xor 128).toByte()
            val changed = vehicleChange(vehicleChange(c,"record.preparation.messageHex",JsonPrimitive(vehicleHex(bytes))),
                "record.preparation.messageSha256",JsonPrimitive(vehicleHash(bytes)))
            rejected { prepared(row,changed) }
        }
    }
    @Test fun `wallet cannot mutate approved message signature metadata or signature count`() {
        val row = rows.first(); val p = prepared(row); val wire = row.charterObject("wire")
        val bytes = vehicleHex(wire.charterText("signedTransactionHex"),66,1232)
        for(index in listOf(0,1,64,65,bytes.lastIndex)) {
            val changed = bytes.copyOf(); changed[index] = (changed[index].toInt() xor 1).toByte()
            rejected { p.verifySigned(changed) }
        }
        for(field in listOf("signature","messageSha256","wireSha256")) rejected { p.verifyWire(vehicleChange(wire,field,JsonPrimitive("1".repeat(64)))) }
        rejected { p.verifyWire(JsonObject(wire+("authority" to JsonPrimitive(true)))) }
        rejected { p.verifySigned(ByteArray(1233)) }
    }
    @Test fun `prepared buffers cannot be edited after approval reconstruction`() {
        val row = rows.first(); val p = prepared(row); val wire = row.charterObject("wire")
        p.unsignedTransaction().fill(7)
        assertEquals(wire,p.verifyWire(wire))
    }
    @Test fun `signed and lost-wire terminal history are independently verified without current pins`() {
        for(row in rows) {
            val c = row.charterObject("client"); val r = c.charterObject("record"); val wire = row.charterObject("wire")
            val signed = JsonObject(wire.filterKeys { it != "signedTransactionHex" } + ("acceptedAt" to JsonPrimitive("2035-01-01T00:00:00.000002Z")))
            val withSigned = vehicleChange(vehicleChange(c,"record.signed",signed),"record.status",JsonPrimitive("signed"))
            VehicleTransaction.verifyHistory(withSigned,policy)
            val receipt = JsonObject(wire.filterKeys { it != "signedTransactionHex" } + mapOf("slot" to JsonPrimitive(21),"finalizedThroughSlot" to JsonPrimitive(22),"feeLamports" to JsonPrimitive("5000"),"assetRefundLamports" to JsonPrimitive("1")))
            val terminal: JsonObject
            val field: String
            if(row.charterText("kind")=="installation") {
                field = "installation"
                val original = r.charterObject("reservation"); val request = original.charterObject("request"); val identity = original.charterObject("identity")
                terminal = buildJsonObject {
                    put("installationId",original.getValue("reservationId")); for(k in listOf("baseId","berthId","assetId"))put(k,request.getValue(k))
                    for(k in listOf("family","tier"))put(k,identity.getValue(k)); put("installedWallet",r.getValue("wallet")); put("installedAt","2035-01-01T00:00:00.000003Z"); put("signature",wire.getValue("signature"))
                }
            } else {
                field = "application"
                terminal = JsonObject(policy.serviceEffect(r.charterObject("intent").charterObject("state")).filterKeys { it in listOf("tierAfter","revisionAfter","completedTotal","allowanceStartAfter","remainingUses") } + mapOf("appliedAt" to JsonPrimitive("2035-01-01T00:00:00.000003Z"),"signature" to wire.getValue("signature")))
            }
            val end = vehicleChange(vehicleChange(vehicleChange(c,"record.$field",terminal),"record.status",JsonPrimitive(if(field=="installation")"installed" else "applied")),"burnReceipt",receipt)
            VehicleTransaction.verifyHistory(end,policy)
            rejected { VehicleTransaction.verifyHistory(vehicleChange(end,"burnReceipt.wireSha256",JsonPrimitive("b".repeat(64))),policy) }
            val other = if(row == rows.first()) rows.last() else rows.first()
            rejected { VehicleTransaction.verifyHistory(vehicleChange(end,"record.$field.signature",other.charterObject("wire").getValue("signature")),policy) }
        }
    }
    @Test fun `service restore cannot restore a partly used allowance`() {
        val row = rows.last(); val c = row.charterObject("client")
        rejected { prepared(row,vehicleChange(c,"record.intent.state.completedTotal",JsonPrimitive("3"))) }
    }
}
