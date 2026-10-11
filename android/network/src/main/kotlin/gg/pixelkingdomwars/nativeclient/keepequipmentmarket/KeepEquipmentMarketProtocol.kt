package gg.pixelkingdomwars.nativeclient.keepequipmentmarket

import gg.pixelkingdomwars.nativeclient.charter.*
import java.math.BigInteger
import kotlinx.serialization.json.*

private typealias MarketCheck=(JsonElement)->Unit
private val count:MarketCheck={CharterGrammar.number(it)}
private val amount:MarketCheck={CharterGrammar.amount(it)}
private val positive:MarketCheck={CharterGrammar.amount(it,true)}
private val quantity:MarketCheck={require(CharterGrammar.amount(it,true)<=Long.MAX_VALUE.toBigInteger())}
private val stockValue:MarketCheck={require(CharterGrammar.amount(it)<=Long.MAX_VALUE.toBigInteger())}
private val address:MarketCheck=CharterGrammar::address
private val id:MarketCheck=CharterGrammar::id
private val paymentId:MarketCheck={id(it);require(CharterGrammar.text(it)[14]=='4')}
private val hash:MarketCheck={CharterGrammar.hex(it,32)}
private val timestamp:MarketCheck={CharterGrammar.timestamp(it);require(CharterGrammar.text(it).matches(Regex(".*\\.[0-9]{3}Z")))}
private val bool:MarketCheck={CharterGrammar.bool(it)}
private val no:MarketCheck={require(!CharterGrammar.bool(it))}
private val yes:MarketCheck={require(CharterGrammar.bool(it))}
private val version:MarketCheck={require(CharterGrammar.number(it)==1L)}
private fun enum(vararg allowed:String):MarketCheck={require(CharterGrammar.text(it) in allowed)}
private val item:MarketCheck={require(CharterGrammar.text(it) in KeepEquipmentMarketCatalogue.itemIds)}
private fun nullable(check:MarketCheck):MarketCheck={if(it!=JsonNull)check(it)}
private fun obj(vararg fields:Pair<String,MarketCheck>):MarketCheck={raw->val o=raw.jsonObject;require(o.keys==fields.map{it.first}.toSet());fields.forEach{(k,c)->c(o.getValue(k))}}
private fun array(min:Int,max:Int,check:MarketCheck):MarketCheck={raw->val a=raw.jsonArray;require(a.size in min..max);a.forEach(check)}
private val signature:MarketCheck={val s=CharterGrammar.text(it);require(s.length in 64..88&&s.matches(Regex("[1-9A-HJ-NP-Za-km-z]+")))}
private val pins:MarketCheck={raw->val a=raw.jsonArray;require(a.size==2&&a.distinct().size==2);a.forEach{require(CharterGrammar.text(it).length in 1..128)}}
private val flags=arrayOf("signingAuthorized" to no,"broadcastAuthorized" to no,"deliveryAuthorized" to no,"fenceReleaseAuthorized" to no,"unpaidProven" to no)
private val original:MarketCheck={raw->val o=raw.jsonObject;val exists=CharterGrammar.bool(o.getValue("sellerAtaExists"));obj("reservationId" to paymentId,"buyer" to address,"seller" to address,"keepMint" to address,"totalBaseUnits" to positive,"sellerAtaExists" to bool,*if(exists)emptyArray()else arrayOf("sellerAtaRentCapLamports" to positive))(o);require(o["buyer"]!=o["seller"])}
private val limits=obj("maxFeeLamports" to amount,"maxPriorityFeeLamports" to amount,"maxComputeUnitLimit" to count)
private val observation=obj("openingSlot" to count,"accountSlot" to count,"feeSlot" to count,"validitySlot" to count,"closingSlot" to count,"currentBlockHeight" to count,"feeLamports" to amount)
private val account=obj("address" to address,"owner" to nullable(address),"lamports" to amount,"dataLength" to count,"dataSha256" to nullable(hash),"executable" to no)
private val commonPreparation=arrayOf("version" to version,"transactionVersion" to {v:JsonElement->require(v==JsonPrimitive("legacy")||v==JsonPrimitive(0))},"original" to original,"limits" to limits,
 "expectedGenesisHash" to address,"expectedKeepMint" to address,"providerIds" to pins,"blockhash" to address,"lastValidBlockHeight" to count,"minContextSlot" to count,"messageSha256" to hash,"messageHex" to {v:JsonElement->CharterGrammar.hex(v,max=1167)},
 "observedAccounts" to array(4,4,account),"accountEvidenceSha256" to hash,"observations" to array(2,2,observation),
 "balances" to obj("buyerKeepBaseUnits" to amount,"sellerKeepBaseUnits" to nullable(amount),"buyerSolLamports" to amount,"sellerAccountState" to enum("existing","missing","prefunded")),
 "costs" to obj("feeLamports" to amount,"rentLamports" to amount,"fullAtaRentLamports" to amount,"totalLamports" to amount),*flags)
private val listingShape=obj("id" to id,"sellerWallet" to address,"sellerBaseId" to id,"itemId" to item,"quantity" to quantity,"unitPriceBaseUnits" to positive,"createdAt" to timestamp,"availableQuantity" to stockValue,"reservedQuantity" to stockValue,"cancelledQuantity" to stockValue)
private val fillShape=obj("id" to paymentId,"listingId" to id,"buyerWallet" to address,"buyerBaseId" to id,"quantity" to quantity,"totalBaseUnits" to positive,"createdAt" to timestamp,"sellerWallet" to address,"sellerBaseId" to id,"itemId" to item,"unitPriceBaseUnits" to positive)
private val cancellationShape=obj("id" to id,"listingId" to id,"actorWallet" to address,"quantity" to quantity,"createdAt" to timestamp)
private val wireFields=arrayOf("signature" to signature,"wireSha256" to hash,"messageSha256" to hash,"signedTransactionHex" to {v:JsonElement->CharterGrammar.hex(v,max=1232);require(CharterGrammar.text(v).length>=132)})
private val proof=obj("version" to version,"signature" to signature,"reservationId" to paymentId,"buyer" to address,"seller" to address,"keepMint" to address,"buyerAta" to address,"sellerAta" to address,"totalBaseUnits" to positive,"sellerBaseUnits" to positive,"burnBaseUnits" to positive,
 "slot" to count,"feeLamports" to amount,"createsSellerAta" to bool,"sellerAtaCreated" to bool,"sellerAtaRentCapLamports" to amount,"sellerAtaRentLamports" to amount,"innerInstructionsSha256" to hash,"messageSha256" to hash,
 "resolvedKeys" to array(1,16,address),"tokenBefore" to array(2,2,amount),"tokenAfter" to array(2,2,amount),"lamportsBefore" to array(1,16,count),"lamportsAfter" to array(1,16,count),"evidenceSha256" to hash,"fenceReleaseAuthorized" to no,"unpaidProven" to no,"expectedGenesisHash" to address,"providerIds" to pins,"finalizedAgreement" to yes)
private val failureError:MarketCheck={raw->
 fun bounded(v:JsonElement,depth:Int){require(depth<=4);when(v){is JsonObject->{require(v.size==1&&v.keys.single().length<=64);bounded(v.values.single(),depth+1)};is JsonArray->{require(v.size in 1..2);v.forEach{bounded(it,depth+1)}};is JsonPrimitive->{if(v.isString)require(v.content.length in (if(depth==0)1 else 0)..256)else count(v)}}}
 require(raw is JsonObject||raw is JsonPrimitive&&raw.isString);bounded(raw,0)
}
private val failedProof=obj("version" to version,"outcome" to enum("failed"),"reservationId" to paymentId,"buyer" to address,"seller" to address,"keepMint" to address,"totalBaseUnits" to positive,
 "signature" to signature,"messageSha256" to hash,"wireSha256" to hash,"transactionVersion" to {v:JsonElement->require(v==JsonPrimitive("legacy")||v==JsonPrimitive(0))},"slot" to {count(it);require(CharterGrammar.number(it)>0)},"blockTime" to count,"error" to failureError,"feeLamports" to amount,
 "resolvedKeys" to array(1,16,address),"lamportsBefore" to array(1,16,count),"lamportsAfter" to array(1,16,count),"tokenBalances" to nullable(array(1,2,obj("accountIndex" to count,"mint" to address,"owner" to address,"programId" to address,"decimals" to {count(it);require(CharterGrammar.number(it)<=255)},"amount" to amount))),"evidenceSha256" to hash,
 "rentLamports" to {require(it==JsonPrimitive("0"))},"paidKeepBaseUnits" to {require(it==JsonPrimitive("0"))},"expectedGenesisHash" to address,"providerIds" to pins,"minContextSlot" to count,
 "observations" to array(2,2,obj("openingSlot" to count,"closingSlot" to count)),"finalizedAgreement" to yes,"paymentAuthorized" to no,*flags)
private val cursor=obj("before" to timestamp,"beforeId" to id)
private val historyCursor=obj("before" to timestamp,"beforeId" to id,"beforeKind" to enum("listing","fill","cancellation"))

/** Closed public ABI. These checks bind originals, never chain or signing authority. */
object KeepEquipmentMarketProtocol {
 const val ROOT="/keep-equipment-market"
 fun copy(raw:JsonElement):JsonElement {var nodes=0;var chars=0;fun own(v:JsonElement,depth:Int):JsonElement{require(++nodes<=8192&&depth<=16);return when(v){is JsonObject->{require(v.size<=48);JsonObject(v.mapValues{(k,x)->require(k.length<=64);own(x,depth+1)})};is JsonArray->{require(v.size<=128);JsonArray(v.map{own(it,depth+1)})};is JsonPrimitive->{chars+=v.content.length;require(v.content.length<=8192&&chars<=1_048_576);v}}};return own(raw,0)}
 private fun checked(raw:JsonObject,check:MarketCheck)=copy(raw).jsonObject.also(check)
 fun policy(raw:JsonObject)=checked(raw,obj("version" to version,"decimals" to count,"minFillBaseUnits" to positive,"sellerBps" to count,"basisPoints" to count,"reviewMaxAgeMs" to count)).also{require(it.number("decimals")<=255&&it.number("sellerBps") in 1 until it.number("basisPoints")&&it.number("reviewMaxAgeMs")>0)}
 fun stock(raw:JsonObject):JsonObject {
  val expanded="catalogueVersion" in raw;val ids=when(raw["catalogueVersion"]){null->KeepEquipmentMarketCatalogue.equipmentIds;JsonPrimitive(2)->KeepEquipmentMarketCatalogue.craftingCatalogueIds;JsonPrimitive(3)->KeepEquipmentMarketCatalogue.fragmentCatalogueIds;JsonPrimitive(4)->KeepEquipmentMarketCatalogue.itemIds;else->error("Unsupported market stock catalogue")}
  return checked(raw,obj("baseId" to id,"wallet" to address,"serverNow" to timestamp,"policy" to {policy(it.jsonObject)},
   *if(expanded)arrayOf("catalogueVersion" to {v:JsonElement->require(v==JsonPrimitive(2)||v==JsonPrimitive(3)||v==JsonPrimitive(4))})else emptyArray(),
   "items" to array(ids.size,ids.size,obj("itemId" to item,"available" to stockValue,"reserved" to stockValue,"pendingOutput" to stockValue,"marketOutgoing" to stockValue,"marketIncoming" to stockValue)))).also{v->
   val rows=v.getValue("items").jsonArray.map{it.jsonObject};require(rows.map{it.charterText("itemId")}.toSet()==ids)
   rows.forEach{r->require(r.charterText("itemId") in KeepEquipmentMarketCatalogue.equipmentIds||r.charterText("reserved")=="0");require(r.charterText("itemId")!="crystal_fragment"||r.charterText("pendingOutput")=="0");require(listOf("available","reserved","pendingOutput","marketOutgoing","marketIncoming").fold(BigInteger.ZERO){sum,k->sum+r.amount(k)}<=Long.MAX_VALUE.toBigInteger())}
  }
 }
 fun listing(raw:JsonObject)=checked(raw,listingShape).also{require(it.amount("quantity")==it.amount("availableQuantity")+it.amount("reservedQuantity")+it.amount("cancelledQuantity"))}
 fun fill(raw:JsonObject)=checked(raw,fillShape).also{require(it["buyerWallet"]!=it["sellerWallet"]&&it["buyerBaseId"]!=it["sellerBaseId"]&&it.amount("totalBaseUnits")==it.amount("quantity")*it.amount("unitPriceBaseUnits"))}
 fun cancellation(raw:JsonObject)=checked(raw,cancellationShape)
 fun preparation(raw:JsonObject,saved:Boolean=true)=checked(raw,obj(*commonPreparation,"blockhashSlot" to count,*if(saved)arrayOf("recordedAt" to timestamp)else emptyArray())).also(::preparationConsistency)
 fun current(raw:JsonObject)=checked(raw,obj(*commonPreparation,"currentReviewPassed" to yes,"finalityVerified" to no)).also(::preparationConsistency)
 private fun preparationConsistency(p:JsonObject){val o=p.charterObject("original");require(o["keepMint"]==p["expectedKeepMint"]);val c=p.charterObject("costs");require(c.amount("totalLamports")==c.amount("feeLamports")+c.amount("rentLamports"));val create=!CharterGrammar.bool(o.getValue("sellerAtaExists"));require(c.amount("rentLamports")==if(create)c.amount("fullAtaRentLamports")else BigInteger.ZERO);if(create)require(c.amount("fullAtaRentLamports")<=o.amount("sellerAtaRentCapLamports"));require(c.amount("feeLamports")<=p.charterObject("limits").amount("maxFeeLamports"));require(p.number("lastValidBlockHeight")>0)}
 fun wire(raw:JsonObject,saved:Boolean=false)=checked(raw,obj(*wireFields,*if(saved)arrayOf("recordedAt" to timestamp)else emptyArray()))
 fun failure(raw:JsonObject)=checked(raw,failedProof).also{v->
  val keys=v.getValue("resolvedKeys").jsonArray;val before=v.getValue("lamportsBefore").jsonArray;val after=v.getValue("lamportsAfter").jsonArray
  require(keys.distinct().size==keys.size&&keys.first()==v["buyer"]&&before.size==keys.size&&after.size==keys.size&&v.number("slot")>=v.number("minContextSlot"))
  v.getValue("observations").jsonArray.forEach{val o=it.jsonObject;require(o.number("openingSlot")>=v.number("minContextSlot")&&o.number("closingSlot")>=maxOf(o.number("openingSlot"),v.number("slot")))}
  before.indices.forEach{i->require(CharterGrammar.number(before[i]).toBigInteger()-CharterGrammar.number(after[i]).toBigInteger()==if(i==0)v.amount("feeLamports")else BigInteger.ZERO)}
  if(v["tokenBalances"]!=JsonNull){val rows=v.getValue("tokenBalances").jsonArray.map{it.jsonObject};require(rows.map{it.number("accountIndex")}.distinct().size==rows.size);rows.forEach{require(it.number("accountIndex")<keys.size&&it["mint"]==v["keepMint"]&&it["owner"] in listOf(v["buyer"],v["seller"]))}}
 }
 fun release(raw:JsonObject)=checked(raw,obj("fillId" to paymentId,"reason" to enum("never_prepared","finalized_failed"),"signature" to nullable(signature),"proof" to nullable{failure(it.jsonObject)},"releasedAt" to timestamp)).also{v->
  if(v.charterText("reason")=="never_prepared")require(v["signature"]==JsonNull&&v["proof"]==JsonNull)else{val p=v.charterObject("proof");require(v["signature"]!=JsonNull&&p["signature"]==v["signature"]&&p["reservationId"]==v["fillId"])}
 }
 fun terminalPurchase(v:JsonObject)=v["delivery"]!=JsonNull||v["release"]!=null
 fun purchase(raw:JsonObject):JsonObject {val v=checked(raw,obj("fill" to {fill(it.jsonObject)},"preparation" to nullable{preparation(it.jsonObject)},"wire" to nullable{wire(it.jsonObject,true)},"delivery" to nullable(obj("fillId" to paymentId,"buyerBaseId" to id,"itemId" to item,"quantity" to quantity,"proof" to proof,"deliveredAt" to timestamp)),"status" to enum("reserved","prepared","signed","delivered","released"),*if("release" in raw)arrayOf("release" to {release(it.jsonObject)})else emptyArray(),"signingAuthorized" to no,"broadcastAuthorized" to no,"fenceReleaseAuthorized" to no,"unpaidProven" to no));
  val f=v.charterObject("fill");val p=v.charterOptional("preparation");val w=v.charterOptional("wire");val d=v.charterOptional("delivery");val r=v["release"]?.jsonObject;require(v.charterText("status")==when{r!=null->"released";d!=null->"delivered";w!=null->"signed";p!=null->"prepared";else->"reserved"});require(w==null||p!=null);require(d==null||p!=null&&w!=null)
  r?.let{require(d==null&&it["fillId"]==f["id"]);if(it.charterText("reason")=="never_prepared")require(p==null&&w==null)else{
   require(p!=null&&w!=null);val q=it.charterObject("proof");require(it["signature"]==w["signature"]&&q["signature"]==w["signature"]&&q["wireSha256"]==w["wireSha256"])
   for((a,b)in listOf("reservationId" to "id","buyer" to "buyerWallet","seller" to "sellerWallet","totalBaseUnits" to "totalBaseUnits"))require(q[a]==f[b])
   require(q["keepMint"]==p["expectedKeepMint"]&&q["expectedGenesisHash"]==p["expectedGenesisHash"]&&q["providerIds"]==p["providerIds"]&&q["messageSha256"]==p["messageSha256"]&&q["transactionVersion"]==p["transactionVersion"]&&q.number("minContextSlot")>=p.number("minContextSlot"))
  }}
  p?.let{val o=it.charterObject("original");for((a,b)in listOf("reservationId" to "id","buyer" to "buyerWallet","seller" to "sellerWallet","totalBaseUnits" to "totalBaseUnits"))require(o[a]==f[b]);w?.let{require(it["messageSha256"]==p["messageSha256"])}}
  d?.let{for((a,b)in listOf("fillId" to "id","buyerBaseId" to "buyerBaseId","itemId" to "itemId","quantity" to "quantity"))require(it[a]==f[b]);val q=it.charterObject("proof");for((a,b)in listOf("reservationId" to "id","buyer" to "buyerWallet","seller" to "sellerWallet","totalBaseUnits" to "totalBaseUnits"))require(q[a]==f[b]);require(q["signature"]==w!!["signature"]&&q["messageSha256"]==p!!["messageSha256"]&&q["keepMint"]==p["expectedKeepMint"]&&q["expectedGenesisHash"]==p["expectedGenesisHash"]&&q.amount("totalBaseUnits")==q.amount("sellerBaseUnits")+q.amount("burnBaseUnits"))};return v
 }
 fun review(raw:JsonObject)=checked(raw,obj("purchase" to {purchase(it.jsonObject)},"current" to {current(it.jsonObject)},"reviewedAt" to timestamp,"expiresAt" to timestamp)).also{require(it.charterObject("purchase")["release"]==null);val p=it.charterObject("purchase").charterObject("preparation");val c=it.charterObject("current");for(k in listOf("original","transactionVersion","messageHex","messageSha256","blockhash","lastValidBlockHeight","minContextSlot","limits","expectedGenesisHash","expectedKeepMint","providerIds"))require(p[k]==c[k]);require(java.time.Instant.parse(it.charterText("expiresAt")).isAfter(java.time.Instant.parse(it.charterText("reviewedAt"))))}
 fun send(raw:JsonObject)=checked(raw,obj("purchase" to {purchase(it.jsonObject)},"status" to enum("delivered","submitted","held"),"reason" to nullable{require(CharterGrammar.text(it).length in 1..128)},"broadcastAuthorized" to no,"fenceReleaseAuthorized" to no)).also{when(it.charterText("status")){"delivered"->require(it.charterObject("purchase")["delivery"]!=JsonNull&&it["reason"]==JsonNull);"submitted"->require(it.charterObject("purchase")["release"]==null&&it.charterObject("purchase")["wire"]!=JsonNull&&it["reason"]==JsonNull);else->require(it["reason"]!=JsonNull)}}
 fun listings(raw:JsonObject)=checked(raw,obj("items" to array(0,20){listing(it.jsonObject)},"nextCursor" to nullable(cursor)))
 fun history(raw:JsonObject)=checked(raw,obj("wallet" to address,"items" to array(0,20,obj("kind" to enum("listing","fill","cancellation"),"id" to id,"baseId" to id,"itemId" to item,"createdAt" to timestamp)),"nextCursor" to nullable(historyCursor)))
 fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?){require(method in setOf("GET","POST"));if(method=="GET")require(body==null)else require(query.isEmpty()&&body!=null)
  val suffix=path.removePrefix(ROOT);require(path.startsWith(ROOT));when{
   method=="GET"&&suffix=="/policy"->require(query==mapOf("version" to "1"))
   method=="GET"&&suffix=="/stock"->{require(query.keys.all{it in setOf("baseId","catalogueVersion")});id(JsonPrimitive(query.getValue("baseId")));query["catalogueVersion"]?.let{require(it in setOf("2","3","4"))}}
   method=="GET"&&suffix in setOf("/listings","/history")-> {val allowed=if(suffix=="/listings")setOf("catalogueVersion","category","itemId","before","beforeId")else setOf("catalogueVersion","category","itemId","before","beforeId","beforeKind");require(query.keys.all{it in allowed});query["catalogueVersion"]?.let{require(it in setOf("2","3","4"))};query["category"]?.let{require(query["catalogueVersion"] in setOf("2","3","4")&&it in setOf("resources","items"))};query["itemId"]?.let{item(JsonPrimitive(it));require(it in KeepEquipmentMarketCatalogue.ids(query["catalogueVersion"]));query["category"]?.let{c->require(KeepEquipmentMarketCatalogue.category(it)==c)}};val cursorKeys=if(suffix=="/history")setOf("before","beforeId","beforeKind")else setOf("before","beforeId");require(query.keys.intersect(cursorKeys).let{it.isEmpty()||it==cursorKeys});query["before"]?.let{timestamp(JsonPrimitive(it))};query["beforeId"]?.let{id(JsonPrimitive(it))};query["beforeKind"]?.let{enum("listing","fill","cancellation")(JsonPrimitive(it))}}
   method=="POST"&&suffix=="/listings"->obj("idempotencyKey" to id,"baseId" to id,"itemId" to item,"quantity" to quantity,"unitPriceBaseUnits" to positive)(body!!)
   method=="POST"&&suffix=="/fills"->obj("idempotencyKey" to paymentId,"listingId" to id,"buyerBaseId" to id,"quantity" to quantity)(body!!)
   method=="POST"&&suffix=="/cancellations"->obj("idempotencyKey" to id,"listingId" to id)(body!!)
   else->{val parts=suffix.split('/');require(parts.size in 3..4&&parts[0].isEmpty());id(JsonPrimitive(parts[2]));if(method=="GET"){require(parts.size==3&&parts[1] in setOf("listings","fills","cancellations")&&query.isEmpty())}else{require(parts.size==4&&parts[1]=="fills");when(parts[3]){"signed"->obj("signedTransactionHex" to {CharterGrammar.hex(it,max=1232)})(body!!);"prepare","recover","review","deliver","release"->require(body!!.isEmpty());else->error("Unsupported market action")}}}
  }
 }
}
fun JsonObject.amount(key:String)=CharterGrammar.amount(getValue(key))
fun JsonObject.number(key:String)=CharterGrammar.number(getValue(key))
