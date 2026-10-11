package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import gg.pixelkingdomwars.nativeclient.vehicle.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class VehiclePresentationTest {
    private val f=VehicleFixtures
    private val service=f.rows.first{it.charterObject("client").charterText("kind")=="service"}.charterObject("client")
    private val original=VehicleProtocol.original(service)
    private val identity=original.charterObject("identity")
    private fun fleet(tier:Long=CharterGrammar.number(identity.getValue("tier")),remaining:Long=f.policy.completedUses)=buildJsonObject {
        put("family",identity.getValue("family"));put("tier",tier);put("remainingUses",remaining)
    }
    private fun record(kind:String="installation",response:JsonObject?=f.client)=VehicleRecord("local-original",kind,"original-key",f.request,f.policy.raw,response=response)

    @Test fun `wrong family stock never offers upgrade or use restoration`() {
        val other=JsonObject(identity+("family" to JsonPrimitive("cargo_cutter")))
        for(operation in listOf("upgrade","restore_uses"))assertFalse(vehicleServiceChoice(fleet(remaining=0),other,f.policy,operation).allowed)
    }
    @Test fun `service consumes an asset of the installed current tier not the target tier`() {
        val other=JsonObject(identity+("tier" to JsonPrimitive(f.policy.tiers.last())))
        assertFalse(vehicleServiceChoice(fleet(),other,f.policy,"upgrade").allowed)
        assertTrue(vehicleServiceChoice(fleet(),identity,f.policy,"upgrade").allowed)
    }
    @Test fun `maximum tier upgrade is refused using installed policy without copying tuning`() {
        val tier=f.policy.tiers.last();val matching=JsonObject(identity+("tier" to JsonPrimitive(tier)))
        val choice=vehicleServiceChoice(fleet(tier),matching,f.policy,"upgrade")
        assertFalse(choice.allowed);assertTrue(choice.reason.contains("maximum tier"))
    }
    @Test fun `nonexhausted vehicle cannot restore uses even with matching stock`() {
        val choice=vehicleServiceChoice(fleet(remaining=f.policy.completedUses),identity,f.policy,"restore_uses")
        assertFalse(choice.allowed);assertTrue(choice.reason.contains("exhausted"))
    }
    @Test fun `exhausted matching stock can restore at the maximum tier without offering upgrade`() {
        val tier=f.policy.tiers.last();val matching=JsonObject(identity+("tier" to JsonPrimitive(tier)));val row=fleet(tier,0)
        assertTrue(vehicleServiceChoice(row,matching,f.policy,"restore_uses").allowed)
        assertFalse(vehicleServiceChoice(row,matching,f.policy,"upgrade").allowed)
    }
    @Test fun `unknown policy stock malformed fields and unsupported operation fail closed`() {
        assertFalse(vehicleServiceChoice(fleet(),identity,null,"upgrade").allowed)
        assertFalse(vehicleServiceChoice(fleet(),null,f.policy,"upgrade").allowed)
        assertFalse(vehicleServiceChoice(buildJsonObject{},identity,f.policy,"upgrade").allowed)
        assertFalse(vehicleServiceChoice(fleet(),buildJsonObject{},f.policy,"upgrade").allowed)
        assertFalse(vehicleServiceChoice(fleet(),identity,f.policy,"sell").allowed)
    }
    @Test fun `held and uncertain requests never claim a completed burn`() {
        assertEquals(PaymentTone.TROUBLE,vehicleRecordPill(record(response=null)).tone)
        assertEquals(PaymentTone.TROUBLE,vehicleRecordPill(record().copy(held=true)).tone)
        assertEquals(PaymentTone.TROUBLE,vehicleRecordPill(record().copy(attempts=listOf("wallet"))).tone)
        assertNull(vehicleFinalFee(record()))
    }
    @Test fun `retained signature indicates approval not finalized installation or paid fee`() {
        val r=record(response=f.signed()).copy(signed=f.wire,attempts=listOf("wallet"))
        assertEquals("APPROVED",vehicleRecordPill(r).label)
        assertEquals(PaymentTone.SENT,vehicleRecordPill(r).tone)
        assertNull(vehicleFinalFee(r))
    }
    @Test fun `only final burn receipt exposes actual fee and installed status`() {
        val end=f.change(f.terminal(),"burnReceipt.feeLamports",JsonPrimitive("1"));val r=record(response=end)
        assertEquals("INSTALLED",vehicleRecordPill(r).label)
        assertEquals(PaymentTone.DONE,vehicleRecordPill(r).tone)
        assertEquals("0.000000001 SOL",vehicleFinalFee(r))
    }
    @Test fun `saved service destination comes from original terms not a current kingdom or asset choice`() {
        val r=record("service",service).copy(request=VehicleProtocol.request(service))
        val details=vehicleOriginalDetails(r).associate{it.label to it.value}
        assertEquals(original.charterObject("state").charterText("baseId"),vehicleOriginalBase(r))
        assertEquals(original.charterObject("state").charterText("berthId"),details["Original berth"])
        assertEquals(identity.charterText("assetId"),details["Original asset"])
        assertEquals(identity.charterText("collection"),details["Collection"])
        assertEquals(original.charterObject("state").charterText("installationId"),details["Original installed vehicle"])
    }
    @Test fun `unanswered service retains original destination before any server receipt`() {
        val dest=VehicleProtocol.destination(service)
        val r=record("service",null).copy(request=VehicleProtocol.request(service),destination=dest)
        assertEquals(dest.charterText("baseId"),vehicleOriginalBase(r))
        assertEquals(dest.charterText("berthId"),vehicleOriginalDetails(r).single{it.label=="Original berth"}.value)
    }
    @Test fun `past scheduled return is not completed cargo until a return receipt exists`() {
        val v=buildJsonObject{put("receipt",buildJsonObject{put("returnsAt","2000-01-01T00:00:00.000Z")});put("return",JsonNull)}
        val r=record("expedition",v)
        assertEquals("AWAY",vehicleRecordPill(r).label)
        assertEquals("2000-01-01T00:00:00.000Z",vehicleOriginalDetails(r).single{it.label=="Scheduled return (UTC)"}.value)
        val returned=JsonObject(v+("return" to buildJsonObject{put("returnedAt","2000-01-01T00:00:01.000Z")}))
        assertEquals("RETURNED",vehicleRecordPill(r.copy(response=returned)).label)
    }
    @Test fun `primary and companion cargo stay separate with exact large quantities and original island share`() {
        fun cargo(resource:String)=buildJsonObject{put("resourceId",resource);put("netQuantity","9223372036854775807");put("grossQuantity","9223372036854775807");put("islandPoolQuantity","0")}
        val rows=vehicleCargoRows(JsonObject(cargo("heartwood")+("secondaryOutput" to cargo("frost_crystal"))))
        assertEquals(4,rows.size)
        assertEquals("Heartwood · net cargo",rows[0].label);assertEquals("9,223,372,036,854,775,807",rows[0].value)
        assertEquals("Frost Crystal · net cargo",rows[2].label)
        assertEquals("9,223,372,036,854,775,807 / 0",rows[3].value)
    }
}
