package gg.pixelkingdomwars.nativeclient.telemetry

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.wallet.WalletFailureKind
import gg.pixelkingdomwars.nativeclient.wallet.WalletFailureReason
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.UUID

/** Closed reliability vocabulary. Throwable messages, causes, arguments and full stacks never enter storage or HTTP. */
enum class NativeError(val code: String, val message: String) {
    UNCAUGHT("NATIVE_UNCAUGHT", "Native client stopped unexpectedly"),
    STARTUP("NATIVE_STARTUP", "Native client startup failed"),
    RENDER("NATIVE_RENDER", "Native rendering failed"),
    SCREEN("NATIVE_SCREEN", "Native screen action failed"),
    // One entry per wallet payment failure class (wallet module `WalletFailureKind.diagnostic`): the MWA error
    // code or the failing step, never the transaction, the wallet's text or the account. The API attributes the
    // same codes in `NATIVE_ERROR_MESSAGES` (apps/api/src/telemetry.ts); an unknown code collapses to NATIVE_ERROR there.
    WALLET_ACCOUNT_MISMATCH("NATIVE_WALLET_ACCOUNT_MISMATCH", "Wallet approved a different account"),
    WALLET_AUTHORIZATION_FAILED("NATIVE_WALLET_AUTHORIZATION_FAILED", "Wallet refused the saved authorization (MWA -1)"),
    WALLET_INVALID_PAYLOADS("NATIVE_WALLET_INVALID_PAYLOADS", "Wallet rejected the transaction payload (MWA -2)"),
    WALLET_NOT_SIGNED("NATIVE_WALLET_NOT_SIGNED", "Wallet request declined (MWA -3)"),
    WALLET_NOT_SUBMITTED("NATIVE_WALLET_NOT_SUBMITTED", "Wallet signed but did not submit (MWA -4)"),
    WALLET_CLUSTER_NOT_SUPPORTED("NATIVE_WALLET_CLUSTER_NOT_SUPPORTED", "Wallet does not support the cluster (MWA -7)"),
    WALLET_METHOD_NOT_FOUND_SEND("NATIVE_WALLET_METHOD_NOT_FOUND_SEND", "Wallet answered method-not-found to sign-and-send (-32601)"),
    WALLET_METHOD_NOT_FOUND_SIGN("NATIVE_WALLET_METHOD_NOT_FOUND_SIGN", "Wallet answered method-not-found to sign-only (-32601)"),
    WALLET_REMOTE_ERROR("NATIVE_WALLET_REMOTE_ERROR", "Wallet returned another MWA error"),
    WALLET_NOT_FOUND("NATIVE_WALLET_NOT_FOUND", "No compatible wallet app answered"),
    WALLET_TIMEOUT("NATIVE_WALLET_TIMEOUT", "Wallet did not answer in time"),
    WALLET_INTERRUPTED("NATIVE_WALLET_INTERRUPTED", "Wallet session cancelled or interrupted"),
    WALLET_INVALID_RESPONSE("NATIVE_WALLET_INVALID_RESPONSE", "Wallet reply failed the app's checks"),
    WALLET_TX_VERSION_CHANGED("NATIVE_WALLET_TX_VERSION_CHANGED", "Wallet returned a different transaction version"),
    WALLET_TX_SIGNERS_CHANGED("NATIVE_WALLET_TX_SIGNERS_CHANGED", "Wallet changed the fee payer or required signers"),
    WALLET_TX_BLOCKHASH_CHANGED("NATIVE_WALLET_TX_BLOCKHASH_CHANGED", "Wallet changed the recent blockhash"),
    WALLET_TX_INSTRUCTIONS_CHANGED("NATIVE_WALLET_TX_INSTRUCTIONS_CHANGED", "Wallet changed the reviewed instructions"),
    WALLET_TX_PRIORITY_FEE_TOO_HIGH("NATIVE_WALLET_TX_PRIORITY_FEE_TOO_HIGH", "Wallet added a priority fee above the app's safety limit"),
    WALLET_TX_BAD_SIGNATURE("NATIVE_WALLET_TX_BAD_SIGNATURE", "Wallet signature does not verify for the returned transaction"),
    WALLET_RPC_REJECTED("NATIVE_WALLET_RPC_REJECTED", "Relay rejected the signed transaction"),
    // Success markers, not failures: which path a payment that went through the sign-only fallback took.
    WALLET_FALLBACK_USED("NATIVE_WALLET_FALLBACK_USED", "Payment completed through the sign-only fallback"),
    WALLET_FALLBACK_USED_COMPUTE_BUDGET("NATIVE_WALLET_FALLBACK_USED_COMPUTE_BUDGET", "Payment completed through the sign-only fallback; wallet added ComputeBudget instructions"),
    WALLET_UNKNOWN("NATIVE_WALLET_UNKNOWN", "Wallet payment failed for an unclassified reason"),
    // In-app update channel (M45 §5): one entry per step and failure kind, never the URL, file or device identity.
    UPDATE_OFFERED("NATIVE_UPDATE_OFFERED", "App update offered"),
    UPDATE_DOWNLOADED("NATIVE_UPDATE_DOWNLOADED", "App update downloaded"),
    UPDATE_VERIFIED("NATIVE_UPDATE_VERIFIED", "App update verified"),
    UPDATE_INSTALLED("NATIVE_UPDATE_INSTALLED", "App update installed"),
    UPDATE_DECLINED("NATIVE_UPDATE_DECLINED", "App update declined"),
    UPDATE_FAILED_HASH("NATIVE_UPDATE_FAILED_HASH", "App update file hash mismatch"),
    UPDATE_FAILED_SIGNER("NATIVE_UPDATE_FAILED_SIGNER", "App update signer mismatch"),
    UPDATE_FAILED_VERSION("NATIVE_UPDATE_FAILED_VERSION", "App update version mismatch"),
    UPDATE_FAILED_PACKAGE("NATIVE_UPDATE_FAILED_PACKAGE", "App update package mismatch"),
    UPDATE_FAILED_ORIGIN("NATIVE_UPDATE_FAILED_ORIGIN", "App update origin refused"),
    UPDATE_FAILED_NETWORK("NATIVE_UPDATE_FAILED_NETWORK", "App update download failed"),
    UPDATE_FAILED_STORAGE("NATIVE_UPDATE_FAILED_STORAGE", "App update storage failed"),
    UPDATE_FAILED_PERMISSION("NATIVE_UPDATE_FAILED_PERMISSION", "App update install permission missing"),
    UPDATE_FAILED_INSTALL("NATIVE_UPDATE_FAILED_INSTALL", "App update install failed"),
    // Sentry 2026-09-27 (a 0.6.0 "installer refused"): Android's install status, one code each, so a dismissed dialog is
    // never read as a broken update. CANCELLED is the player's choice, not a failure; SESSION is this app's own hand-off.
    UPDATE_INSTALL_CANCELLED("NATIVE_UPDATE_INSTALL_CANCELLED", "Player cancelled the Android install dialog"),
    UPDATE_FAILED_INSTALL_SESSION("NATIVE_UPDATE_FAILED_INSTALL_SESSION", "App update install session could not be created or committed"),
    UPDATE_FAILED_INSTALL_BLOCKED("NATIVE_UPDATE_FAILED_INSTALL_BLOCKED", "Android blocked the app update install"),
    UPDATE_FAILED_INSTALL_CONFLICT("NATIVE_UPDATE_FAILED_INSTALL_CONFLICT", "App update conflicts with the installed package"),
    UPDATE_FAILED_INSTALL_INCOMPATIBLE("NATIVE_UPDATE_FAILED_INSTALL_INCOMPATIBLE", "App update is incompatible with the device"),
    UPDATE_FAILED_INSTALL_INVALID("NATIVE_UPDATE_FAILED_INSTALL_INVALID", "Android found the app update file invalid"),
    UPDATE_FAILED_INSTALL_STORAGE("NATIVE_UPDATE_FAILED_INSTALL_STORAGE", "Android had no space to install the app update"),
    UPDATE_FAILED_INSTALL_TIMEOUT("NATIVE_UPDATE_FAILED_INSTALL_TIMEOUT", "Android timed out installing the app update");

    companion object {
        /** Every wallet kind has exactly one entry; a missing one is a build defect, not a runtime fallback. */
        fun forWallet(kind: WalletFailureKind): NativeError = entries.single { it.code == kind.diagnostic }
    }
}

/** One diagnostics record per classified wallet failure, through the same closed-vocabulary channel as native
 * crashes. Fire-and-forget: a disabled or broken reporter never changes the payment's outcome. The channel
 * carries the kind's code only; the stage and numeric code are on the player's screen ([WalletFailureReason.token]). */
fun reportWalletFailure(reason: WalletFailureReason) { NativeTelemetryRuntime.record(NativeError.forWallet(reason.kind)) }

internal fun telemetryCrashHandler(record: (Throwable) -> Unit, previous: Thread.UncaughtExceptionHandler) =
    Thread.UncaughtExceptionHandler { thread, error ->
        try { record(error) } finally { previous.uncaughtException(thread, error) }
    }

data class TelemetryBuild(val sha: String, val version: String) {
    init {
        require(sha.matches(Regex("[a-f0-9]{7,40}|dev|unknown")))
        require(version.matches(Regex("[A-Za-z0-9][A-Za-z0-9._:+-]{0,119}")))
    }
    fun context() = buildJsonObject { put("platform", "android-native"); put("gitSha", sha); put("buildVersion", version) }
}

/** Best-effort diagnostics are independent of account cookies and gameplay recovery.
 * The small encrypted queue survives a crash, with the binary build that produced each event.
 * Operational caps/deadlines below are device reporting policy, never game numbers. */
class NativeTelemetry(private val store: SecretStore, private val build: TelemetryBuild,
    private val enabled: () -> Boolean, private val send: suspend (JsonObject) -> Unit,
    private val now: () -> Long = System::currentTimeMillis, private val newId: () -> String = { UUID.randomUUID().toString() }) {
    private data class Report(val id: String, val at: String, val error: NativeError, val count: Int, val build: TelemetryBuild) {
        fun saved() = buildJsonObject {
            put("id", id); put("at", at); put("code", error.code); put("count", count)
            put("sha", build.sha); put("build", build.version)
        }
        fun event() = buildJsonObject {
            put("event", "app_error"); put("eventId", id); put("ts", at)
            put("props", buildJsonObject {
                put("name", "NativeClientError"); put("code", error.code); put("message", error.message)
                put("count", count)
            })
        }
    }
    private val lock = Any()
    private val flushing = Mutex()
    private var lastFlush: Long? = null
    private fun read(): List<Report> = store.read()?.let { text ->
        require(text.length <= 20_000)
        val root = Json.parseToJsonElement(text).jsonObject
        require(root.keys == setOf("version", "reports") && root["version"] == JsonPrimitive(1))
        val rows = root.getValue("reports").jsonArray; require(rows.size <= 20)
        rows.map { element ->
            val row = element.jsonObject
            require(row.keys == setOf("id", "at", "code", "count", "sha", "build"))
            fun string(key: String) = row.getValue(key).jsonPrimitive.let { require(it.isString); it.content }
            val id = string("id"); require(UUID.fromString(id).toString() == id)
            val at = string("at"); require(at.length <= 40); Instant.parse(at)
            val count = row.getValue("count").jsonPrimitive.int; require(count in 1..1_000_000)
            Report(id, at, NativeError.entries.single { it.code == string("code") }, count, TelemetryBuild(string("sha"), string("build")))
        }
    }.orEmpty()
    private fun write(rows: List<Report>) {
        if (rows.isEmpty()) store.clear() else store.write(buildJsonObject {
            put("version", 1); put("reports", JsonArray(rows.map(Report::saved)))
        }.toString())
    }
    fun record(error: NativeError, failure: Throwable? = null) {
        if (!enabled() || failure is CancellationException) return
        // A broken diagnostic store must never change the game or suppress Android's crash handler.
        runCatching { synchronized(lock) {
            val rows = read().toMutableList()
            val index = rows.indexOfFirst { it.error == error && it.build == build }
            if (index >= 0) rows[index] = rows[index].copy(count = minOf(1_000_000, rows[index].count + 1))
            else rows += Report(newId(), Instant.ofEpochMilli(now()).toString(), error, 1, build)
            write(rows.takeLast(20))
        } }
    }
    suspend fun flush() {
        if (!enabled() || !flushing.tryLock()) return
        try {
            val instant = now()
            if (lastFlush?.let { instant - it in 0 until 15_000L } == true) return
            lastFlush = instant
            val reports = try { synchronized(lock) { read().also { if (it.isNotEmpty()) write(emptyList()) } } }
                catch (_: Exception) { return }
            // Drain before sending: timeout, logout, rejection or process death cannot replay telemetry.
            // Fresh reports produced while this request is in flight remain in the journal.
            withTimeoutOrNull(10_000) {
                for ((originBuild, rows) in reports.groupBy { it.build }) {
                    if (!enabled()) return@withTimeoutOrNull
                    try { send(buildJsonObject { put("context", originBuild.context()); put("events", JsonArray(rows.map(Report::event))) }) }
                    catch (e: CancellationException) { throw e }
                    catch (_: Exception) { /* Fire-and-forget: no retries and no reports about reporting failures. */ }
                }
            }
        } finally { flushing.unlock() }
    }
}
