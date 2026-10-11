package gg.pixelkingdomwars.nativeclient.diagnostics

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The Home opening could not be measured on the Seeker: the PKWLoad vocabulary existed but only SERVICE_READY and
 * PRIVATE_CONTENT_PARSE were ever marked, so "Opening your kingdom…" could not be split into its mapping and GL stages or
 * timed before and after a fix. The measurement plan greps these lines; they must exist,
 * and like every PKWLoad line they must stay account-free (debug and candidate builds print them to logcat).
 */
class SceneLoadMarksTest {
    private val sources = File("src/main/kotlin").walkTopDown().filter { it.name.endsWith(".kt") }.map { it.readText() }.joinToString("\n")

    @Test fun `the Home opening stages are marked`() {
        for (event in listOf("SCENE_MAP", "FRAGMENT_CREATE", "SCENE_SUBMIT", "SCENE_READY", "FRAGMENT_REMOVE", "VEIL_SHOWN", "FRAME_CAPTURE", "SUMMARY"))
            assertTrue("the measurement plan greps PKWLoad for $event", sources.contains("SceneLoadLog.mark(LoadEvent.$event"))
    }

    @Test fun `no load mark carries account identity`() {
        val marks = Regex("""SceneLoadLog\.mark\(LoadEvent\.[A-Z_]+[^\n]*""").findAll(sources).map { it.value }.toList()
        assertTrue(marks.isNotEmpty())
        for (line in marks) for (private in listOf("baseId", "wallet", "session", "raw.", "base?."))
            assertFalse("PKWLoad is account-free: $line", line.contains(private))
    }
}
