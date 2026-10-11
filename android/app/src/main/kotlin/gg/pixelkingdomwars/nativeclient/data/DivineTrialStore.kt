package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.divine.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** [closedAbsent]: an entry/attempt request closed on this device because the event's complete participant record, read in the
 * closing action, listed no entry/attempt with its idempotency key. A later record that does list it still resolves it. */
@Serializable data class DivineCommand(val id:String,val kind:String,val request:JsonObject,val attemptId:String?=null,val sent:Boolean=false,val response:JsonObject?=null,val supersededBy:JsonObject?=null,val closedAbsent:Boolean=false) {val unresolved get()=response==null&&supersededBy==null&&!closedAbsent;val retryable get()=supersededBy==null&&!closedAbsent&&(response==null||kind=="submit"&&response.dt("status")=="committed")}
@Serializable data class DivineObservation(val command:String?,val value:JsonObject)
@Serializable data class DivineSavedEvent(val rules:JsonObject,val event:JsonObject,val participant:JsonObject?=null,val commands:List<DivineCommand> = emptyList(),val held:List<DivineObservation> = emptyList()) {val id get()=event.dt("id")}
@Serializable data class DivineJournal(val version:Int=1,val identity:StarterIdentity,val revision:Long=0,val events:List<DivineSavedEvent> = emptyList())
private val divineJson=Json{encodeDefaults=true}

/** Every original survives request loss, cancellation, session replacement and failed writes. */
class DivineTrialStore(private val disk:SecretStore,val identity:StarterIdentity) {
 private class Locks {val update=Mutex();val requests=Mutex();val received=mutableListOf<Pair<String,DivineObservation>>()}
 companion object {private val shared=mutableMapOf<StarterIdentity,Locks>();@Synchronized private fun locks(id:StarterIdentity)=shared.getOrPut(id){Locks()}}
 private val lock=locks(identity);val requests get()=lock.requests
 init{identity.validate();require(identity.origin.startsWith("https://"))}
 fun path(event:String,c:DivineCommand)=if(c.attemptId==null)"/divine-trials/events/$event/${c.kind}" else "/divine-trials/attempts/${c.attemptId}/${c.kind}"
 private fun validate(e:DivineSavedEvent){val r=DivineRules.from(e.rules);r.event(e.event);require(e.commands.size<=r.bound("attemptsPerWallet")*3+2&&e.commands.map{it.id}.distinct().size==e.commands.size&&e.held.size<=e.commands.size+1);e.participant?.let{r.participant(it,identity.wallet,e.id);it.drows("attempts").forEach{a->require(a["encounter"]==e.event["encounter"])}};e.commands.forEach{c->DivineGrammar.id(JsonPrimitive(c.id));DivineGrammar.request("POST",path(e.id,c),emptyMap(),c.request);if(c.kind=="submit")r.orders(c.request.getValue("orders"),e.event.dobj("encounter"));c.response?.let{response(e,c,it)};c.supersededBy?.let{v->supersession(e,c,v);val current=requireNotNull(e.participant).drows("attempts").single{it.dt("id")==c.attemptId};immutableAttempt(v,current)};require(!c.closedAbsent||c.kind in listOf("entries","attempts")&&c.supersededBy==null);if(c.closedAbsent&&c.response==null)require(!knows(requireNotNull(e.participant),c))}}
 /** The participant record is complete: one entry and every attempt (ordinals 1..n, no paging; server participant()). */
 private fun knows(p:JsonObject,c:DivineCommand)=when(c.kind){"entries"->p.doptional("entry")?.get("idempotencyKey")==c.request["idempotencyKey"];"attempts"->p.drows("attempts").any{it["idempotencyKey"]==c.request["idempotencyKey"]};else->error("Only entry and attempt requests can be checked against the participant record.")}
 private fun snapshot():DivineJournal {val text=disk.read()?:return DivineJournal(identity=identity);require(text.toByteArray().size<=DivineGrammar.MAX_RESPONSE_BYTES*2);val j=divineJson.decodeFromString<DivineJournal>(text);require(j.version==1&&j.identity==identity&&j.revision>=0&&j.events.size<=128&&j.events.map{it.id}.distinct().size==j.events.size);j.events.forEach(::validate);return j}
 private fun write(j:DivineJournal,events:List<DivineSavedEvent>):DivineJournal {val next=j.copy(revision=Math.addExact(j.revision,1),events=events.toList());val text=divineJson.encodeToString(DivineJournal.serializer(),next);require(text.toByteArray().size<=DivineGrammar.MAX_RESPONSE_BYTES*2){"Saved trial history is full. Originals are preserved."};disk.write(text);return next}
 private fun replace(j:DivineJournal,e:DivineSavedEvent)=write(j,j.events.map{if(it.id==e.id)e else it})
 private fun immutableAttempt(old:JsonObject,next:JsonObject){require(JsonObject(old-setOf("status","orders","result","completedAt"))==JsonObject(next-setOf("status","orders","result","completedAt")));for(k in listOf("orders","result","completedAt"))if(old[k]!=JsonNull)require(old[k]==next[k]);val a=old.dt("status");val b=next.dt("status");require(when(a){"admitted"->true;"committed"->b in listOf("committed","completed");else->a==b})}
 private fun response(e:DivineSavedEvent,c:DivineCommand,v:JsonObject):JsonObject {require(c.supersededBy==null){"An incompatible canonical original already superseded this request"};val r=DivineRules.from(e.rules);when(c.kind){
  "entries"->{r.entry(v);require(v["baseId"]==c.request["baseId"]&&v["idempotencyKey"]==c.request["idempotencyKey"])}
  "attempts","submit","abandon"->{r.attempt(v);require(v["encounter"]==e.event["encounter"]);if(c.kind=="attempts")require(v["baseId"]==c.request["baseId"]&&v["idempotencyKey"]==c.request["idempotencyKey"])else{require(v.dt("id")==c.attemptId);if(c.kind=="submit")require(v["orders"]==c.request["orders"]&&v.dt("status") in listOf("committed","completed"))else require(v.dt("status")=="abandoned")}}
  "prize"->{r.claim(v);require(v["baseId"]==c.request["baseId"]);e.participant?.doptional("prize")?.let{require(it["amounts"]==v["amounts"])}}
  else->error("Unknown original command")
 };require(v.dt("wallet")==identity.wallet&&v.dt("eventId")==e.id);c.response?.let{if(c.kind in listOf("attempts","submit"))immutableAttempt(it,v)else require(it==v)};return v}
 // A canonical competing original resolves local uncertainty without claiming that
 // this device's immutable request was accepted. Retain the first proof forever.
 private fun supersedes(c:DivineCommand,v:JsonObject)=when(c.kind){
  "submit"->v.dt("status") in listOf("abandoned","expired")||v.dt("status") in listOf("committed","completed")&&v["orders"]!=c.request["orders"]
  "abandon"->v.dt("status") in listOf("committed","completed","expired")
  else->false
 }
 private fun supersession(e:DivineSavedEvent,c:DivineCommand,v:JsonObject):JsonObject {
  require(c.response==null&&c.kind in listOf("submit","abandon"));DivineRules.from(e.rules).attempt(v)
  require(v.dt("id")==c.attemptId&&v.dt("wallet")==identity.wallet&&v.dt("eventId")==e.id&&v["encounter"]==e.event["encounter"])
  require(supersedes(c,v))
  c.supersededBy?.let{immutableAttempt(it,v)};return v
 }
 private fun mergeParticipant(e:DivineSavedEvent,v:JsonObject):DivineSavedEvent {val rules=DivineRules.from(e.rules);rules.participant(v,identity.wallet,e.id);v.drows("attempts").forEach{require(it["encounter"]==e.event["encounter"])};val old=e.participant;old?.doptional("entry")?.let{require(it==v["entry"])};old?.drows("attempts")?.forEach{a->immutableAttempt(a,v.drows("attempts").single{it["id"]==a["id"]})};old?.doptional("prize")?.let{p->val n=requireNotNull(v.doptional("prize"));require(p["amounts"]==n["amounts"]);p.doptional("claim")?.let{require(it==n["claim"])}}
  val commands=e.commands.map{c->
   val original=if(c.kind in listOf("submit","abandon"))v.drows("attempts").singleOrNull{it.dt("id")==c.attemptId}else null
   if(c.supersededBy!=null){supersession(e,c,requireNotNull(original));c}
   else {
    val candidate=when(c.kind){"entries"->v.doptional("entry")?.takeIf{it["idempotencyKey"]==c.request["idempotencyKey"]};"attempts"->v.drows("attempts").singleOrNull{it["idempotencyKey"]==c.request["idempotencyKey"]};"submit"->original?.takeIf{it.dt("status") in listOf("committed","completed")&&it["orders"]==c.request["orders"]};"abandon"->original?.takeIf{it.dt("status")=="abandoned"};"prize"->v.doptional("prize")?.doptional("claim");else->null}
    if(candidate!=null)c.copy(response=response(e,c,candidate))
    else {require(c.response==null){"Participant omitted an accepted original"};if(original!=null&&original.dt("status")!="admitted")c.copy(supersededBy=supersession(e,c,original))else c}
   }
  }
  return e.copy(participant=v,commands=commands)
 }
 private fun apply(e:DivineSavedEvent,o:DivineObservation):DivineSavedEvent {val next=if(o.command==null)mergeParticipant(e,o.value)else{
  val c=e.commands.single{it.id==o.command}
  if(supersedes(c,o.value)){
   // The abandon endpoint may itself return the already-expired original after
   // our participant read. This is canonical evidence, not accepted abandonment.
   val original=supersession(e,c,o.value);val p=requireNotNull(e.participant);require(p.drows("attempts").any{it.dt("id")==c.attemptId})
   mergeParticipant(e,JsonObject(p+("attempts" to JsonArray(p.drows("attempts").map{if(it.dt("id")==c.attemptId)original else it}))))
  }else e.copy(commands=e.commands.map{if(it.id==o.command)it.copy(response=response(e,c,o.value))else it})
 };return next.copy(held=next.held.filterNot{it==o}).also(::validate)}
 // 2026-10-06 (dead-end audit): an observation that cannot apply (e.g. a prize claimed elsewhere into another kingdom) stays in
 // `held` as evidence and pauses only its own event (begin/mark/closeAbsent need an empty `held`); it no longer makes every
 // read() throw. Past the held bound, a re-readable participant read (command==null) is dropped from memory, never persisted;
 // owned POST replies keep the hard bound. A storage failure still throws.
 private fun flush():DivineJournal {var j=snapshot();while(lock.received.isNotEmpty()){val(id,o)=lock.received.first();val e=j.events.single{it.id==id};val held=if(o in e.held)e.held else e.held+o;if(held.size>e.commands.size+1&&o.command==null){lock.received.removeAt(0);continue};check(held.size<=e.commands.size+1);j=replace(j,e.copy(held=held));lock.received.removeAt(0)};for(saved in j.events)for(o in saved.held){val e=j.events.single{it.id==saved.id};val next=try{apply(e,o)}catch(_:Exception){null};if(next!=null)j=replace(j,next)};return j}
 suspend fun read()=lock.update.withLock{flush()}
 suspend fun event(id:String)=read().events.single{it.id==id}
 suspend fun adopt(event:JsonObject,rules:DivineRules)=lock.update.withLock{var j=flush();val v=rules.event(DivineGrammar.copy(event));val old=j.events.singleOrNull{it.id==v.dt("id")};if(old!=null){require(old.rules==rules.raw&&JsonObject(old.event-"terminal")==JsonObject(v-"terminal"));old.event.doptional("terminal")?.let{require(it==v["terminal"])}};val saved=old?.copy(event=v)?:DivineSavedEvent(rules.raw,v);if(old==null){check(j.events.size<rules.bound("localEventLimit")){"Trial journal is full; all originals remain saved."};j=write(j,j.events+saved)}else j=replace(j,saved);j.events.single{it.id==saved.id}}
 suspend fun begin(event:String,c:DivineCommand):DivineCommand=lock.update.withLock{val j=flush();val e=j.events.single{it.id==event};check(e.held.isEmpty());check(e.commands.none{it.unresolved}){"Recover the saved command before a new action."};require(e.commands.none{it.id==c.id});val next=e.copy(commands=e.commands+c);validate(next);replace(j,next);c}
 suspend fun mark(event:String,id:String)=lock.update.withLock{val j=flush();val e=j.events.single{it.id==event};check(e.held.isEmpty());val next=e.copy(commands=e.commands.map{if(it.id==id)it.copy(sent=true)else it});require(next.commands.any{it.id==id});replace(j,next);Unit}
 suspend fun observe(event:String,command:String?,raw:JsonObject)=withContext(NonCancellable){lock.update.withLock{val o=DivineObservation(command,DivineGrammar.copy(raw,true).jsonObject);if(lock.received.none{it.first==event&&it.second==o})lock.received+=event to o;val j=flush();check(j.events.single{it.id==event}.held.isEmpty()){"The server's trial record conflicts with this device's saved original. Both are kept; new actions for this trial stay paused on this device."};Unit}}
 /** Owner rule 2026-10-06 (no saved request blocks play forever): an entry/attempt request may be closed on this device only
  * against the participant record the closing action itself just read and saved, when that complete record has no
  * entry/attempt with its idempotency key. No POST, no proof; a record that later lists the key still resolves it. */
 suspend fun closeAbsent(event:String,id:String,participant:JsonObject)=lock.update.withLock{val j=flush();val e=j.events.single{it.id==event};check(e.held.isEmpty()){"Recover this event's saved evidence first."};val c=e.commands.single{it.id==id};check(c.unresolved&&c.kind in listOf("entries","attempts")){"Only an unresolved entry or attempt request can be closed this way."};val p=DivineGrammar.copy(participant,true).jsonObject;check(e.participant==p){"Read this event's participation again before closing."};check(!knows(p,c)){"The server has this request. Recover it instead."};val next=e.copy(commands=e.commands.map{if(it.id==id)it.copy(closedAbsent=true)else it});validate(next);replace(j,next);Unit}
}
