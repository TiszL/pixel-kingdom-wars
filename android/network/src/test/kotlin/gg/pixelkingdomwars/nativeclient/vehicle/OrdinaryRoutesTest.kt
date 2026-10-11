package gg.pixelkingdomwars.nativeclient.vehicle

import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class OrdinaryRoutesTest {
 private val legacy=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/vehicle-client-vectors.json")).readText()).jsonObject.charterObject("constants")
 private val vectors=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/ordinary-route-vectors.json")).readText()).jsonObject
 private val installed=VehiclePolicy.from(JsonObject(legacy+("ordinaryRoutes" to vectors.charterObject("constants").getValue("ordinaryRoutes"))))
 private fun rows(key:String)=vectors.getValue(key).jsonArray.map{it.jsonObject}
 private fun change(v:JsonObject,key:String,value:JsonElement)=JsonObject(v+(key to value))
 @Test fun `all32 canonical routes preserve independent family tier economics and supplied art indices`() {
  val catalogue=requireNotNull(installed.ordinaryRoutes);assertEquals(32,catalogue.routes.size)
  rows("v2").forEach{installed.verifyRoute(it,true)}
  assertEquals(8,catalogue.routes.map{it.realmId}.distinct().size)
  catalogue.routes.forEach{r->val crop=catalogue.crop(r.id);assertTrue(crop.x+crop.cell<=crop.atlas&&crop.y+crop.cell<=crop.atlas);assertEquals("${r.chain}-${r.index+1}",r.id)}
 }
 @Test fun `old four-field policies keep all immutable v1 snapshots and fresh v1 routes`() {
  val old=VehiclePolicy.from(legacy);assertNull(old.ordinaryRoutes);assertEquals(1L,old.routePolicyVersion)
  for(row in rows("v1")){old.verifyRoute(row,true);installed.verifyRoute(row,true)}
  assertEquals(2L,installed.routePolicyVersion)
 }
 @Test fun `v2 cannot be read without its installed support or under an unknown version`() {
  val v=rows("v2").first();assertThrows(Exception::class.java){VehiclePolicy.from(legacy).verifyRoute(v)}
  assertThrows(Exception::class.java){installed.verifyRoute(change(v,"policyVersion",JsonPrimitive(3)))}
  assertThrows(Exception::class.java){installed.verifyRoute(change(v,"routeId",JsonPrimitive("invented-1")))}
 }
 @Test fun `below-grade tiers never acquire a preview`() {
  for(held in rows("tierHold")) {
   val candidate=rows("v2").first{it["routeId"]==held["routeId"]&&it["family"]==held["family"]}
   assertThrows(Exception::class.java){installed.verifyRoute(change(candidate,"tier",held.getValue("tier")))}
  }
 }
 @Test fun `wrong realm free foreign access quantities and provisions are held`() {
  for(v in rows("v2"))for((key,value) in listOf("realmId" to JsonPrimitive("invented"),"grossQuantity" to JsonPrimitive("0"),"netQuantity" to JsonPrimitive("0"),"islandPoolQuantity" to JsonPrimitive("0"),"durationSec" to JsonPrimitive(1),"supplies" to JsonArray(emptyList()),"accessRequirement" to JsonPrimitive(if(v.charterText("accessRequirement")=="home")"paid_realm" else "home")))assertThrows(Exception::class.java){installed.verifyRoute(change(v,key,value))}
 }
 @Test fun `HOME follows actual home realm independently of visual chain`() {
  for(v in rows("v2")){val home=change(change(v,"homeRealmId",v.getValue("realmId")),"accessRequirement",JsonPrimitive("home"));installed.verifyRoute(home)}
 }
 @Test fun `optional route version is strict and never accepted on fleet query`() {
  val base="10000000-0000-4000-8000-000000000003"
  for(version in listOf(null,"1","2"))VehicleProtocol.validateRequest("GET","/vehicles/client/routes",mapOf("baseId" to base)+if(version==null)emptyMap() else mapOf("policyVersion" to version),null)
  for(version in listOf("0","3","02","2.0"))assertThrows(Exception::class.java){VehicleProtocol.validateRequest("GET","/vehicles/client/routes",mapOf("baseId" to base,"policyVersion" to version),null)}
  assertThrows(Exception::class.java){VehicleProtocol.validateRequest("GET","/vehicles/fleet",mapOf("baseId" to base,"policyVersion" to "2"),null)}
 }
 @Test fun `catalogue response must match the explicitly requested version`() {
  fun envelope(row:JsonObject)=buildJsonObject{put("version",1);put("wallet",Json.parseToJsonElement(requireNotNull(javaClass.getResource("/vehicle-client-vectors.json")).readText()).jsonObject.getValue("vectors").jsonArray.first().jsonObject.charterObject("client").charterObject("record").getValue("wallet"));put("baseId","10000000-0000-4000-8000-000000000003");put("items",buildJsonArray{add(buildJsonObject{put("installationId","10000000-0000-4000-8000-000000000002");put("previews",JsonArray(listOf(row)))})})}
  installed.verifyRoutes(envelope(rows("v2").first()),2)
  assertThrows(Exception::class.java){installed.verifyRoutes(envelope(rows("v2").first()),1)}
  assertThrows(Exception::class.java){installed.verifyRoutes(envelope(rows("v1").first()),2)}
 }
}
