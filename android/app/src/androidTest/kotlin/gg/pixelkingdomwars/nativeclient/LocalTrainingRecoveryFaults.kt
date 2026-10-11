package gg.pixelkingdomwars.nativeclient

import android.content.Context
import android.os.Build
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.math.BigInteger
import java.util.UUID

/** Test APK only. These are labeled fault simulations, not process-kill or network-loss
 * observations. The normal app must subsequently recover/close through its real UI. */
internal object LocalTrainingRecoveryFaults {
    suspend fun prepare(context: Context, api: GameApi, session: JsonObject, input: File) {
        try {
            check(BuildConfig.DEBUG && Build.HARDWARE == "ranchu")
            val origin=BuildConfig.API_ORIGIN.toHttpUrl()
            val labels=origin.host.split('.')
            val octets=labels.mapNotNull(String::toIntOrNull)
            val privateHost=origin.host in setOf("localhost","127.0.0.1") ||
                (labels.size==4 && octets.size==4 && octets.all { it in 0..255 } && (octets[0]==10 ||
                    (octets[0]==172 && octets[1] in 16..31) || (octets[0]==192 && octets[1]==168)))
            check(origin.isHttps && origin.port==18443 && privateHost)
            val fixture=Json.parseToJsonElement(input.readText()).jsonObject
            val mode=fixture.string("mode")
            check(mode in setOf("accepted-response-not-applied","intent-never-sent"))
            check(fixture.string("origin")==BuildConfig.API_ORIGIN)
            check(session.string("name") in setOf("starter-one","starter-two"))
            check(fixture.string("name")==session.string("name"))
            val wallet=requireNotNull(session.string("wallet"))
            check(fixture.string("wallet")==wallet && api.get("/me").string("wallet")==wallet)
            val baseId=requireNotNull(fixture.string("baseId"))
            UUID.fromString(baseId)
            val query=mapOf("baseId" to baseId)
            check(api.get("/base",query).string("baseId")==baseId)
            val store=PendingIntentStore(EncryptedStore(context,storageNamespace(BuildConfig.API_ORIGIN,"pending-intents")))
            check(store.get(IntentKind.TRAINING_BATCH,wallet)==null) { "An existing training intent must be recovered first" }
            val proof=File(context.noBackupFilesDir,"local-training-fault-receipt.json")
            check(!proof.exists()) { "Preserve and remove the previous test receipt before a new fixture" }
            val troop=requireNotNull(fixture.string("troop"))
            // One troop is the explicit fixture request, not a mirrored game cap or price.
            check(fixture["count"]==JsonPrimitive(1))
            val composition=buildJsonArray { add(buildJsonObject { put("troop",troop); put("count",1) }) }
            val army=api.get("/army",query)
            val scheduling=trainingScheduling(army)
            check(scheduling!=TrainingScheduling.UNSUPPORTED) { "Unsupported training schedule" }
            val quote=api.post("/army/training/quote",buildJsonObject { put("baseId",baseId); put("composition",composition) })
            check(quote["queueable"]==composition)
            val body=trainingConfirmation(quote,baseId,UUID.randomUUID().toString(),scheduling)
            val cost=BigInteger(requireNotNull(body.string("confirmedCostShards")))
            check(cost>BigInteger.ZERO)
            val before=BigInteger(requireNotNull(api.get("/balances",query).string("shards")))
            check(before>=cost)
            // Prove the reviewed recovery route is active before any paid action.
            val initial=api.get(TrainingBatchSpec.RECEIPT,mapOf("idempotencyKey" to requireNotNull(body.string("idempotencyKey"))))
            check(initial["version"]==JsonPrimitive(1) && initial["idempotencyKey"]==body["idempotencyKey"] && initial.string("status")=="unknown")
            val intent=PendingIntent(IntentKind.TRAINING_BATCH,wallet,baseId,requireNotNull(body.string("idempotencyKey")),TrainingBatchSpec.PATH,body,"Train army",quote)
            check(store.create(intent))
            check(store.get(IntentKind.TRAINING_BATCH,wallet)?.let { it.body==body && it.quote==quote }==true)
            var sent=0
            fun record(status: String, after: BigInteger?=null) {
                val data=buildJsonObject {
                    put("localOnly",true); put("faultSimulation",mode); put("status",status)
                    put("paidBatchPostCount",sent); put("quotePostCount",1)
                    put("trainingScheduling",scheduling.name)
                    put("trainingSchedulingCapability",army["features"]?.jsonObject?.get("trainingScheduling") ?: JsonNull)
                    put("body",body); put("quote",quote); put("beforeShards",before.toString())
                    after?.let { put("afterShards",it.toString()) }
                    put("pendingIntentPreserved",store.get(IntentKind.TRAINING_BATCH,wallet)?.body==body)
                    put("walletApprovalTested",false)
                }
                val temp=File(proof.path+".tmp")
                temp.writeText(data.toString()); check(temp.renameTo(proof))
            }
            record("exact intent persisted before any paid POST")
            if(mode=="accepted-response-not-applied") {
                // The attempted flag is durable before the POST leaves, exactly as MoneyOp does it.
                check(store.replaceIfMatching(intent,intent.copy(attempted=true)))
                sent=1; record("one paid POST dispatched; outcome may be unknown")
                val result=api.post("/army/training/batch",body) // Exactly once; never retry here.
                check(result.string("costShards")==cost.toString() && !result.flag("replayed"))
            }
            val receipt=api.get(TrainingBatchSpec.RECEIPT,mapOf("idempotencyKey" to requireNotNull(body.string("idempotencyKey"))))
            check(receipt["version"]==JsonPrimitive(1) && receipt["idempotencyKey"]==body["idempotencyKey"])
            val after=BigInteger(requireNotNull(api.get("/balances",query).string("shards")))
            if(sent==1) {
                check(receipt.string("status")=="accepted" && receipt["baseId"]==body["baseId"])
                check(receipt["request"]?.jsonObject?.get("composition")==body["composition"])
                check(receipt["result"]?.jsonObject?.string("costShards")==cost.toString() && before-after==cost)
            } else check(receipt.string("status")=="unknown" && after==before)
            check(store.get(IntentKind.TRAINING_BATCH,wallet)?.body==body)
            record(if(sent==1) "accepted response deliberately not applied locally; UI recovery pending" else "never-sent intent is unknown; explicit UI close pending",after)
        } finally {
            check(!input.exists() || input.delete()) { "Local fault input cleanup failed" }
        }
    }
}
