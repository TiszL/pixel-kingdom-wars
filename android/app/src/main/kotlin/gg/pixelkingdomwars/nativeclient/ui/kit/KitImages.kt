package gg.pixelkingdomwars.nativeclient.ui.kit

import android.content.res.Resources
import androidx.annotation.DrawableRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.imageResource

/**
 * A least-recently-used cache whose budget is decoded bytes, not entries. Pure JVM so the rule is unit-tested.
 * The newest entry is never evicted by its own insertion (one oversized image still draws).
 */
internal class ByteBoundedLru<K : Any, V : Any>(private val maxBytes: Long, private val sizeOf: (V) -> Long) {
    private val entries = LinkedHashMap<K, V>(32, 0.75f, true)
    private var bytes = 0L

    @Synchronized fun get(key: K): V? = entries[key]

    /** Stores [value] unless [key] is already cached (the first decode wins and is returned), then trims the eldest. */
    @Synchronized fun put(key: K, value: V): V {
        entries[key]?.let { return it }
        entries[key] = value
        bytes += sizeOf(value)
        val iterator = entries.entries.iterator()
        while (bytes > maxBytes && entries.size > 1 && iterator.hasNext()) {
            val eldest = iterator.next()
            if (eldest.key == key) continue
            bytes -= sizeOf(eldest.value)
            iterator.remove()
        }
        return value
    }

    /** The cached value, or [decode]d once and cached. [decode] runs OUTSIDE the lock, so a slow decode on a background
     *  thread never blocks the main thread asking for a different, already cached image. */
    fun getOrDecode(key: K, decode: () -> V): V = get(key) ?: put(key, decode())

    @Synchronized fun size(): Int = entries.size
    @Synchronized fun usedBytes(): Long = bytes
}

/**
 * Process-wide decoded kit drawables. Compose's `ImageBitmap.imageResource(id)` remembers its decode only inside the
 * calling composition, so every sheet opening decoded each of its icons again on the main thread (a sheet with thirty
 * icons paid tens of milliseconds before its first frame). A sheet now draws its art from here at once on every reopen.
 * Bundled art only (drawable-nodpi, identical in every configuration); pack sprites have their own cache (PackSprites).
 */
internal object KitImages {
    /** 24 MiB of decoded ARGB: every icon and sheet illustration a session shows fits (all bundled art is ~31 MiB, of
     *  which the two cinematic wallpapers and the title paintings are drawn through ShellImages, never through here). */
    private const val MAX_BYTES = 24L * 1024 * 1024
    private val cache = ByteBoundedLru<Int, ImageBitmap>(MAX_BYTES) { it.width.toLong() * it.height * 4 }

    fun cached(@DrawableRes id: Int): ImageBitmap? = cache.get(id)

    /** Blocking on a cache miss (a PNG decode): composition only asks for small icons; [prewarm] runs off Main. */
    fun get(resources: Resources, @DrawableRes id: Int): ImageBitmap =
        cache.getOrDecode(id) { ImageBitmap.imageResource(resources, id) }

    /** Decodes [ids] into the cache (call off the main thread). A missing or undecodable id is skipped. */
    fun prewarm(resources: Resources, ids: Iterable<Int>) {
        for (id in ids) runCatching { get(resources, id) }
    }
}

/** Drop-in for `ImageBitmap.imageResource(id)` that shares one decode per drawable across the whole app. */
@Composable internal fun kitImageResource(@DrawableRes id: Int): ImageBitmap {
    val resources = LocalContext.current.resources
    return remember(resources, id) { KitImages.get(resources, id) }
}
