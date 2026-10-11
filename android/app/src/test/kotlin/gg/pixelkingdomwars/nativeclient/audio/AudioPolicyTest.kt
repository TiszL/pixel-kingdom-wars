package gg.pixelkingdomwars.nativeclient.audio

import gg.pixelkingdomwars.nativeclient.network.NativeContentFile
import gg.pixelkingdomwars.nativeclient.network.NativeContentManifest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

internal val audioReference: JsonObject by lazy {
    Json.parseToJsonElement(checkNotNull(AudioPolicyTest::class.java.getResourceAsStream("/audio/source-reference.json"))
        .bufferedReader().use { it.readText() }).jsonObject
}
internal fun audioRuntime() = AudioRuntime.from(audioReference.getValue("catalogue").jsonObject)
internal fun audioPack(identity: String = "a".repeat(64), paths: List<String> = MusicTrack.entries.map { it.path }) =
    AudioPack(NativeContentManifest("b".repeat(40), 14, identity, paths.sorted().map { NativeContentFile(it, "c".repeat(64), 1, "optional") }), audioRuntime())

class AudioPolicyTest {
    @Test fun `production FNV hash matches UTF16 astral and Georgian keys`() {
        audioReference.getValue("hashes").jsonArray.forEach { value ->
            val entry = value.jsonObject
            assertEquals(entry.getValue("hash").jsonPrimitive.long.toUInt(), deterministicSfxHash(entry.getValue("value").jsonPrimitive.content))
        }
    }
    @Test fun `music and ambience route only canonical contexts`() {
        assertEquals(MusicTrack.BATTLE, MusicTrack.forScreen("battle"))
        listOf("base", "mail", "map", "scout", "loading", "profile").forEach { assertEquals(MusicTrack.WORLD, MusicTrack.forScreen(it)) }
        assertEquals("sfx_ambience_campaign", ambienceFamilyForScreen("scout"))
        assertEquals("sfx_ambience_base_day", ambienceFamilyForScreen("layout"))
        assertEquals("sfx_ambience_battle", ambienceFamilyForScreen("battle"))
        assertNull(ambienceFamilyForScreen("mail"))
    }
    @Test fun `unexported or malformed runtime values refuse audio instead of invented defaults`() {
        assertThrows(NoSuchElementException::class.java) { AudioRuntime.from(buildJsonObject { put("constants", buildJsonObject {}) }) }
        val catalogue = audioReference.getValue("catalogue").jsonObject
        val constants = catalogue.getValue("constants").jsonObject
        val runtime = constants.getValue("AUDIO_RUNTIME").jsonObject
        assertThrows(IllegalArgumentException::class.java) { AudioRuntime.from(JsonObject(catalogue + ("constants" to JsonObject(constants +
            ("AUDIO_RUNTIME" to JsonObject(runtime + ("maxOneShotVoices" to JsonPrimitive(-1)))))))) }
    }
    @Test fun `public manifest cannot select an unpinned path or an unmeasured MP3 loop`() {
        val paths = listOf("audio/sfx/sfx_tap.wav", "audio/sfx-ai/cue.mp3", "audio/sfx-ai/loop.mp3")
        val manifest = Json.parseToJsonElement("""{"schemaVersion":1,"entries":[
          {"id":"sfx_ui_tap_v1","file":"cue.mp3"},
          {"id":"sfx_ui_tap_v2","file":"missing.mp3"},
          {"id":"sfx_ui_tap_v3","file":"../outside.mp3"},
          {"id":"sfx_ambience_base_day_v1","file":"loop.mp3","loopStart":0.1,"loopEnd":2.5},
          {"id":"sfx_ambience_base_day_v2","file":"loop.mp3","loopStart":2.5,"loopEnd":0.1}
        ]}""").jsonObject
        val definitions = AudioDefinitions.from(audioPack(paths = paths), manifest)
        assertNotNull(definitions.get("sfx_tap")); assertNotNull(definitions.resolve("sfx_ui_tap", "tap"))
        assertNull(definitions.resolve("sfx_ui_tap", "tap", loop = true))
        assertEquals("sfx_ambience_base_day_v1", definitions.resolve("sfx_ambience_base_day", "base", true)?.id)
        assertNull(definitions.get("sfx_ui_tap_v2")); assertNull(definitions.get("sfx_ui_tap_v3"))
    }
    @Test fun `critical cues evict oldest lower priority voices while ambience cannot evict gameplay`() {
        val plan = AudioVoicePlan(audioRuntime().copy(maxOneShotVoices = 2, maxOneShotVoicesPerCue = 2))
        val first = plan.admit("a", AudioPriority.NORMAL, 0).voice!!
        val second = plan.admit("b", AudioPriority.NORMAL, 30).voice!!
        assertNull(plan.admit("c", AudioPriority.AMBIENT, 60).voice)
        val critical = plan.admit("c", AudioPriority.CRITICAL, 90)
        assertEquals(listOf(first), critical.evicted); assertNotNull(critical.voice)
        assertEquals(listOf(second, critical.voice), plan.active)
    }
    @Test fun `same cue coalesces duplicates and releases one exact voice without freeing another`() {
        val runtime = audioRuntime().copy(maxOneShotVoicesPerCue = 1)
        val plan = AudioVoicePlan(runtime)
        val first = plan.admit("tap", AudioPriority.NORMAL, 0).voice!!
        assertNull(plan.admit("tap", AudioPriority.NORMAL, runtime.duplicateCoalesceMs - 1).voice)
        val next = plan.admit("tap", AudioPriority.NORMAL, runtime.duplicateCoalesceMs)
        assertEquals(listOf(first), next.evicted)
        plan.ended(first.token); assertEquals(listOf(next.voice), plan.active)
        assertEquals(listOf(next.voice), plan.clear()); assertTrue(plan.active.isEmpty())
        assertNotNull(plan.admit("tap", AudioPriority.NORMAL, 0).voice)
    }
    @Test fun `current cue resolution never rescans the immutable production catalogue`() {
        var traversals = 0
        val values = (0 until 600).associate { index ->
            "sfx_family_${index}_v1" to AudioDefinition("sfx_family_${index}_v1", "sample.wav")
        }
        val observed = object : Map<String, AudioDefinition> by values {
            override val values: Collection<AudioDefinition> get() { traversals++; return values.values }
        }
        val definitions = AudioDefinitions(observed)
        val preparedTraversals = traversals
        repeat(1_000) { assertEquals("sfx_family_42_v1", definitions.resolve("sfx_family_42", "$it")?.id) }
        assertEquals(preparedTraversals, traversals)
        assertNull(definitions.resolve("sfx_family_42.*", "x"))
    }

}
