package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.FakeApiClient
import gg.pixelkingdomwars.nativeclient.network.nativeContentManifest
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger

/** Build1R regression: consume the exact historical candidate from tracked /iw3 fixtures, never a synthetic R17 catalogue.
 * The R15/R16 compatibility cases explicitly project its unchanged service metadata only. */
class ServiceContentR17Test {
    private object Pack {
        private fun pinned(name: String, size: Int, sha256: String): JsonObject {
            val bytes = requireNotNull(ServiceContentR17Test::class.java.getResourceAsStream("/iw3/$name")).use { it.readBytes() }
            assertEquals("$name byte count", size, bytes.size)
            val actual = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
            assertEquals("$name must be the unchanged Build1R tracked fixture", sha256, actual)
            return Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
        }
        val state: ContentState by lazy {
            val catalogue = pinned("catalogue.json", 305562, "a844d2ee5322bc687eaaea2874eb87a7df9ef2b1775171397750dce56685a5a2")
            val render = pinned("render-catalog.json", 8032245, "f9eff00c5a8119e3aed0675d816ba5371d1634332f36a398b570c1c488988133")
            val manifest = nativeContentManifest(pinned("manifest.json", 331173,
                "7ce8c43ec191e9b6ba7be4d3b399c46acc3913c3ef1f06ef16209472483c981c"), 18)
            assertEquals(17, render.getValue("rendererContractVersion").jsonPrimitive.int)
            ContentState(catalogue = catalogue, renderCatalogue = render, manifest = manifest)
        }
    }

    private class Harness(val content: ServiceContent, val api: FakeApiClient, val owner: Job) {
        suspend fun open(state: ContentState = Pack.state) = content.open(state, api, owner) {}
        suspend fun refuses(state: ContentState) {
            assertThrows(IllegalArgumentException::class.java) { runBlocking { open(state).close() } }
        }
    }
    private fun metadataOnly(block: suspend Harness.() -> Unit) = runBlocking {
        val root = Files.createTempDirectory("service-r17-admission").toFile()
        val requests = AtomicInteger()
        val transport = OkHttpClient.Builder().addInterceptor {
            requests.incrementAndGet(); error("Metadata admission must not perform HTTP")
        }.build()
        val owner = SupervisorJob()
        val api = FakeApiClient()
        val content = ServiceContent(root, "https://localhost/", transport = transport)
        try { Harness(content, api, owner).block() }
        finally {
            owner.cancel(); owner.children.toList().joinAll(); content.awaitLeaseReleases()
            transport.connectionPool.evictAll(); root.deleteRecursively()
            assertEquals(0, requests.get())
            assertTrue(api.gets.isEmpty() && api.posts.isEmpty() && api.puts.isEmpty() && api.patches.isEmpty() && api.deletes.isEmpty())
        }
    }
    private fun withRender(render: JsonObject) = Pack.state.copy(renderCatalogue = render)
    private fun projected(version: Int): ContentState {
        val original = requireNotNull(Pack.state.renderCatalogue)
        val withoutFleet = original - "fleetJourneys"
        val sections = if (version == 15) withoutFleet - "boundCosmetics" else withoutFleet
        val render = JsonObject(sections + ("rendererContractVersion" to JsonPrimitive(version)))
        return withRender(render)
    }

    @Test fun `bundled renderer17 opens service and cosmetics metadata without loading fleet pixels`() = metadataOnly {
        val session = open()
        session.use {
            val art = requireNotNull(it.art)
            assertEquals(47, art.groups.size)
            // Existing AppGraph publishes these to Awning admission and Wake source preview.
            // Metadata admission supplies no Wake craft/On capability and performs no application.
            assertNotNull(art.cosmetics)
            assertTrue("pe_cosmetics" in art.groups)
            assertFalse("Fleet residency remains the private fleet owner's responsibility", "pe_fleet_starter" in art.groups)
            val admitted = requireNotNull(it.admitted())
            assertSame(art, admitted.art); assertSame(it.assets, admitted.assets)
            assertTrue(it.assets.isCurrent())
        }
        assertFalse(session.assets.isCurrent())
    }

    @Test fun `valid renderer15 service graph remains admitted without cosmetics`() = metadataOnly {
        open(projected(15)).use {
            assertEquals(46, requireNotNull(it.art).groups.size)
            assertNull(requireNotNull(it.art).cosmetics)
        }
        val invalid = JsonObject(requireNotNull(projected(15).renderCatalogue) +
            ("boundCosmetics" to requireNotNull(Pack.state.renderCatalogue).getValue("boundCosmetics")))
        refuses(withRender(invalid))
    }

    @Test fun `valid renderer16 keeps its required cosmetics on the admitted service graph`() = metadataOnly {
        val state = projected(16)
        open(state).use {
            assertEquals(47, requireNotNull(it.art).groups.size)
            assertNotNull(requireNotNull(it.art).cosmetics)
        }
        refuses(withRender(JsonObject(requireNotNull(state.renderCatalogue) - "boundCosmetics")))
    }

    @Test fun `renderer17 requires service cosmetics and fleet metadata together`() = metadataOnly {
        val render = requireNotNull(Pack.state.renderCatalogue)
        for (section in listOf("phaseE", "boundCosmetics", "fleetJourneys")) {
            refuses(withRender(JsonObject(render - section)))
        }
    }

    @Test fun `renderer17 service admission cannot bypass strict fleet version or inventory checks`() = metadataOnly {
        val render = requireNotNull(Pack.state.renderCatalogue)
        val fleet = render.getValue("fleetJourneys").jsonObject
        for (invalid in listOf(
            JsonObject(fleet + ("version" to JsonPrimitive(2))),
            JsonObject(fleet + ("groups" to JsonArray(fleet.getValue("groups").jsonArray.dropLast(1))))
        )) refuses(withRender(JsonObject(render + ("fleetJourneys" to invalid))))
    }

    @Test fun `renderer17 refuses malformed cosmetics instead of dropping the extension`() = metadataOnly {
        val render = requireNotNull(Pack.state.renderCatalogue)
        val cosmetics = render.getValue("boundCosmetics").jsonObject
        refuses(withRender(JsonObject(render + ("boundCosmetics" to JsonObject(cosmetics + ("version" to JsonPrimitive(2)))))))
    }

    @Test fun `service renderer admission remains exact and bounded`() = metadataOnly {
        val render = requireNotNull(Pack.state.renderCatalogue)
        for (version in listOf(JsonPrimitive(14), JsonPrimitive(18), JsonPrimitive("17"), JsonPrimitive(17.5), JsonNull)) {
            refuses(withRender(JsonObject(render + ("rendererContractVersion" to version))))
        }
    }

    @Test fun `renderer17 preserves SIM source and selected group manifest pin checks`() = metadataOnly {
        val state = Pack.state
        val manifest = requireNotNull(state.manifest)
        refuses(state.copy(manifest = manifest.copy(simVersion = 17)))
        refuses(state.copy(manifest = manifest.copy(sourceCommit = "0".repeat(40))))
        val group = requireNotNull(state.renderCatalogue).getValue("phaseE").jsonObject.getValue("groups").jsonArray.first().jsonObject
        val path = group.getValue("files").jsonArray.first().jsonObject.getValue("path").jsonPrimitive.content
        val files = manifest.files.map { if (it.path == path) it.copy(sha256 = "0".repeat(64)) else it }
        refuses(state.copy(manifest = manifest.copy(files = files)))
    }
}
