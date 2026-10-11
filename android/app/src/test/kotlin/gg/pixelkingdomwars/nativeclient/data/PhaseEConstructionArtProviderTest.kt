package gg.pixelkingdomwars.nativeclient.data

import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import kotlin.coroutines.CoroutineContext

/** Provider lifetime tests only. Real IW3 metadata, deliberately FAKE lease files: no claim of
 * actual residency, successful hashing, rendered pixels, HTTP, device evidence or integration.
 * MS-A's unchanged ServiceContent tests own real producer verification. These tests must run
 * only in the content pipeline's allocated queue, together with the exact IW3 source/resource dependency. */
@OptIn(ExperimentalCoroutinesApi::class)
class PhaseEConstructionArtProviderTest {
    companion object {
        private fun fixture(name: String, sha: String): JsonObject {
            val bytes = requireNotNull(PhaseEConstructionArtProviderTest::class.java.getResourceAsStream("/iw3/$name")).use { it.readBytes() }
            assertEquals(sha, MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
            return Json.parseToJsonElement(bytes.decodeToString()).jsonObject
        }
        private val catalogue by lazy { fixture("catalogue.json", "a844d2ee5322bc687eaaea2874eb87a7df9ef2b1775171397750dce56685a5a2") }
        private val render by lazy { fixture("render-catalog.json", "f9eff00c5a8119e3aed0675d816ba5371d1634332f36a398b570c1c488988133") }
        private val manifest by lazy {
            nativeContentManifest(fixture("manifest.json", "7ce8c43ec191e9b6ba7be4d3b399c46acc3913c3ef1f06ef16209472483c981c"),
                catalogue.getValue("simVersion").jsonPrimitive.int)
        }
        private val art by lazy { requireNotNull(RendererCatalogue.serviceArt(JsonReader().parse(render.toString()))) }
        private const val BASE = "00000000-0000-4000-8000-000000000001"
        private fun base(id: String = BASE) = buildJsonObject {
            put("baseId", id)
            put("features", buildJsonObject { put("phaseEBuildings", buildJsonObject {
                put("version", 1); put("enabledTypes", JsonArray(listOf("workshop", "lodge", "market", "harvester", "berth").map(::JsonPrimitive)))
            }) })
            put("visualContext", buildJsonObject { put("version", 1); put("realmId", "frostveil"); put("artVersion", 2) })
            put("buildings", JsonArray(emptyList()))
        }
        private fun request(base: JsonObject, type: String = "lodge", catalogue: JsonObject = this.catalogue,
            render: JsonObject = this.render): PhaseEConstructionArtRequest {
            val row = render.getValue("entries").jsonArray.map { it.jsonObject }.single {
                it["type"] == JsonPrimitive(type) && it["level"] == JsonPrimitive(1)
            }
            return PhaseEConstructionArtRequest(base, catalogue, render, row, type, 1, null)
        }
        private fun selectedGroups(requests: List<PhaseEConstructionArtRequest>): Set<ServiceAtlasGroup> =
            requests.flatMap { request ->
                val appearance = constructionAppearance(request, art)
                appearance.states.keys.flatMap { state ->
                    requireNotNull(resolveServicePlan(art, appearance, state, reducedMotion = false)).groups.map(art.groups::getValue)
                }
            }.toSet()
    }

    private class Worker(private val delegate: CoroutineDispatcher) : CoroutineDispatcher() {
        private val marker = ThreadLocal<Boolean>()
        val active: Boolean get() = marker.get() == true
        override fun dispatch(context: CoroutineContext, block: Runnable) = delegate.dispatch(context, Runnable {
            val previous = marker.get(); marker.set(true)
            try { block.run() } finally { if (previous == null) marker.remove() else marker.set(previous) }
        })
    }

    private class Harness(test: TestScope) {
        val worker = Worker(StandardTestDispatcher(test.testScheduler))
        val owner = SupervisorJob()
        val account = AccountSession("synthetic-wallet-a", "https://example.invalid", testToken())
        var current = true
        var guard: () -> Unit = { check(current) { "Synthetic owner retired" } }
        val acquired = mutableListOf<String>()
        val released = mutableListOf<String>()
        var onAcquire: (String) -> Unit = {}
        var onRelease: (String) -> Unit = {}
        var failGroup: String? = null
        var prepareNull = false
        var residency: PhaseEConstructionResidency? = null
        val service = service(owner, art)
        val provider = PhaseEConstructionArtProvider(test.backgroundScope, worker = worker,
            prepare = { catalogue, render, proof ->
                assertTrue("Preparation belongs to the worker", worker.active)
                residency = proof
                if (prepareNull) null else preparePhaseEConstructionArt(catalogue, render, proof)
            })
        val base = base()
        val content = ContentState(assets = File("synthetic-not-opened"), catalogue = catalogue, renderCatalogue = render, manifest = manifest)
        fun service(owner: Job, art: PhaseEServiceArt?) = ServiceContentSession(owner, { guard() }, art) { group, checkpoint ->
            assertTrue("Lease acquisition must be dispatched off the caller", worker.active)
            checkpoint(); acquired += group
            if (group == failGroup) error("Synthetic verified source refusal")
            onAcquire(group)
            ServiceAssetLease(FileHandle(File("synthetic-not-opened", group))) {
                assertTrue("Lease release must be dispatched off the caller", worker.active)
                onRelease(group); released += group
            }
        }
        fun input(requests: List<PhaseEConstructionArtRequest> = listOf(request(base))) = PhaseEConstructionArtInput(
            account = account, owner = owner, baseId = BASE, baseSelectionGeneration = 1L,
            base = base, content = content, serviceContent = service, permitted = true,
            requests = requests, requireCurrent = { guard() })
        fun dispose() { provider.close(); service.close(); owner.cancel() }
    }

    @Test fun `initial absence and denied permission perform no acquisition`() = runTest {
        val h = Harness(this)
        try {
            assertNull(h.provider.constructionArt.value)
            h.provider.update(null); runCurrent()
            h.provider.update(h.input().copy(permitted = false)); runCurrent()
            assertNull(h.provider.constructionArt.value); assertTrue(h.acquired.isEmpty())
        } finally { h.dispose(); runCurrent() }
    }

    @Test fun `metadata is not published as resident before worker acquires every selected group`() = runTest {
        val h = Harness(this)
        try {
            val input = h.input()
            h.onAcquire = { assertNull(h.provider.constructionArt.value) }
            h.provider.update(input)
            assertNull(h.provider.constructionArt.value); assertTrue(h.acquired.isEmpty())
            runCurrent()
            val callback = requireNotNull(h.provider.constructionArt.value)
            assertTrue(callback.isAvailable(input.requests.single()))
            assertTrue(h.released.isEmpty())
            assertEquals(selectedGroups(input.requests).map { it.id }.toSet(), h.acquired.toSet())
            assertEquals(h.acquired.distinct(), h.acquired)
            assertTrue("Do not eagerly retain every catalogue group", h.acquired.size < art.groups.size)
        } finally { h.dispose(); runCurrent() }
    }

    @Test fun `all state dependencies include cross group rubble and ready effect but duplicate requests share leases`() = runTest {
        val h = Harness(this)
        try {
            val lodge = request(h.base)
            h.provider.update(h.input(listOf(lodge, lodge)))
            runCurrent()
            assertEquals(selectedGroups(listOf(lodge)).map { it.id }.toSet(), h.acquired.toSet())
            assertTrue(h.acquired.contains("pe_workshop_t1"))
            assertTrue(h.acquired.contains("pe_fx"))
            assertEquals(h.acquired.size, h.acquired.distinct().size)
        } finally { h.dispose(); runCurrent() }
    }

    @Test fun `descriptor proof compares every field and requires an owned lease`() = runTest {
        val h = Harness(this)
        try {
            val input = h.input(); h.provider.update(input); runCurrent()
            val proof = requireNotNull(h.residency)
            val group = selectedGroups(input.requests).first()
            assertTrue(proof.contains(group))
            for (changed in listOf(group.copy(atlasPath = "atlas/wrong.json"), group.copy(imagePath = "atlas/wrong.png"),
                group.copy(decodedBytes = group.decodedBytes + 4),
                group.copy(files = group.files.mapIndexed { index, pin -> if (index == 0) pin.copy(sha256 = "0".repeat(64)) else pin }),
                group.copy(files = group.files.mapIndexed { index, pin -> if (index == 0) pin.copy(size = pin.size + 1) else pin })))
                assertFalse(proof.contains(changed))
            val notLeased = art.groups.values.first { it.id !in h.acquired }
            assertFalse(proof.contains(notLeased))
        } finally { h.dispose(); runCurrent() }
    }

    @Test fun `a foreign content descriptor cannot acquire a same named group from another generation`() = runTest {
        val h = Harness(this)
        try {
            val phaseE = render.getValue("phaseE").jsonObject
            val groups = phaseE.getValue("groups").jsonArray
            val changed = JsonObject(render + ("phaseE" to JsonObject(phaseE + ("groups" to JsonArray(groups.map { raw ->
                val group = raw.jsonObject
                if (group["id"] != JsonPrimitive("pe_lodge_t1")) group else JsonObject(group + ("files" to
                    JsonArray(group.getValue("files").jsonArray.mapIndexed { index, pin ->
                        if (index == 0) JsonObject(pin.jsonObject + ("sha256" to JsonPrimitive("0".repeat(64)))) else pin
                    })))
            })))))
            val input = h.input(listOf(request(h.base, render = changed))).copy(content = h.content.copy(renderCatalogue = changed))
            h.provider.update(input); runCurrent()
            assertNull(h.provider.constructionArt.value); assertTrue(h.acquired.isEmpty())
        } finally { h.dispose(); runCurrent() }
    }

    @Test fun `missing admitted graph and missing content stay dark without IO`() = runTest {
        val h = Harness(this)
        val noGraph = h.service(h.owner, null)
        try {
            h.provider.update(h.input().copy(serviceContent = noGraph)); runCurrent()
            h.provider.update(h.input().copy(content = ContentState())); runCurrent()
            assertNull(h.provider.constructionArt.value); assertTrue(h.acquired.isEmpty())
        } finally { noGraph.close(); h.dispose(); runCurrent() }
    }

    @Test fun `failed later acquisition releases already owned groups and publishes nothing`() = runTest {
        val h = Harness(this)
        try {
            h.onAcquire = { if (h.acquired.size == 1) h.failGroup = selectedGroups(h.input().requests).first { group -> group.id != it }.id }
            h.provider.update(h.input()); runCurrent()
            assertNull(h.provider.constructionArt.value)
            assertTrue(h.acquired.size >= 2)
            assertEquals(h.acquired.filter { it != h.failGroup }.sorted(), h.released.sorted())
        } finally { h.dispose(); runCurrent() }
    }

    @Test fun `permission loss clears flow and invalidates captured callbacks before lease retirement`() = runTest {
        val h = Harness(this)
        try {
            val input = h.input(); h.provider.update(input); runCurrent()
            val old = requireNotNull(h.provider.constructionArt.value)
            val proof = requireNotNull(h.residency)
            h.onRelease = { assertNull(h.provider.constructionArt.value); assertFalse(proof.isCurrent()) }
            h.provider.update(input.copy(permitted = false))
            assertNull(h.provider.constructionArt.value)
            assertFalse(old.isAvailable(input.requests.single()))
            assertTrue(h.released.isEmpty())
            runCurrent(); assertEquals(h.acquired.sorted(), h.released.sorted())
            h.onRelease = {}; h.provider.update(input); runCurrent()
            assertNotSame(old, h.provider.constructionArt.value)
            assertTrue(requireNotNull(h.provider.constructionArt.value).isAvailable(input.requests.single()))
        } finally { h.dispose(); runCurrent() }
    }

    @Test fun `account wallet base selection content and producer replacement each invalidate old observation synchronously`() = runTest {
        val h = Harness(this)
        try {
            val original = h.input()
            val otherBase = base("00000000-0000-4000-8000-000000000002")
            val otherRender = JsonObject(render.toMap())
            val otherSession = h.service(h.owner, art)
            val variants = listOf(
                original.copy(account = AccountSession(original.account.wallet, original.account.origin, testToken())),
                original.copy(account = AccountSession("synthetic-wallet-b", original.account.origin, testToken())),
                original.copy(baseId = otherBase.getValue("baseId").jsonPrimitive.content, base = otherBase, requests = listOf(request(otherBase))),
                original.copy(baseSelectionGeneration = original.baseSelectionGeneration + 1),
                original.copy(content = original.content.copy(renderCatalogue = otherRender), requests = listOf(request(h.base, render = otherRender))),
                original.copy(serviceContent = otherSession),
            )
            try {
                for (replacement in variants) {
                    h.provider.update(original); runCurrent()
                    val old = requireNotNull(h.provider.constructionArt.value)
                    h.provider.update(replacement)
                    assertNull(h.provider.constructionArt.value)
                    assertFalse(old.isAvailable(original.requests.single()))
                    h.provider.update(null); runCurrent()
                }
            } finally { otherSession.close() }
        } finally { h.dispose(); runCurrent() }
    }

    @Test fun `retired owner guard and retired producer close cached admission even before mount catches up`() = runTest {
        val h = Harness(this)
        try {
            val input = h.input(); h.provider.update(input); runCurrent()
            val callback = requireNotNull(h.provider.constructionArt.value)
            h.current = false
            assertFalse(callback.isAvailable(input.requests.single()))
            h.current = true; h.service.close()
            assertFalse(callback.isAvailable(input.requests.single()))
        } finally { h.dispose(); runCurrent() }
    }

    @Test fun `owner cancellation darkens immediately while another owner child is still cleaning up`() = runTest {
        val h = Harness(this)
        val releaseCleanup = CompletableDeferred<Unit>()
        val slowSibling = CoroutineScope(h.owner + UnconfinedTestDispatcher(testScheduler)).launch {
            try { awaitCancellation() } finally { withContext(NonCancellable) { releaseCleanup.await() } }
        }
        try {
            val input = h.input(); h.provider.update(input); runCurrent()
            val callback = requireNotNull(h.provider.constructionArt.value)
            h.owner.cancel()
            assertFalse(h.owner.isCompleted)
            assertNull(h.provider.constructionArt.value)
            assertFalse(callback.isAvailable(input.requests.single()))
            runCurrent(); assertEquals(h.acquired.sorted(), h.released.sorted())
        } finally { releaseCleanup.complete(Unit); slowSibling.join(); h.dispose(); runCurrent() }
    }

    @Test fun `late old acquisition cannot publish after replacement and its returned lease is released`() = runTest {
        val h = Harness(this)
        try {
            val original = h.input()
            val otherBase = base("00000000-0000-4000-8000-000000000002")
            val next = original.copy(baseId = otherBase.getValue("baseId").jsonPrimitive.content,
                base = otherBase, baseSelectionGeneration = original.baseSelectionGeneration + 1,
                requests = listOf(request(otherBase)))
            var replaced = false
            h.onAcquire = {
                if (!replaced) { replaced = true; h.provider.update(next); assertNull(h.provider.constructionArt.value) }
            }
            h.provider.update(original); runCurrent()
            assertTrue(replaced)
            val callback = requireNotNull(h.provider.constructionArt.value)
            assertTrue(callback.isAvailable(next.requests.single()))
            assertFalse(callback.isAvailable(original.requests.single()))
            assertTrue("The returned stale acquisition is not leaked", h.released.isNotEmpty())
            h.provider.update(null); runCurrent()
            assertEquals(h.acquired.sorted(), h.released.sorted())
        } finally { h.dispose(); runCurrent() }
    }

    @Test fun `revocation during acquisition cannot publish and releases the returned lease`() = runTest {
        val h = Harness(this)
        try {
            h.onAcquire = { h.current = false }
            h.provider.update(h.input()); runCurrent()
            assertNull(h.provider.constructionArt.value)
            assertFalse(h.acquired.isEmpty())
            assertEquals(h.acquired.sorted(), h.released.sorted())
        } finally { h.dispose(); runCurrent() }
    }

    @Test fun `a foreign base or content request is refused before opening any group`() = runTest {
        val h = Harness(this)
        try {
            val selected = request(h.base)
            for (foreign in listOf(selected.copy(base = base()),
                selected.copy(catalogue = JsonObject(catalogue.toMap())),
                selected.copy(renderCatalogue = JsonObject(render.toMap())))) {
                h.provider.update(h.input(listOf(foreign))); runCurrent()
                assertNull(h.provider.constructionArt.value)
                assertTrue(h.acquired.isEmpty())
            }
        } finally { h.dispose(); runCurrent() }
    }

    @Test fun `callback rejects another base object and every content object from another observation`() = runTest {
        val h = Harness(this)
        try {
            val input = h.input(); h.provider.update(input); runCurrent()
            val callback = requireNotNull(h.provider.constructionArt.value)
            val selected = input.requests.single()
            assertFalse(callback.isAvailable(selected.copy(base = JsonObject(h.base.toMap()))))
            assertFalse(callback.isAvailable(selected.copy(catalogue = JsonObject(catalogue.toMap()))))
            assertFalse(callback.isAvailable(selected.copy(renderCatalogue = JsonObject(render.toMap()))))
            assertTrue(callback.isAvailable(selected))
        } finally { h.dispose(); runCurrent() }
    }

    @Test fun `request snapshots cannot add groups or change the bound selection during worker scheduling`() = runTest {
        val h = Harness(this)
        try {
            val selected = mutableListOf(request(h.base))
            val expected = selectedGroups(selected).map { it.id }.toSet()
            h.provider.update(h.input(selected))
            selected.clear(); selected += request(h.base, "harvester")
            runCurrent()
            assertEquals(expected, h.acquired.toSet())
            assertTrue(requireNotNull(h.provider.constructionArt.value).isAvailable(request(h.base)))
        } finally { h.dispose(); runCurrent() }
    }

    @Test fun `null preparation and explicit close release once and a closed provider cannot reopen`() = runTest {
        val h = Harness(this)
        try {
            h.prepareNull = true; h.provider.update(h.input()); runCurrent()
            assertNull(h.provider.constructionArt.value)
            assertEquals(h.acquired.sorted(), h.released.sorted())
            h.prepareNull = false; h.provider.update(h.input()); runCurrent()
            val callback = requireNotNull(h.provider.constructionArt.value)
            h.provider.close(); h.provider.close()
            assertNull(h.provider.constructionArt.value)
            assertFalse(callback.isAvailable(h.input().requests.single()))
            runCurrent(); assertEquals(h.acquired.sorted(), h.released.sorted())
            val acquired = h.acquired.toList()
            h.provider.update(h.input()); runCurrent()
            assertNull(h.provider.constructionArt.value); assertEquals(acquired, h.acquired)
        } finally { h.dispose(); runCurrent() }
    }
}
