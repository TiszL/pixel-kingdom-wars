package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.io.IOException
import java.net.InetAddress

/** Explicit opt-in local integration runner, never a silently skipped unit test.
 * Uses the real HTTPS GameApi and JVM truststore. Synthetic sessions stay in the
 * ignored local profile; report contains no cookies, keys, or wallet addresses.
 * A canonical camp plus the documented bounded army fixture must exist first. */
object CoordinatorHttpProof {
    private class Memory(var raw: String? = null) : SecretStore {
        override fun read() = raw
        override fun write(value: String) { raw = value }
        override fun clear() { raw = null }
    }
    @JvmStatic fun main(args: Array<String>) = runBlocking {
        require(args.size == 2) { "Expected ignored local profile and output report paths" }
        val profile = File(args[0]).canonicalFile
        val config = Json.parseToJsonElement(File(profile, "config.json").readText()).jsonObject
        val origin = requireNotNull(config.string("origin"))
        val url = origin.toHttpUrl()
        val address = InetAddress.getByName(url.host)
        require(url.isHttps && (address.isLoopbackAddress || address.isSiteLocalAddress)) { "Local synthetic API only" }
        val session = Json.parseToJsonElement(File(profile, "synthetic-sessions.json").readText()).jsonArray[1].jsonObject
        val wallet = requireNotNull(session.string("wallet"))
        val cookieStore = Memory(requireNotNull(session.string("cookie")) + "; Path=/; Secure; HttpOnly")
        var sim: Int? = null
        val api = GameApi(origin, SessionCookieJar(url, cookieStore), "isolated-coordinator-proof") { sim }
        val capabilities = api.get("/native/capabilities")
        sim = requireNotNull(capabilities.string("simVersion")).toInt()
        val base = api.get("/base")
        val baseId = requireNotNull(base.string("baseId"))
        val pendingStore = PendingBattleStore(Memory())
        var posts = 0
        var hideCreate = true
        var hideDeploy = true
        val bodies = mutableListOf<Pair<String, JsonObject>>()
        fun coordinator() = BattleCoordinator(wallet, baseId, requireNotNull(sim), pendingStore,
            { path, query -> api.get(path, query) }, { path, body ->
                posts++; bodies.add(path to body)
                val response = api.post(path, body)
                if (path.startsWith("/campaign/") && hideCreate) { hideCreate = false; throw IOException("Proof: accepted create response deliberately withheld") }
                if (path.endsWith("/commands") && body["command"]?.jsonObject?.string("kind") == "deploy" && hideDeploy) {
                    hideDeploy = false; throw IOException("Proof: accepted deployment response deliberately withheld")
                }
                response
            }, BattlePresentation(api, requireNotNull(sim))::observe)
        var observer: Job? = null
        withTimeout(90_000) {
            try {
                check(api.get("/raids/pending").objects("raids").none { it.string("attackerBaseId") == baseId }) { "Synthetic base has an existing march; recover it first" }
                val first = coordinator()
                check(runCatching { first.createCampaign(1) }.exceptionOrNull() is IOException)
                check(posts == 1 && pendingStore.get(wallet, baseId)?.create != null)
                var current = coordinator() // New lifecycle owner, restored solely from durable intent.
                current.retry(requireNotNull(pendingStore.get(wallet, baseId)?.create?.id))
                check(posts == 2 && bodies[0] == bodies[1]) { "Create retry changed its identity/body" }
                observer = launch { current.runForeground() }
                val staged = current.state.first { it.phase == BattlePhase.STAGING }
                check(staged.presentation?.string("transportProtocolVersion") == "2")
                val counts = staged.presentation!!.getValue("armySnapshot").jsonObject.getValue("counts").jsonObject
                val troop = counts.entries.first { it.value.jsonPrimitive.int > 0 }.key
                val available = current.state.value.available(troop)
                val snapshot = staged.presentation.getValue("snapshot").jsonObject
                val catalogue = Json.parseToJsonElement(File(requireNotNull(config.string("pack")), "catalogue.json").readText()).jsonObject
                val grid = catalogue.getValue("constants").jsonObject.getValue("GRID").jsonObject
                val minimum = snapshot.string("claimMin")?.toInt() ?: requireNotNull(grid.string("deployRingTiles")).toInt()
                val maximum = snapshot.string("claimMax")?.toInt() ?: minimum + requireNotNull(grid.string("claimTiles")).toInt()
                check(runCatching { current.deploy(troop, minimum - 1, (minimum + maximum) / 2) }.exceptionOrNull() is IOException)
                observer!!.cancelAndJoin(); observer = null
                val countBeforeRestore = posts
                current = coordinator()
                observer = launch { current.runForeground() }
                current.state.first { it.presentation != null && it.pending!!.writes.isEmpty() }
                check(posts == countBeforeRestore && current.state.value.available(troop) == available - 1)
                // Canonical command acknowledgement can arrive while its HTTP response is withheld.
                current.start()
                current.state.first { it.clock?.value?.anchorWallAt != null }
                current.speed(2)
                check(current.state.value.clock?.value?.rate == 2)
                current.retreat()
                current.state.first { it.result != null }
                val finalResult = current.state.value.result
                observer!!.cancelAndJoin(); observer = null
                // A fresh owner must recover the persisted server result by GET before Home.
                current = coordinator()
                observer = launch { current.runForeground() }
                val restored = current.state.first { it.result != null }
                // Canonical participant replay adds explicit loot visibility metadata.
                check(restored.result?.get("lootRedacted") == JsonPrimitive(false))
                check(requireNotNull(finalResult).all { (key, value) -> restored.result?.get(key) == value })
                observer!!.join(); observer = null
                current.home()
                check(pendingStore.get(wallet, baseId) == null)
                val refreshed = api.get("/base", mapOf("baseId" to baseId))
                check(refreshed.string("baseId") == baseId)
                val report = buildJsonObject {
                    put("schemaVersion", 1); put("environment", "isolated HTTPS synthetic account")
                    put("simVersion", requireNotNull(sim)); put("transportProtocolVersion", 2); put("posts", posts)
                    put("createLostResponseSameIdentity", true); put("deploymentReadOnlyRecovery", true)
                    put("canonicalStartSpeedRetreat", true); put("serverResultRecoveredAfterRecreation", true)
                    put("recoveryPointerClearedOnlyAfterResult", true); put("baseRefreshed", true)
                    put("paidTrainingVerified", false); put("winningJourneyVerified", false)
                    put("scope", "Combat fixture army; no fresh-account progression, APK/device, wallet, thermal or production claim")
                }
                File(args[1]).writeText(report.toString())
                println(report)
            } finally { observer?.cancelAndJoin() }
        }
    }.also { kotlin.system.exitProcess(0) } // End OkHttp's idle pool after this explicit CLI proof.
}
