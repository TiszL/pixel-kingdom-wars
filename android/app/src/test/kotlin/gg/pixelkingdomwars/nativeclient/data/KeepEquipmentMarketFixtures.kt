package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.util.UUID
import kotlinx.serialization.json.*
import org.junit.Assert.*

internal object KeepEquipmentMarketFixtures {
 val vectors=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/keep-equipment-market-vectors.json")).readText()).jsonObject
 val releaseVectors=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/keep-equipment-market-release-vectors.json")).readText()).jsonObject
 fun released(row:JsonObject,failed:Boolean=false)=releaseVectors.getValue("vectors").jsonArray.single{it.jsonObject["name"]==row["name"]}.jsonObject.charterObject(if(failed)"failedReleased"else"unpreparedReleased")
 val policy=vectors.charterObject("policy")
 val rows=vectors.getValue("vectors").jsonArray.map{it.jsonObject}
 fun change(o:JsonObject,path:String,value:JsonElement):JsonObject {val p=path.split('.',limit=2);return JsonObject(o+(p[0] to if(p.size==1)value else change(o.charterObject(p[0]),p[1],value)))}
 fun reserved(row:JsonObject)=JsonObject(row.charterObject("purchase")+mapOf("status" to JsonPrimitive("reserved"),"preparation" to JsonNull))
 class Memory:SecretStore {var value:String?=null;var fail=false;var failRead=false;override fun read():String?{check(!failRead);return value};override fun write(value:String){check(!fail);this.value=value};override fun clear(){error("Market originals must never clear")}}
 class Fixture(val row:JsonObject=rows.first()) {
  val purchase=row.charterObject("purchase");val fill=purchase.charterObject("fill");val wallet=fill.charterText("buyerWallet");val base=fill.charterText("buyerBaseId");val key=fill.charterText("id");val wire=row.charterObject("wire")
  val memory=Memory();val identity=StarterIdentity("https://${UUID.randomUUID()}.test","devnet",wallet);val store=KeepEquipmentMarketStore(memory,identity)
  var allowed=true;var session=true;var owned=true;var configured=true;var selected:String?=base;var currentPolicy=policy;var clock=0L;var nextKey=key
  var releaseHeld=false;var failBeforePost:String?=null;var failLive=false;var failSetup=false;var failWallet=false;var lateWallet=false;var failPost:String?=null;var failAfterRetain=false;var reviewCost:String?=null
  var recoveryCode="KEEP_EQUIPMENT_PAYMENT_UNAVAILABLE";var recoverDelivered=false
  var approvals=0;var hydrates=0;var liveChecks=0;var failHydrate=false;var afterHydrate:()->Unit={}
  val queries=mutableListOf<Pair<String,Map<String,String>>>();var ignoreCategory=false;var listingCursor:JsonObject?=null;var historyCursor:JsonObject?=null
  val calls=mutableListOf<Pair<String,String>>();val posts get()=calls.filter{it.first=="POST"};val remote=mutableMapOf<String,JsonObject>()
  var listing=buildJsonObject{put("id",fill.getValue("listingId"));for(k in listOf("sellerWallet","sellerBaseId","itemId","unitPriceBaseUnits","createdAt"))put(k,fill.getValue(k));put("quantity","10");put("availableQuantity","10");put("reservedQuantity","0");put("cancelledQuantity","0")}
  var historyItems=JsonArray(emptyList())
  var stockVersionOverride:String?=null
  var stockItems=JsonArray(KeepEquipmentMarketCatalogue.itemIds.map{buildJsonObject{put("itemId",it);put("available","10");for(k in listOf("reserved","pendingOutput","marketOutgoing","marketIncoming"))put(k,"0")}})
  fun path(kind:String,id:String=key)=store.path(kind)+"/"+id
  suspend fun adopt(value:JsonObject=purchase):KeepEquipmentMarketRecord {remote[path("fill")]=value;return store.adopt("fill",value,policy)}
  val ports=object:KeepEquipmentMarketPorts {
   override val transport=KeepEquipmentMarketTransport(object:KeepEquipmentMarketPort {
    override val identity=this@Fixture.identity
    override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit):JsonObject {
     guard();calls+=method to path;queries+=path to query.toMap()
     if(method=="POST"&&failBeforePost==path.substringAfterLast('/'))throw IOException("Connection failed before backend relay")
     val raw=if(method=="GET")when(path){
      KeepEquipmentMarketProtocol.ROOT+"/policy"->currentPolicy
      KeepEquipmentMarketProtocol.ROOT+"/stock"->{check(owned);val version=stockVersionOverride?:query["catalogueVersion"];val ids=KeepEquipmentMarketCatalogue.ids(version);buildJsonObject{put("baseId",requireNotNull(selected));put("wallet",wallet);put("serverNow","2035-01-01T00:00:00.000Z");put("policy",currentPolicy);if(version in setOf("2","3","4"))put("catalogueVersion",version!!.toInt());put("items",JsonArray(stockItems.filter{it.jsonObject.charterText("itemId") in ids}))}}
      KeepEquipmentMarketProtocol.ROOT+"/listings"->buildJsonObject{put("items",JsonArray(listOf(listing).filter{ignoreCategory||query["category"]==null||KeepEquipmentMarketCatalogue.category(it.charterText("itemId"))==query["category"]}));put("nextCursor",listingCursor?:JsonNull)}
      KeepEquipmentMarketProtocol.ROOT+"/history"->buildJsonObject{put("wallet",wallet);put("items",JsonArray(historyItems.filter{ignoreCategory||query["category"]==null||KeepEquipmentMarketCatalogue.category(it.jsonObject.charterText("itemId"))==query["category"]}));put("nextCursor",historyCursor?:JsonNull)}
      else->remote[path]?:if(path==path("listing",listing.charterText("id")))listing else throw ApiException(404,"missing","Original not found")
     }else when {
      path==store.path("listing")->buildJsonObject{val b=requireNotNull(body);put("id",b.getValue("idempotencyKey"));put("sellerWallet",wallet);put("sellerBaseId",b.getValue("baseId"));for(k in listOf("itemId","quantity","unitPriceBaseUnits"))put(k,b.getValue(k));put("createdAt","2035-01-01T00:00:00.000Z");put("availableQuantity",b.getValue("quantity"));put("reservedQuantity","0");put("cancelledQuantity","0")}.also{remote[path("listing",it.charterText("id"))]=it}
      path==store.path("fill")->reserved(row).also{remote[path("fill")]=it}
      path==store.path("cancellation")->buildJsonObject{put("id",requireNotNull(body).getValue("idempotencyKey"));put("listingId",listing.getValue("id"));put("actorWallet",wallet);put("quantity",listing.getValue("availableQuantity"));put("createdAt","2035-01-01T00:00:00.000Z")}.also{remote[path("cancellation")]=it}
      path.endsWith("/prepare")->purchase.also{remote[path("fill")]=it}
      path.endsWith("/signed")->row.charterObject("signedPurchase").also{assertEquals(wire["signedTransactionHex"],requireNotNull(body)["signedTransactionHex"]);remote[path("fill")]=it}
      path.endsWith("/review")->(if(remote[path("fill")]?.get("wire")==JsonNull)row.charterObject("review")else row.charterObject("signedReview")).let{v->reviewCost?.let{cost->change(change(v,"current.costs.feeLamports",JsonPrimitive(cost)),"current.costs.totalLamports",JsonPrimitive((cost.toBigInteger()+v.charterObject("current").charterObject("costs").amount("rentLamports")).toString()))}?:v}
      path.endsWith("/release")->requireNotNull(remote[path("fill")]).let{p->if(releaseHeld)throw ApiException(503,"KEEP_EQUIPMENT_RELEASE_UNAVAILABLE","Keep original saved");if(p["preparation"]!=JsonNull&&p["wire"]==JsonNull)throw ApiException(503,"KEEP_EQUIPMENT_RELEASE_PREPARED","Prepared outcome unknown");released(row,p["wire"]!=JsonNull).also{remote[path("fill")]=it}}
      path.endsWith("/recover")->(if(recoverDelivered)row.charterObject("deliveredPurchase").also{remote[path("fill")]=it}else requireNotNull(remote[path("fill")])).also{if(it["delivery"]==JsonNull)throw ApiException(503,recoveryCode,"Original not observed yet")}
      path.endsWith("/deliver")->buildJsonObject{val p=row.charterObject("deliveredPurchase");remote[path("fill")]=p;put("purchase",p);put("status","delivered");put("reason",JsonNull);put("broadcastAuthorized",false);put("fenceReleaseAuthorized",false)}
      else->error("Unexpected market path $path")
     }
     if(method=="POST"&&failPost==path.substringAfterLast('/'))throw IOException("Accepted response lost")
     retain(raw);if(failAfterRetain)session=false;guard();return raw
    }
   })
   override fun capture(fresh:Boolean):()->Unit {val guard={check(session);if(fresh)check(allowed)};guard();return guard}
   override fun selectedBase()=selected
   override fun requireOwnedBase(base:String){check(owned&&base==selected)}
   override fun trust()=if(configured)KeepEquipmentMarketSigningTrust.from(row.charterObject("trust"))else null
   override fun key()=nextKey
   override fun now()=clock
   override suspend fun live(purchase:JsonObject,prepared:PreparedKeepEquipmentMarket,pins:KeepEquipmentMarketSigningTrust,policy:JsonObject,review:JsonObject,guard:()->Unit):()->Unit {liveChecks++;check(!failLive);return guard}
   override suspend fun ready(guard:()->Unit)=guard()
   override suspend fun sign(prepared:PreparedKeepEquipmentMarket,guard:()->Unit,beforeWallet:suspend()->Unit,retain:suspend(JsonObject)->Unit){if(failSetup)throw IOException("Wallet unavailable");beforeWallet();assertTrue("wallet" in store.record(key).attempts);assertEquals(0,posts.count{it.second.endsWith("/signed")||it.second.endsWith("/deliver")});approvals++;if(failWallet)throw IOException("Wallet outcome uncertain");if(lateWallet)session=false;retain(prepared.verifyWire(wire));guard()}
   override suspend fun hydrate(guard:()->Unit){guard();hydrates++;afterHydrate();if(failHydrate)throw IOException("Current account refresh unavailable");guard()}
  }
  fun repo()=KeepEquipmentMarketRepository(store,ports)
 }
}
