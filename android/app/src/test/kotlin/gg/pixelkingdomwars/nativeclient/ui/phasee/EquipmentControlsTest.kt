package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.EquipmentView
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import org.junit.Assert.*
import org.junit.Test
class EquipmentControlsTest {
 private val f=EquipmentFixtures
 @Test fun `craft and departure controls require current selected kingdom and unpaused content`() {val s=EquipmentState(view=EquipmentView.from(f.readyView()));assertTrue(equipmentCanCraft(s,f.base,true));assertTrue(equipmentCanDepart(s,f.base,true));assertFalse(equipmentCanCraft(s,"other",true));assertFalse(equipmentCanDepart(s,f.base,false));assertFalse(equipmentCanDepart(s.copy(busy=true),f.base,true))}
 @Test fun `reserved or missing tool cannot show a fitted departure action`() {val s=EquipmentState(view=EquipmentView.from(f.readyView("0")));assertFalse(equipmentCanDepart(s,f.base,true));assertTrue(equipmentCanCraft(s,f.base,true))}
 @Test fun `unresolved original blocks new craft and fitting controls`() {val s=EquipmentState(view=EquipmentView.from(f.readyView()),journal=EquipmentJournal(identity=f.identity(),pending=listOf(f.record())));assertFalse(equipmentCanCraft(s,f.base,true));assertFalse(equipmentCanDepart(s,f.base,true))}

 @Test fun `saved progress requires an actual completion rather than acceptance or an unknown reply`() {
  for(kind in listOf("craft","starter","advanced")){
   val draft=f.record(kind)
   assertFalse(equipmentRecordComplete(draft))
   assertFalse(equipmentRecordComplete(draft.copy(attempted=true,response=f.unknown(draft))))
   val accepted=draft.copy(attempted=true,response=f.proof(draft))
   assertFalse(equipmentRecordComplete(accepted))
   assertEquals(PaymentTone.SENT,equipmentRecordPill(accepted).tone)
   val completed=draft.copy(attempted=true,response=f.complete(draft))
   assertTrue(equipmentRecordComplete(completed))
   assertEquals(PaymentTone.DONE,equipmentRecordPill(completed).tone)
  }
 }
 @Test fun `late accepted evidence is not hidden by an earlier refusal or archived draft`() {
  val draft=f.record()
  val recovered=draft.copy(discardedUnsent=true,refusal=EquipmentRefusal(409,"EQUIPMENT_CRAFT_UNAVAILABLE",1),response=f.proof(draft))
  assertEquals(PaymentTone.SENT,equipmentRecordPill(recovered).tone)
  assertEquals(PaymentTone.DONE,equipmentRecordPill(recovered.copy(response=f.complete(draft))).tone)
  assertEquals(PaymentTone.TROUBLE,equipmentRecordPill(recovered.copy(held=true)).tone)
 }
 @Test fun `saved tool title comes from frozen terms after the current tool changes`() {
  val draft=f.record()
  val state=EquipmentState(item="survey_lens",resource="frost_quartz",journal=EquipmentJournal(identity=f.identity(),pending=listOf(draft)),selectedKey=draft.key)
  assertEquals("Craft Route Compass",equipmentRecordTitle(requireNotNull(state.selected)))
 }
 @Test fun `paid destinations explain only the Lens primary cargo conflict and keep Compass choices`() {
  val destinations=listOf("frostveil" to "frost_quartz","elderwood" to "heartwood_logs","sunscar" to "sunstone_rubble","crownlands" to "crown_iron_ore","seeker-reach" to "rough_prism","stormcairn" to "storm_ore","thornwake" to "thorn_fibre","cinderfall" to "ember_nodules")
  for((realm,primary)in destinations){
   assertNull(equipmentPaidDestinationReason(EquipmentState(),realm))
   for((_,resource)in destinations){
    val reason=equipmentPaidDestinationReason(EquipmentState(item="survey_lens",resource=resource),realm)
    if(resource==primary){assertNotNull(reason);assertTrue(requireNotNull(reason).contains("main cargo",ignoreCase=true))}else assertNull(reason)
   }
  }
 }

}
