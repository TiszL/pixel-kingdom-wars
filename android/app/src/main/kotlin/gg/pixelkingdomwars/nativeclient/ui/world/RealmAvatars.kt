package gg.pixelkingdomwars.nativeclient.ui.world

import android.graphics.BitmapFactory
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import gg.pixelkingdomwars.nativeclient.data.ProfileBounds
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/**
 * The realm map's name-tag pictures. Owner 2026-09-26, Seeker code 31: "on this range only player profile picture and
 * name should be visible". A tag shows its player's own profile image when the feed carries one ([RealmHudBase.avatarUrl]),
 * else the game's default profile portrait. 82c91fc drew the same castle art in every tag instead.
 *
 * Bounded, and every tag on screen still gets its picture:
 *  - at most [LOADS] fetches at once. A tag over the cap WAITS for a slot, it is not dropped: a tag asks once, from its
 *    LaunchedEffect, and never asks again while it stays on screen (integration review of 560fe54: 12 of 16 tags kept
 *    the default portrait on a still map). A tag that leaves the screen cancels its wait or its fetch;
 *  - one fetch per picture: a second tag with the same picture (one player, several kingdoms) waits for the first,
 *    and takes the load over if the first tag leaves;
 *  - a transient failure (network, timeout, 5xx, 429, the catalogue or the session not ready yet) is retried after
 *    [BACKOFF_MS], at most that many times, and not remembered: a tag that comes back asks again. Only a definite
 *    miss ([permanent]: a 404/410, or a response that is not a usable image) is remembered, and only until [clear];
 *  - at most [HELD] pictures kept, the least recently SHOWN dropped first ([image] marks a picture shown), so a picture
 *    still on screen is never the one dropped and re-downloaded (owner: "smoothness first").
 * [clear] ends the map visit (the world stops): every picture, every remembered miss and every running load goes, and
 * [visit] changes so a tag still composed asks again in the next visit. Only the server's own avatar path is ever
 * fetched ([accepts], the chat avatars' rule in `ChatRepository.avatar`), never a URL from anywhere else. [fetch] loads
 * and decodes one picture. UI thread only; [shown] and [visit] are snapshot state, so a tag redraws when they change.
 */
internal class RealmAvatars<T : Any>(private val fetch: suspend (String) -> T) {
    private val shown = mutableStateMapOf<String, T>()
    /** [shown]'s paths, least recently shown first. */
    private val recency = LinkedHashSet<String>()
    /** The load running for a path; completed when it ends, however it ends. */
    private val loading = HashMap<String, CompletableDeferred<Unit>>()
    private val missing = HashSet<String>()
    private val slots = Semaphore(LOADS)

    /** The map visit; [clear] starts a new one. A tag keys its load on it, so a load the visit's end dropped runs again. */
    var visit by mutableIntStateOf(0)
        private set

    /** The picture for [path], or null (none, not loaded yet, or failed): the tag then draws the default portrait. */
    fun image(path: String?): T? = path?.let { p -> shown[p]?.also { if (recency.remove(p)) recency.add(p) } }

    /** Loads [path] until it is shown, definitely missing, or its transient retries run out; see the class rules. */
    suspend fun load(path: String) {
        if (!accepts(path)) return
        val visit = this.visit
        while (true) {
            if (visit != this.visit || path in shown || path in missing) return
            val running = loading[path] ?: break
            running.await() // another tag is fetching this picture; look again once it ends (it may have left)
        }
        val done = CompletableDeferred<Unit>(); loading[path] = done
        try {
            for (attempt in 0..BACKOFF_MS.size) {
                val error = slots.withPermit {
                    if (visit != this.visit) return
                    try { hold(path, fetch(path), visit); return }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (e: Exception) { e }
                }
                if (visit != this.visit) return
                if (permanent(error)) { missing += path; return }
                if (attempt == BACKOFF_MS.size) return
                val asked = ((error as? ApiException)?.retryAfterSeconds ?: 0L) * 1_000L
                delay(maxOf(BACKOFF_MS[attempt], asked).coerceAtMost(BACKOFF_MS.last()))
            }
        } finally {
            if (loading[path] === done) loading.remove(path)
            done.complete(Unit)
        }
    }

    /** Ends the map visit: drops every picture, remembered miss and running load (a late result is discarded). */
    fun clear() {
        visit++
        shown.clear(); recency.clear(); missing.clear()
        val ended = loading.values.toList(); loading.clear(); ended.forEach { it.complete(Unit) }
    }

    private fun hold(path: String, picture: T, visit: Int) {
        if (visit != this.visit) return
        shown[path] = picture; recency.remove(path); recency.add(path)
        while (recency.size > HELD) recency.first().let { recency.remove(it); shown.remove(it) }
    }

    /** A picture that did not decode, or does not fit the catalogue's avatar bounds: not a transient failure. */
    class Unusable(message: String) : Exception(message)

    companion object {
        /** More than the 16 tags the map shows at once, so a picture on screen always fits beside the new ones. */
        const val HELD = 32
        const val LOADS = 4
        /** The waits before each retry of a transient failure (a server's Retry-After is honoured up to the last). */
        val BACKOFF_MS = longArrayOf(1_000, 4_000, 15_000, 30_000)
        private val PATH = Regex("/api/avatars/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\.webp")
        fun accepts(path: String): Boolean = PATH.matches(path)

        /** A definite miss: the server has no such picture (404/410), or what it sent is not a usable image (the wrong
         *  type, oversized or empty, [ApiCompatibilityException]; or [Unusable]). Anything else may pass: retry it. */
        fun permanent(error: Exception): Boolean =
            (error is ApiException && error.status in intArrayOf(404, 410)) || error is ApiCompatibilityException || error is Unusable

        /** Decodes a downloaded avatar within the catalogue's bounds (as the profile and chat avatars do), at half size:
         *  a tag's picture is 22 to 34 dp, and the server's image is [ProfileBounds.imageSize] px. */
        fun decode(bytes: ByteArray, bounds: ProfileBounds): ImageBitmap {
            val size = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, size)
            if (size.outWidth !in 1..bounds.imageSize || size.outHeight !in 1..bounds.imageSize) throw Unusable("Avatar is outside its bounds")
            val half = BitmapFactory.Options().apply { inSampleSize = 2 }
            return (BitmapFactory.decodeByteArray(bytes, 0, bytes.size, half) ?: throw Unusable("Avatar did not decode")).asImageBitmap()
        }
    }
}
