package gg.pixelkingdomwars.nativeclient

import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.audio.*
import gg.pixelkingdomwars.nativeclient.scene.SceneMapper
import gg.pixelkingdomwars.nativeclient.ui.battle.BattleHudProgress
import kotlinx.serialization.json.*
import java.io.File
import java.security.MessageDigest
import org.junit.Assert.*
import org.junit.Test

/** Canonical generated workload. No simulator, clock, API or account mutation runs in this test. */
class Stage100PresentationTest {
    private fun json(path: String) = Json.parseToJsonElement(File(path).readText()).jsonObject
    private val catalogue = json("src/main/assets/native/catalogue.json")
    private val render = json("src/main/assets/native/render-catalog.json")
    private val mapper = SceneMapper(catalogue,render)
    private val root = "src/test/resources/battle-reliability"

    @Test fun `full Stage100 dragon and hero revisions preserve every event and sample densely without changing results`() {
        val provenance = json("$root/provenance.json")
        val artRoot = JsonReader().parse(render.toString())
        val art = CombatArt.catalogue(artRoot)
        for (count in listOf(2,90)) {
            val name = "stage100-dragons-$count.json"
            val source = json("$root/$name")
            val digest = MessageDigest.getInstance("SHA-256").digest(File("$root/$name").readBytes()).joinToString("") { "%02x".format(it) }
            assertEquals(provenance.getValue(name).jsonObject.getValue("sha256").jsonPrimitive.content,digest)
            val scene = mapper.replayScene(source)
            assertEquals(306,scene.base.buildings.size)
            assertEquals(source.getValue("events").jsonArray.map { it.toString() },scene.revision.events.map { it.json })
            assertEquals(if(count==2)1271 else 7176,scene.revision.events.size)
            val model = BattleVisualModel(scene.revision.events,scene.positionCadenceTicks,scene.summonedPositionCadenceTicks)
            val walls = WallVisualModel(scene.base.buildings,WallCatalogue(artRoot),scene.revision.events)
            val visual = CombatVisualPlan(scene,model,art,artRoot.getFloat("buildingDamageThreshold"),walls)
            val sprites = mutableListOf<CombatSprite>()
            // The owner's reported 8–22 second failure interval, plus the exact archived end.
            val ticks = (80..220 step 10).map(Int::toFloat) + scene.revision.events.last().t.toFloat()
            for (tick in ticks) {
                visual.transientSprites(tick,sprites)
                assertTrue(sprites.all { it.x.isFinite() && it.y.isFinite() })
                model.actorIds.forEach { id -> visual.actor(id,tick)?.let { assertTrue(it.x.isFinite() && it.y.isFinite()) } }
                scene.base.buildings.forEach { visual.building(it.id,tick) }
            }
            val hud = BattleHudProgress(scene,catalogue)
            assertEquals(source.getValue("stars").jsonPrimitive.int,hud.at(ticks.last()).first)
            assertEquals(source.getValue("destructionPct").jsonPrimitive.int,hud.at(ticks.last()).second)
            assertEquals(0 to 0,hud.at(0f))
        }
    }

    @Test fun `obsolete dense HUD construction cooperatively cancels before indexing its full journal`() {
        val scene = mapper.replayScene(json("$root/stage100-dragons-90.json"))
        var checkpoints = 0
        assertThrows(java.util.concurrent.CancellationException::class.java) {
            BattleHudProgress(scene,catalogue) { if (++checkpoints == 2) throw java.util.concurrent.CancellationException() }
        }
        assertEquals(2,checkpoints)
    }
    @Test fun `dense Stage100 audio and visual indexing cancel obsolete work without dropping canonical cues`() {
        val source = json("$root/stage100-dragons-90.json")
        val scene = mapper.replayScene(source)
        val artRoot = JsonReader().parse(render.toString())
        val art = CombatArt.catalogue(artRoot)
        val model = BattleVisualModel(scene.revision.events, scene.positionCadenceTicks, scene.summonedPositionCadenceTicks)
        var checks = 0
        assertThrows(java.util.concurrent.CancellationException::class.java) {
            CombatVisualPlan(scene, model, art, checkpoint = { if (++checks == 20) throw java.util.concurrent.CancellationException() })
        }
        assertEquals(20, checks)
        checks = 0
        assertThrows(java.util.concurrent.CancellationException::class.java) {
            PreparedBattleAudio.from(scene, catalogue) { if (++checks == 20) throw java.util.concurrent.CancellationException() }
        }
        assertEquals(20, checks)
        val start = System.nanoTime()
        val prepared = PreparedBattleAudio.from(scene, catalogue)
        val cueMs = (System.nanoTime() - start) / 1e6
        assertTrue(prepared.cues.any { it.family == "sfx_troop_dragon_breath" })
        assertTrue(prepared.cues.any { it.family == "sfx_hero_vex_deploy" })
        assertTrue(prepared.cues.any { it.family == "sfx_hero_theodor_deploy" })
        val definitions = AudioDefinitions(prepared.cues.flatMap { cue -> (1..3).map { variant ->
            val id = "${cue.family}_v$variant"; id to AudioDefinition(id, "fixture.wav")
        } }.toMap())
        val windowStart = System.nanoTime()
        val windows = battleAudioWindows(prepared.cues, definitions, AudioRuntime.from(catalogue))
        val bankMs = (System.nanoTime() - windowStart) / 1e6
        assertTrue(windows.isNotEmpty())
        val cursor = BattleAudioCursor(); cursor.replace(prepared.cues, 0.0)
        assertEquals(prepared.cues.filter { it.dispatch == null }, cursor.advance(prepared.cues.last().atMs, true))
        val report = File("../.reports/battle-reliability/dense-audio-jvm.json")
        requireNotNull(report.parentFile).mkdirs()
        report.writeText(buildJsonObject {
            put("scope", "JVM event preparation only; no device FPS or audio fidelity claim")
            put("events", scene.revision.events.size); put("buildings", scene.base.buildings.size)
            put("cues", prepared.cues.size); put("windows", windows.size)
            put("cuePreparationMs", cueMs); put("bankPreparationMs", bankMs)
        }.toString())
    }

}
