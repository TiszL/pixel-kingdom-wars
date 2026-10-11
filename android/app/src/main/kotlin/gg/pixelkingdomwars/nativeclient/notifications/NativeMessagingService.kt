package gg.pixelkingdomwars.nativeclient.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.tasks.Task
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.MainActivity
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.network.EncryptedStore
import gg.pixelkingdomwars.nativeclient.network.GameApi
import gg.pixelkingdomwars.nativeclient.network.SessionCookieJar
import okhttp3.HttpUrl.Companion.toHttpUrl
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Shared by the UI and background service; background delivery never boots an account graph. */
object NativeNotificationRuntime {
    private var storage: NotificationJournal? = null
    private var client: GameApi? = null
    private var simVersion: () -> Int? = { null }
    private var rendererContract: () -> Int? = { null }
    @Volatile var offline = false
    val tokenChanges = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    const val CHANNEL = "pkw_game_updates"
    const val BINDING_EXTRA = "pkw_notification_binding"
    @Synchronized fun journal(context: Context): NotificationJournal = storage ?: NotificationJournal(
        EncryptedStore(context.applicationContext, storageNamespace(BuildConfig.API_ORIGIN, "notifications"))
    ).also { storage = it }
    /** One cookie generation owner in this process, shared with foreground authentication. */
    @Synchronized fun api(context: Context, sim: (() -> Int?)? = null, renderer: (() -> Int?)? = null): GameApi {
        if (sim != null) simVersion = sim
        if (renderer != null) rendererContract = renderer
        client?.let { return it }
        // Cold-start measurement 2026-10-06: the transport holds optional reads behind the first Home read after sign-in
        // (HomeReadGate) and times every call of a launch's first 30 s (PKWLoad HTTP lines, BootHttp).
        val transport = okhttp3.OkHttpClient.Builder()
            .addInterceptor(gg.pixelkingdomwars.nativeclient.data.HomeReadGate.current.interceptor)
            .eventListenerFactory(gg.pixelkingdomwars.nativeclient.diagnostics.BootHttp.listeners).build()
        return GameApi.withTransport(BuildConfig.API_ORIGIN, SessionCookieJar(BuildConfig.API_ORIGIN.toHttpUrl(),
            EncryptedStore(context.applicationContext, storageNamespace(BuildConfig.API_ORIGIN, "session"))), BuildConfig.VERSION_NAME,
            transport, rendererContract = { rendererContract() }, simVersion = { simVersion() })
            .also { client = it }
    }
    fun permitted(context: Context): Boolean = (Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
        NotificationManagerCompat.from(context).areNotificationsEnabled() &&
        context.getSystemService(NotificationManager::class.java).getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE
    fun channel(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Game updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Raids, completed work, full mines and mail"
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            })
    }
    fun cancelShown(context: Context) = NotificationManagerCompat.from(context).cancelAll()
    fun allowedTap(context: Context, intent: Intent): Boolean {
        if (!intent.hasExtra(BINDING_EXTRA)) return true
        return !offline && runCatching { journal(context).active(intent.getStringExtra(BINDING_EXTRA).orEmpty()) }.getOrDefault(false)
    }
}

class FirebaseNotificationTokens : NotificationTokens {
    override suspend fun token(): String = FirebaseMessaging.getInstance().token.awaitResult()
    override suspend fun delete() { if (BuildConfig.NATIVE_FCM_CONFIGURED) FirebaseMessaging.getInstance().deleteToken().awaitResult() }
    override fun autoInit(enabled: Boolean) {
        if (BuildConfig.NATIVE_FCM_CONFIGURED) FirebaseMessaging.getInstance().isAutoInitEnabled = enabled
    }
}
private suspend fun <T> Task<T>.awaitResult(): T = suspendCancellableCoroutine { continuation ->
    addOnSuccessListener { if (continuation.isActive) continuation.resume(it) }
    addOnFailureListener { if (continuation.isActive) continuation.resumeWithException(it) }
    addOnCanceledListener { continuation.cancel() }
}

class NativeMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        if (!BuildConfig.NATIVE_FCM_CONFIGURED || NativeNotificationRuntime.offline) return
        runCatching {
            if (NativeNotificationRuntime.journal(this).rotate(token)) NotificationTokenWorker.enqueue(this)
            NativeNotificationRuntime.tokenChanges.tryEmit(Unit)
        }
    }
    override fun onMessageReceived(message: RemoteMessage) {
        // Only data-only messages are accepted. No OS bypass of our permission, binding or dedup checks.
        if (!BuildConfig.NATIVE_FCM_CONFIGURED || NativeNotificationRuntime.offline || message.notification != null ||
            !NativeNotificationRuntime.permitted(this)) return
        runCatching {
            NativeNotificationRuntime.journal(this).dispatch(message.data) { push ->
            NativeNotificationRuntime.channel(this)
            val intent = Intent(this, MainActivity::class.java).setAction(Intent.ACTION_VIEW).setData(Uri.parse(push.url))
                .addCategory("gg.pixelkingdomwars.notification.${push.eventId}")
                .putExtra(NativeNotificationRuntime.BINDING_EXTRA, push.bindingId)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            val tap = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notification = NotificationCompat.Builder(this, NativeNotificationRuntime.CHANNEL)
                .setSmallIcon(R.drawable.pkw_notification).setContentTitle(push.title).setContentText(push.body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(push.body))
                .setContentIntent(tap).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setOnlyAlertOnce(true).build()
            if (NativeNotificationRuntime.journal(this).active(push.bindingId) && NativeNotificationRuntime.permitted(this) &&
                (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)) {
                NotificationManagerCompat.from(this).notify(push.kind, 0, notification)
            }
            }
        } // Neither payloads nor registration capabilities enter diagnostics.
    }
}
