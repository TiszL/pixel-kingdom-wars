package gg.pixelkingdomwars.nativeclient.update

import android.content.pm.PackageInstaller
import gg.pixelkingdomwars.nativeclient.telemetry.NativeError
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** M45 §5 install hand-off: a PackageInstaller session the player confirms, fed only with the bytes that were verified. */
class UpdateInstallerTest {
    private val bytes = ByteArray(200_000) { (it % 97).toByte() }
    private fun verified(sha256: String = sha(bytes)): VerifiedApk =
        VerifiedApk(Files.createTempFile("verified", ".apk").toFile().apply { writeBytes(bytes); deleteOnExit() }, sha256)
    private fun failure(sessions: FakeSessions, apk: VerifiedApk): UpdateFailure = runBlocking {
        try { UpdateInstaller(sessions).install(apk); throw AssertionError("Expected an update failure") } catch (error: UpdateFailure) { error }
    }

    @Test fun `verified bytes stream into one session that is committed`() = runBlocking {
        val sessions = FakeSessions()
        UpdateInstaller(sessions).install(verified())
        assertArrayEquals(bytes, sessions.written.toByteArray())
        assertEquals(1, sessions.created); assertEquals(1, sessions.committed); assertEquals(0, sessions.abandoned)
    }
    @Test fun `without the install grant the player is sent to the unknown-sources setting`() {
        // Android refuses silently otherwise; the typed failure carries the exact prompt the sheet opens.
        val sessions = FakeSessions(permitted = false)
        val error = failure(sessions, verified())
        assertEquals(UpdateFailureKind.PERMISSION, error.kind); assertSame(sessions.prompt, error.prompt); assertEquals(0, sessions.created)
    }
    @Test fun `bytes that changed after verification abort the session and are deleted`() {
        // Closes the verify-then-install window: the installer only ever commits the hash that was verified.
        val sessions = FakeSessions(); val apk = verified(sha256 = "0".repeat(64))
        assertEquals(UpdateFailureKind.HASH, failure(sessions, apk).kind)
        assertEquals(0, sessions.committed); assertEquals(1, sessions.abandoned); assertFalse(apk.file.exists())
    }
    @Test fun `a write failure abandons the session`() {
        val sessions = FakeSessions(failWrite = true)
        assertEquals(UpdateFailureKind.STORAGE, failure(sessions, verified()).kind)
        assertEquals(0, sessions.committed); assertEquals(1, sessions.abandoned)
    }
    @Test fun `installer statuses map to confirmation, success and path-free failures`() {
        // A pending status without its confirmation must not leave the player waiting on a dialog that never opens.
        val prompt = SystemPrompt { }
        assertEquals(InstallEvent.PendingUserAction(prompt), installEvent(PackageInstaller.STATUS_PENDING_USER_ACTION, null, prompt))
        assertTrue(installEvent(PackageInstaller.STATUS_PENDING_USER_ACTION, null, null) is InstallEvent.Failure)
        assertEquals(InstallEvent.Success, installEvent(PackageInstaller.STATUS_SUCCESS, null, null))
        val failed = installEvent(PackageInstaller.STATUS_FAILURE_INVALID, "INSTALL_FAILED_INVALID_APK: /data/app/vmdl123.tmp/base.apk is corrupt", null) as InstallEvent.Failure
        assertFalse(failed.detail, failed.detail.contains("/data")); assertTrue(failed.detail.startsWith("INSTALL_FAILED_INVALID_APK"))
        assertEquals(NativeError.UPDATE_FAILED_INSTALL_INVALID, failed.telemetry)
        assertEquals("status 3", (installEvent(PackageInstaller.STATUS_FAILURE_ABORTED, null, null) as InstallEvent.Failure).detail)
    }
    @Test fun `each installer status is its own telemetry code, and a dismissed dialog is not a failure`() {
        // Sentry 2026-09-27: a 0.6.0 device reported "installer refused" and nothing said whether the player cancelled
        // Android's dialog or the system rejected the file. Triage needs the status; the message never travels.
        assertEquals(NativeError.UPDATE_INSTALL_CANCELLED, installTelemetry(PackageInstaller.STATUS_FAILURE_ABORTED))
        assertEquals(NativeError.UPDATE_FAILED_INSTALL_BLOCKED, installTelemetry(PackageInstaller.STATUS_FAILURE_BLOCKED))
        assertEquals(NativeError.UPDATE_FAILED_INSTALL_CONFLICT, installTelemetry(PackageInstaller.STATUS_FAILURE_CONFLICT))
        assertEquals(NativeError.UPDATE_FAILED_INSTALL_INCOMPATIBLE, installTelemetry(PackageInstaller.STATUS_FAILURE_INCOMPATIBLE))
        assertEquals(NativeError.UPDATE_FAILED_INSTALL_INVALID, installTelemetry(PackageInstaller.STATUS_FAILURE_INVALID))
        assertEquals(NativeError.UPDATE_FAILED_INSTALL_STORAGE, installTelemetry(PackageInstaller.STATUS_FAILURE_STORAGE))
        assertEquals(NativeError.UPDATE_FAILED_INSTALL_TIMEOUT, installTelemetry(PackageInstaller.STATUS_FAILURE_TIMEOUT))
        assertEquals(NativeError.UPDATE_FAILED_INSTALL, installTelemetry(PackageInstaller.STATUS_FAILURE))
        assertEquals("An unknown status is still an install failure", NativeError.UPDATE_FAILED_INSTALL, installTelemetry(99))
        // This app's own hand-off, not Android's verdict: a pending status that came without its confirmation intent.
        assertEquals(NativeError.UPDATE_FAILED_INSTALL_SESSION, (installEvent(PackageInstaller.STATUS_PENDING_USER_ACTION, null, null) as InstallEvent.Failure).telemetry)
    }
}
