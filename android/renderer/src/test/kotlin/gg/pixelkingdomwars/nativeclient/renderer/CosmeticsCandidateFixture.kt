package gg.pixelkingdomwars.nativeclient.renderer

import java.io.File
import java.security.MessageDigest
import java.util.zip.GZIPInputStream

/** The tracked EXACT fixture of the renderer16 bound-cosmetics candidate pack
 *  (test-fixtures/candidate-6f7a9e81-sim18-r16-cosmetics, see its README): atlas pair, manifest and
 *  catalogue verbatim, the render catalogue gzipped. The decompressed catalogue must equal the
 *  candidate's pinned bytes, so a drifted fixture fails loudly instead of testing something else. */
internal object CosmeticsCandidateFixture {
    val root = File("../test-fixtures/candidate-6f7a9e81-sim18-r16-cosmetics")
    const val RENDER_CATALOGUE_SHA256 = "77d99656a5e6a2279bf857c20692723f6ba06316c2bf157506201b6f8de41e87"
    fun renderCatalogueText(): String {
        val bytes = GZIPInputStream(File(root, "render-catalog.json.gz").inputStream()).use { it.readBytes() }
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
        check(digest == RENDER_CATALOGUE_SHA256) { "Fixture render catalogue differs from the candidate pin" }
        return String(bytes, Charsets.UTF_8)
    }
}
