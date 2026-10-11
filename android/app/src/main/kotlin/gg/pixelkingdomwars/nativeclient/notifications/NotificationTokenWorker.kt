package gg.pixelkingdomwars.nativeclient.notifications

import android.content.Context
import androidx.work.*
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.data.ApiClient
import gg.pixelkingdomwars.nativeclient.data.ApiRouting
import gg.pixelkingdomwars.nativeclient.data.SessionApiClient
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.serialization.json.*

/** Background rotation authenticates the saved cookie and wallet, without restoring a game scene/account graph. */
class NotificationTokenSync(private val journal: NotificationJournal, private val api: ApiClient, private val permitted: () -> Boolean,
    private val packageName: String) {
    suspend fun sync() {
        val b = journal.read()?.takeIf { it.consented } ?: return
        fun guard() { check(permitted() && journal.matches(b)) { "Notification consent changed." } }
        guard()
        try {
            val login = api.get("/auth/login/status"); guard()
            if (login.flag("loginRequired")) { journal.revoke(); return }
            val identity = api.get("/me"); guard()
            if (identity.string("wallet") != b.wallet) { journal.revoke(); return }
            val status = api.get(NativeNotifications.PATH); guard()
            require(status.keys == setOf("version", "enabled") && status["version"] == JsonPrimitive(1))
            if (status["enabled"] != JsonPrimitive(true)) return
            api.post(NativeNotifications.PATH + "/subscribe", buildJsonObject {
                put("token", b.token); put("bindingId", b.bindingId); put("packageName", packageName)
                b.previousToken?.let { put("previousToken", it) }
            })
            guard(); journal.confirm(b)
        } catch (e: ApiException) {
            if (e.status in setOf(401, 403, 409) && journal.matches(b)) journal.revoke()
            throw e
        }
    }
}

class NotificationTokenWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        if (!BuildConfig.NATIVE_FCM_CONFIGURED || NativeNotificationRuntime.offline) return Result.success()
        val context = applicationContext
        return try {
            val transport = NativeNotificationRuntime.api(context)
            val client = SessionApiClient(transport, transport.sessionToken(), ApiRouting())
            withTimeout(30_000) { NotificationTokenSync(NativeNotificationRuntime.journal(context), client,
                { NativeNotificationRuntime.permitted(context) }, context.packageName).sync() }
            Result.success()
        } catch (_: TimeoutCancellationException) { if (runAttemptCount < 3) Result.retry() else Result.failure() }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            // Finite retries for connectivity only; rejected identities/consent never retry themselves.
            if (e is java.io.IOException && (e !is ApiException || e.status >= 500) && runAttemptCount < 3) Result.retry()
            else Result.failure()
        }
    }
    companion object {
        fun enqueue(context: Context) {
            val work = OneTimeWorkRequestBuilder<NotificationTokenWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
            // Input data contains no token, wallet, cookie or payload; the worker reads the encrypted journal.
            WorkManager.getInstance(context).enqueueUniqueWork("pkw-notification-token-sync", ExistingWorkPolicy.REPLACE, work)
        }
    }
}
