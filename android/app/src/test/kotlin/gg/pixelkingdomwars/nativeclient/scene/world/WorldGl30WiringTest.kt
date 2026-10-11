package gg.pixelkingdomwars.nativeclient.scene.world

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The N0 integration wiring (GLOBE-NATIVE-PLAN §3.3, §9): the lines that connect the GL30 world surface to the rest of
 * the app live in shared files (SceneHost, MainActivity), where the world lane's own tests cannot see them.
 *
 * libGDX 1.13.1 leaks `Gdx.gl30` across fragments, and `SpriteBatch.<init>` picks its VAO path from it. Base and battle
 * share one GLES 2 fragment ([gg.pixelkingdomwars.nativeclient.scene.KingdomFragment]), so the leak must be cleared
 * before libGDX creates that scene, not after: once create() has built the batch, clearing is too late.
 */
class WorldGl30WiringTest {
    private val sceneHost = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/SceneHost.kt").readText()
    private val mainActivity = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/MainActivity.kt").readText()

    @Test fun `the GLES 2 scene clears a leaked GL30 handle before libGDX creates it`() {
        val kingdom = sceneHost.substring(sceneHost.indexOf("class KingdomFragment"))
        val clear = kingdom.indexOf("WorldGdxStatics.clearGl30()")
        val initialize = kingdom.indexOf("initializeForView(game")
        assertTrue("KingdomFragment clears the world surface's GL30 handle", clear >= 0)
        assertTrue("initializeForView(game, …) is still the scene's entry", initialize >= 0)
        assertTrue("the clear must run before initializeForView, or create() builds a VAO SpriteBatch in an ES 2 context", clear < initialize)
        assertEquals("exactly one GLES 2 scene entry is guarded", 1, Regex("""initializeForView\(game""").findAll(kingdom).count())
    }

    @Test fun `debug builds assert on the GL thread that the GLES 2 scene runs without GL30`() {
        val kingdom = sceneHost.substring(sceneHost.indexOf("class KingdomFragment"))
        val assert = Regex("""if \(BuildConfig\.DEBUG\) postRunnable \{ check\(com\.badlogic\.gdx\.Gdx\.gl30 == null\)""")
        assertTrue("the assert is debug-only: a release crash would be worse than the leak it reports", assert.containsMatchIn(kingdom))
        assertTrue("the assert follows initializeForView, so it runs after create()", assert.find(kingdom)!!.range.first > kingdom.indexOf("initializeForView(game"))
    }

    @Test fun `only a debug build can request the GL30 world surface`() {
        val line = mainActivity.lines().singleOrNull { "WorldEngineFlags.gl30Requested" in it }
        assertTrue("MainActivity sets the flag in exactly one place", line != null)
        assertTrue("release builds must never open the unapproved GL30 world surface (OQ-10): $line", line!!.trimStart().startsWith("if (BuildConfig.DEBUG)"))
        assertTrue("the flag comes from the debug launch extra worldGl30, default off", """getBooleanExtra("worldGl30", false)""" in line)
    }
}
