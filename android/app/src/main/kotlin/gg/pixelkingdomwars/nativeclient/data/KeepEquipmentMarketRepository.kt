package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

interface KeepEquipmentMarketPorts {
 val transport:KeepEquipmentMarketTransport
 fun capture(fresh:Boolean):()->Unit
 fun selectedBase():String?
 fun requireOwnedBase(base:String)
 fun trust():KeepEquipmentMarketSigningTrust?
 fun key():String
 fun now():Long
 suspend fun live(purchase:JsonObject,prepared:PreparedKeepEquipmentMarket,pins:KeepEquipmentMarketSigningTrust,policy:JsonObject,review:JsonObject,guard:()->Unit):()->Unit
 suspend fun ready(guard:()->Unit)
 suspend fun sign(prepared:PreparedKeepEquipmentMarket,guard:()->Unit,beforeWallet:suspend()->Unit,retain:suspend(JsonObject)->Unit)
 suspend fun hydrate(guard:()->Unit)
}
data class KeepEquipmentMarketState(val busy:Boolean=false,val journal:KeepEquipmentMarketJournal?=null,val policy:JsonObject?=null,
 val stock:JsonObject?=null,val listings:JsonObject?=null,val history:JsonObject?=null,val selectedKey:String?=null,val category:String="items",
 val commandReview:KeepEquipmentMarketRecord?=null,val paymentReview:JsonObject?=null,val notice:String?=null,val error:String?=null) {
 val selected get()=journal?.records?.singleOrNull{it.key==selectedKey}
}
/** All writes and wallet transitions are explicit. Foreground only GETs saved
 * originals. Quantity, destination, payment packet and key never follow UI edits. */
class KeepEquipmentMarketRepository(private val store:KeepEquipmentMarketStore,private val ports:KeepEquipmentMarketPorts) {
 private val mutable=MutableStateFlow(KeepEquipmentMarketState());val state=mutable.asStateFlow();private var epoch=0L;private var reviewGuard:(()->Unit)?=null;private val hydrated=mutableSetOf<String>()
 init{require(store.identity==ports.transport.identity)}
 fun dismiss(){epoch++;reviewGuard=null;mutable.value=mutable.value.copy(commandReview=null,paymentReview=null)}
 suspend fun awaitIdle(){store.requests.withLock{}}
 private fun select(key:String){reviewGuard=null;mutable.value=mutable.value.copy(selectedKey=key,commandReview=null,paymentReview=null,notice=null)}
 private fun selected()=requireNotNull(state.value.selected){"Open a saved market request"}
 private suspend fun reload(guard:()->Unit,requireHydration:Boolean,observeOnly:Boolean=false){
  val j=store.read();guard();val complete=j.records.filter{it.response!=null&&store.terminal(it)}.map{it.key}
  if(complete.any{it !in hydrated}){
   // Saved evidence is historical. Current stock stays unavailable until domain refresh succeeds.
   if(observeOnly){mutable.value=mutable.value.copy(journal=j,stock=null);return}
   try{ports.hydrate(guard);guard();hydrated.addAll(complete)}catch(error:Exception){
    if(error is CancellationException)throw error
    guard();mutable.value=mutable.value.copy(stock=null)
    if(requireHydration)throw error
    mutable.value=mutable.value.copy(journal=j,error="Current kingdom stock could not refresh. Saved requests and original receipt checks remain available.");return
   }
  }
  mutable.value=mutable.value.copy(journal=j)
 }
 private suspend fun action(fresh:Boolean,work:suspend(()->Unit)->Unit){val captured=ports.capture(fresh);val e=epoch;val guard={captured();check(epoch==e){"The market view changed. Your original request is saved"}};guard();check(store.requests.tryLock()){"Another market action is running"}
  try{mutable.value=mutable.value.copy(busy=true,error=null,notice=null);reload(guard,requireHydration=fresh,observeOnly=!fresh);work(guard);reload(guard,requireHydration=fresh)}catch(error:Exception){reviewGuard=null;if(runCatching{guard()}.isSuccess)mutable.value=mutable.value.copy(error=error.message,commandReview=null,paymentReview=null);throw error}finally{store.requests.unlock();if(runCatching{captured()}.isSuccess)mutable.value=mutable.value.copy(busy=false)}
 }
 private fun owned(base:String,guard:()->Unit){guard();check(ports.selectedBase()==base){"Select the original kingdom to confirm this stock command"};ports.requireOwnedBase(base)}
 private suspend fun policy(guard:()->Unit):JsonObject {val p=KeepEquipmentMarketProtocol.policy(ports.transport.request("GET",KeepEquipmentMarketProtocol.ROOT+"/policy",guard=guard,query=mapOf("version" to "1")));guard();mutable.value=mutable.value.copy(policy=p);return p}
 private suspend fun stock(base:String,guard:()->Unit):JsonObject {owned(base,guard);val v=KeepEquipmentMarketProtocol.stock(ports.transport.request("GET",KeepEquipmentMarketProtocol.ROOT+"/stock",guard=guard,query=mapOf("baseId" to base,"catalogueVersion" to "4")));require(v["catalogueVersion"]==JsonPrimitive(4));require(v.charterText("wallet")==store.identity.wallet&&v.charterText("baseId")==base);owned(base,guard);mutable.value=mutable.value.copy(stock=v,policy=v.charterObject("policy"));return v}
 private suspend fun fetch(r:KeepEquipmentMarketRecord,guard:()->Unit):Boolean {if(r.discardedUnsent)return false;return try{ports.transport.request("GET",store.path(r.kind)+"/"+r.key,guard=guard){store.retain(r.key,it)};true}catch(error:ApiException){if(error.status==404&&r.response==null)false else throw error}}
 private fun discovery(cursor:Map<String,String>)=cursor+mapOf("catalogueVersion" to "4","category" to state.value.category)
 private fun categoryRows(v:JsonObject){require(v.getValue("items").jsonArray.all{KeepEquipmentMarketCatalogue.category(it.jsonObject.charterText("itemId"))==state.value.category}){"Market results belong to another category"}}
 private suspend fun history(cursor:Map<String,String>,guard:()->Unit){val v=KeepEquipmentMarketProtocol.history(ports.transport.request("GET",KeepEquipmentMarketProtocol.ROOT+"/history",guard=guard,query=discovery(cursor)));require(v.charterText("wallet")==store.identity.wallet);categoryRows(v);guard();mutable.value=mutable.value.copy(history=v)}
 private suspend fun listings(cursor:Map<String,String>,guard:()->Unit){val v=KeepEquipmentMarketProtocol.listings(ports.transport.request("GET",KeepEquipmentMarketProtocol.ROOT+"/listings",guard=guard,query=discovery(cursor)));categoryRows(v);guard();mutable.value=mutable.value.copy(listings=v)}
 suspend fun browse(category:String)=action(false){guard->require(category in setOf("resources","items"));mutable.value=mutable.value.copy(category=category,listings=null,history=null);history(emptyMap(),guard);listings(emptyMap(),guard)}
 suspend fun open()=action(false){guard->mutable.value=mutable.value.copy(commandReview=null,paymentReview=null,stock=null);reviewGuard=null;for(r in store.read().pending)fetch(r,guard);policy(guard);history(emptyMap(),guard)
  try{listings(emptyMap(),guard);ports.selectedBase()?.let{if(runCatching{ports.requireOwnedBase(it)}.isSuccess)stock(it,guard)}}catch(error:ApiException){guard();mutable.value=mutable.value.copy(error=error.message)}
 }
 suspend fun page(kind:String)=action(false){guard->val current=if(kind=="listings")state.value.listings else state.value.history;val c=requireNotNull(current).charterOptional("nextCursor")?:return@action;val query=c.mapValues{CharterGrammar.text(it.value)};if(kind=="listings")listings(query,guard)else{require(kind=="history");history(query,guard)}}
 suspend fun check()=action(false){guard->for(r in store.read().pending)fetch(r,guard)}
 suspend fun selectSaved(key:String)=action(false){guard->select(key);fetch(store.record(key),guard)}
 suspend fun openHistory(row:JsonObject)=action(false){guard->require(row in requireNotNull(state.value.history).getValue("items").jsonArray);val kind=row.charterText("kind");val key=row.charterText("id");val old=store.read().records.singleOrNull{it.key==key};if(old!=null){require(old.kind==kind);select(key);fetch(old,guard)}else{val p=state.value.policy?:policy(guard);ports.transport.request("GET",store.path(kind)+"/"+key,guard=guard){raw->val f=if(kind=="fill")raw.charterObject("fill")else raw;require(f.charterText("id")==key);if(kind!="cancellation")require(f[if(kind=="fill")"buyerBaseId" else "sellerBaseId"]==row["baseId"]&&f["itemId"]==row["itemId"]);store.adopt(kind,raw,p)};select(key)}}
 private suspend fun offer(id:String,guard:()->Unit)=KeepEquipmentMarketProtocol.listing(ports.transport.request("GET",store.path("listing")+"/"+id,guard=guard))
 private suspend fun review(r:KeepEquipmentMarketRecord,guard:()->Unit){store.begin(r);guard();select(r.key);mutable.value=mutable.value.copy(commandReview=r)}
 suspend fun reviewListing(item:String,quantity:String,unitPriceBaseUnits:String)=action(true){guard->val base=requireNotNull(ports.selectedBase());val view=stock(base,guard);val p=view.charterObject("policy");val request=buildJsonObject{put("idempotencyKey",ports.key());put("baseId",base);put("itemId",item);put("quantity",quantity);put("unitPriceBaseUnits",unitPriceBaseUnits)};KeepEquipmentMarketProtocol.request("POST",store.path("listing"),emptyMap(),request);require(quantity.toBigInteger()<=view.getValue("items").jsonArray.single{it.jsonObject.charterText("itemId")==item}.jsonObject.amount("available")){"Not enough available stock"};review(KeepEquipmentMarketRecord("listing",request.charterText("idempotencyKey"),request,p),guard)}
 suspend fun reviewFill(displayed:JsonObject,quantity:String)=action(true){guard->requireNotNull(ports.trust()){"Market wallet approval is not configured"};val base=requireNotNull(ports.selectedBase());val view=stock(base,guard);val p=view.charterObject("policy");require(requireNotNull(ports.trust()).policy==p){"Installed market policy changed"};val original=KeepEquipmentMarketProtocol.listing(displayed);val current=offer(original.charterText("id"),guard);require(JsonObject(current-setOf("availableQuantity","reservedQuantity","cancelledQuantity"))==JsonObject(original-setOf("availableQuantity","reservedQuantity","cancelledQuantity"))&&current.charterText("sellerWallet")!=store.identity.wallet)
  val request=buildJsonObject{put("idempotencyKey",ports.key());put("listingId",current.getValue("id"));put("buyerBaseId",base);put("quantity",quantity)};KeepEquipmentMarketProtocol.request("POST",store.path("fill"),emptyMap(),request);val total=quantity.toBigInteger()*current.amount("unitPriceBaseUnits");require(quantity.toBigInteger()<=current.amount("availableQuantity")&&total>=p.amount("minFillBaseUnits")&&total.bitLength()<=64){"Choose an available quantity that meets the minimum payment"};review(KeepEquipmentMarketRecord("fill",request.charterText("idempotencyKey"),request,p,preview=current),guard)}
 suspend fun reviewCancel(displayed:JsonObject)=action(true){guard->val current=offer(displayed.charterText("id"),guard);owned(current.charterText("sellerBaseId"),guard);require(current.amount("availableQuantity").signum()>0);val p=state.value.policy?:policy(guard);val key=ports.key();val request=buildJsonObject{put("idempotencyKey",key);put("listingId",current.getValue("id"))};review(KeepEquipmentMarketRecord("cancellation",key,request,p,preview=current),guard)}
 private suspend fun currentCommand(r:KeepEquipmentMarketRecord,guard:()->Unit){val base=when(r.kind){"listing"->r.request.charterText("baseId");"fill"->r.request.charterText("buyerBaseId");else->requireNotNull(r.preview).charterText("sellerBaseId")};owned(base,guard);val view=stock(base,guard);if(r.kind=="fill")require(requireNotNull(ports.trust()){"Market wallet approval is not configured"}.policy==r.policy);require(view["policy"]==r.policy){"Market policy changed. Check your saved request"};if(r.kind=="listing")require(view.getValue("items").jsonArray.single{it.jsonObject["itemId"]==r.request["itemId"]}.jsonObject.amount("available")>=r.request.amount("quantity"))else{val v=offer(r.request.charterText("listingId"),guard);val old=requireNotNull(r.preview);require(JsonObject(v-setOf("availableQuantity","reservedQuantity","cancelledQuantity"))==JsonObject(old-setOf("availableQuantity","reservedQuantity","cancelledQuantity")));require(v.amount("availableQuantity")>=if(r.kind=="fill")r.request.amount("quantity")else java.math.BigInteger.ONE)}}
 private suspend fun submit(r:KeepEquipmentMarketRecord,guard:()->Unit){store.attempt(r.key,"post",true);guard();ports.transport.request("POST",store.path(r.kind),r.request,guard){store.retain(r.key,it)};guard();mutable.value=mutable.value.copy(commandReview=null);ports.hydrate(guard)}
 suspend fun confirm()=action(true){guard->val shown=requireNotNull(state.value.commandReview);val r=store.record(shown.key);require(r==shown&&!r.held);if(fetch(r,guard)){mutable.value=mutable.value.copy(commandReview=null);return@action};currentCommand(r,guard);submit(r,guard)}
 suspend fun reviewSaved(key:String)=action(true){guard->val r=store.record(key);select(key);if(fetch(r,guard))return@action;require(!r.held&&!r.discardedUnsent&&r.attempts.isEmpty());currentCommand(r,guard);mutable.value=mutable.value.copy(commandReview=r)}
 suspend fun retry(key:String)=action(false){guard->val r=store.record(key);select(key);if(fetch(r,guard))return@action;require(!r.held&&!r.discardedUnsent&&!r.closedAbsent&&r.attempts.any{it.startsWith("post:")}){"Review and confirm the saved draft first"};val fresh=ports.capture(true);val combined={guard();fresh()};reload(combined,requireHydration=true);currentCommand(r,combined);submit(r,combined)}
 suspend fun command(name:String)=action(name=="prepare"){guard->require(name in setOf("prepare","recover"));val old=selected();require(old.kind=="fill");fetch(old,guard);val r=store.record(old.key);if(r.response?.let(KeepEquipmentMarketProtocol::terminalPurchase)==true||name=="recover"&&r.response?.get("wire")==JsonNull)return@action;if(name=="prepare")requireNotNull(ports.trust()){"Market wallet approval is not configured"};store.attempt(r.key,name,true);guard();ports.transport.request("POST",store.path("fill")+"/${r.key}/$name",buildJsonObject{},guard){store.retain(r.key,it)};reviewGuard=null;mutable.value=mutable.value.copy(paymentReview=null)}
 private suspend fun current(r:KeepEquipmentMarketRecord,pins:KeepEquipmentMarketSigningTrust,guard:()->Unit):Pair<PreparedKeepEquipmentMarket,()->Unit>{val purchase=requireNotNull(r.response);val prepared=KeepEquipmentMarketTransaction.prepare(purchase,pins,r.policy);val started=ports.now();require(started>=0);var review:JsonObject?=null
  ports.transport.request("POST",store.path("fill")+"/${r.key}/review",buildJsonObject{},guard){raw->val v=KeepEquipmentMarketProtocol.review(raw);store.retain(r.key,v.charterObject("purchase"));require(v["purchase"]==purchase);val duration=java.time.Duration.between(java.time.Instant.parse(v.charterText("reviewedAt")),java.time.Instant.parse(v.charterText("expiresAt"))).toMillis();require(duration==r.policy.number("reviewMaxAgeMs"));guard();review=v}
  val checked=requireNotNull(review);val live=ports.live(purchase,prepared,pins,r.policy,checked,guard);val fresh={guard();live();require(Math.subtractExact(ports.now(),started).let{it>=0&&it<r.policy.number("reviewMaxAgeMs")}){"Review this saved payment again"};check(ports.trust()?.toJson()==pins.toJson())};fresh();mutable.value=mutable.value.copy(paymentReview=checked);return prepared to fresh
 }
 suspend fun reviewPayment()=action(true){guard->val old=selected();require(old.kind=="fill");fetch(old,guard);val r=store.record(old.key);require(!r.held&&r.signed==null&&"wallet" !in r.attempts&&r.response?.get("wire")==JsonNull&&r.response["delivery"]==JsonNull&&r.response["release"]==null);val pins=requireNotNull(ports.trust()){"Market wallet approval is not configured"};val(_,fresh)=current(r,pins,guard);store.consent(r.key,KeepEquipmentMarketConsent(requireNotNull(r.response),requireNotNull(state.value.paymentReview),pins.toJson()));fresh();reviewGuard=fresh}
 suspend fun approve(acceptRentCap:Boolean=false)=action(true){guard->requireNotNull(reviewGuard){"Review the original payment first"}();val old=selected();fetch(old,guard);val r=store.record(old.key);require(!r.held&&r.signed==null&&"wallet" !in r.attempts&&r.response?.get("wire")==JsonNull&&r.response["delivery"]==JsonNull&&r.response["release"]==null);val consent=requireNotNull(r.consent);require(CharterGrammar.bool(consent.purchase.charterObject("preparation").charterObject("original").getValue("sellerAtaExists"))||acceptRentCap){"Confirm the full seller account rent cap before approving"};val pins=requireNotNull(ports.trust());require(consent.pins==pins.toJson()&&consent.purchase["fill"]==r.response["fill"]&&consent.purchase["preparation"]==r.response["preparation"])
  val(prepared,fresh)=current(r,pins,guard);require(consent.review.charterObject("current")["costs"]==state.value.paymentReview!!.charterObject("current")["costs"]){"Payment cost changed. Review it again"};ports.ready(fresh);fresh();val marked=java.util.concurrent.atomic.AtomicBoolean(false);ports.sign(prepared,fresh,{check(marked.compareAndSet(false,true));fresh();store.attempt(r.key,"wallet");fresh()}){store.signed(r.key,it)};check(marked.get());fresh();reviewGuard=null;mutable.value=mutable.value.copy(paymentReview=null)
 }
 suspend fun send()=action(true){guard->val old=selected();require(old.kind=="fill");fetch(old,guard);var r=store.record(old.key);require(!r.held);if(r.response?.let(KeepEquipmentMarketProtocol::terminalPurchase)==true)return@action
  if(r.response?.get("wire")==JsonNull){val wire=requireNotNull(r.signed){"Approve the saved payment first"};KeepEquipmentMarketTransaction.verifyWire(requireNotNull(r.consent).purchase,wire,r.policy);store.attempt(r.key,"upload",true);guard();ports.transport.request("POST",store.path("fill")+"/${r.key}/signed",buildJsonObject{put("signedTransactionHex",wire.getValue("signedTransactionHex"))},guard){store.retain(r.key,it)};r=store.record(r.key)}
  require(r.response?.get("wire")!=JsonNull)
  // A previous relay can have paid already, including after a lost HTTP reply.
  // Only transaction-unavailable permits fresh checks of the SAME signed wire;
  // it is never evidence of nonpayment or permission to replace/release it.
  store.attempt(r.key,"recover",true)
  try{ports.transport.request("POST",store.path("fill")+"/${r.key}/recover",buildJsonObject{},guard){store.retain(r.key,it)}}catch(error:ApiException){if(error.status!=503||error.code!="KEEP_EQUIPMENT_PAYMENT_UNAVAILABLE")throw error}
  r=store.record(r.key);if(r.response?.let(KeepEquipmentMarketProtocol::terminalPurchase)==true)return@action
  val pins=requireNotNull(ports.trust());val(_,fresh)=current(r,pins,guard);store.attempt(r.key,"deliver",true);fresh();ports.transport.request("POST",store.path("fill")+"/${r.key}/deliver",buildJsonObject{},fresh){raw->val v=KeepEquipmentMarketProtocol.send(raw);store.retain(r.key,v.charterObject("purchase"));guard();mutable.value=mutable.value.copy(notice=when(v.charterText("status")){"delivered"->"Goods delivered to the original kingdom";"submitted"->"Payment submitted. Check its saved result";else->"Payment held: ${v.charterText("reason")}. Keep this original"})};reviewGuard=null;mutable.value=mutable.value.copy(paymentReview=null)
 }
 /** Explicit original recovery. Preparing without a returned signature stays
  * unresolved. A locally retained exact signature may be uploaded, never sent. */
 suspend fun release()=action(false){guard->val old=selected();require(old.kind=="fill");fetch(old,guard);var r=store.record(old.key);require(!r.held);var purchase=requireNotNull(r.response)
  if(KeepEquipmentMarketProtocol.terminalPurchase(purchase))return@action
  if(purchase["preparation"]!=JsonNull&&purchase["wire"]==JsonNull){val wire=requireNotNull(r.signed){"Payment was prepared. Keep this original until its outcome can be checked"};KeepEquipmentMarketTransaction.verifyWire(requireNotNull(r.consent).purchase,wire,r.policy)
   store.attempt(r.key,"upload",true);guard();ports.transport.request("POST",store.path("fill")+"/${r.key}/signed",buildJsonObject{put("signedTransactionHex",wire.getValue("signedTransactionHex"))},guard){store.retain(r.key,it)};r=store.record(r.key);purchase=requireNotNull(r.response)
   if(KeepEquipmentMarketProtocol.terminalPurchase(purchase))return@action
  }
  require(purchase["preparation"]==JsonNull||purchase["wire"]!=JsonNull);store.attempt(r.key,"release",true);guard()
  ports.transport.request("POST",store.path("fill")+"/${r.key}/release",buildJsonObject{},guard){store.retain(r.key,it)};require(store.record(r.key).response?.get("release") is JsonObject);reviewGuard=null;mutable.value=mutable.value.copy(paymentReview=null,notice="Reservation closed. Goods returned to the seller's original kingdom; no items were delivered to you.")
 }
 /** Owner rule 2026-10-06: no saved request blocks play forever. A POSTed original closes only when THIS action's
  * by-key GET gets the server's own coded 404; a bare 404 (unmounted route or proxy) or any reply keeps it saved. */
 suspend fun discard(key:String)=action(false){guard->val r=store.record(key);require(!r.discardedUnsent&&!r.closedAbsent&&r.attempts.all{it.startsWith("post:")})
  if(r.attempts.isEmpty()){require(!fetch(r,guard));store.discard(key)}
  else{require(absent(r,guard)){"The server still has this market request. Check its saved result."};guard();store.discard(key,r)}
  mutable.value=mutable.value.copy(commandReview=null)}
 private suspend fun absent(r:KeepEquipmentMarketRecord,guard:()->Unit):Boolean=try{ports.transport.request("GET",store.path(r.kind)+"/"+r.key,guard=guard){store.retain(r.key,it)};false}
  catch(error:ApiException){if(error.status==404&&r.response==null&&!error.code.isNullOrBlank())true else throw error}
 suspend fun archive(key:String)=action(false){guard->val r=store.record(key);fetch(r,guard);val saved=store.record(key);require(store.terminal(saved)&&!saved.held);ports.hydrate(guard);guard();store.archive(key,saved)}
}
