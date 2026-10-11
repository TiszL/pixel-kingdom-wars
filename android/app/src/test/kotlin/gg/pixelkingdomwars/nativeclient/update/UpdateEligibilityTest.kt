package gg.pixelkingdomwars.nativeclient.update

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

/** M45 §5 offer admission: only a strictly newer build, from this game's own HTTPS origin, signed by the installed key.
 * A regression here would let the server (or anyone who can edit its channel row) point players at a foreign file. */
class UpdateEligibilityTest {
    private val bytes = "apk".toByteArray()
    private val origin = "https://play.pixelkingdomwars.com"
    private fun reason(result: UpdateEligibility) = (result as UpdateEligibility.Ineligible).reason

    @Test fun `a newer same-origin same-signer offer resolves against the app's own origin`() {
        // The advertised apkUrl is informational; the bytes always come from API_ORIGIN + apkPath.
        val advertised = offer(bytes).copy(apkUrl = "https://elsewhere.example/native/releases/x.apk")
        val result = eligibleOffer(advertised, 25, origin, SIGNER) as UpdateEligibility.Eligible
        assertEquals("$origin/native/releases/26-${sha(bytes)}.apk".toHttpUrl(), result.resolvedUrl)
        assertSame(advertised, result.offer)
    }
    @Test fun `an equal or older build is never offered`() {
        // Offering the running or an older code would loop players through pointless or downgrade installs.
        assertEquals(IneligibleReason.NOT_NEWER, reason(eligibleOffer(offer(bytes, code = 25), 25, origin, SIGNER)))
        assertEquals(IneligibleReason.NOT_NEWER, reason(eligibleOffer(offer(bytes, code = 24), 25, origin, SIGNER)))
    }
    @Test fun `foreign hosts, cleartext, other ports, credentials and queries are refused`() {
        // The download client is origin-restricted; an offer must never widen that to another server.
        val file = "/native/releases/26-${sha(bytes)}.apk"
        listOf("https://other.example$file", "//other.example$file", "http://play.pixelkingdomwars.com$file",
            "https://play.pixelkingdomwars.com:8443$file", "https://user:secret@play.pixelkingdomwars.com$file", "$file?redirect=1").forEach { path ->
            assertEquals(path, IneligibleReason.FOREIGN_ORIGIN, reason(eligibleOffer(offer(bytes, path = path), 25, origin, SIGNER)))
        }
        assertEquals(IneligibleReason.FOREIGN_ORIGIN, reason(eligibleOffer(offer(bytes), 25, "http://play.pixelkingdomwars.com", SIGNER)))
        assertEquals(IneligibleReason.FOREIGN_ORIGIN, reason(eligibleOffer(offer(bytes), 25, "not a url", SIGNER)))
    }
    @Test fun `offers that break the frozen wire shape are malformed`() {
        // apkPath must name exactly this code and hash (§2 CHECK); sizes stay within the 300 MiB client bound.
        val sha = sha(bytes)
        listOf(offer(bytes, path = "/native/releases/27-$sha.apk"), offer(bytes, path = "/native/releases/26-${"0".repeat(64)}.apk"),
            offer(bytes, path = "/native/other/26-$sha.apk"), offer(bytes, sha256 = sha.uppercase(), path = "/native/releases/26-$sha.apk"),
            offer(bytes, size = 0), offer(bytes, size = MAX_UPDATE_BYTES + 1), offer(bytes).copy(versionName = "latest"),
            offer(bytes, signer = "zz".repeat(32))).forEach { bad ->
            assertEquals(bad.toString(), IneligibleReason.MALFORMED, reason(eligibleOffer(bad, 25, origin, SIGNER)))
        }
        assertTrue(eligibleOffer(offer(bytes, size = MAX_UPDATE_BYTES), 25, origin, SIGNER) is UpdateEligibility.Eligible)
    }
    @Test fun `the signer must equal the running app's signer, ignoring case and colons`() {
        // A different key cannot upgrade in place anyway; offering it would only end in an install failure.
        assertEquals(IneligibleReason.SIGNER_MISMATCH, reason(eligibleOffer(offer(bytes), 25, origin, "a1".repeat(32))))
        assertEquals(IneligibleReason.SIGNER_MISMATCH, reason(eligibleOffer(offer(bytes), 25, origin, null)))
        val printed = SIGNER.uppercase().chunked(2).joinToString(":")
        assertTrue(eligibleOffer(offer(bytes), 25, origin, printed) is UpdateEligibility.Eligible)
        assertTrue(eligibleOffer(offer(bytes, signer = printed), 25, origin, SIGNER) is UpdateEligibility.Eligible)
    }
}
