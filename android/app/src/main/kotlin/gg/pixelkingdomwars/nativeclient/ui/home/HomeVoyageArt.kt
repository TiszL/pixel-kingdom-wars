package gg.pixelkingdomwars.nativeclient.ui.home

import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.ContentState
import gg.pixelkingdomwars.nativeclient.data.WorldContentSession
import gg.pixelkingdomwars.nativeclient.ui.phasee.loadOrdinaryRouteCrop
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LocalVoyageArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RouteUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageArtSource
import gg.pixelkingdomwars.nativeclient.vehicle.OrdinaryRouteCrop
import gg.pixelkingdomwars.nativeclient.vehicle.OrdinaryRoutes
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.withContext

/*
 * The voyage cluster's route-art source on Home (SPEC §0.3, §0.4, §3 Assets, §4 "art missing", §12 item 7). The mount
 * provides it as LocalVoyageArt around the Lodge / Berth body and around the Home overlay host (the collect card):
 *
 * - a route card is its 320 px cell of the installed chain atlas (OrdinaryRoutes.crop), drawn with nearest sampling;
 * - an island cutout is that card × the chain's `-detail-mask.png`, by the globe's own land rule (FantasyGlobeRenderer
 *   ISLAND_FRAGMENT: a texel is land when its red byte is exactly 1), so no card edge ever shows on a header's sea;
 * - while art loads, and when it cannot load, the stand-in that was in scope draws instead (a card that cannot load shows
 *   "Island art loading", the SPEC §4 art-missing state). Never a blank, never the bare card rectangle in a header;
 * - the world-content session (the same one phasee/OrdinaryRouteArt.kt reuses) is open only while a card or cutout that
 *   is not decoded yet is composed, and closes when the last one is decoded or leaves. Decoded art stays in a small LRU
 *   for as long as the host lives, so reopening a tab or the picker needs no session at all.
 *
 * The header shore stays the stand-in coast: the live-world crop around the Lodge needs renderer work (owner note).
 */

/** Decoded crops kept per host. The route picker shows every island at once; the rest is headroom for cutouts. */
internal const val HOME_VOYAGE_ART_CACHE_SIZE = 40

/**
 * The route-art source for the voyage sheets and the collect card. [routes] reads the installed island catalogue (the
 * vehicle owner's policy); it is called only until it first answers, then remembered for this content generation.
 */
@Composable internal fun rememberHomeVoyageArt(graph: AppGraph, session: SessionGraph, routes: () -> OrdinaryRoutes?): VoyageArtSource {
    val fallback = LocalVoyageArt.current
    val content by graph.content.state.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val currentRoutes by rememberUpdatedState(routes)
    val art = remember(content.assets, HomeVoyageSame(content.catalogue), HomeVoyageSame(content.renderCatalogue)) {
        HomeVoyageArtHolder(content) { currentRoutes() }
    }
    DisposableEffect(art) { onDispose { art.clear() } }
    // `active` is read here, not in composition, so a tile starting or finishing a decode never recomposes the host.
    LaunchedEffect(art, session, lifecycle) {
        snapshotFlow { art.users.active }.collectLatest { active ->
            if (active) lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { art.hold(graph, session) }
        }
    }
    return remember(art, fallback) {
        VoyageArtSource(
            routeCard = { route, modifier -> HomeVoyageRouteArt(art, fallback, route, modifier, cutout = false) },
            routeCutout = { route, modifier -> HomeVoyageRouteArt(art, fallback, route, modifier, cutout = true) },
        )
    }
}

/**
 * Who needs the world-content session right now: every route card or cutout still waiting for its decode holds one
 * token. [active] is false at zero users; a token released twice, or never acquired, changes nothing.
 */
internal class HomeVoyageArtUsers {
    private val tokens = HashSet<Any>()
    var active: Boolean by mutableStateOf(false)
        private set

    fun acquire(): Any = Any().also { tokens.add(it); active = true }

    fun release(token: Any) {
        if (tokens.remove(token)) active = tokens.isNotEmpty()
    }
}

/** A small least-recently-used map; reading an entry makes it the most recent. Safe to touch from any thread. */
internal class HomeVoyageArtCache<K : Any, V : Any>(private val limit: Int) {
    private val map = object : java.util.LinkedHashMap<K, V>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<K, V>?): Boolean = size > limit
    }

    operator fun get(key: K): V? = synchronized(map) { map[key] }

    fun put(key: K, value: V) {
        synchronized(map) { map[key] = value }
    }

    fun clear() {
        synchronized(map) { map.clear() }
    }

    val size: Int get() = synchronized(map) { map.size }
}

/** The installed crop of [routeId], or null with no catalogue or an id the catalogue does not know (never throws). */
internal fun homeVoyageCrop(routes: OrdinaryRoutes?, routeId: String): OrdinaryRouteCrop? =
    routes?.let { runCatching { it.crop(routeId) }.getOrNull() }

/** The chain mask beside the detail atlas: same group, same atlas size, same cell. */
internal fun voyageCutoutMaskCrop(crop: OrdinaryRouteCrop): OrdinaryRouteCrop =
    crop.copy(path = crop.path.removeSuffix("-detail.png") + "-detail-mask.png")

/** FantasyGlobeRenderer's island rule (ISLAND_FRAGMENT `u_mask`): a chain-mask texel is land when its red byte is exactly 1. */
internal fun voyageMaskIsLand(argb: Int): Boolean = ((argb ushr 16) and 0xFF) == 1

/** Card × mask, texel by texel: land keeps the card's texel, everything else becomes fully transparent. */
internal fun voyageCutoutPixels(card: IntArray, mask: IntArray): IntArray {
    require(card.size == mask.size) { "Route card and chain mask crops differ in size" }
    return IntArray(card.size) { i -> if (voyageMaskIsLand(mask[i])) card[i] else 0 }
}

/** One decoded crop: the card itself, or its cutout. */
private data class HomeVoyageArtKey(val crop: OrdinaryRouteCrop, val cutout: Boolean)

/** A remember key compared by reference: a deep equals of the render catalogue on every host recomposition is waste. */
private class HomeVoyageSame(private val value: Any?) {
    override fun equals(other: Any?): Boolean = other is HomeVoyageSame && other.value === value
    override fun hashCode(): Int = System.identityHashCode(value)
}

/** One content generation's art: the refcount, the session it gates, the decoded crops and the catalogue lookups. */
private class HomeVoyageArtHolder(val content: ContentState, private val routes: () -> OrdinaryRoutes?) {
    val users = HomeVoyageArtUsers()
    var source: WorldContentSession? by mutableStateOf<WorldContentSession?>(null)
        private set
    /** The last attempt to open the session failed; waiting tiles show the art-missing stand-in. */
    var failed: Boolean by mutableStateOf(false)
        private set
    private val cache = HomeVoyageArtCache<HomeVoyageArtKey, ImageBitmap>(HOME_VOYAGE_ART_CACHE_SIZE)
    private val crops = HashMap<String, OrdinaryRouteCrop>()
    private var catalogue: OrdinaryRoutes? = null

    /** Parsing the policy is not free, so the catalogue and each crop are looked up once per generation. */
    fun key(routeId: String, cutout: Boolean): HomeVoyageArtKey? {
        val crop = crops[routeId] ?: run {
            val installed = catalogue ?: runCatching { routes() }.getOrNull()?.also { catalogue = it }
            homeVoyageCrop(installed, routeId)?.also { crops[routeId] = it }
        }
        return crop?.let { HomeVoyageArtKey(it, cutout) }
    }

    fun cached(key: HomeVoyageArtKey): ImageBitmap? = cache[key]

    fun clear() {
        cache.clear()
    }

    /** Holds the session until cancelled, exactly like OrdinaryRouteArtwork: a failure reads as "no art", never a crash. */
    suspend fun hold(graph: AppGraph, session: SessionGraph) {
        failed = false
        try {
            val acquired = graph.worldContent.open(content, session.api)
            try {
                currentCoroutineContext().ensureActive()
                source = acquired
                awaitCancellation()
            } finally {
                if (source === acquired) source = null
                acquired.close()
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            source = null
            failed = true
        }
    }

    /** Decodes off the main thread (loadOrdinaryRouteCrop runs on IO, the mask pass on Default) and remembers the result. */
    suspend fun load(open: WorldContentSession, key: HomeVoyageArtKey): ImageBitmap {
        cache[key]?.let { return it }
        val cardKey = key.copy(cutout = false)
        val card = cache[cardKey] ?: loadOrdinaryRouteCrop(open, content, key.crop).also { cache.put(cardKey, it) }
        if (!key.cutout) return card
        val mask = loadOrdinaryRouteCrop(open, content, voyageCutoutMaskCrop(key.crop))
        return homeVoyageCutout(card, mask).also { cache.put(key, it) }
    }
}

private sealed interface HomeVoyageLoad {
    object Loading : HomeVoyageLoad
    object Failed : HomeVoyageLoad
    class Ready(val bitmap: ImageBitmap) : HomeVoyageLoad
}

@Composable private fun HomeVoyageRouteArt(art: HomeVoyageArtHolder, fallback: VoyageArtSource, route: RouteUi, modifier: Modifier, cutout: Boolean) {
    val key = art.key(route.routeId, cutout)
    if (key == null) { HomeVoyageStandIn(fallback, route, modifier, cutout, missing = true); return }
    val cached = art.cached(key)
    if (cached != null) HomeVoyageBitmap(cached, modifier) else HomeVoyageRouteLoad(art, fallback, route, modifier, key)
}

/** A crop that is not decoded yet: it holds the session while it waits, then draws the art or the art-missing stand-in. */
@Composable private fun HomeVoyageRouteLoad(art: HomeVoyageArtHolder, fallback: VoyageArtSource, route: RouteUi, modifier: Modifier,
    key: HomeVoyageArtKey) {
    var load by remember(art, key) { mutableStateOf<HomeVoyageLoad>(HomeVoyageLoad.Loading) }
    val source = art.source
    if (load === HomeVoyageLoad.Loading) {
        DisposableEffect(art, key) {
            val token = art.users.acquire()
            onDispose { art.users.release(token) }
        }
    }
    LaunchedEffect(art, source, key) {
        if (source == null || load !== HomeVoyageLoad.Loading) return@LaunchedEffect
        load = try {
            HomeVoyageLoad.Ready(art.load(source, key))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            HomeVoyageLoad.Failed
        }
    }
    when (val shown = load) {
        is HomeVoyageLoad.Ready -> HomeVoyageBitmap(shown.bitmap, modifier)
        else -> HomeVoyageStandIn(fallback, route, modifier, key.cutout, missing = shown === HomeVoyageLoad.Failed || art.failed)
    }
}

/**
 * The stand-in that was in scope. A card that cannot load shows "Island art loading" (SPEC §4 art missing); a cutout keeps
 * the stand-in island shape, which has no card edge.
 */
@Composable private fun HomeVoyageStandIn(fallback: VoyageArtSource, route: RouteUi, modifier: Modifier, cutout: Boolean, missing: Boolean) {
    if (cutout) fallback.routeCutout(route, modifier)
    else fallback.routeCard(if (missing) route.copy(artAvailable = false) else route, modifier)
}

/** A decoded crop scaled into the box with nearest sampling (SPEC §0.4: 2:1 at 80 dp tiles, 4:1 at 40 dp thumbs). */
@Composable private fun HomeVoyageBitmap(bitmap: ImageBitmap, modifier: Modifier) {
    Canvas(modifier) {
        val scale = minOf(size.width / bitmap.width, size.height / bitmap.height)
        val w = (bitmap.width * scale).roundToInt().coerceAtLeast(1)
        val h = (bitmap.height * scale).roundToInt().coerceAtLeast(1)
        drawImage(bitmap, srcOffset = IntOffset.Zero, srcSize = IntSize(bitmap.width, bitmap.height),
            dstOffset = IntOffset(((size.width - w) / 2f).roundToInt(), ((size.height - h) / 2f).roundToInt()), dstSize = IntSize(w, h),
            filterQuality = FilterQuality.None)
    }
}

/** Card × chain mask (SPEC §0.3), built from the two decoded cells off the main thread. */
private suspend fun homeVoyageCutout(card: ImageBitmap, mask: ImageBitmap): ImageBitmap = withContext(Dispatchers.Default) {
    require(card.width == mask.width && card.height == mask.height) { "Route card and chain mask crops differ in size" }
    val cardPixels = IntArray(card.width * card.height).also { card.readPixels(it) }
    val maskPixels = IntArray(mask.width * mask.height).also { mask.readPixels(it) }
    ensureActive()
    Bitmap.createBitmap(voyageCutoutPixels(cardPixels, maskPixels), card.width, card.height, Bitmap.Config.ARGB_8888).asImageBitmap()
}
