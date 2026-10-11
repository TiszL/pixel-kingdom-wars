package gg.pixelkingdomwars.nativeclient.data

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The server's public, generation-specific avatar URL carries no game cookie or wallet grant.
 * No fallback to an older generation, persistent image cache or redirect can revive a removed image. */
class ProfileAvatarImage(transport: OkHttpClient = OkHttpClient()) {
    private val client = transport.newBuilder().cookieJar(CookieJar.NO_COOKIES).cache(null)
        .followRedirects(false).followSslRedirects(false).callTimeout(20, TimeUnit.SECONDS).build()
    suspend fun load(raw: String, wallet: String, maxBytes: Int): ByteArray {
        val url = requireNotNull(raw.toHttpUrlOrNull()) { "Avatar URL is unavailable" }
        val parts = url.pathSegments.takeLast(4)
        require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null
            && parts.size == 4 && parts[0] == "avatar" && parts[1] == wallet
            && parts[2].matches(Regex("[a-f0-9]{64}"))
            && parts[3].matches(Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.webp"))) { "Avatar identity is unavailable" }
        return suspendCancellableCoroutine { continuation ->
            val call = client.newCall(Request.Builder().url(url).header("Accept", "image/webp").get().build())
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
                override fun onResponse(call: Call, response: Response) {
                    try {
                        val bytes = response.use {
                            if (!it.isSuccessful) throw IOException("Avatar is unavailable (${it.code})")
                            val body = it.body ?: throw IOException("Avatar is empty")
                            require(body.contentType()?.toString() == "image/webp") { "Avatar is not a normalized image" }
                            require(body.contentLength() <= maxBytes) { "Avatar exceeds its image limit" }
                            body.byteStream().use { input -> readProfileImage(input, maxBytes) { check(continuation.isActive) } }
                        }
                        if (continuation.isActive) continuation.resume(bytes)
                    } catch (error: Exception) { if (continuation.isActive) continuation.resumeWithException(error) }
                }
            })
        }
    }
}
