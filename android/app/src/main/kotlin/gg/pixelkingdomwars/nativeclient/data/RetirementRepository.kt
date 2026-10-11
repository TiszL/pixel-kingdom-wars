package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.retirement.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

interface RetirementPorts {
 val transport:RetirementTransport
 fun capture(newAction:Boolean):()->Unit
 fun trust():CharterSigningTrust?
 fun cryptoPolicy():CharterCryptoPolicy?
 fun key():String
 fun validate(draft:JsonObject)
 suspend fun live(prepared:PreparedCharter,operation:JsonObject,guard:()->Unit):()->Unit
 suspend fun ready(guard:()->Unit)
 suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend(SignedCharter)->Unit)
 suspend fun hydrate(guard:()->Unit)
}
data class RetirementState(val loaded:Boolean=false,val busy:Boolean=false,val journal:RetirementJournal?=null,val selected:String?=null,val reviewed:Boolean=false,val error:String?=null){val record get()=journal?.records?.singleOrNull{it.key==selected}}
/** Each effect is explicit. Opening/restarting only loads local history; unknown
 * outcomes retain the same request and never cause another wallet approval. */
class RetirementRepository(private val store:RetirementStore,private val ports:RetirementPorts){
 private val mutable=MutableStateFlow(RetirementState());val state=mutable.asStateFlow();private var epoch=0L;private var reviewGuard:(()->Unit)?=null
 private val hydrated=mutableSetOf<String>();private var hydrationPending=false;private val root="/clans/charter/retirements"
 init{require(store.identity==ports.transport.identity)}
 fun dismiss(){epoch++;reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false)}
 suspend fun awaitIdle(){store.requests.withLock{}}
 private suspend fun reload(guard:()->Unit,readOnly:Boolean){val j=store.read();guard();mutable.value=mutable.value.copy(journal=j,loaded=true);val changed=j.records.filter{it.terminal||it.response?.charterOptional("memberPayment")!=null}.map{it.key+it.response.toString()}
  if(hydrationPending||changed.any{it !in hydrated}){hydrationPending=true;reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false)
   try{ports.hydrate(guard);guard();hydrated.addAll(changed);hydrationPending=false}catch(e:Exception){if(e is CancellationException)throw e;guard();if(!readOnly)throw e;mutable.value=mutable.value.copy(error="Current kingdom state could not refresh. Saved dissolution receipts remain available.")}}
 }
 private suspend fun action(fresh:Boolean,readOnly:Boolean=false,block:suspend(()->Unit)->Unit){val captured=ports.capture(fresh);val generation=epoch;val guard={captured();check(epoch==generation){"The dissolution view changed. Its original outcome is saved."}};guard();check(store.requests.tryLock()){"Another request owns this dissolution."}
  try{mutable.value=mutable.value.copy(busy=true,error=null);reload(guard,readOnly);block(guard);reload(guard,readOnly)}catch(e:Exception){reviewGuard=null;if(runCatching{guard()}.isSuccess)mutable.value=mutable.value.copy(error=e.message,reviewed=false);throw e}finally{store.requests.unlock();if(runCatching{captured()}.isSuccess)mutable.value=mutable.value.copy(busy=false)}
 }
 private fun selected()=requireNotNull(state.value.record){"Open a saved dissolution."}
 private suspend fun retain(r:RetirementRecord,raw:JsonElement)=withContext(NonCancellable){val v=RetirementProtocol.copy(raw).jsonObject;require(v["actor"]==JsonPrimitive(store.identity.wallet)&&v["request"]==r.request);CharterGrammar.id(v.getValue("id"));r.response?.let{require(it["id"]==v["id"])};store.observe(r.key,v);store.accept(r.key,v)}
 private suspend fun fetch(r:RetirementRecord,guard:()->Unit){val draft=r.response
  if(draft!=null)ports.transport.request("GET","$root/${draft.charterText("id")}",null,guard){retain(r,it)}
  else ports.transport.request("GET","$root/by-key/${r.key}",null,guard){raw->val envelope=raw.jsonObject;require(envelope["actor"]==JsonPrimitive(store.identity.wallet)&&envelope["idempotencyKey"]==JsonPrimitive(r.key));envelope.charterOptional("draft")?.let{retain(r,it)};RetirementProtocol.byKey(envelope,store.identity.wallet,r.key)}
 }
 suspend fun open()=action(false,true){guard->if(state.value.selected==null){guard();mutable.value=mutable.value.copy(selected=state.value.journal?.records?.lastOrNull()?.key)}}
 suspend fun select(key:String)=action(false,true){guard->store.record(key);guard();reviewGuard=null;mutable.value=mutable.value.copy(selected=key,reviewed=false)}
 suspend fun check()=action(false,true){guard->fetch(selected(),guard)}
 suspend fun begin(clan:String)=action(true){guard->val r=store.begin(ports.key(),clan);mutable.value=mutable.value.copy(selected=r.key,reviewed=false);store.attempt(r.key,"create");guard();ports.transport.request("POST",root,r.request,guard){retain(r,it)}}
 suspend fun retryOriginal()=action(true){guard->val r=selected();require(r.response==null);fetch(r,guard);val current=store.record(r.key);if(current.response==null){store.attempt(r.key,"create",true);guard();ports.transport.request("POST",root,r.request,guard){retain(r,it)}}}
 suspend fun command(name:String)=action(name in listOf("pay-members","prepare"),name in listOf("recover","recover-preparation","cancel")){guard->
  require(name in listOf("pay-members","prepare","recover-preparation","recover","cancel"));var r=selected();require(!r.held&&!r.terminal)
  if(name in listOf("pay-members","prepare")){
   // An explicit retry first observes the same draft. A lost reply never
   // creates a replacement payment or signing candidate.
   fetch(r,guard);reload(guard,false);r=store.record(r.key);require(!r.held&&!r.terminal);ports.validate(requireNotNull(r.response))
   if(name=="pay-members"){if(r.operation!=null)return@action}
   else {if(r.operation?.charterText("status")!="cleared")return@action;require(r.operation?.charterOptional("attempt")==null)}
  }
  val draft=requireNotNull(r.response);store.attempt(r.key,name,true);guard();ports.transport.request("POST","$root/${draft.charterText("id")}/$name",buildJsonObject{},guard){retain(r,it)};reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false)
 }
 suspend fun review()=action(true){guard->val r=selected();fetch(r,guard);val current=store.record(r.key);require(!current.held&&current.signed==null&&"wallet" !in current.attempts&&!current.terminal);val draft=requireNotNull(current.response);ports.validate(draft);val operation=requireNotNull(current.operation);require(operation.charterOptional("signed")==null)
  val pins=requireNotNull(ports.trust());val crypto=requireNotNull(ports.cryptoPolicy());val p=RetirementTransaction.prepare(operation,pins,store.identity.wallet,crypto);val live=ports.live(p,operation,guard);live();store.review(r.key,RetirementReview(operation,pins.toJson(),charterCryptoJson(crypto)));live();reviewGuard={guard();live();check(ports.trust()==pins&&ports.cryptoPolicy()==crypto)};mutable.value=mutable.value.copy(reviewed=true)
 }
 suspend fun approve()=action(true){guard->val reviewed=requireNotNull(reviewGuard){"Review the final dissolution before approval."};reviewed();val r=selected();fetch(r,guard);val current=store.record(r.key);require(!current.held&&current.signed==null&&"wallet" !in current.attempts&&!current.terminal);val c=requireNotNull(current.review);require(c.operation==current.operation&&current.operation?.charterOptional("signed")==null)
  val pins=requireNotNull(ports.trust());val crypto=requireNotNull(ports.cryptoPolicy());require(c.pins==pins.toJson()&&c.crypto==charterCryptoJson(crypto));ports.validate(requireNotNull(current.response));val p=RetirementTransaction.prepare(c.operation,pins,store.identity.wallet,crypto);val live=ports.live(p,c.operation,guard);val fresh={guard();reviewed();live()};ports.ready(fresh);fresh();store.attempt(r.key,"wallet");fresh();ports.sign(p,fresh){store.signed(r.key,RetirementTransaction.toWire(p,it))};fresh();reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false)
 }
 suspend fun upload()=action(false){guard->val r=selected();require(!r.held&&!r.terminal);val c=requireNotNull(r.review);val wire=requireNotNull(r.signed);RetirementTransaction.verifyWire(c.operation,CharterSigningTrust.from(c.pins),wire,charterCryptoPolicy(c.crypto));val bytes=wire.charterText("signedTransactionHex").chunked(2).map{it.toInt(16).toByte()}.toByteArray();store.attempt(r.key,"upload",true);guard();ports.transport.request("POST","$root/${r.response!!.charterText("id")}/signed",buildJsonObject{put("signedTransaction",java.util.Base64.getEncoder().encodeToString(bytes))},guard){retain(r,it)}}
 suspend fun deliver()=action(true){guard->val r=selected();fetch(r,guard);val current=store.record(r.key);require(!current.held&&!current.terminal);ports.validate(requireNotNull(current.response));val operation=requireNotNull(current.operation);val pins=requireNotNull(ports.trust());val crypto=requireNotNull(ports.cryptoPolicy());current.review?.let{require(it.pins==pins.toJson()&&it.crypto==charterCryptoJson(crypto))};RetirementTransaction.verifyWire(operation,pins,operation.charterObject("signed"),crypto);val p=RetirementTransaction.prepare(operation,pins,store.identity.wallet,crypto);val live=ports.live(p,operation,guard);live();store.attempt(r.key,"deliver",true);live();ports.transport.request("POST","$root/${current.response.charterText("id")}/deliver",buildJsonObject{},live){retain(r,it)}}
}
