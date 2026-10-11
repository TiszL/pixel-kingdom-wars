package gg.pixelkingdomwars.nativeclient.data

import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticAppearance
import gg.pixelkingdomwars.nativeclient.renderer.BoundCosmeticPreviewArt
import gg.pixelkingdomwars.nativeclient.renderer.BoundCosmeticWakeCell
import gg.pixelkingdomwars.nativeclient.renderer.PhaseEServiceArt
import gg.pixelkingdomwars.nativeclient.renderer.RendererCatalogue
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAssetLease
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAssetSource
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** C5a: the Aurora Wake SOURCE PREVIEW against the tracked exact candidate fixture. It is a
 *  verified still or a readable refusal, never a no-op, and it carries no readiness: nothing
 *  here may be read as application, presence or craft admission. */
class BoundCosmeticWakeSourcePreviewTest {
    private fun graph(contract: Int = 16): PhaseEServiceArt {
        val root = JsonReader().parse(CosmeticsCandidateFixture.renderCatalogueText())
        if (contract == 15) { root.get("rendererContractVersion").set(15L, null); root.remove("boundCosmetics") }
        return requireNotNull(RendererCatalogue.serviceArt(root))
    }
    private class Source(val current: Boolean = true) : ServiceAssetSource {
        val acquired = mutableListOf<String>(); var released = 0
        override fun isCurrent() = current
        override fun acquire(group: String, checkpoint: () -> Unit): ServiceAssetLease {
            checkpoint(); acquired += group
            return ServiceAssetLease(FileHandle(CosmeticsCandidateFixture.root)) { released++ }
        }
        override fun cancelPending() {}
    }
    private fun wake(art: PhaseEServiceArt, mutate: (MutableMap<String, String>) -> Unit = {}): BoundCosmeticAppearance {
        val b = requireNotNull(art.cosmetics).wakeBinding
        val fields = mutableMapOf("outputId" to b.outputId, "sourceId" to b.sourceId, "manifest" to b.sourceManifestSha256, "index" to b.sourceIndexSha256, "binding" to b.sha256)
        mutate(fields)
        return BoundCosmeticAppearance(1, fields.getValue("outputId"), fields.getValue("sourceId"), fields.getValue("manifest"), fields.getValue("index"), fields.getValue("binding"))
    }

    @Test fun `the preview leases the group verifies the authored still and hands back copied bytes`() = runBlocking {
        val art = graph(); val source = Source(); val guards = intArrayOf(0)
        val preview = LeasedBoundCosmeticWakeSourcePreview({ AdmittedServiceContent(art, source) }).wakePreview(wake(art)) { guards[0]++ }
        assertEquals("aurora_wake", preview.outputId); assertEquals("pe_cosmetics", preview.group); assertEquals("pe_cos_wake_f1", preview.frame)
        assertEquals(listOf(64, 64, 32, 32), listOf(preview.cellW, preview.cellH, preview.anchorX, preview.anchorY))
        assertEquals(requireNotNull(art.cosmetics).clips.getValue("pe_cos_wake").frames.single { it.key == "pe_cos_wake_f1" }.sha256, preview.cropSha256)
        assertEquals(requireNotNull(art.cosmetics).wakeBinding.sha256, preview.bindingSha256)
        val a = preview.pngBytes; val b = preview.pngBytes
        assertNotSame(a, b); assertArrayEquals(a, b); assertTrue("a real PNG came back", a.size > 100)
        assertEquals(byteArrayOf(-119, 80, 78, 71).toList(), a.take(4))
        assertEquals(listOf("pe_cosmetics"), source.acquired); assertEquals("the lease is released after the cut", 1, source.released)
        assertTrue("guard ran at every checkpoint", guards[0] >= 4)
    }

    @Test fun `the preview refuses hash disagreement an Awning output a missing session a bare pack and a superseded guard`() = runBlocking {
        val art = graph(); val source = Source()
        val preview = LeasedBoundCosmeticWakeSourcePreview({ AdmittedServiceContent(art, source) })
        for (mutate in listOf<(MutableMap<String, String>) -> Unit>(
            { it["binding"] = "f".repeat(64) }, { it["manifest"] = "0".repeat(64) }, { it["index"] = "1".repeat(64) },
        )) assertTrue(runCatching { preview.wakePreview(wake(art, mutate)) {} }.isFailure)
        val awning = requireNotNull(art.cosmetics).bindings.getValue("artisan_market_awning_t1")
        assertTrue(runCatching { preview.wakePreview(BoundCosmeticAppearance(1, awning.outputId, awning.sourceId, awning.sourceManifestSha256, awning.sourceIndexSha256, awning.sha256)) {} }.isFailure)
        assertEquals("nothing is leased before the appearance is admitted", 0, source.acquired.size)
        assertTrue(runCatching { LeasedBoundCosmeticWakeSourcePreview({ null }).wakePreview(wake(art)) {} }.isFailure)
        assertTrue(runCatching { LeasedBoundCosmeticWakeSourcePreview({ AdmittedServiceContent(graph(15), source) }).wakePreview(wake(art)) {} }.isFailure)
        // A guard that trips (base changed, session superseded) aborts before the cut and still releases the lease.
        var calls = 0
        assertTrue(runCatching { preview.wakePreview(wake(art)) { if (++calls >= 3) throw IllegalStateException("superseded") } }.isFailure)
        assertEquals(source.acquired.size, source.released)
        // A cell reader that disagrees with the appearance is refused.
        val wrongCell = LeasedBoundCosmeticWakeSourcePreview({ AdmittedServiceContent(art, source) }) { _, _, _ ->
            BoundCosmeticWakeCell("aurora_wake", "pe_cosmetics", "pe_cos_wake_f1", 64, 64, 32, 32, "0".repeat(64), "1".repeat(64), ByteArray(4))
        }
        assertTrue(runCatching { wrongCell.wakePreview(wake(art)) {} }.isFailure)
    }

    @Test fun `a preview cancelled by its caller is observed inside the lease and never cuts`() = runBlocking {
        val art = graph(); var cuts = 0; lateinit var job: Job
        val source = object : ServiceAssetSource {
            var acquired = 0
            override fun isCurrent() = true
            override fun acquire(group: String, checkpoint: () -> Unit): ServiceAssetLease {
                job.cancel() // the caller gives up while the lease is being acquired
                checkpoint() // must carry the caller's cancellation, not only the guard
                acquired++
                return ServiceAssetLease(FileHandle(CosmeticsCandidateFixture.root)) {}
            }
            override fun cancelPending() {}
        }
        val preview = LeasedBoundCosmeticWakeSourcePreview({ AdmittedServiceContent(art, source) }) { a, d, g -> cuts++; BoundCosmeticPreviewArt.wakeCell(a, d, g) }
        job = launch { preview.wakePreview(wake(art)) {} }
        job.join()
        assertTrue("the preview coroutine ends cancelled", job.isCancelled)
        assertEquals("cancellation is observed before any lease is handed out", 0, source.acquired)
        assertEquals("no atlas cut happens for a cancelled preview", 0, cuts)
    }
}
