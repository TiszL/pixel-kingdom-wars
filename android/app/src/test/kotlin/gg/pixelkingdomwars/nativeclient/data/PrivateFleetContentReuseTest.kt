package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.FakeApiClient
import gg.pixelkingdomwars.nativeclient.network.NativeContentManifest
import gg.pixelkingdomwars.nativeclient.network.nativeContentManifest
import gg.pixelkingdomwars.nativeclient.renderer.PhaseEFleetArt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.zip.GZIPInputStream

/** NR-5: reuse immutable DATA only. Permission and lease authority must start fresh on every open.
 * The existing ServiceContentTest remains the unchanged adversarial suite for the byte-array opener. */
class PrivateFleetContentReuseTest {
    private class Counters {
        var reads = 0
        var digests = 0
        var parses = 0
        val cache = PrivateFleetParseCache(
            readBytes = { file -> reads++; file.readBytes() },
            digest = { bytes -> digests++; sha(bytes) },
            parseFleet = { root -> parses++; PhaseEFleetArt.parse(root) },
        )
    }

    private class Harness(val root: File, val content: ServiceContent) {
        val owner: Job = SupervisorJob()
        val api = FakeApiClient()
        val counters = Counters()
        val opener = PrivateFleetContent(content, counters.cache)

        fun generation(name: String = "generation", catalogue: ByteArray = Fixture.catalogue,
            render: ByteArray = Fixture.render): Pair<File, NativeContentManifest> {
            val directory = File(root, name).apply { mkdirs() }
            val raw = if (catalogue === Fixture.catalogue && render === Fixture.render) Fixture.manifest
                else repinned(catalogue, render)
            File(directory, "manifest.json").writeBytes(raw.toString().toByteArray(Charsets.UTF_8))
            File(directory, "catalogue.json").writeBytes(catalogue)
            File(directory, "render-catalog.json").writeBytes(render)
            return directory to nativeContentManifest(raw, 18)
        }

        suspend fun open(generation: Pair<File, NativeContentManifest>, values: MutableList<Boolean> = mutableListOf(),
            job: Job = owner, guard: () -> Unit = {}): PrivateFleetHandle = opener.open(
            PrivateFleetCandidate(generation.second.contentVersion, generation.second.simVersion),
            generation.first, generation.second, api, job, guard, values::add,
        )
    }

    private fun fixture(block: suspend Harness.() -> Unit) = runBlocking {
        val root = Files.createTempDirectory("private-fleet-reuse-test").toFile()
        // No server, downloads or live permissions: all capability reads are scripted below.
        val content = ServiceContent(File(root, "leases"), "https://example.invalid/")
        val harness = Harness(root, content)
        try { harness.block() }
        finally {
            harness.owner.cancel()
            harness.owner.children.toList().joinAll()
            content.awaitLeaseReleases()
            root.deleteRecursively()
        }
    }

    @Test fun `opening the same verified generation twice hashes and parses once`() = fixture {
        val generation = generation()
        val first = open(generation)
        val graph = first.fleet
        first.close()
        open(generation).use { second ->
            assertSame("the immutable graph is reused", graph, second.fleet)
            assertNotSame("the lifetime is new", first.session, second.session)
            assertTrue(second.session.assets.isCurrent())
            assertFalse(first.session.assets.isCurrent())
        }
        assertEquals("the three metadata files are read only on the cold open", 3, counters.reads)
        assertEquals("each pinned catalogue is hashed only once", 2, counters.digests)
        assertEquals(1, counters.parses)
        assertTrue("opening alone observes no capability", api.gets.isEmpty())
    }

    @Test fun `a different manifest pin re-reads and re-verifies`() = fixture {
        val first = generation("first")
        open(first).close()
        // Valid JSON with a genuinely different catalogue pin. Do not overwrite an immutable generation.
        val second = generation("second", catalogue = Fixture.catalogue + byteArrayOf(10))
        assertNotEquals(first.second.contentVersion, second.second.contentVersion)
        open(second).close()
        assertEquals(6, counters.reads)
        assertEquals(4, counters.digests)
        assertEquals(2, counters.parses)
    }

    @Test fun `same manifest in a different directory cannot borrow a previous verification`() = fixture {
        open(generation("first")).close()
        val second = generation("second")
        File(second.first, "render-catalog.json").appendText("tampered")
        assertTrue(runCatching { open(second) }.isFailure)
        assertEquals("the different directory is read", 6, counters.reads)
        assertEquals("unverified bytes never reach the parser", 1, counters.parses)
    }

    @Test fun `canonical path aliases reuse the same verified generation`() = fixture {
        val generation = generation()
        open(generation).close()
        open(File(generation.first, ".") to generation.second).close()
        assertEquals(3, counters.reads)
        assertEquals(2, counters.digests)
        assertEquals(1, counters.parses)
    }

    @Test fun `every open still creates a fresh permission observation`() = fixture {
        val generation = generation()
        val firstValues = mutableListOf<Boolean>()
        api.onGet("/native/capabilities") { capability(true) }
        val first = open(generation, firstValues)
        assertEquals(listOf(false), firstValues)
        first.refreshPermission()
        assertEquals(listOf(false, false, true), firstValues)
        first.close()
        assertFalse(firstValues.last())

        val secondValues = mutableListOf<Boolean>()
        api.onGet("/native/capabilities") { capability(false) }
        open(generation, secondValues).use { second ->
            assertEquals("a prior grant cannot survive in the cache", listOf(false), secondValues)
            assertNotSame(first.session, second.session)
            second.refreshPermission()
            assertEquals(listOf(false, false, false), secondValues)
        }
        assertEquals(listOf("/native/capabilities", "/native/capabilities"), api.gets.map { it.first })
        assertEquals(1, counters.parses)
    }

    @Test fun `cancelled owner remains dark while new owner may reuse the data`() = fixture {
        val generation = generation()
        val oldOwner = SupervisorJob(owner)
        val oldValues = mutableListOf<Boolean>()
        api.onGet("/native/capabilities") { capability(true) }
        val first = open(generation, oldValues, oldOwner)
        first.refreshPermission()
        oldOwner.cancel()
        assertTrue(first.retired)
        assertFalse(first.session.assets.isCurrent())
        assertFalse(oldValues.last())
        val refused = mutableListOf<Boolean>()
        assertTrue(runCatching { open(generation, refused, oldOwner) }.isFailure)
        assertTrue(refused.none { it })
        open(generation).use { assertTrue(it.session.assets.isCurrent()) }
        assertEquals(1, counters.parses)
    }

    @Test fun `changed published manifest cannot reuse a cached graph even with the same lookup pins`() = fixture {
        val generation = generation()
        open(generation).close()
        // A forged typed input preserves the lookup tuple but disagrees with the authenticated manifest.
        val changed = generation.second.copy(sourceCommit = "b".repeat(40))
        val values = mutableListOf<Boolean>()
        assertTrue(runCatching { open(generation.first to changed, values) }.isFailure)
        assertTrue(values.none { it })
        open(generation).close()
        assertEquals("a mismatched published manifest is never parsed or admitted", 1, counters.parses)
    }

    @Test fun `cold open requires raw manifest to equal the published manifest`() = fixture {
        val generation = generation()
        val forged = generation.second.copy(sourceCommit = "b".repeat(40))
        assertTrue(runCatching { open(generation.first to forged) }.isFailure)
        assertEquals(0, counters.parses)
        open(generation).close()
        assertEquals(1, counters.parses)
    }

    @Test fun `failed verification cannot seed a later cache hit`() = fixture {
        val generation = generation()
        val render = File(generation.first, "render-catalog.json")
        render.writeBytes(Fixture.render.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() })
        assertTrue(runCatching { open(generation) }.isFailure)
        assertEquals(0, counters.parses)
        // Test-only repair of rejected bytes; no accepted immutable generation was published by the opener.
        render.writeBytes(Fixture.render)
        open(generation).close()
        assertEquals(6, counters.reads)
        assertEquals(4, counters.digests)
        assertEquals(1, counters.parses)
    }

    @Test fun `cache hit still runs the exact current generation guard`() = fixture {
        val generation = generation()
        open(generation).close()
        val values = mutableListOf<Boolean>()
        assertTrue(runCatching { open(generation, values, guard = { throw CancellationException("generation replaced") }) }.isFailure)
        assertTrue(values.none { it })
        assertTrue(owner.children.none { it.isActive })
        assertEquals(3, counters.reads)
        assertEquals(1, counters.parses)
    }

    private object Fixture {
        private val root = File("../test-fixtures/candidate-6f7a9e81-sim18-r17-fleet")
        val manifest: JsonObject by lazy {
            val bytes = pinned(File(root, "manifest.json").readBytes(), 330796,
                "032af7f0e56331091a530311070db7b15e5a95273e5304364700705276c878b0")
            Json.parseToJsonElement(String(bytes, Charsets.UTF_8)).jsonObject
        }
        val render: ByteArray by lazy {
            pinned(GZIPInputStream(File(root, "render-catalog.json.gz").inputStream()).use { it.readBytes() }, 8032245,
                "f9eff00c5a8119e3aed0675d816ba5371d1634332f36a398b570c1c488988133")
        }
        val catalogue: ByteArray by lazy {
            pinned(File(CosmeticsCandidateFixture.root, "catalogue.json").readBytes(), 296869,
                "50bd5758c55b445d1c6e206f40e17e6a35b6d8cf49597db7eb7427573d3a8f57")
        }
    }

    companion object {
        private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        private fun pinned(bytes: ByteArray, size: Int, digest: String) = bytes.also { check(it.size == size && sha(it) == digest) }
        private fun capability(enabled: Boolean) = buildJsonObject {
            put("protocolVersion", 2); put("simVersion", 18)
            put("phaseEArt", buildJsonObject { put("version", 1); put("enabled", enabled) })
        }
        private fun repinned(catalogue: ByteArray, render: ByteArray): JsonObject {
            val files = JsonArray(Fixture.manifest.getValue("files").jsonArray.map { row ->
                val entry = row.jsonObject
                val bytes = when (entry.getValue("path").jsonPrimitive.content) {
                    "catalogue.json" -> catalogue
                    "render-catalog.json" -> render
                    else -> null
                }
                if (bytes == null) entry else JsonObject(entry + mapOf("size" to JsonPrimitive(bytes.size), "sha256" to JsonPrimitive(sha(bytes))))
            })
            val identity = buildJsonObject {
                put("schemaVersion", 1)
                put("sourceCommit", Fixture.manifest.getValue("sourceCommit"))
                put("simVersion", Fixture.manifest.getValue("simVersion"))
                put("files", files)
            }
            return JsonObject(Fixture.manifest + mapOf("files" to files, "contentVersion" to JsonPrimitive(sha(identity.toString().toByteArray(Charsets.UTF_8)))))
        }
    }
}
