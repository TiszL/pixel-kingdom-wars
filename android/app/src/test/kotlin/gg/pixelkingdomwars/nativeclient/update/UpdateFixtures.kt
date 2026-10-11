package gg.pixelkingdomwars.nativeclient.update

import gg.pixelkingdomwars.nativeclient.model.NativeUpdateOffer
import java.io.ByteArrayOutputStream
import java.io.OutputStream

internal const val PACKAGE = "gg.pixelkingdomwars.twa"
internal val SIGNER = "5e".repeat(32)
internal fun sha(bytes: ByteArray) = sha256Hex(bytes)
internal fun offer(bytes: ByteArray, code: Long = 26, sha256: String = sha(bytes), size: Long = bytes.size.toLong(), mandatory: Boolean = false,
                   signer: String = SIGNER, path: String = "/native/releases/$code-$sha256.apk") = NativeUpdateOffer(
    latestVersionCode = code, versionName = "0.5.9", sourceCommit = "c".repeat(40), apkPath = path,
    apkUrl = "https://play.pixelkingdomwars.com$path", sha256 = sha256, sizeBytes = size, signerSha256 = signer,
    publishedAt = "2026-09-25T10:00:00.000Z", storeStatus = "pending", channel = "tester", mandatory = mandatory)
internal fun running(code: Long = 25) = RunningIdentity(PACKAGE, code, SIGNER)

/** The SharedPreferences install marker without Android: shared between repositories to stand for two processes. */
internal class MemoryInstallMarker(override var pendingVersionCode: Long? = null) : InstallMarker

/** Hand-written PackageInstaller stand-in: records every session call. */
internal class FakeSessions(var permitted: Boolean = true, var failWrite: Boolean = false) : InstallSessions {
    val prompt = SystemPrompt { }
    val written = ByteArrayOutputStream()
    var created = 0; var committed = 0; var abandoned = 0
    override fun canRequestPackageInstalls() = permitted
    override fun permissionPrompt() = prompt
    override fun create(sizeBytes: Long): InstallSession { created++
        return object : InstallSession {
            override fun openWrite(sizeBytes: Long): OutputStream = object : OutputStream() {
                override fun write(b: Int) { if (failWrite) throw java.io.IOException("disk"); written.write(b) }
                override fun write(b: ByteArray, off: Int, len: Int) { if (failWrite) throw java.io.IOException("disk"); written.write(b, off, len) }
            }
            override fun commit() { committed++ }
            override fun abandon() { abandoned++ }
        }
    }
}
