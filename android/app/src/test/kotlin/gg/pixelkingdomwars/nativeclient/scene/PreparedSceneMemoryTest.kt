package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.renderer.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Owner 2026-10-06 (Seeker, build 607a9c37): Home showed the live HUD over a black "Opening your kingdom…" shell. The
 * prepared scene lived only in Kingdom's composition, so every re-entry (MAP or MORE and back, a standalone route, a
 * battle) started from an empty result: the payload was mapped again behind the shell, and only then could the GL surface
 * even start. A reopened Home now starts on the scene it last prepared, which also lets the GL start overlap the fresh
 * mapping. On the same path: Home's per-second recomposition compared the ~8 MB render catalogue tree as a remember key.
 */
class PreparedSceneMemoryTest {
    private val catalogue = buildJsonObject { put("schemaVersion", 1) }
    private val render = buildJsonObject { put("rendererContractVersion", 17) }
    private fun raw(revision: Int) = buildJsonObject { put("baseId", "base-1"); put("revision", revision) }
    private val shown = raw(1)
    private val home = "model-A" to "base-1"
    private val scene = BaseScene(listOf(RenderBuilding("keep-1", "keep-frame", 1f, 2f, 2f, 2f, type = "workshop")), 30, 30, 64f,
        baseId = "base-1", services = RenderServiceFacts(true, emptyList(), listOf(RenderServiceActivity("keep-1", RenderServiceState.WORKING))))
    private val prepared = PreparedBaseSceneResult(scene, rawSource = shown)

    @Test fun `a reopened Home starts on the scene it last prepared, service facts and all`() {
        val memory = PreparedSceneMemory()
        memory.keep(home, catalogue, render, prepared)
        val reopened = memory.recall("model-A" to "base-1", catalogue, render, shown)
        assertSame("the same payload: nothing to map again, nothing to strip", prepared, reopened)
        assertSame(scene, reopened!!.scene)
        assertSame("an equal re-read is the same content (forSource keeps its facts)", prepared,
            memory.recall(home, catalogue, render, JsonObject(shown.toMap())))
    }

    @Test fun `a changed payload never seeds, so a reopened Home never starts on stripped or stale service facts`() {
        val memory = PreparedSceneMemory()
        memory.keep(home, catalogue, render, prepared)
        // N-C5: forSource would strip this scene's services for the new payload; the reopened Home maps it fresh instead.
        assertNull(memory.recall(home, catalogue, render, raw(2)))
    }

    @Test fun `another base, another session or another content generation never seeds`() {
        val memory = PreparedSceneMemory()
        memory.keep(home, catalogue, render, prepared)
        assertNull("another base", memory.recall("model-A" to "base-2", catalogue, render, shown))
        assertNull("another signed-in session (a new Home model)", memory.recall("model-B" to "base-1", catalogue, render, shown))
        // A content update publishes new instances; a scene mapped from the old ones may name frames the new pack lacks.
        assertNull("another catalogue instance, even with equal text", memory.recall(home, JsonObject(catalogue.toMap()), render, shown))
        assertNull("another render catalogue instance", memory.recall(home, catalogue, JsonObject(render.toMap()), shown))
    }

    @Test fun `only a successful preparation is kept and the newest one wins`() {
        val memory = PreparedSceneMemory()
        memory.keep(home, catalogue, render, PreparedBaseSceneResult())
        assertNull("nothing prepared yet", memory.recall(home, catalogue, render, shown))
        memory.keep(home, catalogue, render, prepared)
        memory.keep(home, catalogue, render, prepared.copy(failed = true))
        assertSame("a failed preparation does not replace the good scene", prepared, memory.recall(home, catalogue, render, shown))
        val next = PreparedBaseSceneResult(scene.copy(keepLevel = 2), rawSource = raw(2))
        memory.keep(home, catalogue, render, next)
        assertNull("the older payload is not the shown one any more", memory.recall(home, catalogue, render, shown))
        assertSame(next, memory.recall(home, catalogue, render, raw(2)))
    }

    @Test fun `Home hands its prepared scene to the memory its view model keeps`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/PreparedBaseScene.kt").readText()
        val kingdom = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/KingdomScreen.kt").readText()
        assertTrue("the model outlives the Kingdom composition", kingdom.contains("visualLog, model.preparedScenes)"))
        assertTrue("seeded from the memory when the state is created",
            source.contains("mutableStateOf(memory?.recall(identity, catalogueKey.raw, renderKey.raw, raw) ?: PreparedBaseSceneResult())"))
        assertTrue("every successful preparation is kept", source.contains("memory?.keep(identity, catalogueKey.raw, renderKey.raw, result)"))
        assertTrue("a seed of this exact payload is not mapped again",
            source.contains("if (prepared.rawSource === payload && prepared.scene != null && !prepared.failed)"))
    }

    // ---- the catalogue keys: Home recomposes at least once a second

    /** A map that counts every read, wrapped by a real JsonObject. */
    private class CountingMap(private val inner: Map<String, JsonElement>) : AbstractMap<String, JsonElement>() {
        var reads = 0
        override val entries: Set<Map.Entry<String, JsonElement>> get() { reads++; return inner.entries }
        override fun get(key: String): JsonElement? { reads++; return inner[key] }
    }

    @Test fun `JsonObject equality walks a catalogue even against the same instance`() {
        // Why the catalogues may not be remember keys: Compose compares keys with equals on every recomposition, and this
        // is what equals costs for the ~8 MB render catalogue — there is no identity short-circuit.
        val counting = CountingMap(mapOf("entries" to buildJsonArray { add(1) }, "terrain" to JsonPrimitive("t")))
        val big = JsonObject(counting)
        counting.reads = 0
        @Suppress("ReplaceCallWithBinaryOperator") assertTrue(big.equals(big))
        assertTrue("JsonObject.equals read its own entries", counting.reads > 0)
    }

    @Test fun `the catalogue key answers the same instance without reading it`() {
        val counting = CountingMap(mapOf("entries" to buildJsonArray { add(1) }))
        val big = JsonObject(counting)
        val keys = BaseSourceKeys()
        val key = keys.keyFor(big)
        counting.reads = 0
        repeat(60) { assertSame("a minute of 1 Hz recompositions keeps one key", key, keys.keyFor(big)) }
        assertEquals("and never walks the catalogue", 0, counting.reads)
    }

    @Test fun `the prepared scene never uses a catalogue as a remember key`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/PreparedBaseScene.kt").readText()
        val keyed = Regex("""remember\(([^)]*)\)""").findAll(source).flatMap { m -> m.groupValues[1].split(',').map(String::trim) }.toSet()
        assertFalse("catalogue is never compared per recomposition: $keyed", "catalogue" in keyed)
        assertFalse("render is never compared per recomposition: $keyed", "render" in keyed)
        assertTrue(source.contains("remember(catalogueKey,renderKey) { SceneMapper(catalogueKey.raw,renderKey.raw,log) }"))
    }
}
