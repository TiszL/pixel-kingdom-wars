package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import gg.pixelkingdomwars.nativeclient.data.ApiClient
import gg.pixelkingdomwars.nativeclient.data.WallBatchRepository
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.*
import gg.pixelkingdomwars.nativeclient.ui.PkwTheme
import gg.pixelkingdomwars.nativeclient.ui.kingdom.WallBatchHistory
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.security.MessageDigest
import java.util.UUID

/** Actual receipt panel and session repository; only synthetic in-memory receipts. No account or socket access. */
internal object WallReceiptHarness {
    const val MODE = "wall-receipt"
    private const val WALLET = "11111111111111111111111111111111"
    private const val BASE = "22222222-2222-4222-8222-222222222222"
    private class Memory : SecretStore {
        var value: String? = null
        override fun read() = value
        override fun write(value: String) { this.value = value }
        override fun clear() { value = null }
    }
    fun verify(i: Instrumentation): String {
        check(BuildConfig.DEBUG && BuildConfig.APPLICATION_ID == "gg.pixelkingdomwars.twa.debug" &&
            Build.HARDWARE == "ranchu" && BuildConfig.API_ORIGIN == "https://127.0.0.1:18443")
        val root = File(i.targetContext.noBackupFilesDir, "wall-receipt/${System.currentTimeMillis()}")
        check(root.mkdirs())
        val checks = mutableListOf<String>(); val captures = mutableListOf<JsonObject>()
        var status = "running"; var failure: String? = null; var gets = 0
        fun receipt() = File(root, "receipt.json").writeText(buildJsonObject {
            put("status", status); put("failure", failure?.let(::JsonPrimitive) ?: JsonNull)
            put("actualWallReceiptPanel", true); put("actualWallRepository", true)
            put("networkRequests", 0); put("mutationCalls", 0); put("scriptedGets", gets)
            put("accountAccessRequested", false); put("physicalSeekerAcceptance", false)
            put("checks", JsonArray(checks.map(::JsonPrimitive))); put("captures", JsonArray(captures))
        }.toString())
        fun nodes(node: AccessibilityNodeInfo?): List<AccessibilityNodeInfo> = if (node == null) emptyList() else
            listOf(node) + (0 until node.childCount).flatMap { nodes(node.getChild(it)) }
        fun labels(): List<String> {
            i.uiAutomation.clearCache()
            return nodes(i.uiAutomation.rootInActiveWindow).filter { it.isVisibleToUser }
                .mapNotNull { (it.text ?: it.contentDescription)?.toString() }
        }
        fun waitFor(label: String, condition: () -> Boolean) {
            val until = SystemClock.uptimeMillis() + 20_000
            while (SystemClock.uptimeMillis() < until) { if (condition()) return; Thread.sleep(75) }
            error("Timed out: $label")
        }
        fun click(label: String) {
            waitFor(label) { label in labels() }
            var node = nodes(i.uiAutomation.rootInActiveWindow).first {
                it.isVisibleToUser && (it.text ?: it.contentDescription)?.toString() == label
            }
            while (!node.isClickable) node = requireNotNull(node.parent)
            check(node.isEnabled && node.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        }
        fun capture(name: String) {
            i.waitForIdleSync(); Thread.sleep(200)
            val png = File(root, "$name.png"); val bitmap = requireNotNull(i.uiAutomation.takeScreenshot())
            try { png.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) } }
            finally { bitmap.recycle() }
            captures += buildJsonObject {
                put("path", png.name); put("sha256", MessageDigest.getInstance("SHA-256").digest(png.readBytes()).joinToString("") { "%02x".format(it) })
                put("labels", JsonArray(labels().map(::JsonPrimitive)))
            }; receipt()
        }
        val holder = AccountSessionHolder()
        var host: MainActivity? = null
        try {
            val origin = BuildConfig.API_ORIGIN
            val session = AccountSession(WALLET, origin, SessionCookieJar(origin.toHttpUrl(), Memory()).sessionToken())
            holder.replace(session)
            val disk = Memory(); val store = PendingIntentStore(disk); val observer = ReceiptObserver(store)
            val spec = WallBatchSpec("devnet")
            // Deliberately arbitrary test terms; no game catalogue or player balance is substituted.
            val terms = WallBatchTerms("37", 30, 5)
            val api = object : ApiClient {
                override suspend fun get(path: String, query: Map<String, String>): JsonObject {
                    check(path.startsWith("${spec.path}/")); gets++
                    return buildJsonObject {
                        put("version", 1); put("wallet", WALLET); put("idempotencyKey", path.substringAfterLast('/'))
                        put("enabled", true); put("receipt", JsonNull)
                    }
                }
                override suspend fun post(path: String, body: JsonObject): JsonObject = error("Receipt presentation must never POST")
                override suspend fun put(path: String, body: JsonObject): JsonObject = error("No PUT")
                override suspend fun delete(path: String): JsonObject = error("No DELETE")
            }
            val repo = WallBatchRepository(session, holder, api, store, observer, { BASE },
                { BaseDirectory(true, capabilities = BaseCapabilities(true, true)) }, {}, { null }, { null }, { true }, {}, "devnet")
            fun seed(accepted: Boolean): PendingIntent {
                val key = UUID.randomUUID().toString()
                val request = WallBatchRequest(key, BASE, listOf(WallBatchTile(8, 8)), terms.cost(1))
                val proof = buildJsonObject {
                    put("version", 1); put("actor", WALLET); put("idempotencyKey", key); put("request", request.body)
                    put("receiptId", key); put("acceptedAt", "2026-09-19T00:00:00.000Z")
                    putJsonObject("funding") { put("currency", "SHARDS"); put("amount", terms.cost(1)) }
                }
                val pending = spec.intent(WALLET, request, terms).copy(attempted = true,
                    receipt = if (accepted) ReceiptDocument.fromPost(proof) else null)
                check(store.create(pending)); runBlocking { repo.refresh() }; return pending
            }
            val first = seed(true); check(store.get(IntentKind.WALL_BATCH, WALLET) == null)
            host = i.startActivitySync(Intent(i.targetContext, MainActivity::class.java).putExtra("preview", "base")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            val activity = requireNotNull(host)
            i.runOnMainSync { activity.setContent { PkwTheme { Surface { Column {
                var route by remember { mutableStateOf(true) }; var layout by remember { mutableStateOf(false) }
                Button(onClick = { route = !route }) { Text(if (route) "Leave Home" else "Return Home") }
                Button(onClick = { layout = !layout }) { Text(if (layout) "Close layout" else "Open layout") }
                Text(if (route) if (layout) "Layout fixture" else "Home fixture" else "Unrelated screen")
                val state by repo.state.collectAsState()
                if (route) key(layout) { WallBatchHistory(state, state.busy,
                    { error("No receipt check tap expected") }, { error("No retry tap expected") }, repo::dismissReceipt) }
            } } } } }
            waitFor("first receipt") { "WALL BATCH RECEIPT" in labels() }; capture("first-receipt")
            click("Close"); waitFor("dismissed receipt") { "WALL BATCH RECEIPT" !in labels() }
            check(repo.state.value.receipt?.receiptId == first.idempotencyKey)
            click("Leave Home"); click("Return Home"); click("Open layout"); click("Close layout")
            runBlocking { repo.refresh() }; i.waitForIdleSync()
            check("WALL BATCH RECEIPT" !in labels() && !repo.state.value.historyVisible)
            check(store.get(IntentKind.WALL_BATCH, WALLET) == null)
            capture("dismissed-after-remount"); checks += "Close survives navigation, layout remounts and unrelated GET refresh without any mutation"
            val second = seed(true)
            waitFor("next original receipt") { "WALL BATCH RECEIPT" in labels() }
            check(repo.state.value.receipt?.receiptId == second.idempotencyKey)
            repo.dismissReceipt(first.idempotencyKey); check(repo.state.value.historyVisible)
            capture("new-receipt"); checks += "A new exact receipt appears; a stale close callback cannot hide it"
            click("Close"); waitFor("second receipt dismissed") { "WALL BATCH RECEIPT" !in labels() }
            val pending = seed(false); val savedBytes = disk.value
            waitFor("pending original") { "Check original receipt" in labels() }
            repo.dismissReceipt(pending.idempotencyKey); click("Leave Home"); click("Return Home")
            waitFor("pending original after remount") { "Check original receipt" in labels() }
            check("Close" !in labels()) { "Uncertain intent exposed a receipt-dismiss action" }
            check(store.get(IntentKind.WALL_BATCH, WALLET) == pending && disk.value == savedBytes) { "Navigation changed the durable original intent" }
            capture("pending-preserved"); checks += "Uncertain exact command remains saved and recoverable after navigation; dismissal never discards its evidence"
            status = "passed"; receipt(); return root.absolutePath
        } catch (error: Throwable) {
            status = "failed"; failure = error.message ?: error.javaClass.simpleName
            runCatching { capture("failure") }; receipt(); throw error
        } finally { holder.replace(null); host?.let { i.runOnMainSync { it.finish() } } }
    }
}
