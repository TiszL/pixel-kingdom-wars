package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.FakeApiClient
import gg.pixelkingdomwars.nativeclient.network.nativeContentManifest
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.zip.GZIPInputStream

/** Core promotion must make the admitted bytes usable offline, without granting art capability. */
class ServiceContentResidentTest {
    private val atlas = "atlas/pe_workshop_t1@1x.json"
    private val image = "atlas/pe_workshop_t1@1x.png"
    private val groupId = "pe_workshop_t1"
    private object Pack {
        private val explicitRoot = System.getenv("PKW_SERVICE_ART_PACK")
        val root = File(explicitRoot ?: "../test-fixtures/candidate-6f7a9e81-sim18-r17-fleet-vehicle")
        val catalogue = Json.parseToJsonElement(File(root, "catalogue.json").readText()).jsonObject
        val render = Json.parseToJsonElement(if (explicitRoot != null)
            File(root, "render-catalog.json").readText()
        else GZIPInputStream(File(root, "render-catalog.json.gz").inputStream())
            .bufferedReader(Charsets.UTF_8).use { it.readText() }).jsonObject
        val manifest = nativeContentManifest(Json.parseToJsonElement(File(root, "manifest.json").readText()).jsonObject, 18)
    }
    private val bytes by lazy { listOf(atlas, image).associateWith { File(Pack.root, it).readBytes() } }
    private fun fixture(block: suspend (ServiceContent, File, FakeApiClient, Job) -> Unit) = runBlocking {
        val root = Files.createTempDirectory("service-resident-test").toFile()
        val resident = File(root, "resident").apply { mkdirs() }
        bytes.forEach { (path, value) -> File(resident, path).apply { parentFile.mkdirs(); writeBytes(value) } }
        val api = FakeApiClient()
        api.onGet("/native/capabilities") { error("Resident content must not need the network") }
        val transport = OkHttpClient.Builder().addInterceptor { error("Resident content must not perform HTTP") }.build()
        val owner = SupervisorJob()
        val content = ServiceContent(File(root, "cache"), "https://localhost/", transport = transport)
        try { block(content, resident, api, owner) }
        finally { owner.cancel(); content.awaitLeaseReleases(); root.deleteRecursively(); assertTrue(api.gets.isEmpty()) }
    }
    private suspend fun session(content: ServiceContent, resident: File?, api: FakeApiClient, owner: Job, imageTier: String = "core"): ServiceContentSession {
        val promoted = Pack.manifest.copy(files = Pack.manifest.files.map { pin ->
            pin.copy(tier = if (pin.path == image) imageTier else if (pin.path.startsWith("atlas/pe_")) "core" else pin.tier)
        })
        return content.open(ContentState(assets = resident, catalogue = Pack.catalogue,
            renderCatalogue = Pack.render, manifest = promoted), api, owner) {}
    }

    @Test fun `core pair is verified locally and independently retained after source removal and session closure`() = fixture { content, resident, api, owner ->
        val session = session(content, resident, api, owner)
        val lease = withContext(Dispatchers.IO) { session.assets.acquire(groupId) {} }
        resident.deleteRecursively(); session.close()
        assertFalse(session.assets.isCurrent())
        lease.use { bytes.forEach { (path, value) -> assertArrayEquals(value, File(it.directory.file(), path).readBytes()) } }
    }

    @Test fun `mismatched missing and symlinked resident bytes refuse with no network fallback`() = fixture { content, resident, api, owner ->
        val pixel = File(resident, image)
        for (mode in listOf("mismatch", "missing", "symlink")) {
            pixel.delete()
            if (mode == "mismatch") pixel.writeText("wrong pixels")
            if (mode == "symlink") {
                val outside = File(resident.parentFile, "outside.png").apply { writeBytes(bytes.getValue(image)) }
                Files.createSymbolicLink(pixel.toPath(), outside.toPath())
            }
            session(content, resident, api, owner).use { session ->
                assertThrows(Exception::class.java) { session.assets.acquire(groupId) {} }
            }
        }
    }

    @Test fun `mixed optional core pair and core pair without resident source refuse`() = fixture { content, resident, api, owner ->
        assertThrows(IllegalArgumentException::class.java) { runBlocking { session(content, resident, api, owner, "optional") } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { session(content, null, api, owner) } }
    }

    @Test fun `closed session cannot acquire resident bytes`() = fixture { content, resident, api, owner ->
        val session = session(content, resident, api, owner)
        session.close()
        assertThrows(CancellationException::class.java) { session.assets.acquire(groupId) {} }
    }
}
