package gg.pixelkingdomwars.nativeclient.telemetry

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import okhttp3.CookieJar
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import java.util.concurrent.TimeUnit

internal class NativeTelemetryTransport(origin: String, transport: OkHttpClient = OkHttpClient()) {
    private val base = origin.toHttpUrl().also {
        require(it.isHttps && it.encodedPath == "/" && it.encodedUsername.isEmpty() && it.encodedPassword.isEmpty() && it.query == null && it.fragment == null)
    }
    private val client = transport.newBuilder().cookieJar(CookieJar.NO_COOKIES)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(5, TimeUnit.SECONDS).callTimeout(8, TimeUnit.SECONDS).build()
    suspend fun send(batch: JsonObject) = withContext(Dispatchers.IO) {
        val bytes = batch.toString().toByteArray(Charsets.UTF_8)
        // OkHttp may follow HTTP503 Retry-After:0 even with connection retries disabled.
        // A one-shot body forbids those HTTP follow-ups as well.
        val body = object : RequestBody() {
            override fun contentType() = "application/json".toMediaType()
            override fun contentLength() = bytes.size.toLong()
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) { sink.write(bytes) }
        }
        val request = Request.Builder().url(requireNotNull(base.resolve("/api/telemetry")))
            .header("Origin", base.toString().trimEnd('/')).header("X-PKW-Client", "android-native")
            .post(body).build()
        client.newCall(request).execute().use { /* No response text, cookies or redirects are consumed. */ }
    }
}
