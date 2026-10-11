package gg.pixelkingdomwars.nativeclient.data

import com.badlogic.gdx.files.FileHandle
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticAppearance
import gg.pixelkingdomwars.nativeclient.renderer.BoundCosmeticIdleCell
import gg.pixelkingdomwars.nativeclient.renderer.BoundCosmeticPreviewArt
import gg.pixelkingdomwars.nativeclient.renderer.PhaseECosmeticArt
import gg.pixelkingdomwars.nativeclient.renderer.PhaseEServiceArt
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAssetSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** Inter-lane contract (C4, frozen 2026-09-30 19:44Z): the LOCAL art side of Awning
 *  application. Root's Workshop repository injects [applicationReady] and [preview]
 *  through its existing constructor parameters and never bypasses this boundary to
 *  reach atlas bytes; this side owns no crafting recipe, economy or tier table. */
interface BoundCosmeticArtAdmission {
    /** True only while an OPEN service content session holds the renderer16 extension
     *  with all four Awning bindings and appearances. Never derived from a server flag;
     *  false without a current session. */
    fun applicationReady(): Boolean
    /** Resolve [appearance] against the admitted pack: a Market Awning whose three hashes
     *  EQUAL the packed binding, whose idle cell is leased (fetched under the existing
     *  content lease with [guard] at every checkpoint) and whose digest verifies — or
     *  throw a readable error. Never a no-op success. */
    suspend fun preview(appearance: BoundCosmeticAppearance, guard: () -> Unit): BoundCosmeticPreview
    /** The admitted catalogue's tier rule for a COMPLETED Market level (injected by AppGraph
     *  from the exported constants; the same lambda root's rules carry). */
    fun completedMarketOutput(level: Long): String
    /** The queue limit the admitted pack carries from the shared constants
     *  (PHASE_E_ORDINARY_CRAFTING.v1.maxConcurrentPerBase, the value the shared Workshop
     *  API caps the queue with). Throws while no admitted pack carries it — never a literal. */
    fun maxConcurrentPerBase(): Int
}

/** A verified preview handle. [pngBytes] is a fresh copy on every read; geometry is the
 *  Market seat (112 cell, full-cell bottom pivot 56,112); [cropSha256] is the packed
 *  table's cell digest the bytes were checked against. */
class BoundCosmeticPreview(val outputId: String, val tier: Int, val group: String, val idleFrame: String,
    val cellW: Int, val cellH: Int, val pivotX: Int, val pivotY: Int, val cropSha256: String, val bindingSha256: String,
    private val png: ByteArray) {
    val pngBytes: ByteArray get() = png.copyOf()
}

/** What an open content session hands this seam: the admitted graph (with or without
 *  the extension) and the lease source that owns its verified files. */
class AdmittedServiceContent(val art: PhaseEServiceArt, val assets: ServiceAssetSource)

/** The open session's own admitted graph and lease source, or null while a session
 *  carries no parsed art. Root's AppGraph passes `{ currentSession?.admitted() }`. */
fun ServiceContentSession.admitted(): AdmittedServiceContent? = art?.let { AdmittedServiceContent(it, assets) }

class LeasedBoundCosmeticArtAdmission(
    private val content: () -> AdmittedServiceContent?,
    private val marketOutput: (Long) -> String,
    private val cell: (PhaseEServiceArt, String, FileHandle, () -> Unit) -> BoundCosmeticIdleCell = BoundCosmeticPreviewArt::idleCell,
) : BoundCosmeticArtAdmission {
    override fun applicationReady(): Boolean {
        val current = content() ?: return false
        val cosmetics = current.art.cosmetics ?: return false
        if (cosmetics.rules == null) return false
        if (!runCatching { current.assets.isCurrent() }.getOrDefault(false)) return false
        return PhaseECosmeticArt.awningOutputs.all { output ->
            cosmetics.bindings[output] != null && cosmetics.appearances[PhaseECosmeticArt.appearanceId(output)] != null
        }
    }

    override fun completedMarketOutput(level: Long): String = marketOutput(level)

    override fun maxConcurrentPerBase(): Int =
        requireNotNull(content()?.art?.cosmetics?.rules?.maxConcurrentPerBase) { "Awning queue rules are not available in this client yet" }

    override suspend fun preview(appearance: BoundCosmeticAppearance, guard: () -> Unit): BoundCosmeticPreview {
        appearance.validate()
        require(appearance.outputId in PhaseECosmeticArt.awningOutputs) { "Only a Market Awning can be previewed here" }
        val current = content() ?: throw IllegalStateException("Awning art is not available in this client yet")
        val cosmetics = current.art.cosmetics ?: throw IllegalStateException("Awning art is not available in this client yet")
        val binding = cosmetics.bindings[appearance.outputId] ?: throw IllegalStateException("Awning art is not available in this client yet")
        require(binding.sha256 == appearance.bindingSha256 && binding.sourceManifestSha256 == appearance.sourceManifestSha256
            && binding.sourceIndexSha256 == appearance.sourceIndexSha256 && binding.sourceId == appearance.sourceId) { "This Awning differs from the art this client holds" }
        guard()
        return withContext(Dispatchers.IO) {
            // The session lease runs on its own session-scoped job, so the CALLER's cancellation
            // is only visible through this checkpoint: it is folded into every guard call.
            val context = this.coroutineContext
            val check = { context.ensureActive(); guard() }
            check()
            val lease = current.assets.acquire(PhaseECosmeticArt.GROUP, check)
            val idle = try { check(); cell(current.art, appearance.outputId, lease.directory, check) } finally { lease.close() }
            check()
            require(idle.bindingSha256 == appearance.bindingSha256 && idle.outputId == appearance.outputId)
            BoundCosmeticPreview(idle.outputId, idle.tier, idle.group, idle.frame, idle.cellW, idle.cellH, idle.pivotX, idle.pivotY,
                idle.rgbaSha256, idle.bindingSha256, idle.pngBytes)
        }
    }
}
