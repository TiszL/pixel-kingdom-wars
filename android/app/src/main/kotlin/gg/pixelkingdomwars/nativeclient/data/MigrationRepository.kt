package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.migration.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

interface MigrationPorts {
 val transport:MigrationTransport
 fun capture(newAction:Boolean):()->Unit
 fun trust():CharterSigningTrust?
 fun cryptoPolicy():CharterCryptoPolicy?
 fun key():String
 fun validate(migration:JsonObject)
 suspend fun live(prepared:PreparedCharter,signing:JsonObject,guard:()->Unit):()->Unit
 suspend fun ready(guard:()->Unit)
 suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend(SignedCharter)->Unit)
 suspend fun hydrate(guard:()->Unit)
}
data class MigrationState(val loaded:Boolean=false,val busy:Boolean=false,val journal:MigrationJournal?=null,val selected:String?=null,val activity:JsonObject?=null,val reviewed:Boolean=false,val error:String?=null){val record get()=journal?.records?.singleOrNull{it.key==selected}}
/** Restart loads only local originals. Every server, wallet and relay effect is explicit. */
class MigrationRepository(private val store:MigrationStore,private val ports:MigrationPorts){
 private val mutable=MutableStateFlow(MigrationState());val state=mutable.asStateFlow();private var epoch=0L;private var reviewGuard:(()->Unit)?=null
 private val hydrated=mutableSetOf<String>();private var hydrationPending=false;private val root=MigrationProtocol.ROOT
 init{require(store.identity==ports.transport.identity)}
 fun dismiss(){epoch++;reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false)}
 suspend fun awaitIdle(){store.requests.withLock{}}
 private suspend fun reload(guard:()->Unit,readOnly:Boolean){val j=store.read();guard();mutable.value=mutable.value.copy(journal=j,loaded=true)
  val changed=j.records.map{it.key+it.response.toString()};if(hydrationPending||changed.any{it !in hydrated}){hydrationPending=true;reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false)
   try{ports.hydrate(guard);guard();hydrated.addAll(changed);hydrationPending=false}catch(e:Exception){if(e is CancellationException)throw e;guard();if(!readOnly)throw e;mutable.value=mutable.value.copy(error="Current clan state could not refresh. Saved migration receipts remain available.")}}
 }
 private suspend fun action(fresh:Boolean,readOnly:Boolean=false,block:suspend(()->Unit)->Unit){val captured=ports.capture(fresh);val generation=epoch;val guard={captured();check(epoch==generation){"The migration view changed. Its original outcome is saved."}};guard();check(store.requests.tryLock()){"Another request owns this migration."}
  try{mutable.value=mutable.value.copy(busy=true,error=null);reload(guard,readOnly);block(guard);reload(guard,readOnly)}catch(e:Exception){reviewGuard=null;if(runCatching{guard()}.isSuccess)mutable.value=mutable.value.copy(error=e.message,reviewed=false);throw e}finally{store.requests.unlock();if(runCatching{captured()}.isSuccess)mutable.value=mutable.value.copy(busy=false)}
 }
 private fun selected()=requireNotNull(state.value.record){"Open a saved migration."}
 private suspend fun retain(r:MigrationRecord,raw:JsonElement)=withContext(NonCancellable){val v=MigrationProtocol.copy(raw).jsonObject;require(v["actor"]==JsonPrimitive(store.identity.wallet)&&v["request"]==r.request);CharterGrammar.id(v.getValue("id"));r.response?.let{require(it["id"]==v["id"])};store.observe(r.key,v);store.accept(r.key,v)}
 private suspend fun fetch(r:MigrationRecord,guard:()->Unit){val id=r.remoteId
  if(id!=null)ports.transport.request("GET","$root/$id",null,guard){retain(r,it)}
  else ports.transport.request("GET","$root/by-key/${r.key}",null,guard){raw->val envelope=raw.jsonObject;require(envelope["actor"]==JsonPrimitive(store.identity.wallet)&&envelope["idempotencyKey"]==JsonPrimitive(r.key));envelope.charterOptional("migration")?.let{retain(r,it)};MigrationProtocol.byKey(envelope,store.identity.wallet,r.key)}
 }
 private suspend fun activity(guard:()->Unit){val value=ports.transport.request("GET","$root/activity",null,guard){raw->MigrationProtocol.activity(raw.jsonObject)};guard();mutable.value=mutable.value.copy(activity=MigrationProtocol.activity(value.jsonObject))}
 suspend fun open()=action(false,true){guard->if(state.value.selected==null){guard();mutable.value=mutable.value.copy(selected=state.value.journal?.records?.lastOrNull()?.key)}}
 suspend fun refresh()=action(false,true){guard->activity(guard)}
 suspend fun select(key:String)=action(false,true){guard->store.record(key);guard();reviewGuard=null;mutable.value=mutable.value.copy(selected=key,reviewed=false)}
 suspend fun selectRemote(id:String)=action(false,true){guard->CharterGrammar.id(JsonPrimitive(id));var key:String?=null;ports.transport.request("GET","$root/$id",null,guard){raw->withContext(NonCancellable){val r=store.discover(raw.jsonObject);key=r.key;retain(r,raw)}};guard();reviewGuard=null;mutable.value=mutable.value.copy(selected=key,reviewed=false)}
 suspend fun check()=action(false,true){guard->fetch(selected(),guard)}
 suspend fun begin(clan:String)=action(true){guard->activity(guard);val a=requireNotNull(state.value.activity);require(CharterGrammar.bool(a.getValue("newActions"))&&a.charterObject("currentClan").charterText("id")==clan);val r=store.begin(ports.key(),clan);mutable.value=mutable.value.copy(selected=r.key,reviewed=false);store.attempt(r.key,"create");guard();ports.transport.request("POST",root,r.request,guard){retain(r,it)}}
 suspend fun retryOriginal()=action(true){guard->val r=selected();require(r.response==null);fetch(r,guard);val current=store.record(r.key);if(current.response==null){store.attempt(r.key,"create",true);guard();ports.transport.request("POST",root,r.request,guard){retain(r,it)}}}
 suspend fun command(name:String)=action(name=="prepare",name!="prepare"){guard->
  require(name in listOf("prepare","recover-preparation","recover","cancel"));var r=selected();require((!r.held||name=="recover")&&!r.terminal)
  if(name=="prepare"){
   fetch(r,guard);reload(guard,false);r=store.record(r.key);require(!r.held&&!r.terminal);ports.validate(requireNotNull(r.response))
   if(requireNotNull(r.response).charterText("status")!="pending")return@action
  }
  val id=requireNotNull(r.remoteId);store.attempt(r.key,name,true);guard();ports.transport.request("POST","$root/$id/$name",buildJsonObject{},guard){retain(r,it)};reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false)
 }
 suspend fun review()=action(true){guard->val r=selected();fetch(r,guard);val current=store.record(r.key);require(!current.held&&current.signed==null&&"wallet" !in current.attempts&&!current.terminal);val migration=requireNotNull(current.response);ports.validate(migration);require(migration.charterText("status")=="prepared"&&migration.charterOptional("wire")==null)
  val pins=requireNotNull(ports.trust());val crypto=requireNotNull(ports.cryptoPolicy());val p=MigrationTransaction.prepare(migration,pins,store.identity.wallet,crypto);val live=ports.live(p,migration.charterObject("signing"),guard);live();store.review(r.key,MigrationReview(migration,pins.toJson(),charterCryptoJson(crypto)));live();reviewGuard={guard();live();check(ports.trust()==pins&&ports.cryptoPolicy()==crypto)};mutable.value=mutable.value.copy(reviewed=true)
 }
 suspend fun approve()=action(true){guard->val reviewed=requireNotNull(reviewGuard){"Review the exact migration before approval."};reviewed();val r=selected();fetch(r,guard);val current=store.record(r.key);require(!current.held&&current.signed==null&&"wallet" !in current.attempts&&!current.terminal);val c=requireNotNull(current.review);require(c.migration==current.response&&current.response?.charterOptional("wire")==null)
  val pins=requireNotNull(ports.trust());val crypto=requireNotNull(ports.cryptoPolicy());require(c.pins==pins.toJson()&&c.crypto==charterCryptoJson(crypto));ports.validate(requireNotNull(current.response));val p=MigrationTransaction.prepare(c.migration,pins,store.identity.wallet,crypto);val live=ports.live(p,c.migration.charterObject("signing"),guard);val fresh={guard();reviewed();live()};ports.ready(fresh);fresh();store.attempt(r.key,"wallet");fresh();ports.sign(p,fresh){store.signed(r.key,MigrationTransaction.toWire(p,it))};fresh();reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false)
 }
 suspend fun upload()=action(false){guard->val r=selected();require(!r.held&&!r.terminal);val c=requireNotNull(r.review);val wire=requireNotNull(r.signed);MigrationTransaction.verifyWire(c.migration,CharterSigningTrust.from(c.pins),wire,charterCryptoPolicy(c.crypto));store.attempt(r.key,"upload",true);guard();ports.transport.request("POST","$root/${r.response!!.charterText("id")}/signed",buildJsonObject{put("signedTransaction",wire.getValue("signedTransaction"))},guard){retain(r,it)}}
 suspend fun deliver()=action(true){guard->val r=selected();fetch(r,guard);val current=store.record(r.key);require(!current.held&&!current.terminal);val migration=requireNotNull(current.response);ports.validate(migration);val pins=requireNotNull(ports.trust());val crypto=requireNotNull(ports.cryptoPolicy());current.review?.let{require(it.pins==pins.toJson()&&it.crypto==charterCryptoJson(crypto))};MigrationTransaction.verifyWire(migration,pins,migration.charterObject("wire"),crypto);val p=MigrationTransaction.prepare(migration,pins,store.identity.wallet,crypto);val live=ports.live(p,migration.charterObject("signing"),guard);live();store.attempt(r.key,"deliver",true);live();ports.transport.request("POST","$root/${migration.charterText("id")}/deliver",buildJsonObject{},live){retain(r,it)}}
}
