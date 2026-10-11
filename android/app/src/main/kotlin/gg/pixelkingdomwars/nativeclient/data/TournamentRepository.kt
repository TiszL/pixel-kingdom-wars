package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.tournament.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

interface TournamentPorts {
 val transport:TournamentTransport
 fun capture(newAction:Boolean):()->Unit
 fun trust():CharterSigningTrust?
 fun cryptoPolicy():CharterCryptoPolicy?
 fun policy():JsonObject?
 fun key():String
 fun requireBase(baseId:String)
 suspend fun live(prepared:PreparedCharter,operation:JsonObject,guard:()->Unit):()->Unit
 suspend fun ready(guard:()->Unit)
 suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend (SignedCharter)->Unit)
 suspend fun hydrate(guard:()->Unit)
 suspend fun battle(raidId:String,baseId:String,guard:()->Unit)
}
data class TournamentState(val loaded:Boolean=false,val busy:Boolean=false,val journal:TournamentJournal?=null,val events:JsonObject?=null,
 val event:JsonObject?=null,val participation:JsonObject?=null,val selectedOperation:String?=null,val reviewed:Boolean=false,val error:String?=null) {
 val operation get()=journal?.records?.singleOrNull{it.key==selectedOperation}
 val eventId get()=event?.charterText("id")
}

/** Explicit user effects only. A timeout keeps the original intent; every retry uses
 * its original key. History never prompts a wallet or submits a replacement. */
class TournamentRepository(private val store:TournamentStore,private val ports:TournamentPorts) {
 private val mutable=MutableStateFlow(TournamentState());val state=mutable.asStateFlow()
 private var epoch=0L;private var reviewGuard:(()->Unit)?=null;private val hydrated=mutableSetOf<String>();private var hydrationPending=false
 private val root="/clans/charter/tournaments"
 init {require(store.identity==ports.transport.identity)}
 fun dismiss(){epoch++;reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false)}
 suspend fun awaitIdle(){store.requests.withLock{}}
 private suspend fun hydrate(guard:()->Unit){
  hydrationPending=true
  try{ports.hydrate(guard);guard();hydrationPending=false}catch(error:Exception){
   if(error is CancellationException)throw error
   guard();hydrated.clear();reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false);throw error
  }
 }
 private suspend fun reload(guard:()->Unit,readOnlyRecovery:Boolean=false,observeOnly:Boolean=false){
  val j=store.read();guard();val terminals=j.records.filter{it.kind=="operation"&&it.response?.charterOptional("terminal")!=null}.map{it.key+it.response!!.getValue("terminal").toString()}
  if(hydrationPending||terminals.any{it !in hydrated}){
   // Original operation evidence is independent of current account hydration.
   reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false)
   if(observeOnly){mutable.value=mutable.value.copy(journal=j,loaded=true);return}
   try{hydrate(guard);hydrated.addAll(terminals)}catch(error:Exception){
    if(error is CancellationException)throw error
    guard();if(!readOnlyRecovery)throw error
    mutable.value=mutable.value.copy(journal=j,loaded=true,error="Current kingdom state could not refresh. Saved tournament receipts and original checks remain available.");return
   }
  }
  mutable.value=mutable.value.copy(journal=j,loaded=true)
 }
 private suspend fun action(fresh:Boolean,readOnlyRecovery:Boolean=false,block:suspend (()->Unit)->Unit){val captured=ports.capture(fresh);val current=epoch;val guard={captured();check(epoch==current){"The tournament view changed. Its original outcome is saved."}};guard();check(store.requests.tryLock()){"Another request owns the tournament journal."}
  try{mutable.value=mutable.value.copy(busy=true,error=null);reload(guard,readOnlyRecovery,observeOnly=readOnlyRecovery);block(guard);reload(guard,readOnlyRecovery)}catch(e:Exception){reviewGuard=null;if(runCatching{guard()}.isSuccess)mutable.value=mutable.value.copy(error=e.message,reviewed=false);throw e}finally{store.requests.unlock();if(runCatching{captured()}.isSuccess)mutable.value=mutable.value.copy(busy=false)}
 }
 private fun selected()=requireNotNull(state.value.operation){"Open an original captain operation."}
 private fun eventId()=requireNotNull(state.value.eventId){"Choose a funded tournament."}
 private suspend fun retain(r:TournamentRecord,input:JsonElement,delivery:Boolean=false){if(input==JsonNull){require(r.kind=="raid");return};withContext(NonCancellable){val raw=input.jsonObject;store.observe(r.key,raw);val v=if(delivery)TournamentProtocol.delivery(raw).charterObject("operation") else raw;store.accept(r.key,v)
   if(r.kind=="entry"){for(o in listOfNotNull(v.charterObject("set"),v.charterOptional("clear"))){
    val isClear=o.charterObject("original").charterObject("operation").charterText("action")=="clear"
    val unknownClear=isClear&&store.read().records.any{it.kind=="clear"&&it.response==null&&it.path=="$root/entries/${v.charterText("id")}/clear"}
    if(!unknownClear){val op=store.operation(o);store.observe(op.key,o);store.accept(op.key,o)}
   }}
   if(r.kind=="clear"){val op=store.operation(v);store.observe(op.key,v);store.accept(op.key,v)}
  }}
 private suspend fun fetch(r:TournamentRecord,guard:()->Unit){val path=when(r.kind){"entry"->r.response?.let{"$root/entries/${it.charterText("id")}"}?:"$root/entries/by-key/${r.key}";"raid"->"$root/events/${r.eventId}/raids/by-key/${r.key}";"operation"->r.path;else->null}
  if(path!=null)ports.transport.request("GET",path,null,guard){retain(r,it)} else if(r.kind=="clear") {ports.transport.request("GET",r.path.removeSuffix("/clear"),null,guard){raw->val entry=TournamentProtocol.entry(raw.jsonObject);require(entry.charterText("leader")==store.identity.wallet&&entry.charterText("eventId")==r.eventId);entry.charterOptional("clear")?.let{o->if(r.response!=null&&r.response.charterObject("original").charterObject("operation")["id"]==o.charterObject("original").charterObject("operation")["id"]){val op=store.operation(o);store.observe(op.key,o);store.accept(op.key,o)}}}} else refresh(guard)
 }
 private fun chooseOperation(){val id=state.value.eventId;val r=state.value.journal?.records?.lastOrNull{it.kind=="operation"&&it.eventId==id};mutable.value=mutable.value.copy(selectedOperation=r?.key)}
 private suspend fun refresh(guard:()->Unit){val event=eventId();ports.transport.request("GET","$root/events/$event",null,guard){raw->val v=TournamentProtocol.event(raw.jsonObject);require(v.charterText("id")==event);guard();mutable.value=mutable.value.copy(event=v)}
  ports.transport.request("GET","$root/events/$event/participation",null,guard){raw->val v=TournamentProtocol.participation(raw.jsonObject);require(v.charterText("eventId")==event);v.charterOptional("entry")?.let{require(JsonPrimitive(store.identity.wallet) in it.getValue("roster").jsonArray)};v.charterOptional("prize")?.charterOptional("claim")?.let{claim->require(claim.charterText("wallet")==store.identity.wallet);store.read().records.singleOrNull{it.kind=="prize"&&it.eventId==event}?.let{r->retain(r,claim)}}
   for(raid in v.getValue("raids").jsonArray){store.read().records.singleOrNull{it.kind=="raid"&&it.eventId==event&&it.response?.get("requestId")==raid.jsonObject["requestId"]}?.let{r->retain(r,raid)}};guard();mutable.value=mutable.value.copy(participation=v)}
 }
 suspend fun open(cursor:String?=null)=action(false,readOnlyRecovery=true){guard->ports.transport.request("GET","$root/events",null,guard,cursor?.let{mapOf("cursor" to it)}?:emptyMap()){val v=TournamentProtocol.events(it.jsonObject);guard();mutable.value=mutable.value.copy(events=v)};if(state.value.event!=null)refresh(guard)}
 suspend fun selectEvent(id:String)=action(false,readOnlyRecovery=true){guard->CharterGrammar.id(JsonPrimitive(id));ports.transport.request("GET","$root/events/$id",null,guard){val v=TournamentProtocol.event(it.jsonObject);require(v.charterText("id")==id);guard();mutable.value=mutable.value.copy(event=v,reviewed=false);reviewGuard=null};refresh(guard);reload(guard,readOnlyRecovery=true,observeOnly=true);chooseOperation()}
 suspend fun selectOperation(id:String)=action(false,readOnlyRecovery=true){guard->val r=store.record(id);require(r.kind=="operation");fetch(r,guard);guard();mutable.value=mutable.value.copy(selectedOperation=id,reviewed=false);reviewGuard=null}
 suspend fun check()=action(false,readOnlyRecovery=true){guard->refresh(guard);for(r in store.read().records.filter{it.eventId==eventId()&&it.kind in listOf("entry","operation","raid")})fetch(r,guard);reload(guard,readOnlyRecovery=true,observeOnly=true);chooseOperation()}
 private suspend fun submit(r:TournamentRecord,guard:()->Unit){store.attempt(r.key,"post",repeatable=true);guard();ports.transport.request("POST",r.path,r.body,guard){retain(r,it)};reload(guard);chooseOperation()}
 suspend fun enter(clan:String)=action(true){guard->val id=eventId();val key=ports.key();val body=buildJsonObject{put("eventId",id);put("clanId",clan);put("idempotencyKey",key)};val r=store.begin("entry",key,id,"$root/entries",body);submit(r,guard)}
 suspend fun retry(key:String)=action(true){guard->val r=store.record(key);require(r.kind in listOf("entry","clear","raid","prize"));check(!r.closed){"This request was closed on this device. Start a new one."};if(r.kind in listOf("raid","prize"))ports.requireBase(r.body.charterText("baseId"));if(r.response!=null&&!(r.kind=="raid"&&r.response.charterText("status")=="requested"))fetch(r,guard) else submit(r,guard)}
 /** Dead-end audit 2026-10-06 (shape A). An unknown entry blocks its event's entries and reserves journal capacity;
  * an unknown match request blocks that event's raids. This explicit GET-only action closes it on this device only
  * when this same by-key read answered null for exactly its key. Any shown request is retained and stays open. */
 suspend fun closeAbsent(key:String)=action(false,readOnlyRecovery=true){guard->
  val r=store.record(key);check(r.kind in listOf("entry","raid")&&r.response==null&&!r.closed){"Only an unconfirmed entry or match request can be closed."}
  val path=if(r.kind=="entry")"$root/entries/by-key/$key" else "$root/events/${r.eventId}/raids/by-key/$key"
  var absent=false
  ports.transport.request("GET",path,null,guard){if(it==JsonNull){absent=true} else retain(r,it)}
  check(absent){"The server shows this tournament request. It stays open."}
  store.closeAbsent(key);guard()
 }
 suspend fun recoverIntent(key:String)=action(false,readOnlyRecovery=true){guard->fetch(store.record(key),guard);reload(guard,readOnlyRecovery=true,observeOnly=true);chooseOperation()}
 suspend fun clear()=action(true){guard->val original=store.read().records.lastOrNull{it.kind=="entry"&&it.eventId==eventId()}?:error("Open the original captain entry.");fetch(original,guard);val entry=requireNotNull(store.record(original.key).response);require(entry.charterText("status") in listOf("entered","nonparticipating"));entry.charterOptional("clear")?.let{require(it.charterText("status")=="cancelled"){"Recover the original clear operation first."}};val key=ports.key();val r=store.begin("clear",key,eventId(),"$root/entries/${entry.charterText("id")}/clear",buildJsonObject{put("idempotencyKey",key)});submit(r,guard)}
 suspend fun command(name:String)=action(name=="prepare"){guard->require(name in listOf("prepare","recover-preparation","recover","cancel"));val r=selected();store.attempt(r.key,name,repeatable=true);guard();ports.transport.request("POST","${r.path}/$name",buildJsonObject{},guard){retain(r,it)};reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false)}
 suspend fun review()=action(true){guard->val r=selected();fetch(r,guard);val current=store.record(r.key);require(!current.held&&current.signed==null&&"wallet" !in current.attempts);val operation=requireNotNull(current.response);require(operation.charterOptional("terminal")==null&&operation.charterOptional("signed")==null)
  val pins=requireNotNull(ports.trust());val crypto=requireNotNull(ports.cryptoPolicy());val policy=requireNotNull(ports.policy());validateTournamentPolicy(operation,policy)
  val prepared=TournamentTransaction.prepare(operation,pins,store.identity.wallet,crypto);guard();val live=ports.live(prepared,operation,guard);live();store.review(r.key,TournamentReview(operation,pins.toJson(),charterCryptoJson(crypto),policy));live()
  reviewGuard={guard();live();check(ports.trust()==pins&&ports.cryptoPolicy()==crypto&&ports.policy()==policy)};mutable.value=mutable.value.copy(reviewed=true)
 }
 suspend fun approve()=action(true){guard->val reviewed=requireNotNull(reviewGuard){"Review the exact lock first."};reviewed();val r=selected();fetch(r,guard);val current=store.record(r.key);require(!current.held&&current.signed==null&&"wallet" !in current.attempts);val c=requireNotNull(current.review);val operation=requireNotNull(current.response);require(operation.charterOptional("terminal")==null&&operation.charterOptional("signed")==null&&c.operation==operation)
  val pins=requireNotNull(ports.trust());val crypto=requireNotNull(ports.cryptoPolicy());require(c.pins==pins.toJson()&&c.crypto==charterCryptoJson(crypto)&&c.policy==ports.policy());val p=TournamentTransaction.prepare(operation,pins,store.identity.wallet,crypto);val live=ports.live(p,operation,guard);val fresh={guard();reviewed();live()};ports.ready(fresh);fresh();store.attempt(r.key,"wallet");fresh();ports.sign(p,fresh){signed->store.signed(r.key,TournamentTransaction.toWire(p,signed))};fresh();reviewGuard=null;mutable.value=mutable.value.copy(reviewed=false)
 }
 suspend fun upload()=action(false){guard->val r=selected();val c=requireNotNull(r.review);val wire=requireNotNull(r.signed);TournamentTransaction.verifyWire(c.operation,CharterSigningTrust.from(c.pins),wire,charterCryptoPolicy(c.crypto));val bytes=wire.charterText("signedTransactionHex").chunked(2).map{it.toInt(16).toByte()}.toByteArray();store.attempt(r.key,"upload",true);guard();ports.transport.request("POST","${r.path}/signed",buildJsonObject{put("signedTransaction",java.util.Base64.getEncoder().encodeToString(bytes))},guard){retain(r,it)}}
 suspend fun deliver()=action(true){guard->val r=selected();fetch(r,guard);val current=store.record(r.key);require(!current.held);val operation=requireNotNull(current.response);require(operation.charterOptional("terminal")==null);val pins=requireNotNull(ports.trust());val crypto=requireNotNull(ports.cryptoPolicy());validateTournamentPolicy(operation,requireNotNull(ports.policy()));current.review?.let{require(it.pins==pins.toJson()&&it.crypto==charterCryptoJson(crypto)&&it.policy==ports.policy())};TournamentTransaction.verifyWire(operation,pins,operation.charterObject("signed"),crypto);val p=TournamentTransaction.prepare(operation,pins,store.identity.wallet,crypto);val live=ports.live(p,operation,guard);live();store.attempt(r.key,"deliver",true);live();ports.transport.request("POST","${r.path}/deliver",buildJsonObject{},live){retain(r,it,true)}}
 suspend fun raid(base:String)=action(true){guard->ports.requireBase(base);val key=ports.key();val r=store.begin("raid",key,eventId(),"$root/events/${eventId()}/raids",buildJsonObject{put("baseId",base);put("idempotencyKey",key)});submit(r,guard);refresh(guard)}
 suspend fun cancelRaid(key:String)=action(false){guard->val r=store.record(key);require(r.kind=="raid"&&r.response?.charterText("status")=="requested");store.attempt(key,"cancel",true);guard();ports.transport.request("POST","$root/events/${r.eventId}/raids/by-key/$key/cancel",buildJsonObject{},guard){retain(r,it)}}
 suspend fun play(key:String)=action(true){guard->val r=store.record(key);require(r.kind=="raid");fetch(r,guard);val v=requireNotNull(store.record(key).response);require(v.charterText("status")=="admitted");guard();ports.battle(v.charterObject("raid").charterText("id"),v.charterText("baseId"),guard)}
 suspend fun claim(base:String)=action(true){guard->ports.requireBase(base);val old=store.read().records.singleOrNull{it.kind=="prize"&&it.eventId==eventId()};val r=old?:store.begin("prize",ports.key(),eventId(),"$root/events/${eventId()}/prize",buildJsonObject{put("baseId",base)});require(r.body.charterText("baseId")==base){"Recover the original prize destination."};submit(r,guard);hydrate(guard);refresh(guard)}
 suspend fun closeEvent()=action(false){guard->ports.transport.request("POST","$root/events/${eventId()}/close",buildJsonObject{},guard){raw->val v=TournamentProtocol.event(raw.jsonObject);require(v.charterText("id")==eventId());guard();mutable.value=mutable.value.copy(event=v)};refresh(guard)}
}
