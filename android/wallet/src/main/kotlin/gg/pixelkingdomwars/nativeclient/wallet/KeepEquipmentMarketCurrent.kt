package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.*
import java.math.BigInteger
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

fun interface KeepEquipmentMarketRpcReads {suspend fun request(method:String,params:JsonArray):JsonObject}
/** Installed read-only relay checks current accounts over the exact packet after
 * the API's independent-provider review. No send or recovery authority follows. */
object KeepEquipmentMarketCurrent {
 private val lock=Any();private var pending=0;private val workers=CoroutineScope(SupervisorJob()+Dispatchers.IO)
 suspend fun verify(purchase:JsonObject,pins:KeepEquipmentMarketSigningTrust,policy:JsonObject,review:JsonObject,rpc:KeepEquipmentMarketRpcReads,guard:()->Unit,monotonicMs:()->Long={System.nanoTime()/1_000_000}):()->Unit {
  guard();val client=KeepEquipmentMarketProtocol.purchase(purchase);val checked=KeepEquipmentMarketProtocol.review(review);require(checked["purchase"]==client)
  val frozen=KeepEquipmentMarketSigningTrust.from(pins.toJson());val prepared=KeepEquipmentMarketTransaction.prepare(client,frozen,policy);require(client["delivery"]==JsonNull)
  val started=monotonicMs();require(started>=0);fun fresh(){guard();val age=Math.subtractExact(monotonicMs(),started);require(age>=0&&age<frozen.policy.number("reviewMaxAgeMs")){"Review this saved payment again"}}
  synchronized(lock){require(pending<frozen.number("maxPendingRpc")){"Market network check is busy"};pending++}
  val abandoned=AtomicBoolean(false);val task=workers.async(start=CoroutineStart.LAZY){
   suspend fun call(method:String,params:JsonArray):JsonElement {currentCoroutineContext().ensureActive();check(!abandoned.get());fresh();val raw=KeepEquipmentMarketProtocol.copy(rpc.request(method,params)).jsonObject;currentCoroutineContext().ensureActive();check(!abandoned.get());fresh();require(raw.keys.containsAll(setOf("jsonrpc","id","result"))&&raw.keys.all{it in setOf("jsonrpc","id","result","error")}&&raw["jsonrpc"]==JsonPrimitive("2.0")&&(raw["error"]==null||raw["error"]==JsonNull));return raw.getValue("result")}
   inspect(client,prepared,frozen,checked.charterObject("current"),::call);fresh()
  };task.invokeOnCompletion{synchronized(lock){pending--}};task.start()
  try{withTimeout(frozen.number("rpcTimeoutMs")){task.await()};fresh()}finally{abandoned.set(true);if(!task.isCompleted)task.cancel()};return ::fresh
 }
 private suspend fun inspect(client:JsonObject,prepared:PreparedKeepEquipmentMarket,pins:KeepEquipmentMarketSigningTrust,current:JsonObject,call:suspend(String,JsonArray)->JsonElement){
  val p=client.charterObject("preparation");val o=p.charterObject("original");val keys=listOf(pins.text("expectedKeepMint"),prepared.buyerAta,prepared.sellerAta,prepared.wallet)
  require(call("getGenesisHash",params())==pins.value("expectedGenesisHash")){"Market network changed"}
  val floor=maxOf(p.number("minContextSlot"),current.getValue("observations").jsonArray.maxOf{it.jsonObject.number("closingSlot")})
  val opening=CharterGrammar.number(call("getSlot",params(options())));require(opening>=floor){"Market node has not reached the current review"}
  val snapshot=call("getMultipleAccounts",params(JsonArray(keys.map(::JsonPrimitive)),options(opening,"base64"))).jsonObject;var slot=context(snapshot,opening)
  val rows=snapshot.getValue("value").jsonArray;require(rows.size==4);val mint=account(rows[0],82)!!;require(mint.owner==KEEP_MARKET_TOKEN&&mint.data.size==82&&mint.data[45].toInt()==1&&(mint.data[44].toInt()and 255).toLong()==pins.policy.number("decimals")&&little(mint.data,0,4)<=BigInteger.ONE&&little(mint.data,46,4)<=BigInteger.ONE)
  val buyer=account(rows[1],165)!!;require(token(buyer,keys[0],prepared.wallet)>=o.amount("totalBaseUnits")){"Wallet needs the original KEEP amount"}
  val seller=account(rows[2],165);val create=!CharterGrammar.bool(o.getValue("sellerAtaExists"))
  if(seller?.owner==KEEP_MARKET_TOKEN)token(seller,keys[0],o.charterText("seller"))else require(create&&(seller==null||seller.owner==base58(ByteArray(32))&&seller.data.isEmpty())){"Seller token account changed"}
  val wallet=account(rows[3],0)!!;require(wallet.owner==base58(ByteArray(32))&&wallet.data.isEmpty())
  val rent=CharterGrammar.number(call("getMinimumBalanceForRentExemption",params(JsonPrimitive(165),options()))).toBigInteger();require(rent.signum()>0&&rent==current.charterObject("costs").amount("fullAtaRentLamports")){"ATA rent changed. Review this payment again"}
  if(create)require(rent<=o.amount("sellerAtaRentCapLamports")){"Full ATA rent exceeds your original consent"}
  val message=prepared.unsignedTransaction().let{it.copyOfRange(65,it.size)};val quote=call("getFeeForMessage",params(JsonPrimitive(Base64.getEncoder().encodeToString(message)),options())).jsonObject;slot=context(quote,slot)
  val fee=CharterGrammar.number(quote.getValue("value")).toBigInteger();require(fee==current.charterObject("costs").amount("feeLamports")&&fee<=p.charterObject("limits").amount("maxFeeLamports")&&fee<=pins.limits.amount("maxFeeLamports")){"Network fee changed. Review this payment again"}
  require(wallet.lamports>=fee+if(create)rent else BigInteger.ZERO){"Wallet needs SOL for the full original payment cost"}
  val valid=call("isBlockhashValid",params(p.getValue("blockhash"),options(slot))).jsonObject;slot=context(valid,slot);require(CharterGrammar.bool(valid.getValue("value"))){"Original payment expired or is unresolved. Check saved payment"}
  require(CharterGrammar.number(call("getBlockHeight",params(options(slot))))<=p.number("lastValidBlockHeight")){"Original payment expired or is unresolved. Check saved payment"}
  client.charterOptional("wire")?.let{val status=call("getSignatureStatuses",params(JsonArray(listOf(it.getValue("signature"))),buildJsonObject{put("searchTransactionHistory",true)})).jsonObject;slot=context(status,slot);require(status.getValue("value").jsonArray==JsonArray(listOf(JsonNull))){"Original payment is already observed. Check saved payment"}}
  require(CharterGrammar.number(call("getSlot",params(options())))>=slot&&call("getGenesisHash",params())==pins.value("expectedGenesisHash"))
 }
 private data class Account(val owner:String,val lamports:BigInteger,val data:ByteArray)
 private fun account(raw:JsonElement,max:Int):Account? {if(raw==JsonNull)return null;val o=raw.jsonObject;require(o.keys.containsAll(setOf("owner","executable","lamports","data"))&&o.keys.all{it in setOf("owner","executable","lamports","data","rentEpoch","space")}&&!CharterGrammar.bool(o.getValue("executable")));CharterGrammar.address(o.getValue("owner"));val data=o.getValue("data").jsonArray;require(data.size==2&&data[1]==JsonPrimitive("base64"));val encoded=CharterGrammar.text(data[0]);require(encoded.length<=(max+2)/3*4);val bytes=Base64.getDecoder().decode(encoded);require(bytes.size<=max&&Base64.getEncoder().encodeToString(bytes)==encoded);o["space"]?.let{require(CharterGrammar.number(it)==bytes.size.toLong())};return Account(o.charterText("owner"),CharterGrammar.number(o.getValue("lamports")).toBigInteger(),bytes)}
 private fun token(a:Account,mint:String,owner:String):BigInteger {val d=a.data;require(a.owner==KEEP_MARKET_TOKEN&&d.size==165&&base58(d.copyOfRange(0,32))==mint&&base58(d.copyOfRange(32,64))==owner&&d[108].toInt()==1&&little(d,109,4)==BigInteger.ZERO&&little(d,72,4)<=BigInteger.ONE&&little(d,129,4)<=BigInteger.ONE){"Original token account is unavailable or frozen"};return little(d,64,8)}
 private fun little(bytes:ByteArray,start:Int,length:Int)=BigInteger(1,bytes.copyOfRange(start,start+length).reversedArray())
 private fun params(vararg values:JsonElement)=JsonArray(values.toList())
 private fun options(slot:Long?=null,encoding:String?=null)=buildJsonObject{put("commitment","finalized");slot?.let{put("minContextSlot",it)};encoding?.let{put("encoding",it)}}
 private fun context(raw:JsonObject,min:Long):Long {require(raw.keys==setOf("context","value"));val c=raw.charterObject("context");require(c.keys.contains("slot")&&c.keys.all{it in setOf("slot","apiVersion")});return c.number("slot").also{require(it>=min)}}
}
