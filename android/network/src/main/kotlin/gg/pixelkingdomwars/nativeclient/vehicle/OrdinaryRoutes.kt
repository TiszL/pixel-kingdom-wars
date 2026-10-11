package gg.pixelkingdomwars.nativeclient.vehicle

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.starter.starterResourceRealms
import java.math.BigInteger
import kotlinx.serialization.json.*

data class OrdinaryRoute(val id:String,val chain:String,val index:Int,val realmId:String,val grade:Long)
data class OrdinaryRouteCrop(val path:String,val x:Int,val y:Int,val cell:Int,val atlas:Int)

/** Installed immutable catalogue, never supplied by a route response. Economics
 * reuse admitted v1 family/tier defaults; the visual chain confers no access. */
class OrdinaryRoutes private constructor(val raw:JsonObject,val routes:List<OrdinaryRoute>) {
 val policyVersion get()=CharterGrammar.number(raw.getValue("policyVersion"))
 fun route(id:String)=routes.single{it.id==id}
 fun crop(id:String):OrdinaryRouteCrop {
  val route=route(id);val art=raw.charterObject("art");val columns=CharterGrammar.number(art.getValue("columns")).toInt();val cell=CharterGrammar.number(art.getValue("cell")).toInt();val atlas=CharterGrammar.number(art.getValue("atlas")).toInt()
  return OrdinaryRouteCrop("atlas/fantasy/globe/generated/${route.chain}-detail.png",route.index%columns*cell,route.index/columns*cell,cell,atlas).also{require(it.x+cell<=atlas&&it.y+cell<=atlas)}
 }
 fun verify(snapshot:JsonObject,policy:VehiclePolicy) {
  require(snapshot["policyVersion"]==raw["policyVersion"])
  val r=route(snapshot.charterText("routeId"));val tier=CharterGrammar.number(snapshot.getValue("tier"));require(tier in policy.tiers&&tier>=r.grade)
  val v1=policy.raw.charterObject("advanced").charterObject("v1");val family=v1.charterObject("families").charterObject(snapshot.charterText("family"))
  val factor=CharterGrammar.number(raw.charterObject("gradeFactors").getValue(r.grade.toString())).toBigInteger()
  require(snapshot.charterText("realmId")==r.realmId&&starterResourceRealms[snapshot.charterText("resourceId")]==r.realmId)
  require(snapshot.charterText("accessRequirement")==if(snapshot.charterText("homeRealmId")==r.realmId)"home" else "paid_realm")
  val duration=CharterGrammar.number(family.getValue("durationSecByTier").jsonArray[(tier-1).toInt()]).toBigInteger()*factor
  val gross=CharterGrammar.number(family.getValue("grossRawByTier").jsonArray[(tier-1).toInt()]).toBigInteger()*factor
  val denominator=CharterGrammar.number(v1.getValue("basisPoints")).toBigInteger();val numerator=gross*CharterGrammar.number(v1.getValue("islandPoolBps")).toBigInteger()
  require(denominator.signum()>0&&numerator%denominator==BigInteger.ZERO);val tax=numerator/denominator
  require(CharterGrammar.number(snapshot.getValue("durationSec")).toBigInteger()==duration&&CharterGrammar.amount(snapshot.getValue("grossQuantity"))==gross&&CharterGrammar.amount(snapshot.getValue("islandPoolQuantity"))==tax&&CharterGrammar.amount(snapshot.getValue("netQuantity"))==gross-tax)
  val supplies=family.getValue("supplies").jsonArray.map{it.jsonObject}.sortedBy{it.charterText("resourceId")}.map{buildJsonObject{put("resourceId",it.getValue("resourceId"));put("quantity",(CharterGrammar.number(it.getValue("quantity")).toBigInteger()*factor).toString())}}
  require(snapshot["supplies"]==JsonArray(supplies))
 }
 companion object {
  fun from(input:JsonObject,tiers:List<Long>):OrdinaryRoutes {
   val v=VehicleProtocol.copy(input).jsonObject;require(v.keys==setOf("policyVersion","gradeFactors","art","routes")&&CharterGrammar.number(v.getValue("policyVersion"))==2L)
   val factors=v.charterObject("gradeFactors");require(factors.keys==tiers.map{it.toString()}.toSet());factors.values.forEach{require(CharterGrammar.number(it)>0)}
   val art=v.charterObject("art");require(art.keys==setOf("columns","cell","atlas"));require(CharterGrammar.number(art.getValue("columns")) in 1..64);for(k in listOf("cell","atlas"))require(CharterGrammar.number(art.getValue(k)) in 1..8192)
   val rows=v.charterObject("routes").map{(id,raw)->val r=raw.jsonObject;require(r.keys==setOf("chain","index","realmId","grade"));val chain=r.charterText("chain");require(chain.matches(Regex("[a-z][a-z0-9-]{0,63}")));val index=CharterGrammar.number(r.getValue("index"));require(index in 0..511&&id=="$chain-${index+1}");val grade=CharterGrammar.number(r.getValue("grade"));require(grade in tiers);val realm=r.charterText("realmId");require(realm in starterResourceRealms.values);OrdinaryRoute(id,chain,index.toInt(),realm,grade)}
   require(rows.map{it.realmId to it.grade}.toSet()==starterResourceRealms.values.flatMap{realm->tiers.map{realm to it}}.toSet()&&rows.map{it.realmId to it.grade}.distinct().size==rows.size)
   return OrdinaryRoutes(v,rows).also{catalogue->rows.forEach{catalogue.crop(it.id)}}
  }
 }
}
