package gg.pixelkingdomwars.nativeclient.data

import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticAppearance
import gg.pixelkingdomwars.nativeclient.renderer.BoundCosmeticIdleCell
import gg.pixelkingdomwars.nativeclient.renderer.BoundCosmeticPreviewArt
import gg.pixelkingdomwars.nativeclient.renderer.PhaseEServiceArt
import gg.pixelkingdomwars.nativeclient.renderer.RendererCatalogue
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAssetLease
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAssetSource
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** The frozen inter-lane seam against the ACTUAL renderer16 candidate: readiness only
 *  from an open session holding the extension, preview only through the lease with
 *  exact binding equality and guard checkpoints, never a no-op success. */
class BoundCosmeticArtAdmissionTest {
    private val pack = CosmeticsCandidateFixture.root
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
    private fun appearance(art: PhaseEServiceArt, tier: Int, mutate: (MutableMap<String, String>) -> Unit = {}): BoundCosmeticAppearance {
        val b = requireNotNull(art.cosmetics).bindings.getValue("artisan_market_awning_t$tier")
        val fields = mutableMapOf("outputId" to b.outputId, "sourceId" to b.sourceId, "manifest" to b.sourceManifestSha256, "index" to b.sourceIndexSha256, "binding" to b.sha256)
        mutate(fields)
        return BoundCosmeticAppearance(1, fields.getValue("outputId"), fields.getValue("sourceId"), fields.getValue("manifest"), fields.getValue("index"), fields.getValue("binding"))
    }
    private val rule: (Long) -> String = { level -> "artisan_market_awning_t${(level - 1) / 5 + 1}" }

    @Test fun `readiness is true only for an open current session holding the extension`() {
        val art = graph(); val source = Source()
        assertTrue(LeasedBoundCosmeticArtAdmission({ AdmittedServiceContent(art, source) }, rule).applicationReady())
        assertFalse(LeasedBoundCosmeticArtAdmission({ null }, rule).applicationReady())
        assertFalse(LeasedBoundCosmeticArtAdmission({ AdmittedServiceContent(graph(15), source) }, rule).applicationReady())
        assertFalse(LeasedBoundCosmeticArtAdmission({ AdmittedServiceContent(art, Source(current = false)) }, rule).applicationReady())
        assertEquals("artisan_market_awning_t2", LeasedBoundCosmeticArtAdmission({ null }, rule).completedMarketOutput(6))
        // The queue limit comes from the admitted pack's constants slice, never a literal.
        assertEquals(1, LeasedBoundCosmeticArtAdmission({ AdmittedServiceContent(art, source) }, rule).maxConcurrentPerBase())
        assertTrue(runCatching { LeasedBoundCosmeticArtAdmission({ null }, rule).maxConcurrentPerBase() }.isFailure)
        assertTrue(runCatching { LeasedBoundCosmeticArtAdmission({ AdmittedServiceContent(graph(15), source) }, rule).maxConcurrentPerBase() }.isFailure)
    }

    @Test fun `preview leases the group, verifies the cell and hands back copied bytes`() = runBlocking {
        val art = graph(); val source = Source(); val guards = intArrayOf(0)
        val admission = LeasedBoundCosmeticArtAdmission({ AdmittedServiceContent(art, source) }, rule)
        for (tier in 1..4) {
            val preview = admission.preview(appearance(art, tier)) { guards[0]++ }
            assertEquals("artisan_market_awning_t$tier", preview.outputId); assertEquals(tier, preview.tier)
            assertEquals("pe_cosmetics", preview.group); assertEquals("pe_cos_market_t${tier}_idle_f1", preview.idleFrame)
            assertEquals(listOf(112, 112, 56, 112), listOf(preview.cellW, preview.cellH, preview.pivotX, preview.pivotY))
            assertEquals(requireNotNull(art.cosmetics).clips.getValue("pe_cos_market_t${tier}_idle").frames.single().sha256, preview.cropSha256)
            val a = preview.pngBytes; val b = preview.pngBytes
            assertNotSame(a, b); assertArrayEquals(a, b); assertTrue("a real PNG came back", a.size > 100)
            assertEquals(byteArrayOf(-119, 80, 78, 71).toList(), a.take(4))
        }
        assertEquals(List(4) { "pe_cosmetics" }, source.acquired); assertEquals("every lease is released after the cut", 4, source.released)
        assertTrue("guard ran at every checkpoint", guards[0] >= 4 * 4)
    }

    @Test fun `preview refuses hash disagreement a foreign output a missing session and a superseded guard`() = runBlocking {
        val art = graph(); val source = Source()
        val admission = LeasedBoundCosmeticArtAdmission({ AdmittedServiceContent(art, source) }, rule)
        for (mutate in listOf<(MutableMap<String, String>) -> Unit>(
            { it["binding"] = "f".repeat(64) }, { it["manifest"] = "0".repeat(64) }, { it["index"] = "1".repeat(64) },
            { it["outputId"] = "artisan_market_awning_t2" }, // tier-1 binding hashes under a tier-2 output
        )) {
            val bad = appearance(art, 1, mutate)
            assertTrue(runCatching { admission.preview(bad) {} }.isFailure)
        }
        assertTrue(runCatching { admission.preview(BoundCosmeticAppearance(1, "aurora_wake", "auroraWake", "a".repeat(64), "b".repeat(64), "c".repeat(64))) {} }.isFailure)
        assertEquals("nothing is leased before the appearance is admitted", 0, source.acquired.size)
        assertTrue(runCatching { LeasedBoundCosmeticArtAdmission({ null }, rule).preview(appearance(art, 1)) {} }.isFailure)
        assertTrue(runCatching { LeasedBoundCosmeticArtAdmission({ AdmittedServiceContent(graph(15), source) }, rule).preview(appearance(art, 1)) {} }.isFailure)
        // A guard that trips (base changed, session superseded) aborts before the cut and still releases the lease.
        var calls = 0
        assertTrue(runCatching { admission.preview(appearance(art, 1)) { if (++calls >= 3) throw IllegalStateException("superseded") } }.isFailure)
        assertEquals(source.acquired.size, source.released)
        // The cut itself is the injected cell reader; a reader that disagrees with the appearance is refused.
        val wrongCell = LeasedBoundCosmeticArtAdmission({ AdmittedServiceContent(art, source) }, rule) { _, _, _, _ ->
            BoundCosmeticIdleCell("artisan_market_awning_t2", 2, "pe_cosmetics", "pe_cos_market_t2_idle_f1", 112, 112, 56, 112, "0".repeat(64), "1".repeat(64), ByteArray(4))
        }
        assertTrue(runCatching { wrongCell.preview(appearance(art, 1)) {} }.isFailure)
    }

    @Test fun `a preview cancelled by its caller is observed inside the lease and never cuts`() = runBlocking {
        // The session lease runs on its own session-scoped job: without the seam folding the caller's
        // context into the checkpoint, a cancelled preview keeps fetching and decoding until the guard trips.
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
        val admission = LeasedBoundCosmeticArtAdmission({ AdmittedServiceContent(art, source) }, rule) { a, o, d, g -> cuts++; BoundCosmeticPreviewArt.idleCell(a, o, d, g) }
        job = launch { admission.preview(appearance(art, 1)) {} }
        job.join()
        assertTrue("the preview coroutine ends cancelled", job.isCancelled)
        assertEquals("cancellation is observed before any lease is handed out", 0, source.acquired)
        assertEquals("no atlas cut happens for a cancelled preview", 0, cuts)
    }
}
