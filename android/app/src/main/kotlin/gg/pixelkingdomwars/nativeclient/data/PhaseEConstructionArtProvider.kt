package gg.pixelkingdomwars.nativeclient.data

import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.network.PhaseEConstructionArt
import gg.pixelkingdomwars.nativeclient.network.PhaseEConstructionArtRequest
import gg.pixelkingdomwars.nativeclient.renderer.RendererCatalogue
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAssetLease
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAtlasGroup
import gg.pixelkingdomwars.nativeclient.renderer.resolveServicePlan
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.Closeable
import java.util.Collections

/** The lifecycle owner supplies the existing admitted session and its existing permission
 * observation. This consumer never opens a session, observes capabilities, or owns the source.
 * JSON objects are the admitted repository snapshots; the small request list is copied by update. */
internal data class PhaseEConstructionArtInput(
    val account: AccountSession,
    val owner: Job,
    val baseId: String,
    val baseSelectionGeneration: Long,
    val base: JsonObject,
    val content: ContentState,
    val serviceContent: ServiceContentSession,
    val permitted: Boolean,
    val requests: List<PhaseEConstructionArtRequest>,
    val requireCurrent: () -> Unit,
    val draftContext: PhaseEConstructionDraftContext? = null,
)

/** Retains only groups selected for the current base's construction requests. Admission reads
 * remain synchronous and IO-free; all preparation/acquisition/release is dispatched to worker.
 * The lock orders revocation against publication and lease transfer, including reentrant source
 * checkpoints. Neither a caller guard nor a lease/source method is invoked while holding it. */
internal class PhaseEConstructionArtProvider(
    private val scope: CoroutineScope,
    private val worker: CoroutineDispatcher = Dispatchers.IO,
    private val prepare: (JsonObject, JsonObject, PhaseEConstructionResidency) -> PhaseEConstructionArt? =
        ::preparePhaseEConstructionArt,
) : Closeable {
    private val lock = Any()
    private val mutableArt = MutableStateFlow<PhaseEConstructionArt?>(null)
    val constructionArt: StateFlow<PhaseEConstructionArt?> = mutableArt.asStateFlow()
    private val mutablePreparation = MutableStateFlow<PhaseEConstructionPreparationState?>(null)
    val preparation: StateFlow<PhaseEConstructionPreparationState?> = mutablePreparation.asStateFlow()
    private var closed = false
    private var current: Generation? = null
    private val parent = scope.coroutineContext[Job]

    private class Owned(val descriptor: ServiceAtlasGroup, val lease: ServiceAssetLease)
    private class Generation(val input: PhaseEConstructionArtInput) {
        @Volatile var guard: () -> Unit = input.requireCurrent
        var retired = false // lock
        var work: Job? = null // lock
        var watcher: Job? = null // lock
        val owned = linkedMapOf<String, Owned>() // lock
    }
    private data class Retirement(val work: Job?, val watcher: Job?, val leases: List<ServiceAssetLease>)

    // Public coroutine API: cancellation START revokes even if another child is still draining.
    // The same rule is used by PrivateFleetHandle.bindOwner; there is no new background poller.
    private val parentWatcher: Job? = parent?.let { owner ->
        CoroutineScope(owner + Dispatchers.Unconfined).launch(start = CoroutineStart.UNDISPATCHED) {
            try { awaitCancellation() } finally { close() }
        }
    }

    /** Equivalent observations do not discard live leases solely because a collector created a
     * new checkpoint lambda. The latest equivalent guard replaces the old guard atomically.
     * Actual account/base/content/source/request/permission changes synchronously publish null. */
    fun update(input: PhaseEConstructionArtInput?) {
        synchronized(lock) { if (closed) return }
        val snapshot = input?.copy(requests = Collections.unmodifiableList(input.requests.toList()))
        val eligible = snapshot?.let(::ownershipCurrent) == true
        val next: Generation?
        val retirement: Retirement?
        synchronized(lock) {
            if (closed) return
            val previous = current
            // Ownership can retire between the unlocked guard and this lock. Recheck only
            // atomic lifetime fences here; never call a supplied guard/source under the lock.
            val stillEligible = eligible && snapshot != null && snapshot.owner.isActive && parent?.isActive != false &&
                snapshot.draftContext?.isRetired() != true
            if (stillEligible && snapshot != null && previous != null && !previous.retired && equivalent(previous.input, snapshot)) {
                previous.guard = snapshot.requireCurrent
                return
            }
            next = snapshot?.takeIf { stillEligible }?.let(::Generation)
            // Same-context raw/selection changes replace leases without destroying local intent.
            // Actual context loss is permanent, even if flow collectors conflate this transition.
            if (previous?.input?.draftContext !== next?.input?.draftContext) previous?.input?.draftContext?.retire()
            retirement = previous?.let(::retireLocked)
            current = next
            mutablePreparation.value = next?.let { PhaseEConstructionPreparationState(
                it.input.draftContext, it.input.base, PhaseEConstructionPreparation.PREPARING) }
            // Reentrant flow collectors must already see the old generation as retired.
            mutableArt.value = null
        }
        dispose(retirement)
        if (next == null) return

        val work = scope.launch(worker, start = CoroutineStart.LAZY) { prepareGeneration(next) }
        val installWork = synchronized(lock) {
            if (!closed && current === next && !next.retired) { next.work = work; true } else false
        }
        if (!installWork) { work.cancel(); return }
        val watcher = CoroutineScope(next.input.owner + Dispatchers.Unconfined).launch(start = CoroutineStart.UNDISPATCHED) {
            try { awaitCancellation() } finally { retire(next) }
        }
        val installWatcher = synchronized(lock) {
            if (!closed && current === next && !next.retired) { next.watcher = watcher; true } else false
        }
        if (!installWatcher) watcher.cancel()
        work.start()
    }

    private suspend fun prepareGeneration(generation: Generation) {
        var published = false
        try {
            val input = generation.input
            checkpoint(generation)
            require(input.content.ready && input.requests.isNotEmpty())
            require(input.baseId.isNotBlank() && input.base["baseId"] == JsonPrimitive(input.baseId))
            val catalogue = requireNotNull(input.content.catalogue)
            val render = requireNotNull(input.content.renderCatalogue)
            val manifest = requireNotNull(input.content.manifest)
            require(input.content.simVersion == manifest.simVersion &&
                catalogue["sourceCommit"] == JsonPrimitive(manifest.sourceCommit))
            val admitted = requireNotNull(input.serviceContent.art)
            require(input.requests.all { request -> request.base === input.base &&
                request.catalogue === catalogue && request.renderCatalogue === render })

            // Parse with the SAME renderer parser. This authenticates the selected descriptors
            // against the supplied render object rather than assuming a shared group id means
            // identical content. No files/textures/second content loader are involved.
            val selectedArt = requireNotNull(RendererCatalogue.serviceArt(JsonReader().parse(render.toString())))
            val selected = linkedMapOf<String, ServiceAtlasGroup>()
            for (request in input.requests) {
                checkpoint(generation)
                val appearance = constructionAppearance(request, selectedArt)
                for (state in appearance.states.keys) {
                    val plan = requireNotNull(resolveServicePlan(selectedArt, appearance, state, reducedMotion = false))
                    for (id in plan.groups) {
                        val descriptor = selectedArt.groups.getValue(id)
                        require(admitted.groups[id] == descriptor) { "Construction art differs from admitted service content" }
                        val ownedDescriptor = descriptor.copy(files = Collections.unmodifiableList(descriptor.files.toList()))
                        val previous = selected.putIfAbsent(id, ownedDescriptor)
                        require(previous == null || previous == ownedDescriptor)
                    }
                }
            }
            require(selected.isNotEmpty())
            checkpoint(generation)
            // Every selected descriptor has been checked before the first acquisition. File
            // verification and independent generation ownership belong to this exact source.
            for ((id, descriptor) in selected) {
                checkpoint(generation)
                var returned: ServiceAssetLease? = input.serviceContent.assets.acquire(id) { checkpoint(generation) }
                try {
                    checkpoint(generation)
                    synchronized(lock) {
                        checkLocked(generation)
                        check(generation.owned.put(id, Owned(descriptor, requireNotNull(returned))) == null)
                        returned = null // one transfer: retirement now owns release
                    }
                } finally { returned?.close() } // already on worker, including late returns
            }
            val proof = object : PhaseEConstructionResidency {
                override fun isCurrent(): Boolean = this@PhaseEConstructionArtProvider.isCurrent(generation)
                override fun contains(group: ServiceAtlasGroup): Boolean {
                    if (!this@PhaseEConstructionArtProvider.isCurrent(generation)) return false
                    val exact = synchronized(lock) {
                        current === generation && !generation.retired &&
                            generation.owned[group.id]?.descriptor == group
                    }
                    return exact && this@PhaseEConstructionArtProvider.isCurrent(generation)
                }
            }
            val admission = prepare(catalogue, render, proof) ?: return
            checkpoint(generation)
            val callback = PhaseEConstructionArt { request ->
                try {
                    request.base === input.base && request.catalogue === catalogue && request.renderCatalogue === render &&
                        isCurrent(generation) && admission.isAvailable(request) && isCurrent(generation)
                } catch (_: Exception) { false }
            }
            synchronized(lock) {
                checkLocked(generation)
                // Owner jobs can cancel without taking our lock. The watcher revokes on start;
                // these non-blocking checks also prevent the obvious already-cancelled publish.
                check(input.owner.isActive && parent?.isActive != false)
                mutablePreparation.value = PhaseEConstructionPreparationState(
                    input.draftContext, input.base, PhaseEConstructionPreparation.READY)
                mutableArt.value = callback
                published = true
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* Ordinary refusal keeps this generation dark; no content/action fallback. */ }
        finally { if (!published) retire(generation, refused = true) }
    }

    /** This checkpoint is also called by ServiceAssetSource's own acquisition job. Folding in
     * the provider's job prevents that nested job from outliving cancelled construction work. */
    private fun checkpoint(generation: Generation) {
        val work = synchronized(lock) { checkLocked(generation); generation.work }
        // A successfully completed preparation job leaves live owned leases. Only cancellation
        // retires that job's observation; successful completion must not darken its callback.
        if (work?.isCancelled == true) throw CancellationException("Construction preparation cancelled")
        generation.input.owner.ensureActive()
        parent?.ensureActive()
        if (generation.input.draftContext?.isCurrent() == false) throw CancellationException("Construction draft context retired")
        generation.guard()
        if (!generation.input.serviceContent.assets.isCurrent()) throw CancellationException("Construction source retired")
        synchronized(lock) { checkLocked(generation) }
    }

    private fun isCurrent(generation: Generation): Boolean = try {
        checkpoint(generation)
        true
    } catch (_: Exception) { false } // Never hide fatal VM/errors; unknown ownership is closed.

    private fun ownershipCurrent(input: PhaseEConstructionArtInput): Boolean = try {
        if (!input.permitted || !input.owner.isActive || parent?.isActive == false || input.draftContext?.isCurrent() == false) false
        else { input.requireCurrent(); input.serviceContent.assets.isCurrent() }
    } catch (_: Exception) { false }

    private fun checkLocked(generation: Generation) {
        if (closed || current !== generation || generation.retired)
            throw CancellationException("Construction observation retired")
    }

    /** Called only under lock, before any cancellation or resource disposal. */
    private fun retireLocked(generation: Generation): Retirement {
        generation.retired = true
        val retirement = Retirement(generation.work, generation.watcher, generation.owned.values.map { it.lease })
        generation.owned.clear()
        generation.work = null
        generation.watcher = null
        return retirement
    }

    private fun retire(generation: Generation, refused: Boolean = false) {
        val retirement = synchronized(lock) {
            if (generation.retired) return
            val retirement = retireLocked(generation)
            if (current === generation) {
                generation.input.draftContext?.retire()
                current = null
                mutablePreparation.value = if (refused && generation.input.owner.isActive && parent?.isActive != false)
                    PhaseEConstructionPreparationState(generation.input.draftContext, generation.input.base, PhaseEConstructionPreparation.REFUSED)
                else null
                mutableArt.value = null
            }
            retirement
        }
        dispose(retirement)
    }

    private fun dispose(retirement: Retirement?) {
        if (retirement == null) return
        try {
            try { retirement.work?.cancel() } catch (_: Exception) { /* Still release owned handles. */ }
        } finally {
            try {
                try { retirement.watcher?.cancel() } catch (_: Exception) { /* Still release owned handles. */ }
            } finally { release(retirement.leases) }
        }
    }

    private fun release(leases: List<ServiceAssetLease>) {
        if (leases.isEmpty()) return
        // A finite release task must survive cancellation of the owner and caller scopes.
        // It cannot acquire, publish, retry, or restart anything; no persistent cleanup loop.
        CoroutineScope(NonCancellable + worker).launch {
            leases.forEach { lease ->
                try { lease.close() } catch (_: Exception) { /* Release the remaining handles too. */ }
            }
        }
    }

    override fun close() {
        val retirement = synchronized(lock) {
            if (closed) return
            closed = true
            current?.input?.draftContext?.retire()
            mutablePreparation.value = null
            mutableArt.value = null
            current?.let(::retireLocked).also { current = null }
        }
        dispose(retirement)
        parentWatcher?.cancel()
    }

    private fun equivalent(a: PhaseEConstructionArtInput, b: PhaseEConstructionArtInput): Boolean =
        a.account === b.account && a.owner === b.owner && a.baseId == b.baseId &&
            a.baseSelectionGeneration == b.baseSelectionGeneration && a.base === b.base &&
            a.content.assets == b.content.assets && a.content.catalogue === b.content.catalogue &&
            a.content.renderCatalogue === b.content.renderCatalogue && a.content.manifest === b.content.manifest &&
            a.draftContext === b.draftContext &&
            a.serviceContent === b.serviceContent && a.permitted == b.permitted &&
            a.requests.size == b.requests.size && a.requests.zip(b.requests).all { (left, right) ->
                left.base === right.base && left.catalogue === right.catalogue && left.renderCatalogue === right.renderCatalogue &&
                    left.entry === right.entry && left.type == right.type && left.level == right.level && left.buildingId == right.buildingId
            }
}
