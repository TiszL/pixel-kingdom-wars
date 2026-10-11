package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.*
import gg.pixelkingdomwars.nativeclient.session.*
import gg.pixelkingdomwars.nativeclient.ui.PkwTheme
import gg.pixelkingdomwars.nativeclient.ui.battle.BattleViewModel
import gg.pixelkingdomwars.nativeclient.ui.battle.LiveBattleScreen
import gg.pixelkingdomwars.nativeclient.ui.nav.BackRegistry
import gg.pixelkingdomwars.nativeclient.ui.nav.LocalBackRegistry
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.net.UnknownHostException
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Real battle entry UI/repository/coordinator with an in-memory transport and journal. No account
 * credentials, sockets or gameplay requests. An absent acknowledgement is deliberately NOT treated
 * as proof that a pending row belongs to its saved key; only the acknowledged case rejoins by GET. */
internal object CampaignEntryHarness {
    const val MODE = "campaign-entry"
    private const val BASE = "22222222-2222-4222-8222-222222222222"
    private const val RAID = "11111111-1111-4111-8111-111111111111"
    private const val WALLET = "offline-campaign-entry-fixture"
    private class Memory : SecretStore {
        @Volatile private var value: String? = null
        override fun read() = value
        override fun write(value: String) { this.value = value }
        override fun clear() { value = null }
    }
    private class Content(override val state: StateFlow<ContentState>) : ContentRepository {
        override val mode = LaunchMode.OFFLINE_BATTLE
        override suspend fun initialize() {}
        override fun simVersion() = state.value.simVersion
        override suspend fun checkUpdates(api: ApiClient, force: Boolean) = error("Offline fixture cannot update")
        override suspend fun applyUpdate(canActivate: () -> Boolean) = error("Offline fixture cannot activate content")
        override suspend fun loadPreviewFixtures(): Pair<JsonObject, JsonObject?> = error("Not a preview repository")
    }
    private class Script(val scenario: String, val sim: Int, val page: JsonObject) : ApiClient {
        @Volatile var online = false
        @Volatile var created = false
        @Volatile var limitedAt = 0L
        @Volatile var recoveredAt = 0L
        val gets = AtomicInteger(); val posts = AtomicInteger(); val presentations = AtomicInteger()
        val unexpected = AtomicInteger()
        private fun dns(): Nothing = throw UnknownHostException("Unable to resolve host \"play.pixelkingdomwars.com\": No address associated with hostname")
        fun raid() = buildJsonObject {
            put("id", RAID); put("attackerBaseId", BASE); put("campaignStage", 1)
            put("simVersion", sim); put("raidProtocolVersion", 2)
        }
        override suspend fun get(path: String, query: Map<String, String>): JsonObject {
            gets.incrementAndGet()
            if (!online && (scenario == "preflight" || created)) dns()
            return when (path) {
                "/native/capabilities" -> buildJsonObject {
                    put("simVersion", sim); putJsonObject("presentation") { put("enabled", true) }
                }
                "/raids/pending" -> buildJsonObject { put("raids", JsonArray(if (created) listOf(raid()) else emptyList())) }
                "/raids/pending/$RAID" -> buildJsonObject { put("raid", raid()) }
                else -> { unexpected.incrementAndGet(); error("Unexpected scripted GET: $path") }
            }
        }
        override suspend fun post(path: String, body: JsonObject): JsonObject {
            check(path == "/campaign/1/raid" && body.string("attackerBaseId") == BASE)
            check(posts.incrementAndGet() == 1) { "Recovery repeated a mutation" }
            created = true
            if (scenario == "lost-ack") dns()
            return buildJsonObject { put("raid", raid()) }
        }
        fun observe(id: String): Flow<JsonObject> = flow {
            check(id == RAID); presentations.incrementAndGet()
            if (scenario == "rate-limited" && limitedAt == 0L) {
                limitedAt = SystemClock.elapsedRealtime()
                throw ApiException(429, "RATE_LIMITED", "Too many requests. Please try again in 14 seconds.", retryAfterSeconds = 14)
            }
            if (!online) dns()
            recoveredAt = SystemClock.elapsedRealtime()
            emit(JsonObject(page + ("_clientFirstPageReceivedAtNanos" to JsonPrimitive(System.nanoTime()))))
            awaitCancellation()
        }
        override suspend fun put(path: String, body: JsonObject): JsonObject = error("No PUT allowed")
        override suspend fun delete(path: String): JsonObject = error("No DELETE allowed")
    }
    fun verify(i: Instrumentation): String {
        check(BuildConfig.DEBUG && BuildConfig.APPLICATION_ID == "gg.pixelkingdomwars.twa.debug" &&
            Build.HARDWARE == "ranchu" && BuildConfig.API_ORIGIN == "https://127.0.0.1:18443")
        val context = i.targetContext
        val root = File(context.noBackupFilesDir, "campaign-entry/${System.currentTimeMillis()}")
        check(root.mkdirs())
        val checks = mutableListOf<String>(); val captures = mutableListOf<JsonObject>()
        val scenarios = mutableListOf<JsonObject>(); var status = "running"; var failure: String? = null
        fun receipt() = File(root, "receipt.json").writeText(buildJsonObject {
            put("status", status); put("failure", failure?.let(::JsonPrimitive) ?: JsonNull)
            put("actualBattleScreen", true); put("scriptedTransport", true); put("networkRequests", 0)
            put("accountAccessRequested", false); put("physicalSeekerAcceptance", false)
            put("checks", JsonArray(checks.map(::JsonPrimitive))); put("captures", JsonArray(captures))
            put("scenarios", JsonArray(scenarios))
        }.toString())
        fun waitFor(label: String, timeout: Long = 45_000, condition: () -> Boolean) {
            val end = SystemClock.uptimeMillis() + timeout
            while (SystemClock.uptimeMillis() < end) { if (condition()) return; Thread.sleep(75) }
            error("Timed out: $label")
        }
        fun nodes(node: AccessibilityNodeInfo?): List<AccessibilityNodeInfo> = if (node == null) emptyList() else
            listOf(node) + (0 until node.childCount).flatMap { nodes(node.getChild(it)) }
        // c-gap-army 2026-10-06: the battle opening's BACK TO BASE and TRY AGAIN are kit buttons now, which speak their
        // label as the node's content description (the kit ChunkyBox) instead of a Material text child. A visible label is
        // therefore the node's text OR its description; the click still lands on the same clickable node.
        fun label(node: AccessibilityNodeInfo): String? = (node.text ?: node.contentDescription)?.toString()
        fun labels(): List<String> {
            i.uiAutomation.clearCache()
            return nodes(i.uiAutomation.rootInActiveWindow).filter { it.isVisibleToUser }.mapNotNull(::label)
        }
        fun click(text: String) {
            waitFor("visible action $text") { labels().any { it.equals(text, ignoreCase = true) } }
            val node = nodes(i.uiAutomation.rootInActiveWindow).first { it.isVisibleToUser && label(it).equals(text, ignoreCase = true) }
            var target: AccessibilityNodeInfo? = node
            while (target != null && !target.isClickable) target = target.parent
            val action = requireNotNull(target)
            check(action.isEnabled && action.performAction(AccessibilityNodeInfo.ACTION_CLICK)) { "Action unavailable: $text" }
        }
        fun capture(name: String) {
            i.waitForIdleSync(); Thread.sleep(250)
            val text = labels(); File(root, "$name.labels.json").writeText(JsonArray(text.map(::JsonPrimitive)).toString())
            val output = File(root, "$name.png"); val bitmap = requireNotNull(i.uiAutomation.takeScreenshot())
            try { output.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) } } finally { bitmap.recycle() }
            captures += buildJsonObject {
                put("path", output.name); put("sha256", MessageDigest.getInstance("SHA-256").digest(output.readBytes()).joinToString("") { "%02x".format(it) })
                put("labels", JsonArray(text.map(::JsonPrimitive)))
            }; receipt()
        }
        try {
            val manifest = context.assets.open("native/manifest.json").use { it.readBytes() }
            val assets = BundledContent.prepare(context.noBackupFilesDir, manifest, debug = true,
                verifier = "campaign-entry-${BuildConfig.VERSION_CODE}") { context.assets.open("native/$it") }
            fun read(path: String) = Json.parseToJsonElement(File(assets, path).readText()).jsonObject
            val catalogue = read("catalogue.json"); val render = read("render-catalog.json")
            val sim = requireNotNull(catalogue.string("simVersion")).toInt()
            val fixture = read("fixtures/replay.json")
            val constants = catalogue.getValue("constants").jsonObject
            val duration = constants.getValue("RAID_RULES").jsonObject.getValue("battleDurationSec").jsonPrimitive.long * 1000
            val page = JsonObject(fixture + buildJsonObject {
                put("raidId", RAID); put("source", "live"); put("status", "pending_orders")
                put("revision", "offline-entry-recovery"); put("simVersion", sim); put("raidProtocolVersion", 2)
                put("lastSequence", 0); putJsonArray("commands") {}; putJsonArray("events") {}; put("result", JsonNull)
                put("visualContext", render.getValue("ground").jsonObject.getValue("currentVisual"))
                putJsonObject("clock") {
                    put("protocolVersion", 2); put("revision", 0); put("rate", 1); put("anchorWallAt", JsonNull)
                    put("anchorSimMs", 0); put("serverNow", "2026-09-19T00:00:00Z"); put("simNowMs", 0)
                    put("battleEndsAt", JsonNull); put("durationMs", duration)
                }
            })
            for (scenario in listOf("preflight", "lost-ack", "acknowledged", "rate-limited")) {
                val script = Script(scenario, sim, page)
                val origin = "https://127.0.0.1:18443"
                val holder = AccountSessionHolder(dispatcher = Dispatchers.Main.immediate)
                val jar = SessionCookieJar(origin.toHttpUrl(), Memory())
                val session = AccountSession(WALLET, origin, jar.sessionToken())
                holder.replace(session)
                val store = PendingBattleStore(Memory())
                val repository = LiveBattleRepository(session, holder, requireNotNull(holder.scopeOf(session)), script,
                    GameApi(origin, jar, "offline-campaign-entry"), store, { BASE }, { sim }, { true },
                    { if (!script.online) throw UnknownHostException("offline home") }, { error("No authentication request expected") },
                    coordinatorFactory = { base, version -> BattleCoordinator.withTransport(WALLET, base, version, store,
                        script::get, script::post, script::observe) })
                val content = Content(MutableStateFlow(ContentState(assets, catalogue, render)))
                val last = AtomicReference<LocalSceneSnapshot?>()
                val observer = object : LocalSceneDiagnostics {
                    override fun frameStarted() {}; override fun frameCompleted() {}
                    override fun state(snapshot: LocalSceneSnapshot) { last.set(snapshot) }
                }
                var host: MainActivity? = null
                try {
                    runBlocking { repository.campaignBattle(1) }
                    waitFor("$scenario failed entry") {
                        repository.state.value.coordinator?.state?.value?.let { !it.creating && (if (scenario in setOf("acknowledged", "rate-limited")) it.pending?.raidId == RAID else it.error != null) } == true
                    }
                    val coordinator = requireNotNull(repository.state.value.coordinator)
                    val saved = store.get(WALLET, BASE)
                    check(if (scenario == "preflight") saved == null else saved != null)
                    host = i.startActivitySync(Intent(context, MainActivity::class.java).putExtra("preview", "base")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
                    val model = BattleViewModel(repository, content)
                    val activity = requireNotNull(host)
                    i.runOnMainSync { activity.setContent { PkwTheme { Surface {
                        CompositionLocalProvider(LocalBackRegistry provides remember { BackRegistry() }, LocalSceneObserver provides observer) {
                            val domain by repository.state.collectAsState()
                            if (domain.battleVisible) LiveBattleScreen(model, coordinator, keepLevel = 1)
                            else Text("Returned to base (offline harness)")
                        }
                    } } } }
                    waitFor("$scenario actionable failure") { labels().any { it.equals("TRY AGAIN", true) } }
                    check(labels().none { it.contains("Unable to resolve") || it.contains("UnknownHost") || it == "Entering battle…" })
                    capture("$scenario-failed")
                    checks += "$scenario shows plain error and an actionable recovery without endless Entering battle"
                    if (scenario == "preflight") {
                        click("TRY AGAIN")
                        waitFor("preflight retry finishes") { !coordinator.state.value.creating && coordinator.state.value.error != null }
                        check(script.posts.get() == 0 && store.get(WALLET, BASE) == null)
                        click("BACK TO BASE")
                        waitFor("preflight back while offline") { !repository.state.value.battleVisible }
                        capture("preflight-back")
                        checks += "Preflight retry sends no POST when DNS fails; Back works with Home offline"
                    } else if (scenario == "lost-ack") {
                        script.online = true
                        val reads = script.gets.get(); click("TRY AGAIN")
                        waitFor("lost acknowledgement checked with GET") {
                            script.gets.get() > reads && coordinator.state.value.candidates.isNotEmpty() && coordinator.state.value.error == null
                        }
                        check(script.posts.get() == 1 && store.get(WALLET, BASE) == saved && coordinator.state.value.pending?.raidId == null)
                        waitFor("lost acknowledgement explains saved request") {
                            labels().any { it.contains("awaiting confirmation. Check its status") } && labels().none { it.contains("Can't connect") }
                        }
                        capture("lost-ack-checked")
                        click("BACK TO BASE"); waitFor("lost acknowledgement back") { !repository.state.value.battleVisible }
                        check(store.get(WALLET, BASE) == saved)
                        checks += "Lost acknowledgement CHECK STATUS is GET-only; unknown exact create stays saved on Back"
                    } else if (scenario == "rate-limited") {
                        check(script.limitedAt > 0 && script.presentations.get() == 1)
                        script.online = true
                        repeat(3) { click("TRY AGAIN") }
                        Thread.sleep(1_000)
                        check(script.presentations.get() == 1) { "Retry bypassed Retry-After" }
                        capture("rate-limited-retry-held")
                        waitFor("rate limited original battle rejoined", 90_000) {
                            last.get()?.kind == LocalSceneKind.BATTLE && coordinator.state.value.connected && labels().none { it == "Entering battle…" }
                        }
                        check(script.recoveredAt - script.limitedAt >= 14_000 && script.posts.get() == 1)
                        capture("rate-limited-rejoined")
                        checks += "Three Retry taps cannot bypass 14-second server read backoff; original raid rejoins with one POST"
                    } else {
                        check(saved?.raidId == RAID && saved.create == null && script.posts.get() == 1)
                        click("TRY AGAIN")
                        waitFor("acknowledged offline retry finishes") { coordinator.state.value.error != null }
                        check(script.posts.get() == 1 && store.get(WALLET, BASE)?.raidId == RAID)
                        click("BACK TO BASE")
                        waitFor("acknowledged entry back while offline") { !repository.state.value.battleVisible }
                        check(store.get(WALLET, BASE) == saved && script.posts.get() == 1)
                        capture("acknowledged-back")
                        runBlocking { repository.recoverBattle() }
                        waitFor("saved entry visible again") { repository.state.value.battleVisible && labels().any { it.equals("TRY AGAIN", true) } }
                        script.online = true; click("TRY AGAIN")
                        waitFor("acknowledged original battlefield rejoined", 90_000) {
                            last.get()?.kind == LocalSceneKind.BATTLE && coordinator.state.value.connected &&
                                labels().none { it == "Entering battle…" || it == "Couldn’t open the battlefield" }
                        }
                        check(script.posts.get() == 1 && coordinator.state.value.pending?.raidId == RAID)
                        capture("acknowledged-rejoined")
                        checks += "Acknowledged Back preserves the journal offline; GET recovery draws the same raid after connectivity restores, with exactly one original POST"
                    }
                    check(script.unexpected.get() == 0)
                    scenarios += buildJsonObject {
                        put("name", scenario); put("scriptedGets", script.gets.get()); put("scriptedPosts", script.posts.get())
                        put("presentationSubscriptions", script.presentations.get()); put("unexpectedCalls", script.unexpected.get())
                        put("savedRaidId", store.get(WALLET, BASE)?.raidId?.let(::JsonPrimitive) ?: JsonNull)
                        put("savedCreate", store.get(WALLET, BASE)?.create != null)
                        if (scenario == "rate-limited") put("observedRetryAfterMs", script.recoveredAt - script.limitedAt)
                    }; receipt()
                } finally {
                    host?.let { activity -> i.runOnMainSync { activity.finishAndRemoveTask() } }
                    holder.replace(null); i.waitForIdleSync()
                }
            }
            status = "passed"; receipt(); return root.absolutePath
        } catch (error: Throwable) {
            status = "failed"; failure = error.stackTraceToString(); receipt(); throw error
        }
    }
}
