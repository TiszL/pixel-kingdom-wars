package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.PhaseEConstructionArtRequest
import gg.pixelkingdomwars.nativeclient.network.RaidInterlockState
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.JsonObject
import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean

/** Adapts existing pre-art snapshots to the provider. No fetch, session open or asset acquisition.
 * The captured guard rereads the live sources at dispatch, even before a combine collector runs.
 * Source retirement also pushes null synchronously through the lifecycle owner's sink. */
internal class PhaseEConstructionArtBinding(
    scope: CoroutineScope,
    private val session: AccountSession,
    private val owner: Job,
    private val account: StateFlow<AccountState>,
    private val base: StateFlow<BaseState>,
    private val content: StateFlow<ContentState>,
    private val admissions: ConstructionContentAdmissions,
    selected: Flow<String?>,
    private val selectedNow: () -> String?,
    private val interlock: StateFlow<RaidInterlockState>,
    private val versionCode: Int,
    private val requireSession: () -> Unit,
    private val update: (PhaseEConstructionArtInput?) -> Unit,
    private val demand: (JsonObject?, JsonObject?, JsonObject?, String?) -> List<PhaseEConstructionArtRequest> =
        ::phaseEConstructionRequests,
) : Closeable {
    private val closed = AtomicBoolean(false)
    private val parent = scope.coroutineContext[Job]
    private data class Read(val account: AccountState, val base: BaseState, val content: ContentState,
        val admission: ConstructionContentAdmission?, val selected: String?)
    private data class Draft(val baseId: String, val generation: Long, val content: ContentState,
        val admission: ConstructionContentAdmission, val token: PhaseEConstructionDraftContext)
    private val draftLock = Any()
    private var draft: Draft? = null
    private val listener = admissions.onInvalidated {
        if (!closed.get()) { retireDraft(); update(null) }
    }
    private var watcher: Job? = null
    private val collection = scope.launch {
        combine(account, base, content, admissions.state, selected) { a, b, c, admission, selection ->
            Read(a, b, c, admission, selection)
        }.combine(interlock) { read, _ -> read }.collect {
            ensureActive()
            if (!closed.get()) {
                // The combine event is a wake-up. Read the current pre-art snapshots again so an
                // older queued raw/selection cannot turn a same-context refresh into retirement.
                val read = Read(account.value, base.value, content.value, admissions.state.value, selectedNow())
                val result = input(read)
                if (!result.obsolete) {
                    if (result.input == null) retireDraft()
                    update(result.input)
                }
            }
        }
    }
    init {
        watcher = parent?.let { job ->
            CoroutineScope(job + Dispatchers.Unconfined).launch(start = CoroutineStart.UNDISPATCHED) {
                try { awaitCancellation() } finally { close() }
            }
        }
    }

    private data class Result(val input: PhaseEConstructionArtInput? = null, val obsolete: Boolean = false)

    private fun input(read: Read): Result = try {
        val admission = requireNotNull(read.admission)
        val snapshot = requireNotNull(read.base.base)
        val baseId = requireNotNull(read.account.selectedBaseId)
        val raw = snapshot.raw
        val generation = read.account.baseSelectionGeneration
        val contextGuard = {
            check(!closed.get() && owner.isActive && parent?.isActive != false)
            requireSession()
            val currentAccount = account.value
            check(currentAccount.phase == AccountPhase.SIGNED_IN && currentAccount.session === session &&
                currentAccount.wallet == session.wallet && currentAccount.selectedBaseId == baseId &&
                currentAccount.baseSelectionGeneration == generation)
            val currentBase = base.value.base
            check(currentBase?.baseId == baseId)
            val currentContent = content.value
            check(currentContent.ready && currentContent.allowsGameOrders(versionCode) &&
                constructionContentGenerationMatches(currentContent, read.content) &&
                constructionContentGenerationMatches(currentContent, admission.content))
            check(admission.account === session && admissions.isCurrent(admission))
            check(interlock.value.actionsAllowed)
        }
        val guard = {
            contextGuard()
            check(base.value.base?.raw === raw)
            check(selectedNow() == read.selected)
        }
        // Captured snapshots must match as well: a newer state may already be waiting in combine.
        check(read.account.phase == AccountPhase.SIGNED_IN && read.account.session === session &&
            read.account.wallet == session.wallet && snapshot.baseId == baseId && baseId.isNotBlank())
        guard()
        val requests = demand(raw, read.content.catalogue, read.content.renderCatalogue, read.selected)
        if (requests.isEmpty()) Result() else {
            guard()
            val token = draftToken(baseId, generation, read.content, admission, contextGuard)
            guard(); check(token.isCurrent())
            Result(PhaseEConstructionArtInput(session, owner, baseId, generation, raw, read.content,
                admission.serviceContent, admission.permitted, requests, guard, token))
        }
    } catch (_: Exception) {
        // A newer event is already queued. Keep only local intent through that scheduling gap;
        // its live context guard and the full art guard still refuse real owner/gate retirement.
        val token = synchronized(draftLock) { draft?.token }
        Result(obsolete = snapshotChanged(read) && token?.isCurrent() == true)
    }

    private fun snapshotChanged(read: Read): Boolean =
        account.value !== read.account || base.value.base?.raw !== read.base.base?.raw ||
            content.value !== read.content || admissions.state.value !== read.admission || selectedNow() != read.selected

    private fun draftToken(baseId: String, generation: Long, content: ContentState,
        admission: ConstructionContentAdmission, guard: () -> Unit): PhaseEConstructionDraftContext {
        val before = synchronized(draftLock) { draft }
        val reusable = before != null && before.baseId == baseId && before.generation == generation &&
            before.admission === admission && constructionContentGenerationMatches(before.content, content) && before.token.isCurrent()
        return synchronized(draftLock) {
            if (draft === before && reusable) requireNotNull(before).token
            else {
                draft?.token?.retire()
                PhaseEConstructionDraftContext(guard).also { token -> draft = Draft(baseId, generation, content, admission, token) }
            }
        }
    }

    private fun retireDraft() = synchronized(draftLock) { draft?.token?.retire(); draft = null }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        retireDraft()
        update(null)
        listener.close()
        collection.cancel()
        watcher?.cancel()
    }
}

/** Status/notice changes are not a new admitted generation. Order retirement is checked separately. */
internal fun constructionContentGenerationMatches(a: ContentState, b: ContentState): Boolean =
    a.assets == b.assets && a.catalogue === b.catalogue && a.renderCatalogue === b.renderCatalogue &&
        a.manifest === b.manifest
