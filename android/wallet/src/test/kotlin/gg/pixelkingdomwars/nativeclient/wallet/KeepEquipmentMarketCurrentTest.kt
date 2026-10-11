package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.*
import java.util.Base64
import java.util.Collections
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class KeepEquipmentMarketCurrentTest {
 private val rows=keepMarketRows();private val row=rows.first();private val policy=keepMarketFixture().charterObject("policy")
 private inner class Rpc(val r:JsonObject=row,val edit:(String,JsonElement)->JsonElement={_,v->v}):KeepEquipmentMarketRpcReads {
  var slot=r.number("slot")+1
  val calls=Collections.synchronizedList(mutableListOf<String>());val parameters=Collections.synchronizedList(mutableListOf<Pair<String,JsonArray>>())
  override suspend fun request(method:String,params:JsonArray):JsonObject {
   calls.add(method);parameters.add(method to params)
   fun context(value:JsonElement)=buildJsonObject{put("context",buildJsonObject{put("slot",++slot)});put("value",value)}
   val costs=r.charterObject("review").charterObject("current").charterObject("costs")
   val result=when(method){
    "getGenesisHash"->r.charterObject("trust").getValue("expectedGenesisHash")
    "getSlot"->JsonPrimitive(++slot)
    "getMultipleAccounts"->context(r.getValue("rawAccounts"))
    "getMinimumBalanceForRentExemption"->JsonPrimitive(costs.amount("fullAtaRentLamports").toLong())
    "getFeeForMessage"->context(JsonPrimitive(costs.amount("feeLamports").toLong()))
    "isBlockhashValid"->context(JsonPrimitive(true))
    "getBlockHeight"->r.charterObject("purchase").charterObject("preparation").getValue("lastValidBlockHeight")
    "getSignatureStatuses"->context(JsonArray(listOf(JsonNull)))
    else->error("Current review must never sign, send or replace blockhash: $method")
   }
   return buildJsonObject{put("jsonrpc","2.0");put("id",1);put("result",edit(method,result))}
  }
 }
 private suspend fun verify(r:JsonObject=row,rpc:KeepEquipmentMarketRpcReads=Rpc(r),purchase:JsonObject=r.charterObject("purchase"),review:JsonObject=r.charterObject("review"),trust:JsonObject=r.charterObject("trust"),guard:()->Unit={},clock:()->Long={100})=
  KeepEquipmentMarketCurrent.verify(purchase,KeepEquipmentMarketSigningTrust.from(trust),policy,review,rpc,guard,clock)
 private suspend fun rejected(label:String,rpc:KeepEquipmentMarketRpcReads,r:JsonObject=row,purchase:JsonObject=r.charterObject("purchase"),review:JsonObject=r.charterObject("review"))=assertNotNull(label,runCatching{verify(r,rpc,purchase,review)}.exceptionOrNull())
 private fun accounts(value:JsonElement,index:Int,edit:(JsonObject)->JsonElement):JsonObject {val o=value.jsonObject;val a=o.getValue("value").jsonArray.toMutableList();a[index]=edit(a[index].jsonObject);return keepMarketChange(o,"value",JsonArray(a))}
 private fun data(account:JsonObject,edit:(ByteArray)->Unit):JsonObject {val bytes=Base64.getDecoder().decode(account.getValue("data").jsonArray[0].jsonPrimitive.content);edit(bytes);return keepMarketChange(account,"data",JsonArray(listOf(JsonPrimitive(Base64.getEncoder().encodeToString(bytes)),JsonPrimitive("base64"))))}
 @Test fun `legacy and v0 review read exact packet fee accounts and original blockhash without mutation RPCs`()=runBlocking {
  for(r in rows){val rpc=Rpc(r);verify(r,rpc)()
   assertEquals(listOf("getGenesisHash","getSlot","getMultipleAccounts","getMinimumBalanceForRentExemption","getFeeForMessage","isBlockhashValid","getBlockHeight","getSlot","getGenesisHash"),rpc.calls)
   assertEquals(r.getValue("accountKeys"),rpc.parameters.single{it.first=="getMultipleAccounts"}.second[0])
   val message=r.charterObject("purchase").charterObject("preparation").charterText("messageHex")
   assertEquals(Base64.getEncoder().encodeToString(vehicleHex(message,1,1167)),rpc.parameters.single{it.first=="getFeeForMessage"}.second[0].jsonPrimitive.content)
   assertEquals(r.charterObject("purchase").charterObject("preparation").getValue("blockhash"),rpc.parameters.single{it.first=="isBlockhashValid"}.second[0])
   rpc.parameters.filter{it.first in setOf("getSlot","getMultipleAccounts","getFeeForMessage","isBlockhashValid","getBlockHeight")}.forEach{assertEquals(JsonPrimitive("finalized"),it.second.last().jsonObject["commitment"])}
  }
 }
 @Test fun `wrong genesis and regressed account fee validity or closing banks hold`()=runBlocking {
  rejected("genesis",Rpc(edit={m,v->if(m=="getGenesisHash")row.charterObject("purchase").charterObject("fill").getValue("buyerWallet")else v}))
  for(method in listOf("getSlot","getMultipleAccounts","getFeeForMessage","isBlockhashValid"))rejected(method,Rpc(edit={m,v->if(m!=method)v else if(m=="getSlot")JsonPrimitive(0)else keepMarketChange(v.jsonObject,"context.slot",JsonPrimitive(0))}))
 }
 @Test fun `local bank must reach the server current review floor rather than only original preparation`()=runBlocking {
  val review=row.charterObject("review");val observations=review.charterObject("current").getValue("observations").jsonArray.map{keepMarketChange(it.jsonObject,"closingSlot",JsonPrimitive(row.number("slot")+50))}
  rejected("stale local bank",Rpc(),review=keepMarketChange(review,"current.observations",JsonArray(observations)))
 }
 @Test fun `wrong mint and token authority frozen uninitialized native or executable accounts fail closed`()=runBlocking {
  val mutations=listOf<Pair<Int,(JsonObject)->JsonElement>>(
   0 to {a->keepMarketChange(a,"owner",JsonPrimitive(base58(ByteArray(32))))},0 to {a->data(a){it[44]=(it[44]-1).toByte()}},0 to {a->data(a){it[45]=0}},
   1 to {a->data(a){it[0]=(it[0].toInt() xor 1).toByte()}},1 to {a->data(a){it[32]=(it[32].toInt() xor 1).toByte()}},1 to {a->data(a){it[108]=2}},1 to {a->data(a){it[108]=0}},1 to {a->data(a){it[109]=1}},
   2 to {a->data(a){it[32]=(it[32].toInt() xor 1).toByte()}},2 to {a->data(a){it[108]=2}},2 to {a->keepMarketChange(a,"executable",JsonPrimitive(true))},3 to {a->keepMarketChange(a,"owner",JsonPrimitive(KEEP_MARKET_TOKEN))})
  for((index,edit) in mutations)rejected("account $index",Rpc(edit={m,v->if(m=="getMultipleAccounts")accounts(v,index,edit)else v}))
 }
 @Test fun `missing buyer account or closed originally existing seller account cannot proceed`()=runBlocking {
  for(index in listOf(0,1,2,3))rejected("missing $index",Rpc(edit={m,v->if(m=="getMultipleAccounts")accounts(v,index){JsonNull}else v}))
 }
 @Test fun `full original amount and SOL fee plus ATA rent must be available before approval`()=runBlocking {
  rejected("insufficient KEEP",Rpc(edit={m,v->if(m=="getMultipleAccounts")accounts(v,1){a->data(a){it.fill(0,64,72)}}else v}))
  for(r in rows)rejected("insufficient SOL",Rpc(r,edit={m,v->if(m=="getMultipleAccounts")accounts(v,3){a->keepMarketChange(a,"lamports",JsonPrimitive(0))}else v}),r)
 }
 @Test fun `create idempotent race still requires full saved rent and correct newly existing owner`()=runBlocking {
  val r=rows.last();val buyerAccount=r.getValue("rawAccounts").jsonArray[1].jsonObject
  val seller=data(buyerAccount){bytes->vehicleKey(r.charterObject("purchase").charterObject("fill").charterText("sellerWallet")).copyInto(bytes,32);bytes.fill(0,64,72)}
  val rpc=Rpc(r,edit={m,v->if(m=="getMultipleAccounts")keepMarketChange(v.jsonObject,"value",JsonArray(v.jsonObject.getValue("value").jsonArray.toMutableList().also{it[2]=seller}))else v})
  verify(r,rpc)();assertTrue(rpc.calls.contains("getMinimumBalanceForRentExemption"))
  rejected("rent increased",Rpc(r,edit={m,v->if(m=="getMinimumBalanceForRentExemption")JsonPrimitive(v.jsonPrimitive.long+1)else v}),r)
 }
 @Test fun `unknown or changed actual network fee and rent cannot reuse displayed consent`()=runBlocking {
  for(fee in listOf<JsonElement>(JsonNull,JsonPrimitive("5000"),JsonPrimitive(0),JsonPrimitive(100001)))rejected("fee $fee",Rpc(edit={m,v->if(m=="getFeeForMessage")keepMarketChange(v.jsonObject,"value",fee)else v}))
  rejected("rent mismatch",Rpc(edit={m,v->if(m=="getMinimumBalanceForRentExemption")JsonPrimitive(v.jsonPrimitive.long+1)else v}))
 }
 @Test fun `original blockhash validity and original last valid height are both required`()=runBlocking {
  rejected("invalid hash",Rpc(edit={m,v->if(m=="isBlockhashValid")keepMarketChange(v.jsonObject,"value",JsonPrimitive(false))else v}))
  rejected("expired height",Rpc(edit={m,v->if(m=="getBlockHeight")JsonPrimitive(v.jsonPrimitive.long+1)else v}))
 }
 @Test fun `every retained signature observation forces recovery rather than another approval`()=runBlocking {
  val rpc=Rpc();verify(rpc=rpc,purchase=row.charterObject("signedPurchase"),review=row.charterObject("signedReview"))()
  assertEquals(row.charterObject("wire").getValue("signature"),rpc.parameters.single{it.first=="getSignatureStatuses"}.second[0].jsonArray.single())
  for(status in listOf(buildJsonObject{put("confirmationStatus","processed");put("err",JsonNull)},buildJsonObject{put("err","failed")}))rejected("observed signature",Rpc(edit={m,v->if(m=="getSignatureStatuses")keepMarketChange(v.jsonObject,"value",JsonArray(listOf(status)))else v}),purchase=row.charterObject("signedPurchase"),review=row.charterObject("signedReview"))
 }
 @Test fun `malformed envelope base64 and response account counts hold before wallet call`()=runBlocking {
  rejected("RPC error",KeepEquipmentMarketRpcReads{_,_->buildJsonObject{put("jsonrpc","2.0");put("id",1);put("error","offline")}})
  rejected("parsed encoding",Rpc(edit={m,v->if(m=="getMultipleAccounts")accounts(v,1){a->keepMarketChange(a,"data",JsonArray(listOf(JsonPrimitive(""),JsonPrimitive("jsonParsed"))))}else v}))
  rejected("missing account rows",Rpc(edit={m,v->if(m=="getMultipleAccounts")keepMarketChange(v.jsonObject,"value",JsonArray(emptyList()))else v}))
 }
 @Test fun `returned freshness guard refuses at exact lease expiry and when monotonic time regresses`()=runBlocking {
  var now=100L;val fresh=verify(clock={now});fresh();now+=policy.number("reviewMaxAgeMs")
  assertNotNull("At expiry must require a new review",runCatching{fresh()}.exceptionOrNull())
  now=99;assertNotNull("Clock regression",runCatching{fresh()}.exceptionOrNull())
 }
 @Test fun `session or view loss drains the active read and invokes no subsequent RPC`()=runBlocking {
  var live=true;val rpc=Rpc();val port=KeepEquipmentMarketRpcReads{m,p->rpc.request(m,p).also{live=false}}
  assertTrue(runCatching{verify(rpc=port,guard={check(live)})}.isFailure);assertEquals(listOf("getGenesisHash"),rpc.calls)
  val untouched=Rpc();assertTrue(runCatching{verify(rpc=untouched,guard={check(live)})}.isFailure);assertTrue(untouched.calls.isEmpty())
 }
 @Test fun `timeout keeps ignored cancellation occupied until actual provider calls drain`()=runBlocking {
  val trust=keepMarketChange(keepMarketChange(row.charterObject("trust"),"rpcTimeoutMs",JsonPrimitive(100)),"maxPendingRpc",JsonPrimitive(2))
  val entered=Channel<Unit>(2);val release=CompletableDeferred<Unit>();val calls=Collections.synchronizedList(mutableListOf<String>())
  val port=KeepEquipmentMarketRpcReads{m,_->calls.add(m);withContext(NonCancellable){entered.send(Unit);release.await()};buildJsonObject{put("jsonrpc","2.0");put("id",1);put("result",row.charterObject("trust").getValue("expectedGenesisHash"))}}
  val jobs=List(2){async{runCatching{verify(rpc=port,trust=trust)}}}
  try{withTimeout(2000){repeat(2){entered.receive()}};jobs.forEach{assertTrue(it.await().isFailure)}
   val busy=runCatching{verify(trust=trust)}.exceptionOrNull();assertTrue(busy?.message.orEmpty().contains("busy"));assertEquals(2,calls.size)
  }finally{release.complete(Unit);jobs.forEach{it.join()}}
  withTimeout(2000){while(true){val result=runCatching{verify(trust=trust)};if(result.isSuccess)break;delay(5)}}
  assertEquals(listOf("getGenesisHash","getGenesisHash"),calls)
 }
}
