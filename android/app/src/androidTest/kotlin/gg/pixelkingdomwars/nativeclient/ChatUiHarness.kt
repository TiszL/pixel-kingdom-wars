package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.os.Build
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.PkwTheme
import gg.pixelkingdomwars.nativeclient.ui.community.ChatScreen
import gg.pixelkingdomwars.nativeclient.ui.community.HostedChat
import gg.pixelkingdomwars.nativeclient.ui.community.hostedChatFrame
import gg.pixelkingdomwars.nativeclient.ui.nav.BackRegistry
import gg.pixelkingdomwars.nativeclient.ui.nav.LocalBackRegistry
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.time.Instant
import java.util.UUID

/** Interactive emulator host for the production global chat over a stand-in scene. The repository is the real
 * [LiveChatRepository]; its transport is an in-memory script, so typing, SEND, REPORT and BLOCK can be exercised
 * with the soft keyboard in both orientations without any account, network or production write. Chat limits come
 * from the bundled constants catalogue exactly as in the app. The host stays up until `chat-ui/stop` appears in
 * no_backup or the timeout passes, so the screen can be driven with adb. `chatFailSend=true` loses every reply to
 * SEND, which is the only way to see the saved-message recovery next to the keyboard. Player cards are scripted per
 * author (see [ChatScript.card]); `chatCards=limited|missing|slow` answers every card with the 429, with the route-less
 * 404 production gives until the route ships, or four seconds late. Synthetic test data only. */
internal object ChatUiHarness {
    const val MODE = "chat-ui"
    fun host(instrumentation: Instrumentation, lock: String?, arrivals: Boolean, seconds: Long, fullRoute: Boolean = false, failSend: Boolean = false, cards: String? = null): String {
        check(BuildConfig.DEBUG && Build.HARDWARE == "ranchu")
        require(lock == null || lock in setOf("USERNAME_REQUIRED", "DEED_REQUIRED", "MUTED"))
        require(cards == null || cards in setOf("limited", "missing", "slow"))
        val context = instrumentation.targetContext
        val root = File(context.noBackupFilesDir, "chat-ui"); check(root.mkdirs() || root.isDirectory)
        val stop = File(root, "stop"); stop.delete()
        val manifest = context.assets.open("native/manifest.json").use { it.readBytes() }
        val assets = BundledContent.prepare(context.noBackupFilesDir, manifest, debug = true,
            verifier = "chat-ui-${BuildConfig.VERSION_CODE}") { path -> context.assets.open("native/$path") }
        val catalogue = Json.parseToJsonElement(File(assets, "catalogue.json").readText()).jsonObject
        val bounds = requireNotNull(ChatBounds.from(catalogue)) { "Bundled catalogue has no CHAT bounds" }
        val origin = "https://localhost:18443"
        val wallet = "offline-chat-ui-fixture"
        val holder = AccountSessionHolder()
        val session = AccountSession(wallet, origin, SessionCookieJar(origin.toHttpUrl(), MemoryStore()).sessionToken())
        holder.replace(session)
        val script = ChatScript(bounds, lock, arrivals, failSend, cards)
        val repository = LiveChatRepository(session, holder, script, ChatOutbox(MemoryStore(), wallet, origin), { bounds })
        val host = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .putExtra("preview", "base").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
        check(host.intent.getStringExtra("preview") == "base")
        instrumentation.runOnMainSync {
            host.setContent {
                PkwTheme {
                    CompositionLocalProvider(LocalBackRegistry provides remember { BackRegistry() }) {
                        Surface { BoxWithConstraints(Modifier.fillMaxSize().background(Color(0xFF5E7D3A))) {
                            // Stand-in for the base scene and its HUD plates, so covered/visible area is obvious in captures.
                            Row(Modifier.windowInsetsPadding(WindowInsets.safeDrawing).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                for (plate in listOf("MENU", "SHARDS 3,518", "KEEP 4,900", "SOL 0.400"))
                                    Text(plate, Modifier.background(Palette.ink).padding(horizontal = 10.dp, vertical = 12.dp), color = Palette.gold)
                            }
                            // The production frame and screen, exactly as PkwApp hosts them over Home; `chatRoute` shows
                            // the full-screen ChatRoute variant (MORE tab / no dock) with its own page insets instead.
                            if (fullRoute) ChatScreen(repository, bounds, null, onProfile = {}, onBack = {}, onLand = {})
                            else HostedChat(hostedChatFrame(maxWidth, maxHeight), repository, bounds, null, onProfile = {}, onLand = {}, onBack = {}, onReleased = {})
                        } }
                    }
                }
            }
        }
        val deadline = System.nanoTime() + seconds * 1_000_000_000L
        while (!stop.exists() && System.nanoTime() < deadline) Thread.sleep(500)
        stop.delete()
        File(root, "receipt.json").writeText(buildJsonObject {
            put("syntheticUiOnly", true); put("accountAccessed", false); put("networkAccessRequested", false)
            put("scriptedGets", script.gets); put("scriptedCardGets", script.cardGets); put("scriptedPosts", script.posts); put("unexpectedCalls", script.unexpected)
        }.toString())
        instrumentation.runOnMainSync { host.finish() }
        holder.replace(null)
        return root.path
    }

    private class MemoryStore : SecretStore {
        private var value: String? = null
        override fun read() = value
        override fun write(value: String) { this.value = value }
        override fun clear() { value = null }
    }

    /** In-memory chat server script. Message text is invented test data. */
    private class ChatScript(private val bounds: ChatBounds, private val lock: String?, private val arrivals: Boolean, private val failSend: Boolean, private val cards: String?) : ApiClient {
        var gets = 0; var posts = 0; var unexpected = 0; var cardGets = 0
        private val authorPath = Regex("/chat/messages/([1-9][0-9]*)/author")
        /** GET /chat/messages/:id/author, version 1, one invented player per scripted author: a multi-kingdom clan
         * member, a landless player whose starter base has a Keep, a player with no base at all, a message whose
         * card the server refuses, and the viewer's own card. */
        private suspend fun card(id: String): JsonObject {
            cardGets++
            val row = messages.firstOrNull { it.string("id") == id } ?: throw ApiException(404, "CHAT_MESSAGE_NOT_FOUND", "chat message not found")
            val author = requireNotNull(row["author"]).jsonObject; val name = requireNotNull(author.string("name"))
            when (cards) {
                "limited" -> throw ApiException(429, "CHAT_RATE_LIMITED", "player card limit reached; try again in 12s")
                "missing" -> throw ApiException(404, null, "Route GET:/chat/messages/$id/author not found")
                "slow" -> kotlinx.coroutines.delay(4_000)
            }
            fun answer(bases: Int, keep: Int?, trophies: Int, clan: Pair<String, String>?) = buildJsonObject {
                put("version", 1); put("name", name); put("avatarUrl", JsonNull); put("seekerVerified", author.flag("seekerVerified"))
                put("bases", bases); put("highestKeepLevel", keep?.let { JsonPrimitive(it) } ?: JsonNull); put("trophies", trophies)
                put("clan", clan?.let { (tag, clanName) -> buildJsonObject { put("name", clanName); put("tag", tag) } } ?: JsonNull)
            }
            return when (name) {
                "ironvale" -> answer(3, 11, 1284, "IRON" to "Iron Crest")
                "69arc" -> answer(0, 4, 36, null)
                "heissamueel" -> answer(0, null, 0, null)
                "moonsunder" -> throw ApiException(404, "CHAT_MESSAGE_NOT_FOUND", "chat message not found")
                else -> answer(1, 7, 212, "DAWN" to "Dawnwatch")
            }
        }
        private var next = 100L
        private var polls = 0
        private val now = System.currentTimeMillis()
        private val messages = mutableListOf<JsonObject>()
        private val events = mutableListOf<Pair<Long, JsonObject>>()
        private fun message(author: String, text: String, agoMinutes: Long, own: Boolean = false, mentioned: Boolean = false, verified: Boolean = false,
            client: String = UUID.randomUUID().toString()): JsonObject = buildJsonObject {
            put("id", (++next).toString()); put("clientMessageId", client); put("text", text)
            put("createdAt", Instant.ofEpochMilli(now - agoMinutes * 60_000).toString())
            putJsonObject("author") { put("name", author); put("avatarUrl", JsonNull); put("seekerVerified", verified) }
            put("canBlock", !own); putJsonArray("mentions") {}; put("mentioned", mentioned)
        }
        init {
            val seed = listOf(
                message("ironvale", "anyone up for a raid exchange tonight?", 62),
                message("ironvale", "my walls are level 6 now", 61),
                message("69arc", "gg that last defence was close", 48, verified = true),
                message("heissamueel", "hello", 40),
                message("heissamueel", "how do I get more builders?", 40),
                message("heissamueel", "found it, the shop", 39),
                message("qa_fixture", "builders are in SHOP under BUILDERS", 33, own = true),
                message("qa_fixture", "second one costs KEEP", 33, own = true),
                message("69arc", "the new dragon nest is brutal, lost half my army to it and still only got one star", 21, verified = true),
                message("moonsunder", "@qa_fixture thanks for the tip", 12, mentioned = true),
                message("moonsunder", "trading a haste keg if anyone needs one", 11),
                message("ironvale", "me", 5),
                message("ironvale", "after this upgrade finishes", 5),
                message("69arc", "test 12", 2, verified = true))
            messages += seed.takeLast(bounds.pageSize)
        }
        private fun status() = buildJsonObject {
            put("enabled", true); put("canSend", lock == null); put("sendBlockedReason", lock?.let(::JsonPrimitive) ?: JsonNull)
            put("mutedUntil", if (lock == "MUTED") JsonPrimitive(Instant.ofEpochMilli(now + 3_600_000).toString()) else JsonNull)
            put("latestEventId", (events.lastOrNull()?.first ?: 0L).toString())
            put("pollOpenMs", bounds.pollOpenMs); put("pollClosedMs", bounds.pollClosedMs)
        }
        override suspend fun get(path: String, query: Map<String, String>): JsonObject { gets++
            authorPath.matchEntire(path)?.let { return card(it.groupValues[1]) }
            return when (path) {
            "/chat/status" -> status()
            "/chat/messages" -> buildJsonObject { putJsonArray("messages") { messages.asReversed().forEach(::add) }; put("nextBefore", JsonNull) }
            "/chat/blocks" -> buildJsonObject { putJsonArray("blocks") {}; put("nextBefore", JsonNull) }
            "/chat/events" -> {
                polls++
                if (arrivals && polls % 3 == 0) {
                    val arrived = message("moonsunder", "arrival ${polls / 3}", 0); messages += arrived
                    events += (events.lastOrNull()?.first ?: 0L) + 1 to arrived
                }
                val after = requireNotNull(query["after"]).toLong()
                buildJsonObject {
                    putJsonArray("events") { events.filter { it.first > after }.take(bounds.pageSize).forEach { (id, row) -> addJsonObject {
                        put("id", id.toString()); put("type", "message"); put("createdAt", requireNotNull(row.string("createdAt")))
                        put("messageId", requireNotNull(row.string("id"))); put("message", row)
                    } } }
                    put("nextAfter", maxOf(after, events.lastOrNull()?.first ?: 0L).toString())
                }
            }
            else -> { unexpected++; error("Unexpected scripted GET $path") }
        } }
        override suspend fun post(path: String, body: JsonObject): JsonObject { posts++; return when {
            // `chatFailSend`: the reply is lost, so the saved-message recovery and the failed-order line show together.
            path == "/chat/messages" && failSend -> throw java.io.IOException("Chat connection interrupted. Refresh to check.")
            path == "/chat/messages" -> message("qa_fixture", requireNotNull(body.string("text")), 0, own = true,
                client = requireNotNull(body.string("clientMessageId"))).also { messages += it }
            path.matches(Regex("/chat/messages/[0-9]+/(report|block)")) -> buildJsonObject {}
            else -> { unexpected++; error("Unexpected scripted POST $path") }
        } }
        override suspend fun put(path: String, body: JsonObject): JsonObject { unexpected++; error("Unexpected scripted PUT $path") }
        override suspend fun delete(path: String): JsonObject { unexpected++; error("Unexpected scripted DELETE $path") }
    }
}
