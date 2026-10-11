package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.vehicle.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class OrdinaryRouteCatalogueTest {
 private val vector=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/ordinary-route-vectors.json")).readText()).jsonObject
 private val catalogue=OrdinaryRoutes.from(vector.charterObject("constants").charterObject("ordinaryRoutes"),vector.charterObject("constants").charterObject("vehicles").getValue("tiers").jsonArray.map{CharterGrammar.number(it)})
 private val previews=vector.getValue("v2").jsonArray.map{it.jsonObject}.filter{it.charterText("family")=="survey_balloon"&&CharterGrammar.number(it.getValue("tier"))==1L}
 @Test fun `tier1 lists every island and explains all24 unavailable tier choices`() {
  val choices=ordinaryRouteChoices(catalogue,1,previews);assertEquals(32,choices.size);assertEquals(24,choices.count{it.belowTier});assertEquals(8,choices.count{ordinaryRouteDispatchable(it,true)})
  assertEquals(catalogue.routes.map{it.id}.toSet(),choices.map{it.route.id}.toSet());assertTrue(choices.filter{it.belowTier}.all{it.preview==null})
 }
 @Test fun `no preview and paused fleet never fabricate a dispatch permission`() {
  assertTrue(ordinaryRouteChoices(catalogue,4,emptyList()).none{ordinaryRouteDispatchable(it,true)})
  assertTrue(ordinaryRouteChoices(catalogue,1,previews).none{ordinaryRouteDispatchable(it,false)})
 }
 @Test fun `chain membership cannot label stormcairn extras as another HOME`() {
  val choices=ordinaryRouteChoices(catalogue,1,previews)
  assertEquals("HOME",choices.single{it.route.id=="mintwake-1"}.access)
  for(id in listOf("aurora-5","emberwake-5","emberwake-6","whispering-5"))assertEquals("Paid realm access required",choices.single{it.route.id==id}.access)
 }
 @Test fun `all art crops derive from installed index dimensions and original chain sheet`() {
  for(route in catalogue.routes){val crop=catalogue.crop(route.id);val art=catalogue.raw.charterObject("art");assertEquals(route.index%art.getValue("columns").jsonPrimitive.int*crop.cell,crop.x);assertEquals(route.index/art.getValue("columns").jsonPrimitive.int*crop.cell,crop.y);assertEquals("atlas/fantasy/globe/generated/${route.chain}-detail.png",crop.path)}
 }
}
