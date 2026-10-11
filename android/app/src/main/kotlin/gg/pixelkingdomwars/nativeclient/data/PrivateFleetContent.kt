package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.NativeContentManifest
import gg.pixelkingdomwars.nativeclient.renderer.PhaseEFleetArt
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAtlasGroup
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.io.File
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean

/** N-C5 CONTENT17 (local preparation under I4/D153.249): a PRIVATE, owner-bound opener for the accepted candidate17
 *  metadata. It composes ONLY existing seams — the canonical manifest decoder (identity, supported SIM, ordered
 *  files, fixed core paths), the accepted [PhaseEFleetArt.parse] (the whole exact renderer17 root), the EXISTING
 *  [ServiceContent.session] (manifest-bound optional-file leases, 68 disjoint service + fleet descriptors) and the
 *  EXISTING [ServiceArtPermission] (revision-ordered capability observation). It adds no downloader, store, parser,
 *  capability reader. NR-5 reuses only verified immutable metadata for the published-directory opener; permission and
 *  lease ownership remain per open. This opener proves no hosted bytes, pixels, residency, readiness or visible journey.
 *
 *  Ownership rules: the explicit [PrivateFleetCandidate] names the content the caller selected; the three metadata
 *  inputs are SNAPSHOTTED (bounded) before any suspension, and the SAME snapshots are authenticated and parsed; the
 *  caller's exact-owner guard runs before and after suspension; a failure or cancellation before the handle is
 *  returned closes whatever was created; the returned handle retires both the session and the permission together. */
data class PrivateFleetCandidate(val contentVersion: String, val simVersion: Int) {
    init { require(contentVersion.matches(Regex("[a-f0-9]{64}")) && simVersion > 0) { "A private candidate is named by its content digest and SIM" } }
}

/** One owned private result: the explicit candidate, the parsed renderer17 capability, the EXISTING lease session (its
 *  [ServiceContentSession.art] is the same parsed service graph) and the EXISTING permission observation (false until a
 *  current refresh observes the capability). [close] retires both; coordinated callers fence observations
 *  immediately and defer physical cleanup through their admission owner. Legacy callers retain direct owner
 *  cancellation. Nothing here is a readiness flag or a cache. */
class PrivateFleetHandle internal constructor(val candidate: PrivateFleetCandidate, val manifest: NativeContentManifest, val fleet: PhaseEFleetArt,
    val session: ServiceContentSession, private val permission: ServiceArtPermission, descriptors: Map<String, ServiceAtlasGroup>,
    private val retirement: ServiceContentRetirement? = null) : Closeable {
    private val closed = AtomicBoolean()
    /** The tiny owned cancellation child (see [bindOwner]); cancelled on explicit close. */
    private var watcher: Job? = null
    /** A contained failure of the caller's permission sink while retiring (its dark publication threw). Retirement of the
     *  observer and the session still completed; no claim is made that a throwing sink received false. */
    @Volatile var publicationFailure: Throwable? = null
        private set
    /** The 47 service/cosmetics + 21 fleet descriptors the session validated against the manifest; registration only. */
    val descriptors: Map<String, ServiceAtlasGroup> = Collections.unmodifiableMap(LinkedHashMap(descriptors))
    val retired: Boolean get() = closed.get() || retirement?.requested == true
    /** Observe the current capability through the EXISTING permission: it publishes false first, then the observed value
     *  only if this revision is still current and the composed owner/caller/session guard still holds. Retired handles
     *  observe nothing. */
    suspend fun refreshPermission() { if (!retired) permission.refresh() }
    /** Bind retirement to the supplied owner's CANCELLATION START, not its terminal completion: a tiny owned child of the
     *  owner (public API only) waits for cancellation and retires in its `finally`. Children are cancelled the moment the
     *  owner starts cancelling, so a prior positive goes dark and the source dies even while another child is still
     *  draining its own cleanup. Launched undispatched on Unconfined: binding on an already-cancelled owner runs the
     *  `finally` synchronously here, so a dead owner can never receive a live handle. Explicit close cancels this child;
     *  retirement is idempotent, so the child's own `finally` then does nothing. */
    internal fun bindOwner(owner: Job) {
        // The activity bound the coordinated watcher before asynchronous open. Adding another
        // watcher here would restore the direct-close race this retirement seam removes.
        if (retirement != null) {
            if (!owner.isActive) retirement.requestRetirement()
            return
        }
        watcher = CoroutineScope(owner + Dispatchers.Unconfined).launch(start = CoroutineStart.UNDISPATCHED) {
            try { awaitCancellation() } finally { retire(dispose = false) }
        }
    }
    /** ONE retirement for explicit close, open failure and owner cancellation: the observer is closed (clearing any prior
     *  positive and suppressing pending/next positives) and the session is ALWAYS closed afterwards, whatever the sink does. */
    private fun retire(dispose: Boolean) {
        if (!closed.compareAndSet(false, true)) return
        retirement?.let { it.requestRetirement(); return }
        if (dispose) watcher?.cancel()
        try { permission.close() } catch (failure: Throwable) { publicationFailure = failure } finally { session.close() }
    }
    override fun close() = retire(dispose = true)
}

class PrivateFleetContent internal constructor(private val content: ServiceContent, private val cache: PrivateFleetParseCache) {
    constructor(content: ServiceContent) : this(content, PrivateFleetParseCache.process)

    /** Open the explicit [candidate] from the three metadata inputs for [owner]. Refuses (before any HTTP) a different
     *  identity or SIM, a manifest or render root that is not renderer17, catalogue/render bytes that are not the
     *  manifest's core pins, a catalogue of another generation, a semantically invalid graph, and descriptors whose pins
     *  are not optional members of the same manifest. [publishPermission] receives false immediately on success. */
    suspend fun open(candidate: PrivateFleetCandidate, manifestBytes: ByteArray, catalogueBytes: ByteArray, renderBytes: ByteArray,
        api: ApiClient, owner: Job, requireCurrent: () -> Unit, publishPermission: (Boolean) -> Unit): PrivateFleetHandle {
        // Bounded owned snapshots BEFORE any suspension: the existing manifest bound, and metadata capped before hashing
        // (each must then EQUAL its core pin exactly). A caller mutating its arrays afterwards changes nothing here.
        require(manifestBytes.size in 1..MANIFEST_BOUND) { "Private candidate manifest exceeds the manifest bound" }
        require(catalogueBytes.size in 1..METADATA_BOUND && renderBytes.size in 1..METADATA_BOUND) { "Private candidate metadata exceeds the bound" }
        val manifestSnapshot = manifestBytes.copyOf(); val catalogueSnapshot = catalogueBytes.copyOf(); val renderSnapshot = renderBytes.copyOf()
        // Arbitrary caller bytes NEVER consult or seed the published-directory cache.
        return openOwned(candidate, api, owner, requireCurrent, publishPermission, residentRoot = null) { consume ->
            consume(cache.verify(candidate, manifestSnapshot, catalogueSnapshot, renderSnapshot))
        }
    }

    /** [directory] is an immutable generation already published by ContentRepository. Only the
     * cached data is shared: this call always creates a fresh lease session and dark permission
     * observer. On a miss, its own raw manifest and both pinned metadata files must verify first.
     * The same selected directory supplies core service residency through MS-A's session overload. */
    internal suspend fun open(candidate: PrivateFleetCandidate, directory: File, manifest: NativeContentManifest,
        api: ApiClient, owner: Job, requireCurrent: () -> Unit, publishPermission: (Boolean) -> Unit): PrivateFleetHandle {
        val published = manifest.copy(files = Collections.unmodifiableList(manifest.files.toList()))
        return openOwned(candidate, api, owner, requireCurrent, publishPermission, residentRoot = directory) { consume ->
            cache.published(directory, published, candidate, { requireCurrent(); owner.ensureActive() }, consume)
        }
    }

    /** The caller reserves an open ticket and binds its account watcher before this suspension.
     * Every resource registers with that owner before the ticket can settle. */
    internal suspend fun open(candidate: PrivateFleetCandidate, directory: File, manifest: NativeContentManifest,
        api: ApiClient, owner: Job, retirement: ServiceContentRetirement,
        requireCurrent: () -> Unit, publishPermission: (Boolean) -> Unit): PrivateFleetHandle {
        val published = manifest.copy(files = Collections.unmodifiableList(manifest.files.toList()))
        return openOwned(candidate, api, owner, requireCurrent, publishPermission, directory, retirement) { consume ->
            cache.published(directory, published, candidate, { requireCurrent(); owner.ensureActive() }, consume)
        }
    }

    private suspend fun openOwned(candidate: PrivateFleetCandidate, api: ApiClient, owner: Job,
        requireCurrent: () -> Unit, publishPermission: (Boolean) -> Unit, residentRoot: File?,
        retirement: ServiceContentRetirement? = null,
        parsed: suspend ((PrivateFleetParseCache.Parsed) -> Opened) -> Opened): PrivateFleetHandle {
        requireCurrent(); owner.ensureActive(); currentCoroutineContext().ensureActive()
        var session: ServiceContentSession? = null
        var permission: ServiceArtPermission? = null
        try {
            val opened = withContext(Dispatchers.IO) {
                requireCurrent(); ensureActive()
                parsed { admitted ->
                    requireCurrent(); ensureActive()
                    // Every open validates the descriptors and creates a NEW session. Only data enters the cache.
                    // Byte-array callers have no verified resident directory and retain the original
                    // optional-only overload. The published path passes its EXACT selected assets root;
                    // MS-A's overload independently verifies/copies any core groups into leased stores.
                    val opened = if (retirement != null) {
                        content.session(admitted.manifest, admitted.descriptors, api, owner,
                            admitted.fleet.services, residentRoot, retirement, requireCurrent)
                    } else if (residentRoot == null) {
                        content.session(admitted.manifest, admitted.descriptors, api, owner, admitted.fleet.services, requireCurrent)
                    } else {
                        content.session(admitted.manifest, admitted.descriptors, api, owner, admitted.fleet.services, residentRoot, requireCurrent)
                    }.also { session = it }
                    Opened(admitted.manifest, admitted.fleet, opened, admitted.descriptors)
                }
            }
            // After suspension: the supplied owner must still be active, the caller/candidate guard must hold and the SPECIFIC
            // opened session must still be current (never a dead session with a live observer).
            currentCoroutineContext().ensureActive(); owner.ensureActive(); requireCurrent()
            require(opened.manifest.contentVersion == candidate.contentVersion) // the same immutable snapshot; the guard above is the owner's
            require(opened.session.assets.isCurrent()) { "Private fleet session is no longer current" }
            // The observer's guard is COMPOSED: supplied owner active + exact caller/candidate guard + this session current.
            val guard = { requireCurrent(); owner.ensureActive(); if (!opened.session.assets.isCurrent()) throw CancellationException("Private fleet session is no longer current") }
            val observation = ServiceArtPermission(api, guard, publishPermission).also {
                permission = it
                retirement?.beforeSourceClose(it::close)
            }
            val handle = PrivateFleetHandle(candidate, opened.manifest, opened.fleet, opened.session,
                observation, opened.descriptors, retirement)
            session = null; permission = null // the handle now owns both; its retirement is unconditional
            try {
                handle.bindOwner(owner) // race-safe: an owner cancelled meanwhile retires the handle synchronously here
                owner.ensureActive(); requireCurrent(); require(opened.session.assets.isCurrent()) { "Private fleet session is no longer current" }
                publishPermission(false) // permission starts dark; only a current refresh can turn it on (a throwing sink fails the open)
                return handle
            } catch (failure: Throwable) { handle.close(); throw failure }
        } finally {
            // Cancellation or failure before the hand-off cleans both — the session ALWAYS, whatever the sink does on close.
            if (retirement != null) {
                // No await here: the caller still holds the open ticket which cleanup must await.
                if (permission != null || session != null) retirement.requestRetirement()
            } else {
                try { permission?.close() } catch (_: Throwable) { /* contained: no claim that a throwing sink received false */ }
                finally { session?.close() }
            }
        }
    }

    private class Opened(val manifest: NativeContentManifest, val fleet: PhaseEFleetArt, val session: ServiceContentSession, val descriptors: Map<String, ServiceAtlasGroup>)

    companion object {
        /** The private renderer17 identity; never a global admission value. */
        const val CONTRACT = 17
        /** The existing remote-manifest bound (ServiceContent.acquire) reused for the caller's manifest bytes. */
        const val MANIFEST_BOUND = 16 * 1024 * 1024
        /** A hard cap before hashing caller metadata; the exact size is then the manifest's core pin. */
        const val METADATA_BOUND = 64 * 1024 * 1024
    }
}
