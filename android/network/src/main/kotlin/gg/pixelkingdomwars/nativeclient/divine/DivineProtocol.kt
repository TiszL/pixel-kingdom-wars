package gg.pixelkingdomwars.nativeclient.divine

import java.math.BigInteger
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.*

fun JsonObject.dt(key:String)=DivineGrammar.text(getValue(key))
fun JsonObject.dn(key:String)=DivineGrammar.number(getValue(key))
fun JsonObject.dobj(key:String)=getValue(key).jsonObject
fun JsonObject.drows(key:String)=getValue(key).jsonArray.map{it.jsonObject}
fun JsonObject.doptional(key:String)=getValue(key).takeUnless{it==JsonNull}?.jsonObject

/** Canonical JSON commitment grammar, independently implemented. No parser grants authority. */
object DivineGrammar {
 const val MAX_BYTES=16*1024*1024
 // Frozen D184 v1: up to three bounded attempts plus participant envelope.
 const val MAX_RESPONSE_BYTES=MAX_BYTES*4
 fun text(v:JsonElement):String {val p=v as? JsonPrimitive?:error("Expected text");require(p.isString);return p.content.also{require(it.length<=256)}}
 fun number(v:JsonElement):Long {val p=v as? JsonPrimitive?:error("Expected integer");require(!p.isString);return requireNotNull(p.longOrNull).also{require(it in -9_007_199_254_740_991L..9_007_199_254_740_991L)}}
 fun count(v:JsonElement,max:Long=9_007_199_254_740_991L)=number(v).also{require(it in 0..max)}
 fun id(v:JsonElement)=text(v).also{require(it.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")))}
 fun wallet(v:JsonElement)=text(v).also{require(it.matches(Regex("[1-9A-HJ-NP-Za-km-z]{32,44}")))}
 fun hash(v:JsonElement)=text(v).also{require(it.matches(Regex("[0-9a-f]{64}")))}
 fun amount(v:JsonElement,max:BigInteger=Long.MAX_VALUE.toBigInteger()):BigInteger=text(v).also{require(it.matches(Regex("0|[1-9][0-9]{0,19}")))}.toBigInteger().also{require(it<=max)}
 fun time(v:JsonElement):Instant {val s=text(v);require(s.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z")));return Instant.parse(s).also{require(java.time.format.DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC).format(it)==s)}}
 fun fields(v:JsonElement,vararg keys:String):JsonObject=v.jsonObject.also{require(it.keys==keys.toSet()){ "Unexpected Divine fields" }}
 fun canonical(v:JsonElement,aggregate:Boolean=false):String {
  var nodes=0;var size=0
  fun add(s:String):String {size+=s.length;require(size<=if(aggregate)MAX_RESPONSE_BYTES else MAX_BYTES);return s}
  fun walk(x:JsonElement,depth:Int):String {require(++nodes<=if(aggregate)4_000_000 else 1_000_000);require(depth<=if(aggregate)20 else 16)
   return when(x){
    JsonNull->add("null")
    is JsonObject->{require(x.size<=64&&x.keys.all{it.isNotEmpty()&&it.length<=256&&it.all{c->c.code in 32..126}});add("{")+x.keys.sorted().joinToString(","){add(JsonPrimitive(it).toString()+":")+walk(x.getValue(it),depth+1)}+add("}")}
    is JsonArray->{require(x.size<=250_000);add("[")+x.joinToString(","){walk(it,depth+1)}+add("]")}
    is JsonPrimitive->if(x.isString)add(JsonPrimitive(text(x)).toString()) else if(x.booleanOrNull!=null)add(x.toString()) else add(number(x).toString())
   }
  }
  return walk(v,0).also{require(it.toByteArray(Charsets.UTF_8).size<=if(aggregate)MAX_RESPONSE_BYTES else MAX_BYTES)}
 }
 fun copy(v:JsonElement,aggregate:Boolean=false)=Json.parseToJsonElement(canonical(v,aggregate))
 fun sha(v:JsonElement)=MessageDigest.getInstance("SHA-256").digest(canonical(v).toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)}
 /** Transport grammar only. Installed rules and original ownership are checked by the controller. */
 fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?) {
  require(path.startsWith("/divine-trials/")&&!path.contains('%'))
  val p=path.removePrefix("/divine-trials/").split('/')
  if(method=="GET") {require(body==null);if(p==listOf("events")){require(query.keys.all{it=="cursor"});query["cursor"]?.let{require(it.matches(Regex("[A-Za-z0-9_-]{1,256}")))}}
   else {require(query.isEmpty());require(p.size==3&&p[0]=="events"&&p[2]=="participant"||p.size==2&&p[0]=="attempts");id(JsonPrimitive(p[1]))};return}
  require(method=="POST"&&query.isEmpty()&&p.size==3);id(JsonPrimitive(p[1]));val b=requireNotNull(body);canonical(b)
  when {
   p[0]=="events"&&p[2] in listOf("entries","attempts")->{fields(b,"idempotencyKey","baseId");id(b.getValue("idempotencyKey"));id(b.getValue("baseId"))}
   p[0]=="events"&&p[2]=="prize"->{fields(b,"baseId");id(b.getValue("baseId"))}
   p[0]=="attempts"&&p[2]=="abandon"->fields(b)
   p[0]=="attempts"&&p[2]=="submit"->{fields(b,"orders");fields(b.getValue("orders"),"deploys").getValue("deploys").jsonArray.forEach{val d=fields(it,"troop","tx","ty","tMs");text(d.getValue("troop"));listOf("tx","ty","tMs").forEach{number(d.getValue(it))}}}
   else->error("Unsupported Divine request")
  }
 }
}

/** Saved validation constants come from admitted content, never the server event. */
@ConsistentCopyVisibility
data class DivineRules private constructor(val raw:JsonObject) {
 val policy=raw.dobj("policy");val grid=raw.dobj("grid");val structures=raw.dobj("structures");val raid=raw.dobj("raidRules");val replay=raw.dobj("replayLimits")
 fun bound(name:String)=policy.dn(name).toInt()
 val items=policy.getValue("prizeItems").jsonArray.map(DivineGrammar::text)
 private fun count(x:JsonElement,max:Int)=DivineGrammar.count(x,max.toLong())
 private fun amounts(x:JsonElement):JsonObject {val o=x.jsonObject;require(o.keys==items.toSet());o.values.forEach{DivineGrammar.amount(it)};return o}
 private fun one(o:JsonObject){require(o.dn("version")==1L)}
 fun encounter(x:JsonElement):JsonObject {
  val o=DivineGrammar.fields(x,"simVersion","seed","snapshot","army","levels","inputSha256");require(o["simVersion"]==policy["simVersion"]&&o["seed"]==policy["seed"]&&o["army"]==policy["army"]&&o["levels"]==policy["levels"])
  val s=DivineGrammar.fields(o.getValue("snapshot"),"keepLevel","surplusShards","claimMin","claimMax","buildings");require(s["keepLevel"]==raw["stageKeepLevel"]&&s.dn("surplusShards")==0L)
  val max=grid.dn("plotTiles");require(s.dn("claimMin") in 0..max&&s.dn("claimMax") in 1..max&&s.dn("claimMax")>s.dn("claimMin"))
  val b=s.drows("buildings");require(b.isNotEmpty()&&b.size<=bound("maxSnapshotBuildings")&&b.map{it.dt("id")}.distinct().size==b.size&&b.count{it.dt("type")=="keep"}==1)
  b.forEach{DivineGrammar.fields(it,"id","type","level","tx","ty");require(it.dt("id").isNotEmpty());require(it.dt("type") in structures.keys&&it.dn("level") in 1..s.dn("keepLevel")&&it.dn("tx") in 0 until max&&it.dn("ty") in 0 until max)}
  require(DivineGrammar.hash(o.getValue("inputSha256"))==DivineGrammar.sha(JsonObject(o-"inputSha256"))){"Frozen encounter hash differs"};return o
 }
 fun legal(encounter:JsonObject,x:Long,y:Long):Boolean {
  val s=encounter.dobj("snapshot");val margin=raid.dn("deployMarginTiles");val max=grid.dn("plotTiles")
  if(x< -margin||y< -margin||x>=max+margin||y>=max+margin||x>s.dn("claimMin")&&x<s.dn("claimMax")-1&&y>s.dn("claimMin")&&y<s.dn("claimMax")-1)return false
  return s.drows("buildings").none{b->val f=structures.dobj(b.dt("type")).getValue("footprint").jsonArray; x>=b.dn("tx")&&x<b.dn("tx")+DivineGrammar.number(f[0])&&y>=b.dn("ty")&&y<b.dn("ty")+DivineGrammar.number(f[1])}
 }
 fun orders(x:JsonElement,encounter:JsonObject?=null):JsonObject {
  val o=DivineGrammar.fields(x,"deploys");val d=o.drows("deploys");require(d.size==bound("maxDeploys"));val army=policy.dobj("army")
  d.forEach{DivineGrammar.fields(it,"troop","tx","ty","tMs");require(it.dt("troop") in army.keys&&it["tMs"]==policy["deployTimeMs"]);val tx=it.dn("tx");val ty=it.dn("ty");if(encounter!=null)require(legal(encounter,tx,ty)){"Deployment is outside the frozen legal field"}}
  army.forEach{(troop,n)->require(d.count{it.dt("troop")==troop}.toLong()==DivineGrammar.number(n))};return o
 }
 private fun result(x:JsonElement):JsonObject {
  val o=DivineGrammar.fields(x,"stars","destruction","events","inputSha256");count(o.getValue("stars"),bound("maxStars"));count(o.getValue("destruction"),bound("maxDestruction"));DivineGrammar.hash(o.getValue("inputSha256"))
  val events=o.drows("events");require(events.size<=bound("maxReplayEvents"));var last=0L
  events.forEach{e->val tick=e.dn("t");require(tick in last..(raid.dn("battleDurationSec")*10+replay.dn("postBattleDrainTicks")));last=tick
   val common=listOf("t","e");val names=when(e.dt("e")){
    "deploy"->listOf("id","troop","x","y");"pos"->listOf("id","x","y");"attackRun"->listOf("id","side","troop","targetKind","target","ix","iy","mode","technique","cycleMs","releaseOffsetMs","cycleTicks","releaseOffsetTicks","impactOffsetsTicks","cadenceTicks","count");"fire"->listOf("id","target","proj","ix","iy","releaseOffsetMs","flightMs","impactOffsetTicks");"hit"->listOf("target","dmg");"destroyed","troopDeath"->listOf("id");"star"->listOf("n");"trap"->listOf("id","victim","kind","victims")+if(e.containsKey("stunUntil"))listOf("stunUntil")else emptyList();else->error("Unsupported trial event")}
   DivineGrammar.fields(e,*(common+names).toTypedArray())
   e.forEach{(k,v)->if(k !in listOf("e","troop","side","targetKind","target","id","mode","technique","proj","kind","impactOffsetsTicks","victims")) {if(k in listOf("x","y","ix","iy"))DivineGrammar.number(v) else DivineGrammar.count(v)}}
   fun name(k:String){require(e.dt(k).isNotEmpty())};fun n(k:String){DivineGrammar.count(e.getValue(k))}
   when(e.dt("e")){
    "deploy"->{n("id");require(e.dt("troop") in policy.dobj("army").keys)}
    "pos","troopDeath"->n("id")
    "attackRun"->{n("id");name("target");require(e.dt("side")=="attacker"&&e.dt("targetKind")=="building"&&e.dt("troop") in policy.dobj("army").keys&&e.dt("mode") in listOf("melee","projectile")&&e.dt("technique") in listOf("strike","arrow"));require(e.dn("count") in 1..replay.dn("maxAttackRunCycles"));val a=e.getValue("impactOffsetsTicks").jsonArray;require(a.size<=replay.dn("maxAttackContactsPerCycle"));a.forEach{DivineGrammar.count(it)}}
    "fire"->{name("id");n("target");require(e.dt("proj") in listOf("cannonball","arrow"))}
    "hit"->{if(e.getValue("target").jsonPrimitive.isString)name("target")else n("target")}
    "destroyed"->name("id")
    "star"->require(e.dn("n") in 1..policy.dn("maxStars"))
    "trap"->{name("id");n("victim");require(e.dt("kind") in listOf("spiketrap","powdermine"));val a=e.getValue("victims").jsonArray;require(a.size<=bound("maxDeploys"));a.forEach{DivineGrammar.count(it)};e["stunUntil"]?.let{require(DivineGrammar.count(it)<=raid.dn("battleDurationSec")*10+replay.dn("postBattleDrainTicks"))}}
   }
  };return o
 }
 fun entry(x:JsonElement):JsonObject {val o=DivineGrammar.fields(x,"version","id","eventId","wallet","baseId","idempotencyKey","enteredAt","qualification");one(o);listOf("id","eventId","baseId","idempotencyKey").forEach{DivineGrammar.id(o.getValue(it))};DivineGrammar.wallet(o.getValue("wallet"));DivineGrammar.time(o.getValue("enteredAt"));val q=DivineGrammar.fields(o.getValue("qualification"),"sequence","day","renown","daysAttested","sourceSha256");val u=BigInteger.ONE.shiftLeft(64)-BigInteger.ONE;for(k in listOf("sequence","renown","daysAttested"))DivineGrammar.amount(q.getValue(k),u);require(DivineGrammar.amount(q.getValue("renown"),u)>=policy.dn("minRenown").toBigInteger()&&DivineGrammar.amount(q.getValue("daysAttested"),u)>=policy.dn("minDaysAttested").toBigInteger());DivineGrammar.count(q.getValue("day"));DivineGrammar.hash(q.getValue("sourceSha256"));return o}
 fun attempt(x:JsonElement):JsonObject {require(DivineGrammar.canonical(x).toByteArray().size<=bound("maxPayloadBytes"));val o=DivineGrammar.fields(x,"version","id","eventId","wallet","baseId","idempotencyKey","ordinal","status","admittedAt","encounter","orders","result","completedAt");one(o);listOf("id","eventId","baseId","idempotencyKey").forEach{DivineGrammar.id(o.getValue(it))};DivineGrammar.wallet(o.getValue("wallet"));require(o.dn("ordinal") in 1..policy.dn("attemptsPerWallet"));val at=DivineGrammar.time(o.getValue("admittedAt"));val e=encounter(o.getValue("encounter"));val status=o.dt("status");require(status in listOf("admitted","committed","completed","abandoned","expired"));val order=o.doptional("orders");val r=o.doptional("result");require((status in listOf("committed","completed"))==(order!=null)&&(status=="completed")== (r!=null)&&(status in listOf("completed","abandoned","expired"))==(o["completedAt"]!=JsonNull));order?.let{orders(it,e)};r?.let{result(it);require(it.dt("inputSha256")==DivineGrammar.sha(buildJsonObject{put("encounter",e);put("orders",order!!)}))};if(o["completedAt"]!=JsonNull)require(DivineGrammar.time(o.getValue("completedAt"))>=at);return o}
 fun claim(x:JsonElement):JsonObject {val o=DivineGrammar.fields(x,"eventId","wallet","baseId","amounts","claimedAt");listOf("eventId","baseId").forEach{DivineGrammar.id(o.getValue(it))};DivineGrammar.wallet(o.getValue("wallet"));amounts(o.getValue("amounts"));DivineGrammar.time(o.getValue("claimedAt"));return o}
 fun participant(x:JsonElement,wallet:String,event:String):JsonObject {val o=DivineGrammar.fields(x,"version","eventId","wallet","entry","attempts","prize");one(o);require(o.dt("wallet")==wallet&&o.dt("eventId")==event);o.doptional("entry")?.let{entry(it);require(it.dt("wallet")==wallet&&it.dt("eventId")==event)};val a=o.drows("attempts");require(a.size<=bound("attemptsPerWallet")&&(a.isEmpty()||o["entry"]!=JsonNull)&&a.map{it.dt("id")}.distinct().size==a.size&&a.map{it.dt("idempotencyKey")}.distinct().size==a.size&&a.count{it.dt("status") in listOf("admitted","committed")}<=bound("maxUnfinishedAttempts"));a.forEachIndexed{i,v->attempt(v);require(v.dt("wallet")==wallet&&v.dt("eventId")==event&&v.dn("ordinal")==i+1L)};o.doptional("prize")?.let{p->DivineGrammar.fields(p,"amounts","claim");amounts(p.getValue("amounts"));p.doptional("claim")?.let{claim(it);require(it.dt("wallet")==wallet&&it.dt("eventId")==event&&it["amounts"]==p["amounts"])}};return o}
 fun event(x:JsonElement):JsonObject {
  val o=DivineGrammar.fields(x,"version","id","domain","sponsorWallet","entryStartsAt","playStartsAt","playEndsAt","occupationEndsAt","policy","budget","encounter","terminal");one(o);DivineGrammar.id(o.getValue("id"));require(o["policy"]==policy);DivineGrammar.wallet(o.getValue("sponsorWallet"));val domain=DivineGrammar.fields(o.getValue("domain"),"genesisHash","economyProgram");domain.values.forEach{DivineGrammar.wallet(it)};encounter(o.getValue("encounter"));val budget=amounts(o.getValue("budget"));require(budget.values.any{DivineGrammar.amount(it)>BigInteger.ZERO});val start=DivineGrammar.time(o.getValue("entryStartsAt"));val utc=start.atOffset(ZoneOffset.UTC);require(utc.dayOfWeek.value%7==bound("entryWeekdayUtc")&&utc.toLocalTime()==java.time.LocalTime.MIDNIGHT)
  var date=start;for((key,days)in listOf("playStartsAt" to "entryDurationDays","playEndsAt" to "playDurationDays","occupationEndsAt" to "occupationDurationDays")){date=date.plusSeconds(policy.dn(days)*86400);require(DivineGrammar.time(o.getValue(key))==date)}
  o.doptional("terminal")?.let{terminal(it,o)};return o
 }
 private fun terminal(t:JsonObject,event:JsonObject){DivineGrammar.fields(t,"version","eventId","completedAt","rankings","occupations","entitlements");one(t);require(t["eventId"]==event["id"]&&DivineGrammar.time(t.getValue("completedAt"))>=DivineGrammar.time(event.getValue("playEndsAt")));val r=t.drows("rankings");require(r.size<=bound("divineSites")&&r.map{it.dt("wallet")}.distinct().size==r.size&&r.map{it.dt("attemptId")}.distinct().size==r.size);r.forEach{DivineGrammar.fields(it,"wallet","attemptId","ordinal","stars","destruction");DivineGrammar.wallet(it.getValue("wallet"));DivineGrammar.id(it.getValue("attemptId"));require(it.dn("ordinal") in 1..policy.dn("attemptsPerWallet")&&it.dn("stars") in policy.dn("minWinningStars")..policy.dn("maxStars"));count(it.getValue("destruction"),bound("maxDestruction"))};require(r==r.sortedWith(compareByDescending<JsonObject>{it.dn("stars")}.thenByDescending{it.dn("destruction")}.thenBy{it.dt("wallet")}));val occupations=JsonArray(r.mapIndexed{i,v->buildJsonObject{put("site","divine-individual-${(i+1).toString().padStart(3,'0')}");put("wallet",v.getValue("wallet"))}});require(t["occupations"]==occupations)
  val balances=sortedMapOf<String,MutableMap<String,BigInteger>>()
  fun balance(w:String)=balances.getOrPut(w){items.associateWith{BigInteger.ZERO}.toMutableMap()}
  val refund=balance(event.dt("sponsorWallet"));val budget=event.dobj("budget");for(item in items){var rest=DivineGrammar.amount(budget.getValue(item));if(r.isNotEmpty()){val share=rest/r.size.toBigInteger();r.forEach{val b=balance(it.dt("wallet"));b[item]=b.getValue(item)+share;rest-=share}};refund[item]=refund.getValue(item)+rest};val expected=JsonArray(balances.map{(w,b)->buildJsonObject{put("wallet",w);put("amounts",buildJsonObject{items.forEach{put(it,b.getValue(it).toString())}})}});require(t["entitlements"]==expected){"Funded prize conservation differs"}
 }
 fun discovery(x:JsonElement):JsonObject {val o=DivineGrammar.fields(x,"version","events","nextCursor");one(o);val e=o.drows("events");require(e.size<=bound("discoveryPageSize")&&e.map{it.dt("id")}.distinct().size==e.size);e.forEach(::event);if(o["nextCursor"]!=JsonNull)require(o.dt("nextCursor").matches(Regex("[A-Za-z0-9_-]{1,256}")));return o}
 companion object {
  fun from(value:JsonObject):DivineRules {val r=DivineGrammar.copy(value).jsonObject;DivineGrammar.fields(r,"policy","grid","structures","raidRules","replayLimits","stageKeepLevel");val p=r.dobj("policy");DivineGrammar.fields(p,"version","entryWeekdayUtc","entryDurationDays","playDurationDays","occupationDurationDays","divineSites","attemptsPerWallet","maxUnfinishedAttempts","minRenown","minDaysAttested","minWinningStars","maxStars","maxDestruction","campaignStage","simVersion","seed","army","levels","maxDeploys","deployTimeMs","observationMaxAgeMs","rpcTimeoutMs","maxSourceConcurrency","discoveryPageSize","localEventLimit","maxSnapshotBuildings","maxStringLength","maxObjectKeys","maxJsonDepth","maxJsonNodes","maxPayloadBytes","maxReplayEvents","prizeItems","fragments","prizeSource","tieBreak","heroes","energy");require(p.dn("version")==1L&&p.dt("fragments")=="held"&&p.dt("prizeSource")=="funded-existing-refined-stock"&&p.dt("tieBreak")=="wallet-ascii"&&p.dt("heroes")=="none"&&p.dt("energy")=="none");val numeric=(p.keys-setOf("army","levels","prizeItems","fragments","prizeSource","tieBreak","heroes","energy"));numeric.forEach{DivineGrammar.count(p.getValue(it),DivineGrammar.MAX_BYTES.toLong())};require(p.dn("maxPayloadBytes")<=DivineGrammar.MAX_BYTES&&p.dn("maxJsonDepth")<=16&&p.dn("maxStringLength")<=256&&p.dn("maxJsonNodes")<=1_000_000&&p.dn("maxReplayEvents")<=250_000&&p.dn("localEventLimit") in 1..128);require(p.dobj("army").keys==setOf("highlander","bowman")&&p.dobj("levels").keys==p.dobj("army").keys&&p.dobj("army").values.sumOf{DivineGrammar.count(it)}==p.dn("maxDeploys"));require(p.getValue("prizeItems").jsonArray.map(DivineGrammar::text).distinct().size==p.getValue("prizeItems").jsonArray.size);return DivineRules(r)}
  fun installed(policy:JsonObject,c:JsonObject)=from(buildJsonObject{
   put("policy",policy);put("grid",buildJsonObject{put("plotTiles",c.dobj("GRID").getValue("plotTiles"))})
   put("structures",buildJsonObject{JsonObject(c.dobj("STRUCTURES")+c.dobj("DEFENSES")).forEach{(k,v)->put(k,buildJsonObject{put("footprint",v.jsonObject.getValue("footprint"))})}})
   put("raidRules",buildJsonObject{for(k in listOf("deployMarginTiles","battleDurationSec"))put(k,c.dobj("RAID_RULES").getValue(k))})
   put("replayLimits",buildJsonObject{for(k in listOf("postBattleDrainTicks","maxAttackRunCycles","maxAttackContactsPerCycle"))put(k,c.dobj("RAID_REPLAY_LIMITS").getValue(k))})
   put("stageKeepLevel",c.getValue("campaignKeepLevel"))
  })
  fun catalogue(catalogue:JsonObject?):DivineRules?=runCatching{val c=requireNotNull(catalogue).dobj("constants");val p=c.dobj("PHASE_E_DIVINE_TRIALS");val policy=JsonObject(p+mapOf("prizeItems" to JsonArray(listOf("frostglass","heartwood_beams","sunstone_blocks","crownsteel","prismstone_lens","stormalloy","thornsilk","embercore").map(::JsonPrimitive)),"fragments" to JsonPrimitive("held"),"prizeSource" to JsonPrimitive("funded-existing-refined-stock"),"tieBreak" to JsonPrimitive("wallet-ascii"),"heroes" to JsonPrimitive("none"),"energy" to JsonPrimitive("none")));installed(policy,JsonObject(c+("campaignKeepLevel" to c.dobj("CAMPAIGN").getValue("encounters").jsonArray[p.dn("campaignStage").toInt()-1].jsonObject.getValue("keepLevel"))))}.getOrNull()
 }
}
