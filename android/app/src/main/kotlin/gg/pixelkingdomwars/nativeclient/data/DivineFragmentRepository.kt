package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.divinefragments.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.*

interface DivineFragmentPorts {
 val transport:DivineFragmentTransport
 fun rules(policy:JsonObject):DivineFragmentRules
 fun discoveryGuard():()->Unit = capture(false)
 fun capture(destination:Boolean):()->Unit
 fun selectedBase():String?
 fun owned(base:String)
 fun key():String
 suspend fun refresh(guard:()->Unit)
}
data class DivineFragmentReview(val key:String,val generation:Long)
data class DivineFragmentState(val journal:DivineFragmentJournal?=null,val rules:JsonObject?=null,val awards:JsonObject?=null,
 val claims:JsonObject?=null,val claimCursor:String?=null,val stock:JsonObject?=null,val review:DivineFragmentReview?=null,val busy:Boolean=false,val notice:String?=null,val available:Boolean=false)
/** Commands name original earnings and destinations. The server alone grants protected stock. */
class DivineFragmentRepository(val store:DivineFragmentStore,private val ports:DivineFragmentPorts) {
 private val mutable=MutableStateFlow(DivineFragmentState());val state=mutable.asStateFlow();private var epoch=0L
 init{require(store.identity==ports.transport.identity)}
 fun dismiss(){epoch++;mutable.value=state.value.copy(review=null,stock=null,busy=false)}
 private suspend fun action(destination:Boolean=false,entry:Boolean=false,block:suspend(()->Unit)->Unit){check(store.requests.tryLock()){"A fragment request is still settling."};val e=epoch
  try{val captured=if(entry)ports.discoveryGuard()else ports.capture(destination);val guard={captured();check(e==epoch){"The fragment view changed. Your original is saved."}};guard();mutable.value=state.value.copy(journal=store.read(),busy=true,notice=null);block(guard);guard();mutable.value=state.value.copy(journal=store.read())}
  finally{if(e==epoch)mutable.value=state.value.copy(journal=runCatching{store.read()}.getOrNull()?:state.value.journal,busy=false);store.requests.unlock()}
 }
 suspend fun discoverEntry()=action(entry=true){g->try{policy(g);g();mutable.value=state.value.copy(available=true)}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){g();mutable.value=state.value.copy(available=false)}}
 suspend fun local(){mutable.value=state.value.copy(journal=store.read(),busy=false,review=null)}
 private suspend fun policy(guard:()->Unit):DivineFragmentRules {val p=ports.transport.request("GET","/divine-fragments/policy",null,guard);val r=ports.rules(p);guard();mutable.value=state.value.copy(rules=r.raw);return r}
 private suspend fun observe(c:DivineFragmentCommand,guard:()->Unit){val rules=DivineFragmentRules.from(c.rules);val retain:suspend(JsonObject)->Unit={raw->val r=rules.envelope(raw,c.kind,c.consent);if(r!=null)store.observe(c.key,r)else check(store.read().commands.single{it.key==c.key}.receipt==null){"An accepted fragment receipt disappeared."}};ports.transport.request("GET",c.receiptPath,null,guard,retain=retain)}
 private suspend fun original(key:String,guard:()->Unit):DivineFragmentCommand {val c=store.read().commands.single{it.key==key};if(!c.closed)observe(c,guard);return store.read().commands.single{it.key==key}}
 private suspend fun page(kind:String,cursor:String?,rules:DivineFragmentRules,guard:()->Unit):JsonObject {val path=if(kind=="awards")"/divine-fragments/awards" else "/divine-fragments/seeker/terms";val raw=ports.transport.request("GET",path,null,guard,cursor?.let{mapOf("cursor" to it)}?:emptyMap());return rules.page(raw,store.identity.wallet,kind,cursor)}
 suspend fun discover(kind:String="awards",cursor:String?=null)=action{g->val r=policy(g);val p=page(kind,cursor,r,g);g();mutable.value=if(kind=="awards")state.value.copy(awards=p)else state.value.copy(claims=p,claimCursor=cursor)}
 suspend fun stock()=action{g->val base=requireNotNull(ports.selectedBase()){ "Select a kingdom to view its stock." };ports.owned(base);val r=state.value.rules?.let(DivineFragmentRules::from)?:policy(g);val v=r.stock(ports.transport.request("GET","/divine-fragments/stock/$base",null,g),store.identity.wallet,base);g();check(ports.selectedBase()==base);ports.owned(base);mutable.value=state.value.copy(stock=v)}
 suspend fun check(key:String)=action{g->val c=original(key,g);if(c.receipt!=null)hydrate(c,g)}
 private suspend fun hydrate(c:DivineFragmentCommand,g:()->Unit){ports.refresh(g);g();val same=ports.selectedBase()==c.base&&runCatching{ports.owned(c.base)}.isSuccess;if(same){val r=DivineFragmentRules.from(c.rules);val s=r.stock(ports.transport.request("GET","/divine-fragments/stock/${c.base}",null,g),store.identity.wallet,c.base);g();mutable.value=state.value.copy(stock=s,notice="Original receipt confirmed. Kingdom stock refreshed.")}else mutable.value=state.value.copy(stock=null,notice="Original receipt confirmed for its saved kingdom. Current selection receives no additional stock.")}
 private suspend fun currentAward(c:DivineFragmentCommand,g:()->Unit){val r=DivineFragmentRules.from(c.rules);val v=r.event(ports.transport.request("GET","/divine-fragments/events/${c.consent.ft("eventId")}",null,g),store.identity.wallet,c.consent.ft("eventId"));require(v["award"]==c.consent["award"]&&v["delivery"]==JsonNull){"Original award changed or was already delivered. Check its receipt."}}
 suspend fun reviewDelivery(event:String)=action(true){g->mutable.value=state.value.copy(review=null);ports.refresh(g);val base=requireNotNull(ports.selectedBase());ports.owned(base);val r=policy(g);val v=r.event(ports.transport.request("GET","/divine-fragments/events/$event",null,g),store.identity.wallet,event);val award=requireNotNull(v.foptional("award")){"No settled fragment award is available."};require(v["delivery"]==JsonNull);g();ports.owned(base);val c=DivineFragmentCommand("delivery",buildJsonObject{put("version",1);put("wallet",store.identity.wallet);put("eventId",event);put("request",buildJsonObject{put("idempotencyKey",ports.key());put("baseId",base)});put("award",award)},r.raw);store.begin(c);g();mutable.value=state.value.copy(review=DivineFragmentReview(c.key,epoch))}
 suspend fun reviewClaim(row:JsonObject)=action(true){g->mutable.value=state.value.copy(review=null);ports.refresh(g);val base=requireNotNull(ports.selectedBase());ports.owned(base);val r=policy(g);r.entitlement(row);require(state.value.claims?.fr("rows")?.contains(row)==true&&row.fa("claimable").signum()>0){"Refresh the original term share before reviewing."};g();ports.owned(base);val c=DivineFragmentCommand("claim",buildJsonObject{put("version",1);put("wallet",store.identity.wallet);put("request",buildJsonObject{put("idempotencyKey",ports.key());put("baseId",base);put("termId",row.getValue("termId"));put("spotId",row.getValue("spotId"))})},r.raw,row.ft("termHash"),state.value.claimCursor);currentClaim(c,g);store.begin(c);g();mutable.value=state.value.copy(review=DivineFragmentReview(c.key,epoch))}
 /** Original rights are addressed directly; a discovery cursor never authenticates a term. */
 private suspend fun currentClaim(c:DivineFragmentCommand,g:()->Unit){val rules=DivineFragmentRules.from(c.rules);val q=c.consent.fo("request")
  val raw=ports.transport.request("GET","/divine-fragments/seeker/terms/${q.ft("termId")}",null,g)
  val p=rules.page(raw,store.identity.wallet,"claims",null);require(p["nextCursor"]==JsonNull&&p.fr("rows").all{it["termId"]==q["termId"]})
  val row=p.fr("rows").singleOrNull{it["spotId"]==q["spotId"]}
  require(row!=null&&row.ft("termHash")==c.termHash&&row.fa("claimable").signum()>0){"The original spot has no available share. Its saved request is preserved."}
 }
 suspend fun reviewSaved(key:String)=action{g->mutable.value=state.value.copy(review=null);val c=original(key,g);if(c.receipt!=null){hydrate(c,g);return@action};check(c.unresolved);val destination=ports.capture(true);destination();ports.refresh{g();destination()};g();destination();ports.owned(c.base);check(ports.selectedBase()==c.base){"Select the saved destination kingdom."};if(c.kind=="delivery")currentAward(c){g();destination()}else currentClaim(c){g();destination()};mutable.value=state.value.copy(review=DivineFragmentReview(key,epoch))}
 suspend fun confirm(review:DivineFragmentReview)=action{g->check(state.value.review===review&&review.generation==epoch);var c=original(review.key,g);if(c.receipt!=null){mutable.value=state.value.copy(review=null);hydrate(c,g);return@action};val destination=ports.capture(true);val guard={g();destination();check(state.value.review===review&&ports.selectedBase()==c.base);ports.owned(c.base)};guard();ports.refresh(guard);guard();if(c.kind=="delivery")currentAward(c,guard)else currentClaim(c,guard);store.mark(c.key);guard()
  try{ports.transport.request("POST",c.path,c.consent.fo("request"),guard,retain={store.observe(c.key,c.match(it))});g();c=store.read().commands.single{it.key==c.key};hydrate(c,g)}finally{mutable.value=state.value.copy(review=null)}
 }
 suspend fun abandonDraft(key:String)=action{g->val c=original(key,g);check(c.unresolved&&!c.sent);store.closeDraft(key);g();mutable.value=state.value.copy(review=null)}
 /** Owner rule 2026-10-06 (no saved request blocks play forever): CLOSE re-reads this sent request's own by-key receipt now.
  * No receipt for exactly its key closes it on this device with that answer kept; a receipt is retained and hydrated. No POST. */
 suspend fun closeAbsent(key:String)=action{g->val c=store.read().commands.single{it.key==key};check(c.unresolved&&c.sent){"Only a sent request the server has no record of can be closed."}
  val rules=DivineFragmentRules.from(c.rules)
  ports.transport.request("GET",c.receiptPath,null,g,retain={raw->val r=rules.envelope(raw,c.kind,c.consent);if(r!=null)store.observe(c.key,r)else store.closeAbsent(c.key,raw)})
  g();val saved=store.read().commands.single{it.key==key}
  if(saved.receipt!=null)hydrate(saved,g)else mutable.value=state.value.copy(review=null,notice="The server has no record of this request. It is closed on this device.")
 }
}
