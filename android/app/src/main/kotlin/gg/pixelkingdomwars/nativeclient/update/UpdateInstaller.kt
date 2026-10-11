package gg.pixelkingdomwars.nativeclient.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.provider.Settings
import androidx.core.content.edit
import androidx.core.net.toUri
import gg.pixelkingdomwars.nativeclient.telemetry.NativeError
import java.io.IOException
import java.io.OutputStream
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** One `PackageInstaller` session, abstracted so the install state machine runs in JVM tests. */
interface InstallSession {
    fun openWrite(sizeBytes: Long): OutputStream
    /** The outcome arrives later through [UpdateInstallReceiver] as an [InstallEvent]. */
    fun commit()
    fun abandon()
}
interface InstallSessions {
    fun canRequestPackageInstalls(): Boolean
    /** `ACTION_MANAGE_UNKNOWN_APP_SOURCES` for this package. */
    fun permissionPrompt(): SystemPrompt
    fun create(sizeBytes: Long): InstallSession
}

sealed interface InstallEvent {
    data class PendingUserAction(val prompt: SystemPrompt) : InstallEvent
    data object Success : InstallEvent
    /** [telemetry] is the closed code for what happened; [detail] is for the banner only and never travels. */
    data class Failure(val detail: String, val telemetry: NativeError) : InstallEvent
}

/** A status message is shown and never leaks device paths. */
internal fun installFailureDetail(status: Int, message: String?): String =
    (message ?: "status $status").replace(Regex("(?:/[^\\s/]+)+/?"), "…").take(160)

/** `EXTRA_STATUS` → event. A pending-user-action status without its confirmation is a failure, not a hang. */
fun installEvent(status: Int, message: String?, confirmation: SystemPrompt?): InstallEvent = when (status) {
    PackageInstaller.STATUS_PENDING_USER_ACTION -> confirmation?.let { InstallEvent.PendingUserAction(it) }
        ?: InstallEvent.Failure("The installer did not ask for confirmation", NativeError.UPDATE_FAILED_INSTALL_SESSION)
    PackageInstaller.STATUS_SUCCESS -> InstallEvent.Success
    else -> InstallEvent.Failure(installFailureDetail(status, message), installTelemetry(status))
}

/** Sentry 2026-09-27: a 0.6.0 device reported "installer refused" and nothing said whether the player cancelled Android's
 * dialog or the system rejected the file. Each platform status is its own closed code; the status message never travels. */
internal fun installTelemetry(status: Int): NativeError = when (status) {
    PackageInstaller.STATUS_FAILURE_ABORTED -> NativeError.UPDATE_INSTALL_CANCELLED
    PackageInstaller.STATUS_FAILURE_BLOCKED -> NativeError.UPDATE_FAILED_INSTALL_BLOCKED
    PackageInstaller.STATUS_FAILURE_CONFLICT -> NativeError.UPDATE_FAILED_INSTALL_CONFLICT
    PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> NativeError.UPDATE_FAILED_INSTALL_INCOMPATIBLE
    PackageInstaller.STATUS_FAILURE_INVALID -> NativeError.UPDATE_FAILED_INSTALL_INVALID
    PackageInstaller.STATUS_FAILURE_STORAGE -> NativeError.UPDATE_FAILED_INSTALL_STORAGE
    PackageInstaller.STATUS_FAILURE_TIMEOUT -> NativeError.UPDATE_FAILED_INSTALL_TIMEOUT
    else -> NativeError.UPDATE_FAILED_INSTALL
}

class UpdateInstaller(private val sessions: InstallSessions) {
    fun canInstall(): Boolean = sessions.canRequestPackageInstalls()

    /** Streams the verified file into a session while hashing it again, so bytes that changed after verification never
     * reach the installer (closes the verify→install window), then commits. The player confirms in the system dialog. */
    suspend fun install(apk: VerifiedApk): Unit = withContext(Dispatchers.IO) {
        if (!sessions.canRequestPackageInstalls())
            throw UpdateFailure(UpdateFailureKind.PERMISSION, "Allow this app to install updates", sessions.permissionPrompt())
        val size = apk.file.length()
        val session = try { sessions.create(size) } catch (error: Exception) {
            throw UpdateFailure(UpdateFailureKind.INSTALL, "The installer could not start", telemetry = NativeError.UPDATE_FAILED_INSTALL_SESSION)
        }
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            apk.file.inputStream().use { input -> session.openWrite(size).use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count); output.write(buffer, 0, count) }
            } }
            if (digest.digest().joinToString("") { "%02x".format(it) } != apk.sha256) {
                session.abandon(); apk.file.delete()
                throw UpdateFailure(UpdateFailureKind.HASH, "The update file changed after it was verified")
            }
            session.commit()
        } catch (error: UpdateFailure) { throw error }
        catch (error: IOException) { session.abandon(); throw UpdateFailure(UpdateFailureKind.STORAGE, "The update could not be handed to the installer") }
        catch (error: Exception) { session.abandon(); throw UpdateFailure(UpdateFailureKind.INSTALL, "The installer refused the update", telemetry = NativeError.UPDATE_FAILED_INSTALL_SESSION) }
    }
}

/** Platform sessions: full install of this package, explicit user confirmation on API 31+, status to a private receiver. */
class AndroidInstallSessions(private val context: Context) : InstallSessions {
    private val installer get() = context.packageManager.packageInstaller
    override fun canRequestPackageInstalls() = context.packageManager.canRequestPackageInstalls()
    override fun permissionPrompt(): SystemPrompt {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${context.packageName}".toUri())
        return SystemPrompt { it.startActivity(intent) }
    }
    override fun create(sizeBytes: Long): InstallSession {
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName); setSize(sizeBytes)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        }
        val id = installer.createSession(params)
        val session = try { installer.openSession(id) } catch (error: Exception) { installer.abandonSession(id); throw error }
        return object : InstallSession {
            override fun openWrite(sizeBytes: Long): OutputStream = session.openWrite("base.apk", 0, sizeBytes).let { stream ->
                object : java.io.FilterOutputStream(stream) {
                    override fun write(b: ByteArray, off: Int, len: Int) { stream.write(b, off, len) }
                    override fun close() { session.fsync(stream); stream.close() }
                }
            }
            override fun commit() {
                // Mutable: the installer adds EXTRA_STATUS and the confirmation intent. Explicit and package-bound.
                val status = Intent(context, UpdateInstallReceiver::class.java).setPackage(context.packageName)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                session.commit(PendingIntent.getBroadcast(context, id, status, flags).intentSender)
                session.close()
            }
            override fun abandon() { runCatching { session.abandon() } }
        }
    }
}

/** Written synchronously: the package replacement kills this process moments after the player confirms. */
class SharedInstallMarker(context: Context) : InstallMarker {
    private val store = context.getSharedPreferences("pkw-update-install", Context.MODE_PRIVATE)
    override var pendingVersionCode: Long?
        get() = store.getLong(KEY, 0L).takeIf { it > 0 }
        set(value) { store.edit(commit = true) { if (value == null) remove(KEY) else putLong(KEY, value) } }
    private companion object { const val KEY = "pendingVersionCode" }
}
