package gg.pixelkingdomwars.nativeclient.keepequipmentmarket

import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class KeepEquipmentMarketProtocolTest {
 private val fixture=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/keep-equipment-market-vectors.json")).readText()).jsonObject
 private val rows=fixture.getValue("vectors").jsonArray.map{it.jsonObject}
 private fun change(o:JsonObject,path:String,value:JsonElement):JsonObject {val p=path.split('.',limit=2);return JsonObject(o+(p[0] to if(p.size==1)value else change(o.charterObject(p[0]),p[1],value)))}
 private fun rejected(why:String,operation:()->Unit)=assertNotNull(why,runCatching(operation).exceptionOrNull())
 @Test fun `actual legacy and v0 public views retain exact prepared signed and delivered identities`() {
  assertEquals(2,rows.size)
  for(r in rows){for(k in listOf("purchase","signedPurchase","deliveredPurchase"))assertEquals(r.charterObject(k),KeepEquipmentMarketProtocol.purchase(r.charterObject(k)))
   assertEquals(r.charterObject("review"),KeepEquipmentMarketProtocol.review(r.charterObject("review")));assertEquals(r.charterObject("signedReview"),KeepEquipmentMarketProtocol.review(r.charterObject("signedReview")))
   assertEquals(r.charterObject("wire"),KeepEquipmentMarketProtocol.wire(r.charterObject("wire")))
  }
 }
 @Test fun `public policy stays data and never carries request selected trust or authority`() {
  val p=fixture.charterObject("policy");assertEquals(p,KeepEquipmentMarketProtocol.policy(p))
  for((path,value) in listOf("version" to JsonPrimitive(2),"reviewMaxAgeMs" to JsonPrimitive(0),"sellerBps" to p.getValue("basisPoints"),"expectedGenesisHash" to rows.first().charterObject("trust").getValue("expectedGenesisHash")))rejected(path){KeepEquipmentMarketProtocol.policy(change(p,path,value))}
 }
 @Test fun `unknown fields and every claimed authority bit are refused at each public layer`() {
  val r=rows.first();for(k in listOf("signingAuthorized","broadcastAuthorized","fenceReleaseAuthorized","unpaidProven"))rejected(k){KeepEquipmentMarketProtocol.purchase(change(r.charterObject("purchase"),k,JsonPrimitive(true)))}
  for(k in listOf("signingAuthorized","broadcastAuthorized","deliveryAuthorized","fenceReleaseAuthorized","unpaidProven"))rejected(k){KeepEquipmentMarketProtocol.purchase(change(r.charterObject("purchase"),"preparation.$k",JsonPrimitive(true)))}
  rejected("unknown proof shortcut"){KeepEquipmentMarketProtocol.purchase(change(r.charterObject("purchase"),"paymentVerified",JsonPrimitive(true)))}
 }
 @Test fun `frozen participant amount base and item identities cannot drift between receipt layers`() {
  val r=rows.first();val f=r.charterObject("purchase").charterObject("fill")
  for((path,value) in listOf("preparation.original.buyer" to f.getValue("sellerWallet"),"preparation.original.totalBaseUnits" to JsonPrimitive("1"),"fill.totalBaseUnits" to JsonPrimitive("1"),"fill.buyerBaseId" to f.getValue("sellerBaseId")))rejected(path){KeepEquipmentMarketProtocol.purchase(change(r.charterObject("purchase"),path,value))}
  for((path,value) in listOf("delivery.buyerBaseId" to f.getValue("sellerBaseId"),"delivery.itemId" to JsonPrimitive("survey_lens"),"delivery.quantity" to JsonPrimitive("2"),"delivery.proof.burnBaseUnits" to JsonPrimitive("1")))rejected(path){KeepEquipmentMarketProtocol.purchase(change(r.charterObject("deliveredPurchase"),path,value))}
 }
 @Test fun `status requires the corresponding immutable evidence and cannot hide a retained signature`() {
  val r=rows.first();for((view,status) in listOf("purchase" to "delivered","signedPurchase" to "prepared","deliveredPurchase" to "signed"))rejected(status){KeepEquipmentMarketProtocol.purchase(change(r.charterObject(view),"status",JsonPrimitive(status)))}
  rejected("wire without original"){KeepEquipmentMarketProtocol.purchase(change(r.charterObject("signedPurchase"),"preparation",JsonNull))}
  rejected("delivery without wire"){KeepEquipmentMarketProtocol.purchase(change(r.charterObject("deliveredPurchase"),"wire",JsonNull))}
 }
 @Test fun `ATA creation needs explicit full rent consent while existing account excludes invented rent cap`() {
  val existing=rows.first().charterObject("purchase");val created=rows.last().charterObject("purchase")
  rejected("invented cap"){KeepEquipmentMarketProtocol.purchase(change(existing,"preparation.original.sellerAtaRentCapLamports",JsonPrimitive("1")))}
  rejected("insufficient cap"){KeepEquipmentMarketProtocol.purchase(change(created,"preparation.original.sellerAtaRentCapLamports",JsonPrimitive("1")))}
  rejected("missing cap"){KeepEquipmentMarketProtocol.purchase(change(created,"preparation.original",JsonObject(created.charterObject("preparation").charterObject("original")-"sellerAtaRentCapLamports")))}
  rejected("discounted rent"){KeepEquipmentMarketProtocol.purchase(change(created,"preparation.costs.rentLamports",JsonPrimitive("0")))}
 }
 @Test fun `review binds original message blockhash expiry mint provider pins and its own lease ordering`() {
  val v=rows.first().charterObject("review")
  for(k in listOf("blockhash","expectedGenesisHash","expectedKeepMint"))rejected(k){KeepEquipmentMarketProtocol.review(change(v,"current.$k",v.charterObject("purchase").charterObject("fill").getValue("buyerWallet")))}
  for(k in listOf("messageSha256","messageHex"))rejected(k){KeepEquipmentMarketProtocol.review(change(v,"current.$k",JsonPrimitive("00".repeat(if(k=="messageSha256")32 else 1))))}
  rejected("replacement provider"){KeepEquipmentMarketProtocol.review(change(v,"current.providerIds",JsonArray(listOf(JsonPrimitive("x"),JsonPrimitive("y")))))}
  rejected("empty lease"){KeepEquipmentMarketProtocol.review(change(v,"expiresAt",v.getValue("reviewedAt")))}
  rejected("finality claim"){KeepEquipmentMarketProtocol.review(change(v,"current.finalityVerified",JsonPrimitive(true)))}
 }
 @Test fun `quantities and payment identities reject unsafe or ambiguous numeric representations`() {
  val v=rows.first().charterObject("purchase")
  for(x in listOf<JsonElement>(JsonPrimitive(1),JsonPrimitive("01"),JsonPrimitive("-1"),JsonPrimitive("1.0"),JsonPrimitive("9223372036854775808")))rejected(x.toString()){KeepEquipmentMarketProtocol.purchase(change(v,"fill.quantity",x))}
  rejected("non-v4 payment memo"){KeepEquipmentMarketProtocol.purchase(change(v,"fill.id",JsonPrimitive("00000000-0000-7000-8000-000000000001")))}
 }
 @Test fun `submitted response needs retained wire and never proves delivery`() {
  val r=rows.first();fun send(view:String,status:String,reason:JsonElement=JsonNull)=buildJsonObject{put("purchase",r.charterObject(view));put("status",status);put("reason",reason);put("broadcastAuthorized",false);put("fenceReleaseAuthorized",false)}
  KeepEquipmentMarketProtocol.send(send("signedPurchase","submitted"));KeepEquipmentMarketProtocol.send(send("deliveredPurchase","delivered"));KeepEquipmentMarketProtocol.send(send("signedPurchase","held",JsonPrimitive("SEND_UNCERTAIN")))
  rejected("unsigned submit"){KeepEquipmentMarketProtocol.send(send("purchase","submitted"))};rejected("unproven delivery"){KeepEquipmentMarketProtocol.send(send("signedPurchase","delivered"))};rejected("unexplained hold"){KeepEquipmentMarketProtocol.send(send("signedPurchase","held"))}
 }
 @Test fun `requests accept only explicit market actions and reject buyer supplied proofs callbacks and providers`() {
  val f=rows.first().charterObject("purchase").charterObject("fill");val root=KeepEquipmentMarketProtocol.ROOT;val id=f.charterText("id")
  KeepEquipmentMarketProtocol.request("GET","$root/policy",mapOf("version" to "1"),null)
  for(action in listOf("prepare","review","recover","deliver","release")){KeepEquipmentMarketProtocol.request("POST","$root/fills/$id/$action",emptyMap(),buildJsonObject{});rejected(action){KeepEquipmentMarketProtocol.request("POST","$root/fills/$id/$action",emptyMap(),buildJsonObject{put("proof",true)})}}
  for(path in listOf("$root/fills/$id/replace","${root}X/fills/$id"))rejected(path){KeepEquipmentMarketProtocol.request("POST",path,emptyMap(),buildJsonObject{})}
  rejected("policy version"){KeepEquipmentMarketProtocol.request("GET","$root/policy",mapOf("version" to "2"),null)}
 }
 @Test fun `history continuation requires complete time id and kind tie breakers without wallet override`() {
  val r=rows.first().charterObject("purchase").charterObject("fill");val root=KeepEquipmentMarketProtocol.ROOT;val cursor=mapOf("before" to r.charterText("createdAt"),"beforeId" to r.charterText("id"),"beforeKind" to "fill")
  KeepEquipmentMarketProtocol.request("GET","$root/history",cursor,null)
  for(k in cursor.keys)rejected(k){KeepEquipmentMarketProtocol.request("GET","$root/history",cursor-k,null)}
  rejected("foreign wallet"){KeepEquipmentMarketProtocol.request("GET","$root/history",mapOf("wallet" to r.charterText("sellerWallet")),null)}
 }
 @Test fun `bounded copy rejects oversized strings arrays and recursive response nesting`() {
  rejected("oversized text"){KeepEquipmentMarketProtocol.copy(JsonPrimitive("x".repeat(8193)))}
  rejected("oversized rows"){KeepEquipmentMarketProtocol.copy(JsonArray(List(129){JsonNull}))}
  var nested:JsonElement=JsonNull;repeat(18){nested=buildJsonObject{put("n",nested)}};rejected("deep payload"){KeepEquipmentMarketProtocol.copy(nested)}
 }
 private val releasedRows=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/keep-equipment-market-release-vectors.json")).readText()).jsonObject.getValue("vectors").jsonArray.map{it.jsonObject}
 @Test fun `both terminal release reasons retain exact original while active ABI stays unchanged`() {
  for(r in releasedRows)for(kind in listOf("unpreparedReleased","failedReleased")){val p=r.charterObject(kind);assertEquals(p,KeepEquipmentMarketProtocol.purchase(p));assertTrue(KeepEquipmentMarketProtocol.terminalPurchase(p))}
  assertFalse(KeepEquipmentMarketProtocol.terminalPurchase(rows.first().charterObject("purchase")))
 }
 @Test fun `release cannot hide preparation signature delivery or foreign failure proof`() {
  val r=releasedRows.first();val failed=r.charterObject("failedReleased");val never=r.charterObject("unpreparedReleased")
  for((path,value) in listOf("release" to JsonNull,"release.reason" to JsonPrimitive("expired"),"release.fillId" to failed.charterObject("fill").getValue("listingId"),"release.signature" to JsonNull,"release.proof.buyer" to failed.charterObject("fill").getValue("sellerWallet"),"release.proof.wireSha256" to JsonPrimitive("00".repeat(32)),"release.proof.transactionVersion" to JsonPrimitive(0),"release.proof.providerIds" to JsonArray(listOf(JsonPrimitive("other"),JsonPrimitive("providers"))),"status" to JsonPrimitive("signed"),"delivery" to rows.first().charterObject("deliveredPurchase").getValue("delivery")))rejected(path){KeepEquipmentMarketProtocol.purchase(change(failed,path,value))}
  rejected("prepared cannot claim never prepared"){KeepEquipmentMarketProtocol.purchase(change(never,"preparation",failed.getValue("preparation")))}
  rejected("never prepared cannot hide signature"){KeepEquipmentMarketProtocol.purchase(change(never,"release.signature",failed.charterObject("wire").getValue("signature")))}
 }
 @Test fun `failure observations require bounded rollback context and every authority stays false`() {
  val r=releasedRows.first().charterObject("failedReleased");for((path,value) in listOf("release.proof.slot" to JsonPrimitive(0),"release.proof.error" to JsonNull,"release.proof.lamportsAfter" to r.charterObject("release").charterObject("proof").getValue("lamportsBefore"),"release.proof.observations" to JsonArray(emptyList()),"release.proof.paymentAuthorized" to JsonPrimitive(true),"release.proof.fenceReleaseAuthorized" to JsonPrimitive(true),"release.proof.paidKeepBaseUnits" to JsonPrimitive("1"),"release.proof.rentLamports" to JsonPrimitive("1")))rejected(path){KeepEquipmentMarketProtocol.purchase(change(r,path,value))}
 }
 @Test fun `released purchase cannot become a new review or submitted response`() {
  val p=releasedRows.first().charterObject("failedReleased");rejected("released review"){KeepEquipmentMarketProtocol.review(change(rows.first().charterObject("signedReview"),"purchase",p))}
  fun send(status:String)=buildJsonObject{put("purchase",p);put("status",status);put("reason",if(status=="held")JsonPrimitive("FILL_RELEASED")else JsonNull);put("broadcastAuthorized",false);put("fenceReleaseAuthorized",false)}
  KeepEquipmentMarketProtocol.send(send("held"));rejected("released submitted"){KeepEquipmentMarketProtocol.send(send("submitted"))}
 }

 @Test fun `fourth catalogue admits all kits as Items while every historical set stays frozen`() {
  assertEquals(listOf(2,11,12,14),listOf(null,"2","3","4").map{KeepEquipmentMarketCatalogue.ids(it).size})
  for(kit in listOf("navigation_kit","climate_kit","expedition_kit"))assertEquals("items",KeepEquipmentMarketCatalogue.category(kit))
  for(kit in listOf("climate_kit","expedition_kit")){
   KeepEquipmentMarketProtocol.request("GET",KeepEquipmentMarketProtocol.ROOT+"/listings",mapOf("catalogueVersion" to "4","category" to "items","itemId" to kit),null)
   for(v in listOf(null,"2","3"))rejected("old discovery $v"){KeepEquipmentMarketProtocol.request("GET",KeepEquipmentMarketProtocol.ROOT+"/listings",mapOf("itemId" to kit)+(v?.let{mapOf("catalogueVersion" to it)}?:emptyMap()),null)}
   rejected("kit resource category"){KeepEquipmentMarketProtocol.request("GET",KeepEquipmentMarketProtocol.ROOT+"/listings",mapOf("catalogueVersion" to "4","category" to "resources","itemId" to kit),null)}
  }
 }

}
