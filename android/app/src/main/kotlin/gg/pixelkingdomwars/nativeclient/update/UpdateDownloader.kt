package gg.pixelkingdomwars.nativeclient.update

import gg.pixelkingdomwars.nativeclient.model.NativeUpdateOffer
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request

data class DownloadedApk(val file: File)

/** `<versionCode>-<sha256>.apk`, or its `.part` while the transfer runs: the only names [UpdateDownloader] writes. */
private val UPDATE_FILE = Regex("([0-9]{1,18})-[0-9a-f]{64}\\.apk(?:\\.part)?")

fun interface ApkDownloader {
    /** Throws [UpdateFailure]; a cancelled coroutine stops the transfer and keeps the partial file for a Range resume. */
    suspend fun download(offer: NativeUpdateOffer, url: HttpUrl, onProgress: (Long, Long) -> Unit): DownloadedApk
    /** No eligible offer remains (typically after the update installed): release the stored files. */
    fun discard() {}
    /** Release every stored file this build can never install: a version it already runs or has passed (the APK that
     * just installed it), a name this client did not write, and, when [keep] is known, any other offer's file. */
    fun prune(runningVersionCode: Long, keep: NativeUpdateOffer?) {}
}

/** App-private, resumable APK download (M45 §5) with the [gg.pixelkingdomwars.nativeclient.NativeContentUpdates]
 * transport rules: cookie-free, redirects refused, one attempt per call. Only the eligible same-origin URL is fetched. */
class UpdateDownloader(private val directory: File,
    client: OkHttpClient = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()) : ApkDownloader {
    // The download is long; bound each read, not the whole call. A player on a slow link resumes rather than restarts.
    private val client = client.newBuilder().cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).callTimeout(0, TimeUnit.SECONDS).build()

    override fun discard() { directory.listFiles()?.forEach { it.delete() } }
    override fun prune(runningVersionCode: Long, keep: NativeUpdateOffer?) {
        val kept = keep?.let { setOf(partFile(it), apkFile(it)) }
        directory.listFiles()?.forEach { file ->
            val code = UPDATE_FILE.matchEntire(file.name)?.groupValues?.get(1)?.toLongOrNull()
            if (code == null || code <= runningVersionCode || (kept != null && file !in kept)) file.delete()
        }
    }
    fun partFile(offer: NativeUpdateOffer) = File(directory, "${offer.latestVersionCode}-${offer.sha256}.apk.part")
    fun apkFile(offer: NativeUpdateOffer) = File(directory, "${offer.latestVersionCode}-${offer.sha256}.apk")

    override suspend fun download(offer: NativeUpdateOffer, url: HttpUrl, onProgress: (Long, Long) -> Unit): DownloadedApk = withContext(Dispatchers.IO) {
        val expected = offer.sizeBytes
        if (expected !in 1..MAX_UPDATE_BYTES) throw UpdateFailure(UpdateFailureKind.STORAGE, "The update is larger than this app accepts")
        val part = partFile(offer); val apk = apkFile(offer)
        if (!directory.isDirectory && !directory.mkdirs()) throw UpdateFailure(UpdateFailureKind.STORAGE, "Update storage is unavailable")
        // One offer's files at a time: an older or withdrawn offer never holds hundreds of megabytes.
        directory.listFiles()?.filter { it != part && it != apk }?.forEach { it.delete() }
        if (apk.isFile && apk.length() == expected) return@withContext DownloadedApk(apk)
        apk.delete()
        var offset = if (part.isFile) part.length() else 0L
        if (offset > expected) { part.delete(); offset = 0L }
        if (offset < expected) fetch(url, part, offset, expected, onProgress)
        if (!part.renameTo(apk)) throw UpdateFailure(UpdateFailureKind.STORAGE, "The update could not be saved")
        DownloadedApk(apk)
    }

    private suspend fun fetch(url: HttpUrl, part: File, offset: Long, expected: Long, onProgress: (Long, Long) -> Unit) {
        val context = currentCoroutineContext()
        val request = Request.Builder().url(url).header("Accept", "application/vnd.android.package-archive")
            .apply { if (offset > 0) header("Range", "bytes=$offset-") }.build()
        val response = try { client.newCall(request).execute() } catch (error: IOException) {
            throw UpdateFailure(UpdateFailureKind.NETWORK, "The update download could not connect")
        }
        response.use {
            if (response.code in 300..399) throw UpdateFailure(UpdateFailureKind.ORIGIN, "The update server tried to redirect the download")
            val start = when (response.code) {
                // Only the exact remaining range continues a partial file; a full 200 replaces it.
                206 -> if (offset > 0 && response.header("Content-Range") == "bytes $offset-${expected - 1}/$expected") offset
                    else throw UpdateFailure(UpdateFailureKind.NETWORK, "The update server answered an unexpected range")
                200 -> 0L
                416 -> { part.delete(); throw UpdateFailure(UpdateFailureKind.NETWORK, "The partial update was discarded") }
                else -> throw UpdateFailure(UpdateFailureKind.NETWORK, "The update server answered ${response.code}")
            }
            val body = requireNotNull(response.body)
            if (body.contentLength() != expected - start) throw UpdateFailure(UpdateFailureKind.NETWORK, "The update size does not match the offer")
            var written = start
            onProgress(written, expected)
            val output = try { FileOutputStream(part, start > 0) } catch (error: IOException) {
                throw UpdateFailure(UpdateFailureKind.STORAGE, "The update could not be saved")
            }
            output.use {
                val input = body.byteStream(); val buffer = ByteArray(64 * 1024)
                while (true) {
                    context.ensureActive()
                    val count = try { input.read(buffer) } catch (error: IOException) {
                        context.ensureActive(); throw UpdateFailure(UpdateFailureKind.NETWORK, "The update download was interrupted")
                    }
                    if (count < 0) break
                    if (written + count > expected) {
                        output.close(); part.delete()
                        throw UpdateFailure(UpdateFailureKind.ORIGIN, "The update server sent more than the offer")
                    }
                    try { output.write(buffer, 0, count) } catch (error: IOException) {
                        throw UpdateFailure(UpdateFailureKind.STORAGE, "The update could not be saved")
                    }
                    written += count
                    onProgress(written, expected)
                }
                try { output.fd.sync() } catch (error: IOException) { throw UpdateFailure(UpdateFailureKind.STORAGE, "The update could not be saved") }
            }
            if (written != expected) throw UpdateFailure(UpdateFailureKind.NETWORK, "The update download ended early")
        }
    }
}
