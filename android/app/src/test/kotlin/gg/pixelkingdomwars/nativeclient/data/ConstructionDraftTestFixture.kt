package gg.pixelkingdomwars.nativeclient.data

import androidx.lifecycle.viewModelScope
import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Identity
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.ui.InterruptedActions
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomViewModel
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import java.io.Closeable
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.CoroutineContext

/** Test-only orchestration. Exact IW3 metadata, fake never-opened lease paths, no HTTP/device/IO.
 * Source.acquire uses runBlocking, so bounded real workers keep a held lease off the test thread.
 * At most two workers, no polling/sleep, bounded waits, and every fixture closes in finally. */
internal object ConstructionDraftFixtures {
    private fun fixture(name: String, sha: String): JsonObject {
        val bytes = requireNotNull(javaClass.getResourceAsStream("/iw3/$name")).use { it.readBytes() }
        assertEquals(sha, MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
        return Json.parseToJsonElement(bytes.decodeToString()).jsonObject
    }
    val catalogue by lazy { fixture("catalogue.json", "a844d2ee5322bc687eaaea2874eb87a7df9ef2b1775171397750dce56685a5a2") }
    val render by lazy { fixture("render-catalog.json", "f9eff00c5a8119e3aed0675d816ba5371d1634332f36a398b570c1c488988133") }
    val manifest by lazy { nativeContentManifest(fixture("manifest.json", "7ce8c43ec191e9b6ba7be4d3b399c46acc3913c3ef1f06ef16209472483c981c"), catalogue.getValue("simVersion").jsonPrimitive.int) }
    val art by lazy { requireNotNull(RendererCatalogue.serviceArt(JsonReader().parse(render.toString()))) }
    fun raw(revision: Int = 1, id: String = BASE_ID, enabled: Boolean = true, featureVersion: Int = 1): JsonObject =
        json("""{"baseId":"$id","revision":$revision,
          "visualContext":{"version":1,"realmId":"frostveil","artVersion":2},
          "player":{"wallet":"$WALLET","keepLevel":3,"builders":1,"expansions":0},
          "claim":{"min":8,"max":22},"freeBuilders":1,
          "buildings":[{"id":"facility","type":"workshop","level":1,"tx":10,"ty":12,"underConstruction":false}],
          "obstacles":[],"jobs":[],
          "features":{"phaseEBuildings":{"version":$featureVersion,"enabledTypes":${if (enabled) "[\"workshop\"]" else "[]"}}}}""")
}

internal class ConstructionDraftGate(val fail: Boolean = false) {
    val entered = CompletableFuture<Unit>()
    val release = CompletableDeferred<Unit>()
    var task: ConstructionDraftWorker.Task? = null
}

internal class ConstructionDraftWorker : CoroutineDispatcher(), Closeable {
    class Task(val block: Runnable) {
        val done = CompletableFuture<Unit>()
        fun await() { done.get(10, TimeUnit.SECONDS) }
    }
    private val queue = ConcurrentLinkedQueue<Runnable>()
    private val executor = Executors.newFixedThreadPool(2) { runnable ->
        Thread(runnable, "construction-draft-test-worker").apply { isDaemon = true }
    }
    private val started = mutableListOf<Task>()
    override fun dispatch(context: CoroutineContext, block: Runnable) { queue.add(block) }
    val queued: Boolean get() = queue.isNotEmpty()
    private fun start(): Task {
        val task = Task(requireNotNull(queue.poll()) { "Expected queued worker task" })
        started += task
        executor.execute {
            try { task.block.run(); task.done.complete(Unit) }
            catch (failure: Throwable) { task.done.completeExceptionally(failure) }
        }
        return task
    }
    fun drain() {
        repeat(64) { if (!queued) return; start().await() }
        error("Unexpected unbounded worker scheduling")
    }
    fun enter(gate: ConstructionDraftGate) {
        repeat(64) {
            val task = start()
            CompletableFuture.anyOf(task.done, gate.entered).get(10, TimeUnit.SECONDS)
            if (gate.entered.isDone) { gate.task = task; return }
            task.await()
        }
        error("Expected one held acquisition")
    }
    override fun close() {
        try { started.forEach { it.await() }; drain() }
        finally { executor.shutdownNow(); check(executor.awaitTermination(10, TimeUnit.SECONDS)) }
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
internal class ConstructionDraftHarness(private val test: TestScope, admitted: Boolean = true) : Closeable {
    val worker = ConstructionDraftWorker()
    val owner = SupervisorJob()
    val session = AccountSession(WALLET, "https://example.invalid", testToken())
    val account = MutableStateFlow(AccountState(phase = AccountPhase.SIGNED_IN, session = session,
        identity = Identity(WALLET), selectedBaseId = BASE_ID, baseSelectionGeneration = 1))
    val base = FakeBaseRepository().also { it._state.value = BaseState(base = BaseSnapshot.from(ConstructionDraftFixtures.raw())) }
    val content = FakeContentRepository(ConstructionDraftFixtures.catalogue, ConstructionDraftFixtures.render, File("synthetic-not-opened"))
        .also { it.set { state -> state.copy(manifest = ConstructionDraftFixtures.manifest) } }
    val originalContent = content.state.value
    val interlock = MutableStateFlow(RaidInterlockState(known = true))
    val sink = ConstructionContentAdmissions()
    val token = Any()
    private val gates = mutableListOf<ConstructionDraftGate>()
    private val nextGate = AtomicReference<ConstructionDraftGate?>()
    val acquired = ConcurrentLinkedQueue<String>()
    val released = ConcurrentLinkedQueue<String>()
    @Volatile var holderCurrent = true
    private val services = mutableListOf<ServiceContentSession>()
    val source = newSource()
    lateinit var provider: PhaseEConstructionArtProvider
        private set
    lateinit var binding: PhaseEConstructionArtBinding
        private set
    val model: KingdomViewModel
    private var revision = 1
    init {
        if (admitted) admit()
        model = KingdomViewModel(base, content, ReceiptObserver(PendingIntentStore(MemoryStore())),
            InterruptedActions({}, {}, {}), versionCode = 1, wallet = WALLET,
            deedInterlock = interlock, accountState = account,
            constructionRuntimeFactory = { scope, selected, selectedNow ->
                provider = PhaseEConstructionArtProvider(scope, worker)
                binding = PhaseEConstructionArtBinding(scope, session, owner, account, base.state,
                    content.state, sink, selected, selectedNow, interlock, 1,
                    requireSession = { check(holderCurrent) }, update = provider::update)
                PhaseEConstructionRuntime(provider.constructionArt, provider.preparation)
            })
    }
    fun newSource(): ServiceContentSession = ServiceContentSession(owner, {}, ConstructionDraftFixtures.art) { group, checkpoint ->
        checkpoint(); acquired.add(group)
        nextGate.getAndSet(null)?.let { gate ->
            gate.entered.complete(Unit)
            // Models a slow source returning after cancellation; all waits are released by finally.
            withContext(NonCancellable) { gate.release.await() }
            if (gate.fail) error("Synthetic terminal preparation refusal")
        }
        checkpoint()
        ServiceAssetLease(FileHandle(File("synthetic-not-opened", group))) { released.add(group) }
    }.also { services += it }
    fun admit(service: ServiceContentSession = source) {
        sink.beginOwner(token); sink.setSource(token, session, content.state.value, service); sink.permission(token, true)
    }
    fun main() { test.testScheduler.runCurrent() }
    fun settle() {
        repeat(8) { main(); if (!worker.queued) return; worker.drain() }
        main(); check(!worker.queued) { "Unexpected repeated preparation" }
    }
    fun ready() {
        settle()
        assertEquals(PhaseEConstructionPreparation.READY, provider.preparation.value?.phase)
        assertNotNull(provider.constructionArt.value)
    }
    fun startDraft() {
        ready(); model.openBuildMenu(); main()
        model.startPlacement("workshop"); main(); model.pickTile(15f, 17f); main()
        assertEquals(15 to 17, requireNotNull(model.state.value.placement).tile)
    }
    fun refresh(raw: JsonObject = ConstructionDraftFixtures.raw(++revision)) { base._state.value = BaseState(base = BaseSnapshot.from(raw)) }
    fun holdNext(fail: Boolean = false): ConstructionDraftGate = ConstructionDraftGate(fail).also {
        check(nextGate.compareAndSet(null, it)); gates += it
    }
    fun beginRefresh(fail: Boolean = false): ConstructionDraftGate {
        val gate = holdNext(fail); refresh(); main()
        assertEquals(PhaseEConstructionPreparation.PREPARING, provider.preparation.value?.phase)
        assertNull(provider.constructionArt.value)
        worker.enter(gate); main()
        return gate
    }
    fun finish(gate: ConstructionDraftGate) { gate.release.complete(Unit); requireNotNull(gate.task).await(); settle() }
    fun context(): PhaseEConstructionDraftContext = requireNotNull(provider.preparation.value?.context)
    fun assertNoMutation() { assertTrue(base.calls.none { it.startsWith("place:") || it.startsWith("upgrade:") }) }
    override fun close() {
        gates.forEach { it.release.complete(Unit) }
        try { binding.close(); provider.close(); sink.clear(token); services.forEach { it.close() }; owner.cancel(); model.viewModelScope.cancel(); main() }
        finally { worker.close() }
    }
}
