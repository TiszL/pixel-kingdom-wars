package gg.pixelkingdomwars.nativeclient.data

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import okhttp3.*

/** The same fixed allowlist as production AboutLegalPane; never accepts a supplied URL. */
enum class LegalDocument(val label: String, val url: String, val title: String) {
    TERMS("Terms of Use", "https://pixelkingdomwars.com/terms", "Pixel Kingdom Wars Terms of Use"),
    PRIVACY("Privacy Policy", "https://pixelkingdomwars.com/privacy", "Pixel Kingdom Wars Privacy Policy")
}
object GameSupport {
    const val EMAIL = "support@pixelkingdomwars.com"
    const val DISCORD = "https://discord.gg/PWb65fg3mN"
    fun mailto(wallet: String?): String {
        val subject = "Pixel Kingdom Wars support" + wallet?.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()
        return "mailto:$EMAIL?subject=" + java.net.URLEncoder.encode(subject, Charsets.UTF_8.name()).replace("+", "%20")
    }
}

/** Public document transport has its own client, with no cookie jar, authentication, cache,
 * redirects or connection to GameApi/Privy. The call factory seam is only for isolated tests. */
class PublicLegalDocuments internal constructor(private val calls: Call.Factory) {
    constructor() : this(OkHttpClient.Builder().cookieJar(CookieJar.NO_COOKIES).cache(null)
        .authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE)
        .followRedirects(false).followSslRedirects(false).callTimeout(20, TimeUnit.SECONDS).build())
    companion object {
        // Transport memory ceiling, not a gameplay number. Published HTML is currently below 40 KB.
        const val MAX_BYTES = 1_048_576
    }
    suspend fun load(document: LegalDocument): String = suspendCancellableCoroutine { continuation ->
        val call = calls.newCall(Request.Builder().url(document.url).header("Accept", "text/html").get().build())
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
            override fun onResponse(call: Call, response: Response) {
                try {
                    val html = response.use {
                        check(it.code == 200) { "Published document is unavailable (${it.code})." }
                        val body = requireNotNull(it.body)
                        val type = body.contentType()
                        require(type?.type == "text" && type.subtype == "html" && type.charset(Charsets.UTF_8) == Charsets.UTF_8) { "The published document format changed." }
                        require(body.contentLength() <= MAX_BYTES) { "The published document exceeds the reader limit." }
                        val output = ByteArrayOutputStream()
                        body.byteStream().use { input ->
                            val buffer = ByteArray(8192)
                            while (true) {
                                if (!continuation.isActive) throw CancellationException()
                                val count = input.read(buffer); if (count < 0) break
                                require(output.size() + count <= MAX_BYTES) { "The published document exceeds the reader limit." }
                                output.write(buffer, 0, count)
                            }
                        }
                        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                            .decode(ByteBuffer.wrap(output.toByteArray())).toString().also { text -> require(text.isNotBlank()) { "The published document is empty." } }
                    }
                    if (continuation.isActive) continuation.resume(html)
                } catch (error: Exception) { if (continuation.isActive) continuation.resumeWithException(error) }
            }
        })
    }
}

data class LegalState(val document: LegalDocument = LegalDocument.TERMS, val html: String? = null,
    val loading: Boolean = false, val error: String? = null)
class LegalRepository(private val offline: Boolean = false, private val fetch: suspend (LegalDocument) -> String = PublicLegalDocuments()::load) {
    private val mutable = MutableStateFlow(LegalState()); val state = mutable.asStateFlow()
    private var generation = 0L
    fun close() { generation++; mutable.update { it.copy(loading = false) } }
    suspend fun load(document: LegalDocument, force: Boolean = false) {
        if (!force && mutable.value.document == document && mutable.value.html != null) return
        val ticket = ++generation
        mutable.update { LegalState(document, it.html.takeIf { _ -> it.document == document }, loading = true) }
        try {
            check(!offline) { "Published legal text needs a connection. The canonical browser links remain available." }
            val html = fetch(document); currentCoroutineContext().ensureActive()
            if (ticket == generation) mutable.value = LegalState(document, html)
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) {
            if (ticket == generation) mutable.update { it.copy(error = if (offline) "Offline preview: connect to read the complete published document."
                else "The published document could not be loaded. Retry or use its canonical browser link." ) }
        } finally { if (ticket == generation) mutable.update { it.copy(loading = false) } }
    }
}

/** Adds a restrictive policy before any remote HTML. The document text is retained verbatim;
 * platform settings and request interception independently disable all active/network content. */
internal fun legalReaderHtml(html: String): String = """<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'">""" +
    // The published site's empty-alt decorative logo cannot load in the static reader.
    // Hide that placeholder only; retain the complete document and all network restrictions.
    """<style>img.site-logo[alt=""]{display:none!important}</style>""" + html
