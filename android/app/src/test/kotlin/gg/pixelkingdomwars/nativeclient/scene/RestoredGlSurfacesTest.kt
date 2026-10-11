package gg.pixelkingdomwars.nativeclient.scene

import com.badlogic.gdx.backends.android.AndroidFragmentApplication
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AndroidX rebuilds every fragment by class name when the activity is recreated (a dark-theme flip, a font or locale
 * change, a process restore). A rebuilt GL surface fragment has none of the inputs Compose hands a fresh one and no
 * laid-out container, so MainActivity discards them right after onCreate ([discardRestoredGlSurfaces]). The GL30 world's
 * WorldEngineFragment was missing from that filter; N5 ships it to release, where a recreation with the World tab on it
 * threw "World engine inputs were not provided" in Activity.onStart and crashed the app.
 */
class RestoredGlSurfacesTest {
    private val main = File("src/main/kotlin")

    /** Every class the app declares that is a libGDX GL surface fragment (directly or through another app class). */
    private fun glSurfaceFragments(): List<Class<*>> {
        val declared = mutableMapOf<String, Pair<String, String>>() // simple name -> (binary name, simple super name)
        main.walkTopDown().filter { it.name.endsWith(".kt") }.forEach { f ->
            val text = f.readText()
            val pkg = PACKAGE.find(text)?.groupValues?.get(1) ?: return@forEach
            for (m in CLASS.findAll(text)) declared[m.groupValues[1]] = "$pkg.${m.groupValues[1]}" to m.groupValues[2].substringAfterLast('.')
        }
        val gl = mutableSetOf(AndroidFragmentApplication::class.java.simpleName)
        while (true) { val more = declared.filter { (n, d) -> n !in gl && d.second in gl }.keys; if (more.isEmpty()) break; gl += more }
        return declared.filterKeys { it in gl }.values.map { Class.forName(it.first, false, javaClass.classLoader) }
    }

    @Test fun `every GL surface fragment the app declares is discarded after a recreation`() {
        val surfaces = glSurfaceFragments()
        for (name in listOf("KingdomFragment", "WorldFragment", "WorldEngineFragment"))
            assertTrue("the scan finds $name", surfaces.any { it.simpleName == name })
        for (c in surfaces) {
            assertTrue("${c.name} is a GL surface fragment", AndroidFragmentApplication::class.java.isAssignableFrom(c))
            assertTrue("${c.simpleName} rebuilt from saved state is discarded before its view exists", RESTORABLE_GL_SURFACES.any { it.isAssignableFrom(c) })
        }
    }

    @Test fun `a rebuilt WorldEngineFragment without inputs shows an empty frame instead of throwing`() {
        val surface = File(main, "gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineSurface.kt").readText()
        val create = surface.substring(surface.indexOf("class WorldEngineFragment"), surface.indexOf("private fun watchThermal("))
        val view = create.substring(create.indexOf("override fun onCreateView("))
        assertTrue("null inputs take the empty-frame branch", "val made = inputs?.invoke()" in view)
        assertTrue("never a throw in Activity.onStart", "requireNotNull(inputs)" !in view)
    }

    private companion object {
        val PACKAGE = Regex("""(?m)^package\s+([\w.]+)""")
        val CLASS = Regex("""(?m)^(?:(?:open|abstract|internal|public|private|final)\s+)*class\s+(\w+)[^\n{]*?:\s*([\w.]+)\s*\(""")
    }
}
