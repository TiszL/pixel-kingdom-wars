package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.divine.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.*

interface DivineTrialPorts {
 val transport:DivineTransport
 fun rules():DivineRules?
 fun capture(fresh:Boolean):()->Unit
 fun owned(base:String)
 fun key():String
 suspend fun hydrate(guard:()->Unit)
}
data class DivineTrialState(val journal:DivineJournal?=null,val discovery:JsonObject?=null,val selectedId:String?=null,val busy:Boolean=false,val error:String?=null) {
 val selected get()=journal?.events?.singleOrNull{it.id==selectedId}
}
/** Every retry first reads its own original. No timer or view exit creates an effect. */
class DivineTrialRepository(val store:DivineTrialStore,private val ports:DivineTrialPorts) {
 private val mutable=MutableStateFlow(DivineTrialState());val state=mutable.asStateFlow();private var epoch=0L
 init{require(store.identity==ports.transport.identity)}
 fun dismiss(){epoch++}
 private suspend fun action(fresh:Boolean,block:suspend(()->Unit)->Unit){check(store.requests.tryLock()){"A saved trial request is still settling."};val generation=epoch
  try{val guard=ports.capture(fresh);val current={guard();check(generation==epoch){"The trial view changed; original responses remain saved."}};current();mutable.value=state.value.copy(busy=true,error=null,journal=store.read());block(current);current();mutable.value=state.value.copy(journal=store.read())}
  catch(e:Exception){if(generation==epoch)mutable.value=state.value.copy(error=e.message,journal=runCatching{store.read()}.getOrNull()?:state.value.journal);throw e}
  finally{if(generation==epoch)mutable.value=state.value.copy(busy=false);store.requests.unlock()}
 }
 suspend fun local(){mutable.value=state.value.copy(journal=store.read(),busy=false)}
 suspend fun discover(cursor:String?=null)=action(false){guard->val r=ports.rules()?:return@action;val raw=ports.transport.request("GET","/divine-trials/events",null,guard,if(cursor==null)emptyMap()else mapOf("cursor" to cursor));r.discovery(raw);guard();mutable.value=state.value.copy(discovery=raw)}
 suspend fun select(event:JsonObject)=action(false){guard->val saved=store.read().events.singleOrNull{it.id==event.dt("id")};val rules=saved?.let{DivineRules.from(it.rules)}?:requireNotNull(ports.rules());store.adopt(event,rules);guard();mutable.value=state.value.copy(selectedId=event.dt("id"));refresh(event.dt("id"),guard)}
 suspend fun reopen(id:String)=action(false){guard->store.event(id);guard();mutable.value=state.value.copy(selectedId=id);refresh(id,guard)}
 suspend fun check()=action(false){guard->refresh(selected().id,guard)}
 private suspend fun selected()=store.event(requireNotNull(state.value.selectedId){"Choose a trial event first."})
 private suspend fun refresh(id:String,guard:()->Unit){ports.transport.request("GET","/divine-trials/events/$id/participant",null,guard){store.observe(id,null,it)};guard()}
 private suspend fun send(e:DivineSavedEvent,c:DivineCommand,guard:()->Unit){guard();store.mark(e.id,c.id);guard();ports.transport.request("POST",store.path(e.id,c),c.request,guard){store.observe(e.id,c.id,it)};guard();refresh(e.id,guard);if(c.kind=="prize")ports.hydrate(guard)}
 private suspend fun currentEvent(guard:()->Unit):DivineSavedEvent {val e=selected();refresh(e.id,guard);return store.event(e.id)}
 suspend fun enter(base:String)=action(true){guard->ports.owned(base);val e=currentEvent(guard);require(ports.rules()==DivineRules.from(e.rules));require(e.participant?.get("entry")==JsonNull);val key=ports.key();val c=DivineCommand(key,"entries",buildJsonObject{put("idempotencyKey",key);put("baseId",base)});store.begin(e.id,c);send(e,c,guard)}
 suspend fun admit(base:String)=action(true){guard->ports.owned(base);val e=currentEvent(guard);require(ports.rules()==DivineRules.from(e.rules));val p=requireNotNull(e.participant);require(p["entry"]!=JsonNull);val attempts=p.drows("attempts");val rules=DivineRules.from(e.rules);require(attempts.size<rules.bound("attemptsPerWallet")&&attempts.none{it.dt("status") in listOf("admitted","committed")});val key=ports.key();val c=DivineCommand(key,"attempts",buildJsonObject{put("idempotencyKey",key);put("baseId",base)});store.begin(e.id,c);send(e,c,guard)}
 suspend fun submit(attemptId:String,orders:JsonObject)=action(true){guard->val e=currentEvent(guard);val a=requireNotNull(e.participant).drows("attempts").single{it.dt("id")==attemptId};require(a.dt("status")=="admitted");val r=DivineRules.from(e.rules);require(ports.rules()==r){"Trial content changed; restore the original supported profile."};r.orders(orders,a.dobj("encounter"));val c=DivineCommand(ports.key(),"submit",buildJsonObject{put("orders",orders)},attemptId);store.begin(e.id,c);send(e,c,guard)}
 suspend fun abandon(attemptId:String)=action(false){guard->val e=currentEvent(guard);val a=requireNotNull(e.participant).drows("attempts").single{it.dt("id")==attemptId};require(a.dt("status")=="admitted");val c=DivineCommand(ports.key(),"abandon",buildJsonObject{},attemptId);store.begin(e.id,c);send(e,c,guard)}
 suspend fun claim(base:String)=action(false){guard->ports.owned(base);val e=currentEvent(guard);val prize=requireNotNull(e.participant?.doptional("prize"));require(prize["claim"]==JsonNull);val c=DivineCommand(ports.key(),"prize",buildJsonObject{put("baseId",base)});store.begin(e.id,c);send(e,c,guard)}
 suspend fun retry(commandId:String)=action(false){historyGuard->var e=currentEvent(historyGuard);var c=e.commands.single{it.id==commandId};if(!c.retryable)return@action
  // A committed exact batch may finish after pause; all never-accepted fresh actions recheck admission.
  val fresh=c.kind in listOf("entries","attempts")||c.kind=="submit"&&c.response==null
  val guard=if(fresh)ports.capture(true)else historyGuard
  guard();if(fresh)require(ports.rules()==DivineRules.from(e.rules));if(c.kind in listOf("entries","attempts"))ports.owned(c.request.dt("baseId"))
  if(c.kind=="entries")require(e.participant?.get("entry")==JsonNull)
  if(c.kind=="attempts"){val p=requireNotNull(e.participant);require(p.drows("attempts").none{it.dt("status") in listOf("admitted","committed")})}
  if(c.kind in listOf("submit","abandon")){val a=requireNotNull(e.participant).drows("attempts").single{it.dt("id")==c.attemptId};require(a.dt("status") in if(c.kind=="submit")listOf("admitted","committed")else listOf("admitted"));if(c.kind=="submit"&&a["orders"]!=JsonNull)require(a["orders"]==c.request["orders"])}
  if(c.kind=="prize"){require(e.participant?.doptional("prize")?.get("claim")==JsonNull);ports.owned(c.request.dt("baseId"))}
  send(e,c,{historyGuard();guard()})
 }
 /** Owner rule 2026-10-06 (no saved request blocks play forever): CLOSE reads this event's complete participant record now;
  * the saved entry/attempt request closes on this device only if that record has no entry/attempt with its key. A record
  * that has it resolves the request instead. No POST. */
 suspend fun closeAbsent(commandId:String)=action(false){guard->val id=selected().id;var seen:JsonObject?=null
  ports.transport.request("GET","/divine-trials/events/$id/participant",null,guard){store.observe(id,null,it);seen=it};guard()
  if(!store.event(id).commands.single{it.id==commandId}.unresolved)return@action
  store.closeAbsent(id,commandId,requireNotNull(seen))
 }
}
