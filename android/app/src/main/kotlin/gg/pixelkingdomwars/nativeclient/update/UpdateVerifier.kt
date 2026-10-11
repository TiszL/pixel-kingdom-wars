package gg.pixelkingdomwars.nativeclient.update

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import gg.pixelkingdomwars.nativeclient.model.NativeUpdateOffer
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** What the platform reads from an APK file; [signerSha256s] are SHA-256 digests of each signer's DER certificate. */
data class ArchiveInfo(val packageName: String, val longVersionCode: Long, val signerSha256s: List<String>)
fun interface ArchiveInspector { fun inspect(file: File): ArchiveInfo? }
data class RunningIdentity(val packageName: String, val versionCode: Long, val signerSha256: String)
data class VerifiedApk(val file: File, val sha256: String)

internal fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
internal fun sha256Hex(file: File): String = MessageDigest.getInstance("SHA-256").let { digest ->
    file.inputStream().use { input -> val buffer = ByteArray(64 * 1024)
        while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) } }
    digest.digest().joinToString("") { "%02x".format(it) }
}

/** M45 §5 verification, in order: bytes, package, signer, version. Any mismatch deletes the file. */
class UpdateVerifier(private val inspector: ArchiveInspector) {
    suspend fun verify(file: File, offer: NativeUpdateOffer, running: RunningIdentity): VerifiedApk = withContext(Dispatchers.IO) {
        fun refuse(kind: UpdateFailureKind, message: String): Nothing { file.delete(); throw UpdateFailure(kind, message) }
        val sha = runCatching { sha256Hex(file) }.getOrElse { refuse(UpdateFailureKind.STORAGE, "The update file could not be read") }
        if (sha != offer.sha256) refuse(UpdateFailureKind.HASH, "The update file does not match its published hash")
        val info = runCatching { inspector.inspect(file) }.getOrNull()
        if (info == null || info.packageName != running.packageName) refuse(UpdateFailureKind.PACKAGE, "The update is for a different app")
        val signer = normalizedSigner(running.signerSha256)
        if (info.signerSha256s.size != 1 || normalizedSigner(info.signerSha256s.single()) != signer)
            refuse(UpdateFailureKind.SIGNER, "The update is not signed by this app's publisher")
        if (info.longVersionCode != offer.latestVersionCode || info.longVersionCode <= running.versionCode)
            refuse(UpdateFailureKind.VERSION, "The update version does not match the offer")
        VerifiedApk(file, sha)
    }
}

private fun signers(info: PackageInfo?): List<String>? =
    // apkContentsSigners names the current signer(s) with or without rotation history; several signers are refused later.
    info?.signingInfo?.apkContentsSigners?.map { sha256Hex(it.toByteArray()) }

/** `getPackageArchiveInfo(GET_SIGNING_CERTIFICATES)` on the downloaded file (API 28+). */
class AndroidArchiveInspector(private val packages: PackageManager) : ArchiveInspector {
    override fun inspect(file: File): ArchiveInfo? {
        val info = if (Build.VERSION.SDK_INT >= 33) packages.getPackageArchiveInfo(file.path, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
            else @Suppress("DEPRECATION") packages.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES)
        return info?.let { ArchiveInfo(it.packageName, it.longVersionCode, signers(it) ?: return null) }
    }
}

/** The installed app's identity; null (no offer is eligible) when the platform cannot name exactly one signer. */
fun runningIdentity(context: Context, versionCode: Long): RunningIdentity? = runCatching {
    val packages = context.packageManager
    val info = if (Build.VERSION.SDK_INT >= 33) packages.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
        else @Suppress("DEPRECATION") packages.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
    signers(info)?.singleOrNull()?.let { RunningIdentity(context.packageName, versionCode, it) }
}.getOrNull()
