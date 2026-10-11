package gg.pixelkingdomwars.nativeclient.data

import com.badlogic.gdx.files.FileHandle
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticAppearance
import gg.pixelkingdomwars.nativeclient.renderer.BoundCosmeticPreviewArt
import gg.pixelkingdomwars.nativeclient.renderer.BoundCosmeticWakeCell
import gg.pixelkingdomwars.nativeclient.renderer.PhaseECosmeticArt
import gg.pixelkingdomwars.nativeclient.renderer.PhaseEServiceArt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** C5a (2026-09-30): the VERIFIED SOURCE PREVIEW of the Aurora Wake still, and nothing
 *  else. It is independent of [BoundCosmeticArtAdmission.applicationReady] and carries NO
 *  readiness of any kind: no presence capability, no trip attachment, no craft/On admission
 *  may be derived from a preview succeeding. It either returns a verified handle or throws
 *  a readable error, never a no-op success. */
interface BoundCosmeticWakeSourcePreview {
    /** Resolve [appearance] against the admitted pack: the Aurora Wake whose four binding
     *  fields EQUAL the packed wake binding, whose authored first frame is cut under the
     *  existing content lease (with [guard] at every checkpoint and the caller's
     *  cancellation observed) and whose digest verifies. */
    suspend fun wakePreview(appearance: BoundCosmeticAppearance, guard: () -> Unit): BoundCosmeticWakePreview
}

/** A verified wake preview handle: 64x64 centre-anchored geometry from the packed clip and
 *  the table digest the bytes were checked against. [pngBytes] is a fresh copy per read. */
class BoundCosmeticWakePreview(val outputId: String, val group: String, val frame: String,
    val cellW: Int, val cellH: Int, val anchorX: Int, val anchorY: Int, val cropSha256: String, val bindingSha256: String,
    private val png: ByteArray) {
    val pngBytes: ByteArray get() = png.copyOf()
}

class LeasedBoundCosmeticWakeSourcePreview(
    private val content: () -> AdmittedServiceContent?,
    private val cell: (PhaseEServiceArt, FileHandle, () -> Unit) -> BoundCosmeticWakeCell = BoundCosmeticPreviewArt::wakeCell,
) : BoundCosmeticWakeSourcePreview {
    override suspend fun wakePreview(appearance: BoundCosmeticAppearance, guard: () -> Unit): BoundCosmeticWakePreview {
        appearance.validate()
        require(appearance.outputId == PhaseECosmeticArt.WAKE_OUTPUT) { "Only the Aurora Wake can be previewed here" }
        val current = content() ?: throw IllegalStateException("Aurora Wake art is not available in this client yet")
        val cosmetics = current.art.cosmetics ?: throw IllegalStateException("Aurora Wake art is not available in this client yet")
        val binding = cosmetics.wakeBinding
        require(binding.sha256 == appearance.bindingSha256 && binding.sourceManifestSha256 == appearance.sourceManifestSha256
            && binding.sourceIndexSha256 == appearance.sourceIndexSha256 && binding.sourceId == appearance.sourceId) { "This Aurora Wake differs from the art this client holds" }
        guard()
        return withContext(Dispatchers.IO) {
            // The session lease runs on its own session-scoped job, so the CALLER's cancellation
            // is only visible through this checkpoint: it is folded into every guard call.
            val context = this.coroutineContext
            val check = { context.ensureActive(); guard() }
            check()
            val lease = current.assets.acquire(PhaseECosmeticArt.GROUP, check)
            val still = try { check(); cell(current.art, lease.directory, check) } finally { lease.close() }
            check()
            require(still.bindingSha256 == appearance.bindingSha256 && still.outputId == appearance.outputId)
            BoundCosmeticWakePreview(still.outputId, still.group, still.frame, still.cellW, still.cellH, still.anchorX, still.anchorY,
                still.rgbaSha256, still.bindingSha256, still.pngBytes)
        }
    }
}
