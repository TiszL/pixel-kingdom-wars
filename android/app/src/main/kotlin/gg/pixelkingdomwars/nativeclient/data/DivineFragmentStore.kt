package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.divinefragments.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** [absent] is the server's own by-key answer, with no receipt, for exactly this key: the only evidence that closes a sent request. */
@Serializable data class DivineFragmentCommand(val kind:String,val consent:JsonObject,val rules:JsonObject,val termHash:String?=null,val browseCursor:String?=null,
 val sent:Boolean=false,val receipt:JsonObject?=null,val closed:Boolean=false,val absent:JsonObject?=null) {
 val key get()=consent.fo("request").ft("idempotencyKey")
 val base get()=consent.fo("request").ft("baseId")
 val unresolved get()=receipt==null&&!closed
 val path get()=if(kind=="delivery")"/divine-fragments/events/${consent.ft("eventId")}/delivery" else "/divine-fragments/seeker/claims"
 val receiptPath get()=if(kind=="delivery")"/divine-fragments/deliveries/$key" else "/divine-fragments/seeker/claims/$key"
 fun match(raw:JsonObject)=DivineFragmentRules.from(rules).match(raw,kind,consent).also{if(kind=="claim")require(it.ft("termHash")==termHash)}
 fun validate(){browseCursor?.let{DivineFragmentProtocol.id(JsonPrimitive(it))};val r=DivineFragmentRules.from(rules);r.consent(consent,kind);require(!closed||receipt==null&&(!sent||absent!=null));require(absent==null||closed&&sent);absent?.let{require(r.envelope(it,kind,consent)==null)};if(kind=="claim")gg.pixelkingdomwars.nativeclient.charter.CharterGrammar.hex(JsonPrimitive(requireNotNull(termHash)),32)else require(termHash==null);receipt?.let(::match)}
}
@Serializable data class DivineFragmentJournal(val version:Int=1,val identity:StarterIdentity,val revision:Long=0,val commands:List<DivineFragmentCommand> = emptyList())
private val fragmentJson=Json{encodeDefaults=true}
/** One actor-owned journal; an attempted original never becomes another request.
 * Bound each command/response, not lifetime receipts: old permanent rights cannot
 * consume admission capacity for the next legitimate claim. */
class DivineFragmentStore(private val disk:SecretStore,val identity:StarterIdentity) {
 private class Locks {val update=Mutex();val requests=Mutex();val received=mutableListOf<Pair<String,JsonObject>>()}
 companion object {private val locks=mutableMapOf<StarterIdentity,Locks>();@Synchronized private fun forActor(id:StarterIdentity)=locks.getOrPut(id){Locks()}}
 private val lock=forActor(identity);val requests get()=lock.requests
 init{identity.validate();require(identity.origin.startsWith("https://"))}
 private fun snapshot():DivineFragmentJournal {val s=disk.read()?:return DivineFragmentJournal(identity=identity);val j=fragmentJson.decodeFromString<DivineFragmentJournal>(s);require(j.version==1&&j.identity==identity&&j.revision>=0&&j.commands.map{it.key}.distinct().size==j.commands.size&&j.commands.count{it.unresolved}<=1);j.commands.forEach{it.validate();require(it.consent.ft("wallet")==identity.wallet)};return j}
 private fun write(j:DivineFragmentJournal,c:List<DivineFragmentCommand>):DivineFragmentJournal {val n=j.copy(revision=Math.addExact(j.revision,1),commands=c.toList());val text=fragmentJson.encodeToString(DivineFragmentJournal.serializer(),n);disk.write(text);return n}
 private fun flush():DivineFragmentJournal {var j=snapshot();while(lock.received.isNotEmpty()){val(key,r)=lock.received.first();val c=j.commands.single{it.key==key};c.match(r);check(!c.closed);c.receipt?.let{require(it==r){"An original fragment receipt changed."}};if(c.receipt==null)j=write(j,j.commands.map{if(it.key==key)it.copy(receipt=r)else it});lock.received.removeAt(0)};return j}
 suspend fun read()=lock.update.withLock{flush()}
 suspend fun begin(c:DivineFragmentCommand)=lock.update.withLock{val j=flush();c.validate();require(c.consent.ft("wallet")==identity.wallet&&!c.sent&&!c.closed&&c.receipt==null);check(j.commands.none{it.unresolved}&&j.commands.none{it.key==c.key}){"Check your saved fragment request first."};write(j,j.commands+c);c}
 suspend fun mark(key:String)=lock.update.withLock{val j=flush();val c=j.commands.single{it.key==key};check(c.unresolved);if(!c.sent)write(j,j.commands.map{if(it.key==key)it.copy(sent=true)else it});Unit}
 suspend fun closeDraft(key:String)=lock.update.withLock{val j=flush();val c=j.commands.single{it.key==key};check(c.unresolved&&!c.sent);write(j,j.commands.map{if(it.key==key)it.copy(closed=true)else it});Unit}
 /** Owner rule 2026-10-06: a sent request may block new deliveries and claims only while the server might know it. It closes
  * on this device only with the server's by-key answer, read in the closing action, that has no receipt for exactly its key
  * and wallet; that answer is kept as evidence. Never on a receipt; a draft uses [closeDraft]. */
 suspend fun closeAbsent(key:String,envelope:JsonObject)=withContext(NonCancellable){lock.update.withLock{val j=flush();val c=j.commands.single{it.key==key};check(c.unresolved&&c.sent){"Only a sent request the server has no record of can be closed."};val e=DivineFragmentProtocol.copy(envelope).jsonObject;check(DivineFragmentRules.from(c.rules).envelope(e,c.kind,c.consent)==null){"The server has a receipt for this request."};val next=c.copy(closed=true,absent=e);next.validate();write(j,j.commands.map{if(it.key==key)next else it});Unit}}
 suspend fun observe(key:String,raw:JsonObject)=withContext(NonCancellable){lock.update.withLock{val r=DivineFragmentProtocol.copy(raw).jsonObject;val c=snapshot().commands.single{it.key==key};c.match(r);check(!c.closed);c.receipt?.let{require(it==r)};check(lock.received.none{it.first==key&&it.second!=r});if(lock.received.none{it.first==key})lock.received+=key to r;flush();Unit}}
}
