package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.ops.*

import java.io.File
import java.io.IOException
import java.math.BigInteger
import java.net.InetAddress
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Opt-in, actual HTTPS purchases on synthetic account two. Never loaded as a
 * JUnit test. Research/build state changes only through canonical HTTPS. This
 * account has an earlier, unused army fixture; it is not a pristine account.
 * No fixture funds, accelerated deadlines or POST retries are used here. */
object ResearchHttpProof {
    private class Memory(private var raw: String?=null):SecretStore {
        override fun read()=raw
        override fun write(value:String){raw=value}
        override fun clear(){raw=null}
    }
    @JvmStatic fun main(args:Array<String>) {
        val result=runCatching { runBlocking { withTimeout(40*60_000L) { proof(args) } } }
        result.exceptionOrNull()?.let { System.err.println("Research proof stopped: ${it.javaClass.simpleName}: ${it.message}") }
        kotlin.system.exitProcess(if(result.isSuccess) 0 else 1)
    }
    private suspend fun proof(args:Array<String>) {
        require(args.size in 2..3)
        val profile=File(args[0]);val report=File(args[1]).absoluteFile
        require(!report.exists()) { "Keep the existing receipt; a new proof requires a distinct output path" }
        // This continuation admits only a previously verified construction debit.
        // A pending POST or research episode needs operation-specific reconciliation.
        val resume=args.getOrNull(2)?.let { Json.parseToJsonElement(File(it).readText()).jsonObject }
        resume?.let {
            require(it.string("status")=="waiting for Forge upgrade canonical deadline" && it["pendingBody"]==null)
            require(it.string("syntheticAccountIndex")=="1" && it.objects("events").lastOrNull()?.string("action")=="Forge upgrade")
        }
        requireNotNull(report.parentFile).mkdirs()
        val config=Json.parseToJsonElement(File(profile,"config.json").readText()).jsonObject
        val origin=requireNotNull(config.string("origin"));val url=origin.toHttpUrl()
        val db=java.net.URI(requireNotNull(config.string("databaseUrl")))
        require(url.isHttps && url.port==18443 && InetAddress.getByName(url.host).let { it.isLoopbackAddress||it.isSiteLocalAddress }
            && db.host=="127.0.0.1" && db.port==55473 && db.path=="/pkw_native_local")
        val session=Json.parseToJsonElement(File(profile,"synthetic-sessions.json").readText()).jsonArray[1].jsonObject
        val jar=SessionCookieJar(url,Memory(requireNotNull(session.string("cookie"))+"; Path=/; Secure; HttpOnly"))
        var sim:Int?=null;val api=GameApi(origin,jar,"research-local-proof") {sim}
        suspend fun read(path:String,query:Map<String,String> = emptyMap()):JsonObject {
            repeat(12) { attempt ->
                try {return api.get(path,query)}
                catch(e:IOException) {
                    if(attempt==11 || (e is ApiException && e.status !in setOf(502,503,504))) throw e
                    delay(5_000)
                }
            };error("unreachable")
        }
        sim=requireNotNull(read("/native/capabilities").string("simVersion")).toInt()
        check(read("/me").string("wallet")==session.string("wallet"))
        fun catalogue()=Json.parseToJsonElement(File(requireNotNull(config.string("pack")),"catalogue.json").readText()).jsonObject
        val catalog=catalogue()
        var base=read("/base");val baseId=requireNotNull(base.string("baseId"));val query=mapOf("baseId" to baseId)
        val events=resume?.objects("events")?.toMutableList() ?: mutableListOf()
        fun checkpoint(phase:String,extra:JsonObject=buildJsonObject {}) {
            val value=buildJsonObject {put("status",phase);put("baseId",baseId);put("syntheticAccountIndex",1);put("fixtureResearchStateUsed",false);put("priorUnusedArmyFixture",true);put("stateMutationPath","canonical HTTPS research and construction");put("events",JsonArray(events));resume?.let {put("continuedFrom",File(args[2]).absolutePath);put("interruption","Local backend restart returned HTTP 502 during GET; prior construction POSTs were not repeated")};extra.forEach { (k,v)->put(k,v) }}
            val temp=File(report.path+".tmp");temp.writeText(value.toString());check(temp.renameTo(report))
            println("Research proof: $phase")
        }
        suspend fun balance()=read("/balances",query)
        suspend fun shards()=BigInteger(requireNotNull(balance().string("shards")))
        suspend fun waitForJobs() {
            do {base=read("/base",query);if(base.objects("jobs").isNotEmpty()) delay(5_000)} while(base.objects("jobs").isNotEmpty())
        }
        suspend fun purchase(path:String,fields:JsonObject,price:BaseOrderPrice,label:String) {
            check(price.currency=="SHARDS") { "Proof never authorizes SOL/KEEP construction" }
            val before=shards();val body=JsonObject(fields+buildJsonObject {put("baseId",baseId);put("idempotencyKey",UUID.randomUUID().toString())})
            checkpoint("sending $label",buildJsonObject {put("pendingPath",path);put("pendingBody",body)})
            api.post(path,body)
            val after=shards();check(before-after==BigInteger(price.amount))
            events.add(buildJsonObject {put("action",label);put("costShards",price.amount);put("durationSec",price.seconds);put("balanceAfter",after.toString())})
            checkpoint("waiting for $label canonical deadline")
            waitForJobs();checkpoint("completed $label")
        }
        check(read("/army",query).objects("research").isEmpty())
        resume?.let {
            check(it.string("baseId")==baseId)
            check(shards()==BigInteger(requireNotNull(events.last().string("balanceAfter"))))
            val forge=base.objects("buildings").single {building->building.string("type")=="forge"}
            check(base.objects("jobs").all { job->job.string("kind")=="upgrade" && job.string("buildingId")==forge.string("id") })
            checkpoint("resuming canonical Forge deadline without another purchase")
            waitForJobs()
            val currentLevel=requireNotNull(read("/army",query)["levels"]?.jsonObject?.string("highlander")).toInt()
            check(base.objects("buildings").single {building->building.string("type")=="forge"}.string("level")!!.toInt()>=currentLevel+1) {
                "Original Forge upgrade did not complete; refuse another construction purchase"
            }
        }
        checkpoint("preparing canonical prerequisites")
        check(base.objects("jobs").isEmpty()) { "Another construction owns this synthetic base" }
        val requiredKeep=requireNotNull(catalog["constants"]?.jsonObject?.get("BUILD_COSTS")?.jsonObject?.get("forge")?.jsonObject?.string("requiresKeepLevel")).toInt()
        while(requireNotNull(base["player"]?.jsonObject?.string("keepLevel")).toInt()<requiredKeep) {
            val keep=base.objects("buildings").single {it.string("type")=="keep"}
            purchase("/base/buildings/${keep.string("id")}/upgrade",buildJsonObject {},requireNotNull(buildingUpgradePrice(catalog,keep)),"Keep upgrade")
        }
        if(base.objects("buildings").none {it.string("type")=="forge"}) purchase("/base/buildings",buildJsonObject {put("type","forge");put("tx",8);put("ty",12)},requireNotNull(buildingPrice(catalog,base,"forge")),"Forge construction")
        val troop="highlander"
        val level=requireNotNull(read("/army",query)["levels"]?.jsonObject?.string(troop)).toInt()
        while(base.objects("buildings").single {it.string("type")=="forge"}.string("level")!!.toInt()<level+1) {
            val forge=base.objects("buildings").single {it.string("type")=="forge"}
            purchase("/base/buildings/${forge.string("id")}/upgrade",buildJsonObject {},requireNotNull(buildingUpgradePrice(catalog,forge)),"Forge upgrade")
        }
        var army=read("/army",query)
        check(researchConsentSupported(army)) { "Canonical prerequisites ready; restart guarded local backend before research" }
        // Use current profile after root updates the content pack while timers run.
        val currentConfig=Json.parseToJsonElement(File(profile,"config.json").readText()).jsonObject
        val currentCatalog=Json.parseToJsonElement(File(requireNotNull(currentConfig.string("pack")),"catalogue.json").readText()).jsonObject
        val choice=researchChoices(currentCatalog,base,army,balance()).single {it.troop==troop}
        check(choice.reason==null)
        val original=shards()
        fun target(kind:String,row:JsonObject?=null)=buildJsonObject {
            put("action",kind);put("troop",troop);put("level",level);put("toLevel",level+1);put("price",requireNotNull(choice.cost).toString());put("baseId",baseId)
            row?.let {put("finishesAt",requireNotNull(it.string("finishesAt")));put("episodeId",requireNotNull(it["episodeId"]))}
        }
        fun body(target:JsonObject)=buildJsonObject {put("baseId",baseId);put("troop",troop);put("idempotencyKey",UUID.randomUUID().toString());put("consent",researchConsent(target))}
        suspend fun rejected(path:String,payload:JsonObject,code:String) {
            val before=balance();val beforeArmy=read("/army",query)
            val error=runCatching {api.post(path,payload)}.exceptionOrNull() as? ApiException
            check(error?.status==409 && error.code==code)
            check(balance()==before && read("/army",query)==beforeArmy)
            events.add(buildJsonObject {put("rejectedCode",code);put("noStateChange",true)})
        }
        val start=target("start");val startBody=body(start)
        checkpoint("sending paid research",buildJsonObject {put("pendingBody",startBody)})
        var posts=0
        val researchOp=MoneyOp(ResearchSpec,PendingIntentStore(Memory()),object:OpTransport {
            override suspend fun get(path:String,query:Map<String,String>)=read(path,query)
            override suspend fun post(path:String,body:JsonObject):JsonObject { posts++;api.post(path,body);throw IOException("synthetic lost reply after acceptance") }
        })
        val researchIntent=PendingIntent(IntentKind.RESEARCH,requireNotNull(session.string("wallet")),baseId,requireNotNull(startBody.string("idempotencyKey")),"/army/research",startBody,"Research $troop",start)
        try { researchOp.submit(researchIntent) {} } catch(_:IOException) { }
        check(researchOp.observe(requireNotNull(session.string("wallet"))) {} is Receipt.Accepted)
        check(posts==1 && original-shards()==choice.cost)
        army=read("/army",query);val first=army.objects("research").single();check(first["episodeId"]!=JsonNull)
        checkpoint("paid start recovered from lost reply")
        val cancel=target("cancel",first)
        val wrong=JsonObject(body(cancel)+mapOf("consent" to JsonObject(researchConsent(cancel)+mapOf("episodeId" to JsonPrimitive(UUID.randomUUID().toString())))))
        rejected("/army/research/$troop/cancel",wrong,"RESEARCH_CONSENT_STALE")
        api.post("/army/research/$troop/cancel",body(cancel));check(shards()==original)
        check(read("/army",query).objects("research").isEmpty())
        val secondBody=body(start);checkpoint("sending second episode",buildJsonObject {put("pendingBody",secondBody)})
        api.post("/army/research",secondBody)
        val second=read("/army",query).objects("research").single();check(second["episodeId"]!=first["episodeId"])
        rejected("/army/research/$troop/cancel",body(cancel),"RESEARCH_CONSENT_STALE")
        rejected("/army/research/speedup",body(target("finish",first)),"RESEARCH_CONSENT_STALE")
        api.post("/army/research/$troop/cancel",body(target("cancel",second)))
        check(shards()==original && read("/army",query).objects("research").isEmpty())
        checkpoint("passed",buildJsonObject {put("paidStartVerified",true);put("lostReplySinglePostVerified",true);put("cancelRefundVerified",true);put("staleEpisodeNoCharge",true);put("researchCostShards",choice.cost.toString());put("endingShards",original.toString());put("paidKeepSpeedupVerified",false);put("physicalAcceptance",false)})
    }
}
