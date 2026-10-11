package gg.pixelkingdomwars.nativeclient.divinefragments

import gg.pixelkingdomwars.nativeclient.charter.CharterGrammar
import java.math.BigInteger
import java.time.Instant
import kotlinx.serialization.json.*

fun JsonObject.ft(key:String)=CharterGrammar.text(getValue(key))
fun JsonObject.fn(key:String)=CharterGrammar.number(getValue(key))
fun JsonObject.fa(key:String)=DivineFragmentProtocol.amount(getValue(key))
fun JsonObject.fo(key:String)=getValue(key).jsonObject
fun JsonObject.fr(key:String)=getValue(key).jsonArray.map{it.jsonObject}
fun JsonObject.foptional(key:String)=getValue(key).takeUnless{it==JsonNull}?.jsonObject

/** Closed transport grammar. No parser grants source, custody or issuance authority. */
object DivineFragmentProtocol {
 const val ROOT="/divine-fragments"
 const val MAX_BYTES=1_048_576 // Protocol work bound, not an economic cap.
 fun copy(v:JsonElement):JsonElement {var nodes=0;fun own(x:JsonElement,d:Int):JsonElement{require(++nodes<=8192&&d<=16);return when(x){is JsonObject->{require(x.size<=40);JsonObject(x.mapValues{(k,c)->require(k.length<=64);own(c,d+1)})};is JsonArray->{require(x.size<=1024);JsonArray(x.map{own(it,d+1)})};is JsonPrimitive->{require(x.content.length<=1024);x}}};require(v.toString().toByteArray().size<=MAX_BYTES);return own(v,0)}
 fun fields(raw:JsonElement,vararg names:String)=copy(raw).jsonObject.also{require(it.keys==names.toSet())}
 fun id(v:JsonElement){CharterGrammar.id(v);require(CharterGrammar.text(v)!="00000000-0000-0000-0000-000000000000")}
 fun amount(v:JsonElement):BigInteger {val s=CharterGrammar.text(v);require(s.matches(Regex("0|[1-9][0-9]{0,18}")));return s.toBigInteger().also{require(it<=Long.MAX_VALUE.toBigInteger())}}
 fun time(v:JsonElement):Long {val s=CharterGrammar.text(v);require(s.matches(Regex("\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z")));val i=Instant.parse(s);require(java.time.format.DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(java.time.ZoneOffset.UTC).format(i)==s);return i.toEpochMilli()}
 fun address(v:JsonElement){CharterGrammar.address(v);val s=CharterGrammar.text(v);val alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";var n=BigInteger.ZERO;s.forEach{n=n*BigInteger.valueOf(58)+BigInteger.valueOf(alphabet.indexOf(it).toLong())};require((n.bitLength()+7)/8+s.takeWhile{it=='1'}.length==32)}
 fun common(o:JsonObject){require(o.fn("version")==1L&&o.ft("resourceId")=="crystal_fragment")}
 fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?) {
  require(path.startsWith("$ROOT/"));val p=path.removePrefix("$ROOT/").split('/');require(method in setOf("GET","POST"))
  if(method=="GET"){require(body==null);if(p in listOf(listOf("awards"),listOf("seeker","terms"))){require(query.keys.all{it=="cursor"});query["cursor"]?.let{id(JsonPrimitive(it))}}else{require(query.isEmpty());require(p==listOf("policy")||p.size==2&&p[0] in setOf("events","deliveries","stock")||p.size==3&&p.take(2) in listOf(listOf("seeker","claims"),listOf("seeker","terms")));if(p!=listOf("policy"))id(JsonPrimitive(p.last()))}}
  else{require(query.isEmpty());val b=requireNotNull(body);when{p.size==3&&p[0]=="events"&&p[2]=="delivery"->{id(JsonPrimitive(p[1]));fields(b,"idempotencyKey","baseId")};p==listOf("seeker","claims")->fields(b,"idempotencyKey","baseId","termId","spotId");else->error("Unsupported fragment command")};b.forEach{(k,v)->if(k=="spotId")CharterGrammar.number(v)else id(v)}}
 }
}
/** Policy comes from the server; source-independent validation bounds come from canonical content.
 * Every saved command retains these exact rules so later content cannot reinterpret it. */
class DivineFragmentRules private constructor(val raw:JsonObject) {
 val policy=raw.fo("policy");val limits=raw.fo("limits")
 val pageSize get()=limits.fn("pageSize").toInt();val localLimit get()=limits.fn("localLimit").toInt()
 private fun spot(o:JsonObject){require(o.fn("spotId") in 0 until limits.fn("totalSpots"))}
 private fun winner(o:JsonObject,zero:Boolean=false){require(o.fn("winnerCount") in (if(zero)0L else 1L)..limits.fn("totalSpots"))}
 private fun head(o:JsonObject){DivineFragmentProtocol.common(o);DivineFragmentProtocol.address(o.getValue("wallet"))}
 private fun quantities(o:JsonObject,vararg keys:String)=keys.forEach{o.fa(it)}
 fun award(raw:JsonObject):JsonObject {
  val common=arrayOf("version","resourceId","economicLineage","domain","eventId","wallet","site","weekStart","earnedAt","sourceHash","termId","termHash","winnerCount","poolDisposition","gross","net","tax","carryBefore","carryAfter","settledAt")
  val isClan="clan" in raw
  val o=if(isClan)DivineFragmentProtocol.fields(raw,*common,"clan")else DivineFragmentProtocol.fields(raw,*common)
  head(o);require(o.ft("economicLineage")=="shardkeep")
  val domain=DivineFragmentProtocol.fields(o.getValue("domain"),"genesisHash","economyProgram");domain.values.forEach(DivineFragmentProtocol::address)
  listOf("eventId","termId").forEach{DivineFragmentProtocol.id(o.getValue(it))}
  listOf("sourceHash","termHash").forEach{CharterGrammar.hex(o.getValue(it),32)}
  val expectedGross=if(isClan){
   val clan=DivineFragmentProtocol.fields(o.getValue("clan"),"clanId","entryId","rosterSize","rosterHash","siteGross","tournamentDomain")
   listOf("clanId","entryId").forEach{DivineFragmentProtocol.id(clan.getValue(it))};CharterGrammar.hex(clan.getValue("rosterHash"),32)
   val tournament=DivineFragmentProtocol.fields(clan.getValue("tournamentDomain"),"genesisHash","economyProgram","craftProgram","treasury")
   tournament.values.forEach(DivineFragmentProtocol::address)
   require(tournament["genesisHash"]==domain["genesisHash"]&&tournament["economyProgram"]==domain["economyProgram"])
   // Site allowance and roster are authenticated server facts. SQL/shared pin the
   // gameplay tuning; native independently checks shape, budget division and tax.
   // These limits match the three-digit site grammar and existing roster work bound.
   val siteGross=clan.fa("siteGross");val budget=policy.fa("clanGross");val roster=clan.fn("rosterSize")
   require(siteGross>BigInteger.ZERO&&siteGross<=budget&&budget%siteGross==BigInteger.ZERO&&roster in 1..256)
   val sites=budget/siteGross;require(sites in BigInteger.ONE..BigInteger.valueOf(999))
   require(o.ft("site").matches(Regex("divine-clan-[0-9]{3}"))&&o.ft("site").takeLast(3).toBigInteger() in BigInteger.ONE..sites)
   (siteGross/roster.toBigInteger()).also{require(it>BigInteger.ZERO)}
  }else{
   require(o.ft("site").matches(Regex("divine-individual-[0-9]{3}"))&&o.ft("site").takeLast(3).toLong() in 1..policy.fn("individualSites"))
   policy.fa("grossPerSite")
  }
  winner(o,true)
  val earned=DivineFragmentProtocol.time(o.getValue("earnedAt"));val period=Math.multiplyExact(policy.fn("periodDays"),86_400_000L)
  require(DivineFragmentProtocol.time(o.getValue("weekStart"))==Math.multiplyExact(Math.floorDiv(earned,period),period)&&DivineFragmentProtocol.time(o.getValue("settledAt"))>=earned)
  quantities(o,"gross","net","tax","carryBefore","carryAfter")
  val b=policy.fn("basisPoints").toBigInteger();val value=o.fa("gross")*policy.fn("seekerBps").toBigInteger()+o.fa("carryBefore")
  require(o.fa("carryBefore")<b&&o.fa("gross")==expectedGross&&o.fa("tax")==value/b&&o.fa("carryAfter")==value%b&&o.fa("net")+o.fa("tax")==o.fa("gross"))
  require(o.ft("poolDisposition")==if(o.fn("winnerCount")==0L)"held_zero_winners" else "original_winning_spots")
  return o
 }
 fun receipt(raw:JsonObject,kind:String):JsonObject {val common=arrayOf("version","resourceId","wallet","idempotencyKey","baseId","quantity","stockBefore","stockAfter");val o=when(kind){"delivery"->DivineFragmentProtocol.fields(raw,*common,"eventId","deliveredAt");"claim"->DivineFragmentProtocol.fields(raw,*common,"termId","spotId","termHash","winnerCount","poolTotal","previousTotal","cumulativeTotal","claimedAt");else->error("Unknown fragment receipt")};head(o);listOf("idempotencyKey","baseId",if(kind=="delivery")"eventId" else "termId").forEach{DivineFragmentProtocol.id(o.getValue(it))};quantities(o,"quantity","stockBefore","stockAfter");require(o.fa("quantity")>BigInteger.ZERO&&o.fa("stockBefore")+o.fa("quantity")==o.fa("stockAfter"));DivineFragmentProtocol.time(o.getValue(if(kind=="delivery")"deliveredAt" else "claimedAt"));if(kind=="claim"){share(o,"quantity");require(o.fa("quantity")>BigInteger.ZERO)};return o}
 private fun share(o:JsonObject,due:String){spot(o);winner(o);CharterGrammar.hex(o.getValue("termHash"),32);quantities(o,"poolTotal","previousTotal","cumulativeTotal",due);require(o.fa("poolTotal")>BigInteger.ZERO&&o.fa("cumulativeTotal")==o.fa("poolTotal")/o.fn("winnerCount").toBigInteger()&&o.fa("previousTotal")<=o.fa("cumulativeTotal")&&o.fa(due)==o.fa("cumulativeTotal")-o.fa("previousTotal"))}
 fun entitlement(raw:JsonObject):JsonObject {val o=DivineFragmentProtocol.fields(raw,"termId","termHash","startsAt","endsAt","spotId","winnerCount","poolTotal","previousTotal","cumulativeTotal","claimable");DivineFragmentProtocol.id(o.getValue("termId"));share(o,"claimable");require(Math.subtractExact(DivineFragmentProtocol.time(o.getValue("endsAt")),DivineFragmentProtocol.time(o.getValue("startsAt")))==Math.multiplyExact(limits.fn("termSeconds"),1000));return o}
 fun event(raw:JsonObject,wallet:String,event:String):JsonObject {val o=DivineFragmentProtocol.fields(raw,"version","wallet","eventId","enrolled","settled","award","delivery");require(o.fn("version")==1L&&o.ft("wallet")==wallet&&o.ft("eventId")==event);DivineFragmentProtocol.id(o.getValue("eventId"));DivineFragmentProtocol.address(o.getValue("wallet"));val enrolled=CharterGrammar.bool(o.getValue("enrolled"));val settled=CharterGrammar.bool(o.getValue("settled"));require(!settled||enrolled);require(settled||o["award"]==JsonNull&&o["delivery"]==JsonNull);row(buildJsonObject{put("award",o.getValue("award"));put("delivery",o.getValue("delivery"))},wallet,true);o.foptional("award")?.let{require(it.ft("eventId")==event)};return o}
 private fun row(o:JsonObject,wallet:String,nullable:Boolean=false){DivineFragmentProtocol.fields(o,"award","delivery");val a=o.foptional("award");if(a==null){require(nullable&&o["delivery"]==JsonNull);return};award(a);require(a.ft("wallet")==wallet);o.foptional("delivery")?.let{d->receipt(d,"delivery");require(d["wallet"]==a["wallet"]&&d["eventId"]==a["eventId"]&&d["quantity"]==a["net"]&&DivineFragmentProtocol.time(d.getValue("deliveredAt"))>=DivineFragmentProtocol.time(a.getValue("settledAt")))}}
 fun page(raw:JsonObject,wallet:String,kind:String,cursor:String?):JsonObject {val o=DivineFragmentProtocol.fields(raw,"version","wallet","rows","nextCursor");require(o.fn("version")==1L&&o.ft("wallet")==wallet);DivineFragmentProtocol.address(o.getValue("wallet"));cursor?.let{DivineFragmentProtocol.id(JsonPrimitive(it))};val rows=o.fr("rows");require(rows.size<=if(kind=="awards")pageSize else limits.fn("totalSpots").toInt());val next=o.getValue("nextCursor").takeUnless{it==JsonNull}?.let{DivineFragmentProtocol.id(it);CharterGrammar.text(it)};require(cursor==null||next==null||next>cursor)
  if(kind=="awards"){rows.forEach{row(it,wallet)};val ids=rows.map{it.fo("award").ft("eventId")};require(ids==ids.distinct().sorted()&&ids.all{cursor==null||it>cursor}&&(next==null||next==ids.lastOrNull()))}
  else{require(kind=="claims");rows.forEach(::entitlement);rows.firstOrNull()?.let{first->require(rows.size<=first.fn("winnerCount"));require(rows.all{r->listOf("termId","termHash","startsAt","endsAt","winnerCount","poolTotal").all{r[it]==first[it]}&&(cursor==null||r.ft("termId")>cursor)});val spots=rows.map{it.fn("spotId")};require(spots==spots.distinct().sorted()&&(next==null||next==first.ft("termId")))}};return o
 }
 fun stock(raw:JsonObject,wallet:String,base:String)=DivineFragmentProtocol.fields(raw,"version","resourceId","wallet","baseId","available").also{head(it);DivineFragmentProtocol.id(it.getValue("baseId"));it.fa("available");require(it.ft("wallet")==wallet&&it.ft("baseId")==base)}
 fun consent(raw:JsonObject,kind:String):JsonObject {val o=if(kind=="delivery")DivineFragmentProtocol.fields(raw,"version","wallet","eventId","request","award")else DivineFragmentProtocol.fields(raw,"version","wallet","request");require(o.fn("version")==1L);DivineFragmentProtocol.address(o.getValue("wallet"));val q=o.fo("request");DivineFragmentProtocol.request("POST",if(kind=="delivery")"${DivineFragmentProtocol.ROOT}/events/${o.ft("eventId")}/delivery" else "${DivineFragmentProtocol.ROOT}/seeker/claims",emptyMap(),q);if(kind=="delivery"){val a=award(o.fo("award"));require(a["wallet"]==o["wallet"]&&a["eventId"]==o["eventId"])}else{require(kind=="claim");spot(q)};return o}
 fun match(raw:JsonObject,kind:String,original:JsonObject):JsonObject {val c=consent(original,kind);val r=receipt(raw,kind);require(r["wallet"]==c["wallet"]);c.fo("request").forEach{(k,v)->require(r[k]==v)};if(kind=="delivery")require(r["eventId"]==c["eventId"]&&r["quantity"]==c.fo("award")["net"]&&DivineFragmentProtocol.time(r.getValue("deliveredAt"))>=DivineFragmentProtocol.time(c.fo("award").getValue("settledAt")));return r}
 fun envelope(raw:JsonObject,kind:String,consent:JsonObject):JsonObject? {val o=DivineFragmentProtocol.fields(raw,"version","wallet","idempotencyKey","receipt");require(o.fn("version")==1L&&o["wallet"]==consent["wallet"]&&o["idempotencyKey"]==consent.fo("request")["idempotencyKey"]);return o.foptional("receipt")?.let{match(it,kind,consent)}}
 companion object {
  fun from(raw:JsonObject):DivineFragmentRules {val r=DivineFragmentProtocol.fields(raw,"policy","limits");val p=DivineFragmentProtocol.fields(r.getValue("policy"),"version","resourceId","weeklyGross","periodDays","individualGross","clanGross","salvageGross","individualSites","grossPerSite","basisPoints","playerBps","seekerBps","developerBps");DivineFragmentProtocol.common(p);val l=DivineFragmentProtocol.fields(r.getValue("limits"),"totalSpots","termSeconds","pageSize","localLimit");l.values.forEach{require(CharterGrammar.number(it) in 1..1_000_000)};require(l.fn("totalSpots")<=1024&&l.fn("pageSize")<=1024&&l.fn("localLimit")<=128);require(p.fn("individualSites") in 1..999&&p.fn("periodDays") in 1..365&&p.fn("basisPoints")>0);require(p.fn("developerBps")==0L&&p.fn("playerBps")>0&&p.fn("seekerBps")>0&&p.fn("playerBps")+p.fn("seekerBps")==p.fn("basisPoints"));listOf("weeklyGross","individualGross","clanGross","salvageGross","grossPerSite").forEach{p.fa(it)};require(p.fa("weeklyGross")==p.fa("individualGross")+p.fa("clanGross")+p.fa("salvageGross")&&p.fa("grossPerSite")==p.fa("individualGross")/p.fn("individualSites").toBigInteger()&&p.fa("grossPerSite")>BigInteger.ZERO);return DivineFragmentRules(r)}
  fun installed(policy:JsonObject,catalogue:JsonObject):DivineFragmentRules {val c=catalogue.fo("constants");val island=c.fo("PHASE_E_POLICY").fo("seekerIsland");val trials=c.fo("PHASE_E_DIVINE_TRIALS");val tax=c.fo("PHASE_E_POLICY").fo("taxes").fo("resources");require(policy["basisPoints"]==c.fo("PHASE_E_POLICY")["basisPoints"]&&policy["playerBps"]==tax["playerBps"]&&policy["seekerBps"]==tax["islandPoolBps"]&&policy["developerBps"]==tax["devBps"]&&policy["individualSites"]==trials["divineSites"]);return from(buildJsonObject{put("policy",policy);put("limits",buildJsonObject{put("totalSpots",island.getValue("totalSpots"));put("termSeconds",island.getValue("operatingTermSec"));put("pageSize",trials.getValue("discoveryPageSize"));put("localLimit",trials.getValue("localEventLimit"))})})}
 }
}
