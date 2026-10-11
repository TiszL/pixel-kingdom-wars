package gg.pixelkingdomwars.nativeclient.data

import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.renderer.RendererCatalogue
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAssetLease
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/** Additive regression tests. Original17 tests stay byte-identical. Historical IW3 metadata
 * is staged by the content pipeline from fixtureSOURCE.json; lease files here are deliberately never opened. */
@OptIn(ExperimentalCoroutinesApi::class)
class PhaseEConstructionArtProviderContentGenerationTest {
    companion object {
        private fun fixture(name: String, sha: String): JsonObject {
            val bytes = requireNotNull(PhaseEConstructionArtProviderContentGenerationTest::class.java
                .getResourceAsStream("/iw3/$name")).use { it.readBytes() }
            assertEquals(sha, MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
            return Json.parseToJsonElement(bytes.decodeToString()).jsonObject
        }
        private val catalogue by lazy { fixture("catalogue.json", "a844d2ee5322bc687eaaea2874eb87a7df9ef2b1775171397750dce56685a5a2") }
        private val render by lazy { fixture("render-catalog.json", "f9eff00c5a8119e3aed0675d816ba5371d1634332f36a398b570c1c488988133") }
        private val manifest by lazy { nativeContentManifest(fixture("manifest.json", "7ce8c43ec191e9b6ba7be4d3b399c46acc3913c3ef1f06ef16209472483c981c"),
            catalogue.getValue("simVersion").jsonPrimitive.int) }
        private val art by lazy { requireNotNull(RendererCatalogue.serviceArt(JsonReader().parse(render.toString()))) }
        private val base = Json.parseToJsonElement("""{"baseId":"00000000-0000-4000-8000-000000000001",
            "features":{"phaseEBuildings":{"version":1,"enabledTypes":["workshop","lodge","market","harvester","berth"]}},
            "visualContext":{"version":1,"realmId":"frostveil","artVersion":2},"buildings":[]}""").jsonObject
        private fun request(catalogue: JsonObject = this.catalogue, render: JsonObject = this.render): PhaseEConstructionArtRequest =
            PhaseEConstructionArtRequest(base, catalogue, render, render.getValue("entries").jsonArray.map { it.jsonObject }.single {
                it["type"] == JsonPrimitive("workshop") && it["level"] == JsonPrimitive(1)
            }, "workshop", 1, null)
    }

    private class Fixture(test: TestScope) {
        val owner = SupervisorJob()
        val account = AccountSession("synthetic-wallet", "https://example.invalid", testToken())
        var acquisitions = 0
        var releases = 0
        val service = ServiceContentSession(owner, {}, art) { _, checkpoint ->
            checkpoint(); acquisitions++
            ServiceAssetLease(FileHandle(File("synthetic-not-opened"))) { releases++ }
        }
        val provider = PhaseEConstructionArtProvider(test.backgroundScope, worker = StandardTestDispatcher(test.testScheduler))
        val content = ContentState(assets = File("synthetic-generation-A"), catalogue = catalogue, renderCatalogue = render, manifest = manifest)
        fun input() = PhaseEConstructionArtInput(account, owner, base.getValue("baseId").jsonPrimitive.content,
            1L, base, content, service, true, listOf(request()), {})
        fun close() { provider.close(); service.close(); owner.cancel() }
    }

    @Test fun `status only content copies and equal asset path preserve the live callback and leases`() = runTest {
        val f = Fixture(this)
        try {
            val initial = f.input(); f.provider.update(initial); runCurrent()
            val callback = requireNotNull(f.provider.constructionArt.value)
            val acquisitions = f.acquisitions
            val status = f.content.copy(assets = File(requireNotNull(f.content.assets).path), checking = true,
                error = "Synthetic update check message", contentUpdate = "candidate status", updateNotice = "Synthetic notice")
            assertNotSame(initial.content, status)
            f.provider.update(initial.copy(content = status, requireCurrent = {}))
            assertSame("Status reporting is not content retirement", callback, f.provider.constructionArt.value)
            runCurrent()
            assertSame(callback, f.provider.constructionArt.value)
            assertEquals(acquisitions, f.acquisitions); assertEquals(0, f.releases)
            assertTrue(callback.isAvailable(initial.requests.single()))
        } finally { f.close(); runCurrent() }
    }

    @Test fun `each actual content identity component retires the callback even with structurally equal metadata`() = runTest {
        val f = Fixture(this)
        try {
            val initial = f.input()
            val copiedCatalogue = JsonObject(catalogue.toMap())
            val copiedRender = JsonObject(render.toMap())
            val changed = listOf(
                initial.copy(content = f.content.copy(assets = File("synthetic-generation-B"))),
                initial.copy(content = f.content.copy(catalogue = copiedCatalogue), requests = listOf(request(catalogue = copiedCatalogue))),
                initial.copy(content = f.content.copy(renderCatalogue = copiedRender), requests = listOf(request(render = copiedRender))),
                initial.copy(content = f.content.copy(manifest = manifest.copy())),
            )
            for (next in changed) {
                f.provider.update(initial); runCurrent()
                val previous = requireNotNull(f.provider.constructionArt.value)
                f.provider.update(next)
                assertNull(f.provider.constructionArt.value)
                assertFalse(previous.isAvailable(initial.requests.single()))
                f.provider.update(null); runCurrent()
            }
        } finally { f.close(); runCurrent() }
    }

    @Test fun `an equivalent content observation adopts its latest guard without restarting leases`() = runTest {
        val f = Fixture(this)
        try {
            val initial = f.input(); f.provider.update(initial); runCurrent()
            val callback = requireNotNull(f.provider.constructionArt.value)
            val acquisitions = f.acquisitions
            var current = true
            f.provider.update(initial.copy(content = f.content.copy(checking = true), requireCurrent = { check(current) }))
            assertSame(callback, f.provider.constructionArt.value)
            runCurrent(); assertEquals(acquisitions, f.acquisitions); assertEquals(0, f.releases)
            current = false
            assertFalse("The old no-op checkpoint must not outlive the new guard", callback.isAvailable(initial.requests.single()))
        } finally { f.close(); runCurrent() }
    }
}
