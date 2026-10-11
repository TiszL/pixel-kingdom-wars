package gg.pixelkingdomwars.nativeclient.renderer.generated

import java.security.MessageDigest
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.Test

/**
 * GLOBE-NATIVE-PLAN §4.4: the native world renderer must draw the web engine's shaders byte for byte (D-168.2), and CI
 * cannot check out the web pin (the branch is on no remote). So this is the drift check CI can run: every stage the
 * generated table names is on the renderer classpath with exactly its pinned sha256, and a stage whose bytes differ is
 * refused at load instead of reaching a GPU. The re-export against the real pin is the local gate step
 * `node tools/world-shaders.mjs --source <SHARDKEEP-globe> --check`.
 */
class WorldShadersPinTest {
    private val all = WorldShaders.realm.values + WorldShaders.globe.values

    @Test fun `every stage in the table loads from the classpath with its pinned sha256`() {
        for (p in all) for (stage in listOf(p.vs, p.fs)) {
            val text = WorldShaders.source(stage)
            assertEquals(stage.chars, text.length, "${stage.path}: the table's length is the exported stage's")
            assertTrue(text.startsWith("#version 300 es\n"), "${stage.path} is a GLSL ES 3.00 stage")
        }
    }

    @Test fun `the programs N1 and N2 draw are all in the table`() {
        // NM (N2 overview): stub-ground, rm-lowres-blit, minimap, minimap-dots. NG (N1 flat globe): the shared flat
        // globe's three programs (src/globe) and, kept for reference, the concept's relief path. A table that silently
        // lost one would still load.
        for (key in listOf("stub-ground", "rm-lowres-blit", "minimap", "minimap-dots", "rm-chart", "bases-dot"))
            assertTrue(key in WorldShaders.realm, "realm program $key")
        for (key in listOf("globe-flat", "globe-isles", "globe-fx", "globe-terrain2", "globe-sky", "globe-cloud", "globe-blit"))
            assertEquals("draw", WorldShaders.globe[key]?.use, "globe program $key")
        assertTrue(WorldShaders.PIN.matches(Regex("[0-9a-f]{40}")))
    }

    @Test fun `a stage whose bytes differ from the pin is refused`() {
        val real = WorldShaders.realm.getValue("minimap").fs
        val forged = WorldShaders.Stage(real.path, "0".repeat(64), real.chars)
        assertFailsWith<IllegalStateException> { WorldShaders.source(forged) }
        val missing = WorldShaders.Stage("no-such-stage.fs.glsl", real.sha256, real.chars)
        assertFailsWith<IllegalStateException> { WorldShaders.source(missing) }
        val sha = MessageDigest.getInstance("SHA-256").digest(WorldShaders.source(real).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        assertEquals(real.sha256, sha, "the hex digest the table compares is the file's own sha256")
    }
}
