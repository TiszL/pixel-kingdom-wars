package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.ops.*

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.math.BigInteger
import java.time.Instant
import java.util.UUID

/** Opt-in paid progression proof against the isolated synthetic API. No database,
 * fixture army, clock acceleration, wallet transaction or production access. */
object PaidCampaignHttpProof {
    private class LocalStore(private val file: File) : SecretStore {
        override fun read() = file.takeIf { it.exists() }?.readText()
        override fun write(value: String) { val temp = File(file.path + ".tmp"); temp.writeText(value); check(temp.renameTo(file)) }
        override fun clear() { check(!file.exists() || file.delete()) }
    }
    private class Memory(private var raw: String?) : SecretStore {
        override fun read() = raw
        override fun write(value: String) { raw = value }
        override fun clear() { raw = null }
    }
    @JvmStatic fun main(args: Array<String>) {
        val outcome = runCatching { runBlocking { proof(args) } }
        outcome.exceptionOrNull()?.printStackTrace()
        kotlin.system.exitProcess(if (outcome.isSuccess) 0 else 1)
    }
    private suspend fun proof(args: Array<String>) = coroutineScope {
        require(args.size == 2 || (args.size == 3 && args[2] in setOf("--resume-paid-checkpoint", "--retry-campaign", "--recover-result")))
        val profile = File(args[0]); val reportFile = File(args[1]).absoluteFile; requireNotNull(reportFile.parentFile).mkdirs()
        val recoverResult = args.getOrNull(2) == "--recover-result"
        val retryCampaign = args.getOrNull(2) == "--retry-campaign"
        val prior = if (args.size == 3) Json.parseToJsonElement(reportFile.readText()).jsonObject else null
        prior?.let { check((if (retryCampaign || recoverResult) it.string("status") == "campaign running with paid troops" else it.string("status")?.startsWith("paid training ") == true) && it.flag("startingRosterEmpty") && !it.flag("fixtureArmyUsed")) }
        val config = Json.parseToJsonElement(File(profile, "config.json").readText()).jsonObject
        val origin = requireNotNull(config.string("origin")); val url = origin.toHttpUrl()
        val ip = InetAddress.getByName(url.host)
        require(url.isHttps && (ip.isLoopbackAddress || ip.isSiteLocalAddress)) { "Isolated local API required" }
        val session = Json.parseToJsonElement(File(profile, "synthetic-sessions.json").readText()).jsonArray[0].jsonObject
        val wallet = requireNotNull(session.string("wallet"))
        val jar = SessionCookieJar(url, Memory(requireNotNull(session.string("cookie")) + "; Path=/; Secure; HttpOnly"))
        var sim: Int? = null
        val api = GameApi(origin, jar, "paid-campaign-local-proof") { sim }
        suspend fun read(path: String, query: Map<String, String> = emptyMap()): JsonObject {
            repeat(3) { attempt ->
                try { return api.get(path, query) }
                catch (error: IOException) { if (error is ApiException || attempt == 2) throw error; delay(1_000) }
            }
            error("unreachable")
        }
        sim = requireNotNull(read("/native/capabilities").string("simVersion")).toInt()
        val catalogue = Json.parseToJsonElement(File(requireNotNull(config.string("pack")), "catalogue.json").readText()).jsonObject
        val constants = catalogue.getValue("constants").jsonObject
        var base = read("/base"); val baseId = requireNotNull(base.string("baseId")); val query = mapOf("baseId" to baseId)
        suspend fun shards() = BigInteger(requireNotNull(read("/balances", query).string("shards")))
        val armyInitial = read("/army", query)
        if (prior == null || retryCampaign) check(armyInitial.getValue("counts").jsonObject.values.all { it.jsonPrimitive.int == 0 } && armyInitial.objects("queue").isEmpty()) { "Proof requires a clean, unseeded roster" }
        val firstStage = read("/campaign", query).objects("stages").first { it.string("stage") == "1" }
        check(if (recoverResult) firstStage.string("bestStars") == "3" && firstStage.flag("firstThreeStarClaimed")
            else (if (retryCampaign) firstStage.string("bestStars") == "2" else firstStage.string("bestStars") == "0") && !firstStage.flag("firstThreeStarClaimed"))
        val startingShards = if (prior == null) shards() else null
        val buildReceipts = prior?.objects("constructionReceipts")?.toMutableList() ?: mutableListOf()
        val trainingReceipts = prior?.objects("trainingReceipts")?.toMutableList() ?: mutableListOf()
        var trainingCost = trainingReceipts.fold(BigInteger.ZERO) { sum, receipt -> sum + BigInteger(requireNotNull(receipt.string("costShards"))) }
        val previousAttempts = prior?.objects("previousAttempts")?.toMutableList() ?: mutableListOf()
        val recovery = PendingBattleStore(LocalStore(File(reportFile.parentFile, "battle-intent.json")))
        if (recoverResult) {
            val battle = BattleCoordinator(wallet, baseId, requireNotNull(sim), recovery, api)
            val observing = launch { battle.runForeground() }
            try {
                val result = requireNotNull(withTimeout(30_000) { battle.state.first { it.result != null } }.result)
                check(result.string("stars") == "3" && result.flag("keepDestroyed"))
                val balance = shards(); val reward = BigInteger(requireNotNull(result.string("lootShards")))
                val firstPaid = Json.parseToJsonElement(File(reportFile.parentFile, "paid-stage.json").readText()).jsonObject
                val firstCost = firstPaid.objects("trainingReceipts").fold(BigInteger.ZERO) { sum, row -> sum + BigInteger(requireNotNull(row.string("costShards"))) }
                val beforeBattle = BigInteger(requireNotNull(previousAttempts.last().string("balanceAfterShards"))) - (trainingCost - firstCost)
                check(reward > BigInteger.ZERO && balance - beforeBattle == reward)
                val repeated = runCatching { api.post("/raids/${requireNotNull(battle.state.value.pending?.raidId)}/finish", buildJsonObject {}) }
                check((repeated.exceptionOrNull() as? ApiException)?.let { it.status == 422 && it.message == "raid already resolved" } == true)
                check(shards() == balance)
                battle.home(); check(recovery.get(wallet, baseId) == null)
                check(read("/base", query).string("baseId") == baseId)
                reportFile.writeText(JsonObject(requireNotNull(prior) + buildJsonObject {
                    put("status", "passed"); put("paidTrainingVerified", true); put("winningJourneyVerified", true)
                    put("result", result); put("beforeWinningBattleShards", beforeBattle.toString()); put("endingShards", balance.toString())
                    put("trainingCostShards", trainingCost.toString()); put("rewardReplayNoDoubleCredit", true)
                    put("repeatFinishStatus", 422); put("homeClearedRecovery", true); put("canonicalBaseRefreshed", true)
                    put("continuedAfterReadInterruption", true); put("continuedAfterResolvedFinishRejection", true)
                    put("scope", "Actual paid HTTP purchases, server deadlines, winning campaign and persisted rewards; no Android UI/device/wallet/full-parity claim")
                }).toString())
                println("Paid journey: PASSED after canonical result recovery")
            } finally { observing.cancelAndJoin() }
            return@coroutineScope
        }
        if (retryCampaign) {
            val old = BattleCoordinator(wallet, baseId, requireNotNull(sim), recovery, api)
            val observing = launch { old.runForeground() }
            try {
                val result = requireNotNull(withTimeout(30_000) { old.state.first { it.result != null } }.result)
                check(result.string("stars") == "2" && result.string("lootShards") == "0")
                previousAttempts.add(buildJsonObject { put("result", result); put("balanceAfterShards", shards().toString()) })
                old.home()
            } finally { observing.cancelAndJoin() }
        }
        val startingAt = prior?.string("startedAt") ?: Instant.now().toString()
        fun checkpoint(phase: String) {
            reportFile.writeText(buildJsonObject {
                put("status", phase); put("startedAt", startingAt); put("environment", "isolated synthetic HTTPS")
                put("startingRosterEmpty", true); put("fixtureArmyUsed", false)
                put("constructionReceipts", JsonArray(buildReceipts)); put("trainingReceipts", JsonArray(trainingReceipts)); put("previousAttempts", JsonArray(previousAttempts))
            }.toString())
            println("Paid journey: $phase")
        }
        withTimeout(35 * 60_000L) {
            val troop = "highlander"
            val points = requireNotNull(constants.getValue("TROOPS").jsonObject.getValue(troop).jsonObject.string("pts")).toInt()
            val target = requireNotNull(firstStage.string("recommendedArmyPoints")).toInt() / points
            if (prior == null) {
            for ((type, x) in listOf("camp" to 10, "barracks" to 12)) {
                check(base.objects("buildings").none { it.string("type") == type }) { "Proof expects its own canonical construction" }
                val before = shards()
                val body = buildJsonObject { put("type", type); put("tx", x); put("ty", 10); put("baseId", baseId); put("idempotencyKey", UUID.randomUUID().toString()) }
                val receipt = api.post("/base/buildings", body)
                val id = requireNotNull(receipt["building"]?.jsonObject?.string("id"))
                val cost = BigInteger(requireNotNull(constants.getValue("BUILD_COSTS").jsonObject.getValue(type).jsonObject.string("costShards")))
                check(before - shards() == cost)
                checkpoint("building $type")
                do { delay(2_000); base = read("/base", query) }
                while (base.objects("buildings").single { it.string("id") == id }.flag("underConstruction"))
                buildReceipts.add(buildJsonObject { put("type", type); put("costShards", cost.toString()); put("completedByCanonicalBaseRead", true) })
                checkpoint("completed $type")
            }
            }
            if (prior == null || retryCampaign) {
            val pendingTraining = PendingIntentStore(LocalStore(File(reportFile.parentFile, "training-intent.json")))
            while (true) {
                val army = read("/army", query)
                val count = requireNotNull(army.getValue("counts").jsonObject.string(troop)).toInt()
                if (count == target) break
                check(count < target && army.objects("queue").isEmpty())
                val quote = api.post("/army/training/quote", buildJsonObject {
                    put("baseId", baseId); put("composition", buildJsonArray { add(buildJsonObject { put("troop", troop); put("count", target-count) }) })
                })
                check(quote.objects("queueable").isNotEmpty())
                val body = trainingConfirmation(quote, baseId, UUID.randomUUID().toString())
                val intent = PendingIntent(IntentKind.TRAINING_BATCH, wallet, baseId, requireNotNull(body.string("idempotencyKey")), TrainingBatchSpec.PATH, body, "Train army", quote)
                check(pendingTraining.create(intent))
                val before = shards(); val receipt = api.post("/army/training/batch", body)
                val cost = BigInteger(requireNotNull(receipt.string("costShards")))
                check(cost == BigInteger(requireNotNull(quote.string("costShards"))) && before - shards() == cost)
                // Explicit receipt replay must neither buy another batch nor debit again.
                val replay = api.post("/army/training/batch", requireNotNull(pendingTraining.get(IntentKind.TRAINING_BATCH, wallet)).body)
                check(replay.flag("replayed") && replay["queue"] == receipt["queue"] && shards() == before - cost)
                check(pendingTraining.clearIfMatching(intent)); trainingCost += cost
                trainingReceipts.add(buildJsonObject { put("costShards", cost.toString()); put("count", receipt.objects("queue").size); put("idempotentReplay", true) })
                checkpoint("paid training ${count + receipt.objects("queue").size}/$target queued")
                var ready: JsonObject
                do { delay(5_000); ready = read("/army", query) } while (ready.objects("queue").isNotEmpty())
                check(requireNotNull(ready.getValue("counts").jsonObject.string(troop)).toInt() == count + receipt.objects("queue").size)
                checkpoint("training completed by canonical army read")
            }
            } else {
                // Continue this runner's already-verified paid stage after a GET interruption.
                // Never synthesize receipts or run a new purchase on resume.
                check(buildReceipts.map { it.string("type") } == listOf("camp", "barracks"))
                check(prior.string("status") == "paid training $target/$target queued")
                check(trainingReceipts.sumOf { requireNotNull(it.string("count")).toInt() } == target)
                var ready: JsonObject
                do { ready = read("/army", query); if (ready.objects("queue").isNotEmpty()) delay(5_000) } while (ready.objects("queue").isNotEmpty())
                check(ready.getValue("counts").jsonObject.string(troop)?.toInt() == target)
                check(ready.getValue("counts").jsonObject.filterKeys { it != troop }.values.all { it.jsonPrimitive.int == 0 })
            }
            val beforeBattle = shards()
            val battle = BattleCoordinator(wallet, baseId, requireNotNull(sim), recovery, api)
            battle.createCampaign(1)
            checkpoint("campaign created")
            val observing = launch { battle.runForeground() }
            try {
                val staged = battle.state.first { it.phase == BattlePhase.STAGING }
                check(staged.available(troop) == target)
                val snapshot = requireNotNull(staged.presentation)["snapshot"]!!.jsonObject
                val grid = constants.getValue("GRID").jsonObject
                val minimum = snapshot.string("claimMin")?.toInt() ?: requireNotNull(grid.string("deployRingTiles")).toInt()
                val maximum = snapshot.string("claimMax")?.toInt() ?: minimum + requireNotNull(grid.string("claimTiles")).toInt()
                val cannon = snapshot.objects("buildings").firstOrNull { it.string("type") == "cannon" }
                val deployX = cannon?.string("tx")?.toInt() ?: (minimum + maximum) / 2
                repeat(target) { battle.deploy(troop, deployX, maximum - 1) }
                battle.start(); battle.speed(2)
                checkpoint("campaign running with paid troops")
                // Wait the authoritative simulation horizon before a single finish POST.
                // Read polling never settles rewards or submits another mutation.
                while (battle.state.value.result == null && battle.state.value.clock!!.playheadMs(System.nanoTime()) < battle.state.value.clock!!.value.durationMs) delay(1_000)
                if (battle.state.value.result == null) battle.finish()
                val result = requireNotNull(battle.state.first { it.result != null }.result)
                check(result.string("stars") == "3" && result.flag("keepDestroyed")) { "Paid roster did not complete a three-star win: $result" }
                val after = shards()
                val board = read("/campaign", query).objects("stages").first { it.string("stage") == "1" }
                check(board.string("bestStars") == "3" && board.flag("firstThreeStarClaimed"))
                val reward = BigInteger(requireNotNull(result.string("lootShards")))
                check(reward > BigInteger.ZERO && after - beforeBattle == reward)
                val raid = requireNotNull(battle.state.value.pending?.raidId)
                val replayFinish = runCatching { api.post("/raids/$raid/finish", buildJsonObject {}) }
                check((replayFinish.exceptionOrNull() as? ApiException)?.let { it.status == 422 && it.message == "raid already resolved" } == true && shards() == after) { "Resolved finish must not credit another reward" }
                battle.home(); check(recovery.get(wallet, baseId) == null)
                base = read("/base", query); check(base.string("baseId") == baseId)
                reportFile.writeText(buildJsonObject {
                    put("status", "passed"); put("environment", "isolated synthetic HTTPS"); put("simVersion", requireNotNull(sim))
                    put("startingRosterEmpty", true); put("fixtureArmyUsed", false); put("paidTrainingVerified", true)
                    put("winningJourneyVerified", true); put("stars", 3); put("trainingCostShards", trainingCost.toString())
                    put("startingShards", startingShards?.toString()?.let(::JsonPrimitive) ?: JsonNull); put("continuedAfterReadInterruption", prior != null); put("rewardShards", reward.toString()); put("endingShards", after.toString())
                    put("rewardReplayNoDoubleCredit", true); put("homeClearedRecovery", true); put("canonicalBaseRefreshed", true)
                    put("constructionReceipts", JsonArray(buildReceipts)); put("trainingReceipts", JsonArray(trainingReceipts)); put("previousAttempts", JsonArray(previousAttempts))
                    put("scope", "Real HTTPS JVM flows and server deadlines; no Android UI, wallet, physical device or complete-player-parity claim")
                }.toString())
                println("Paid journey: PASSED")
            } finally { observing.cancelAndJoin() }
        }
    }
}
