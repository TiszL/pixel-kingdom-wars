package gg.pixelkingdomwars.nativeclient.update

import gg.pixelkingdomwars.nativeclient.model.NativeUpdateOffer
import gg.pixelkingdomwars.nativeclient.network.sameOriginContentUrl
import java.util.Locale
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** M45 §1: `size_bytes <= 314572800`; the client refuses anything larger before and while downloading. */
const val MAX_UPDATE_BYTES: Long = 300L * 1024 * 1024

enum class IneligibleReason { NOT_NEWER, FOREIGN_ORIGIN, SIGNER_MISMATCH, MALFORMED }

sealed interface UpdateEligibility {
    data class Eligible(val offer: NativeUpdateOffer, val resolvedUrl: HttpUrl) : UpdateEligibility
    data class Ineligible(val reason: IneligibleReason) : UpdateEligibility
}

/** `apksigner --print-certs` style digests may carry colons or upper case; compare the bare lowercase hex. */
fun normalizedSigner(value: String): String = value.replace(":", "").lowercase(Locale.ROOT)

private val HEX64 = Regex("[0-9a-f]{64}")
private val APK_PATH = Regex("/native/releases/([0-9]{1,6})-([0-9a-f]{64})\\.apk")
private val VERSION_NAME = Regex("[0-9]+\\.[0-9]+\\.[0-9]+")

/** Offer only a strictly newer build, served by this game's own HTTPS origin, signed by the key already installed.
 * The advertised `apkUrl` is informational: the file is fetched from [apiOrigin] + `apkPath`, never elsewhere. */
fun eligibleOffer(offer: NativeUpdateOffer, runningVersionCode: Long, apiOrigin: String, runningSignerSha256: String?): UpdateEligibility {
    if (offer.latestVersionCode <= runningVersionCode) return UpdateEligibility.Ineligible(IneligibleReason.NOT_NEWER)
    val resolved = runCatching {
        val origin = requireNotNull(apiOrigin.toHttpUrlOrNull())
        sameOriginContentUrl(origin, requireNotNull(origin.resolve(offer.apkPath)))
    }.getOrNull() ?: return UpdateEligibility.Ineligible(IneligibleReason.FOREIGN_ORIGIN)
    val path = APK_PATH.matchEntire(resolved.encodedPath)
    if (path == null || path.groupValues[1].toLong() != offer.latestVersionCode || path.groupValues[2] != offer.sha256 ||
        !offer.sha256.matches(HEX64) || !normalizedSigner(offer.signerSha256).matches(HEX64) ||
        offer.sizeBytes !in 1..MAX_UPDATE_BYTES || !offer.versionName.matches(VERSION_NAME)) return UpdateEligibility.Ineligible(IneligibleReason.MALFORMED)
    if (runningSignerSha256 == null || normalizedSigner(runningSignerSha256) != normalizedSigner(offer.signerSha256))
        return UpdateEligibility.Ineligible(IneligibleReason.SIGNER_MISMATCH)
    return UpdateEligibility.Eligible(offer, resolved)
}
