package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.network.objects
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.renderer.RealmVisual
import gg.pixelkingdomwars.nativeclient.scene.SceneMapper
import gg.pixelkingdomwars.nativeclient.ui.preview.PreviewFixtures
import gg.pixelkingdomwars.nativeclient.ui.preview.PreviewOptions
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The debug preview decoration exists to photograph the contract-13 renderer; it must stay a pure
 * fixture transform driven by the pack's own wall vocabulary and never invent gameplay state. */
class PreviewFixturesTest {
    private fun json(path: String) = Json.parseToJsonElement(File(path).readText()).jsonObject
    private val catalogue = json("src/main/assets/native/catalogue.json")
    private val render = json("src/main/assets/native/render-catalog.json")
    private val base = json("src/debug/assets/native/fixtures/base.json")

    @Test fun `no options leaves the bundled fixture untouched`() {
        assertEquals(base to emptyList<JsonObject>(), PreviewFixtures.decorate(base, render, PreviewOptions(), 0L))
        assertFalse(PreviewOptions.fromExtras(null, 0, false, false).active)
        assertEquals(PreviewOptions("frostveil", 2, walls = true, job = false), PreviewOptions.fromExtras("frostveil", 2, true, false))
        assertNull(PreviewOptions.fromExtras(" ", -1, false, false).realm)
    }

    @Test fun `army evidence uses the complete current terrain context while explicit legacy previews stay available`() {
        val current = render.getValue("ground").jsonObject.getValue("currentVisual").jsonObject
        val (decorated, _) = PreviewFixtures.decorate(base, render, PreviewOptions(army = "training"), 0L)
        assertEquals("missing groundRevision would silently choose an older painting", current, decorated["visualContext"])
        assertEquals(RealmVisual(current.string("realmId")!!, current.string("artVersion")!!.toInt(), current.string("groundRevision")?.toInt()),
            SceneMapper(catalogue, render).baseScene(decorated).visual)
        val legacy = PreviewFixtures.decorate(base, render, PreviewOptions("crownlands", 1, army = "training"), 0L).first
        assertEquals(RealmVisual("crownlands", 1), SceneMapper(catalogue, render).baseScene(legacy).visual)
        val missingCurrent = JsonObject(render + ("ground" to JsonObject(render.getValue("ground").jsonObject - "currentVisual")))
        assertThrows(IllegalArgumentException::class.java) { PreviewFixtures.decorate(base, missingCurrent, PreviewOptions(army = "training"), 0L) }
    }

    @Test fun `walls of every tier with light and heavy damage plus a running job map into a realm scene`() {
        val now = 1_700_000_000_000L
        val (decorated, health) = PreviewFixtures.decorate(base, render, PreviewOptions("frostveil", 2, walls = true, job = true), now)
        val constants = render.getValue("walls5").jsonObject.getValue("constants").jsonObject
        val tiers = constants.getValue("tiers").jsonPrimitive.int; val levelsPerTier = constants.getValue("levelsPerTier").jsonPrimitive.int
        val walls = decorated.objects("buildings").filter { it.string("type") == "wall" }
        val levels = walls.map { it.string("level")!!.toInt() }.toSet()
        for (tier in 1..tiers) assertTrue("tier $tier present", ((tier - 1) * levelsPerTier + 1) in levels)
        assertEquals(walls.size, walls.map { it.string("tx") to it.string("ty") }.toSet().size)
        val stages = render.getValue("walls5").jsonObject.getValue("damageStages").jsonObject
        val light = stages.getValue("light").jsonObject.getValue("below").jsonPrimitive.double
        val heavy = stages.getValue("heavy").jsonObject.getValue("below").jsonPrimitive.double
        assertEquals(tiers * 2, health.size)
        val fractions = health.map { it.getValue("initialHp").jsonPrimitive.long.toDouble() / it.getValue("maxHp").jsonPrimitive.long }
        assertEquals(tiers, fractions.count { it < light && it >= heavy }); assertEquals(tiers, fractions.count { it < heavy })
        val job = decorated.objects("jobs").single()
        assertEquals(PreviewFixtures.JOB_ID, job.string("id")); assertEquals("2023-11-14T22:13:28Z", job.string("startedAt"))
        assertTrue(decorated.objects("buildings").any { it.string("id") == job.string("buildingId") })
        val scene = SceneMapper(catalogue, render).baseScene(decorated, health)
        assertEquals(RealmVisual("frostveil", 2), scene.visual)
        assertEquals(walls.size, scene.buildings.count { it.type == "wall" })
        assertEquals("the walk starts after the offline scene has had time to load", now + PreviewFixtures.JOB_DELAY_MS, scene.jobs.single().startedAtMs)
        assertEquals(tiers * 2, scene.buildings.count { it.initialHp != null })
        assertEquals(base.objects("buildings").size, PreviewFixtures.decorate(base, render, PreviewOptions(realm = "sunscar"), now).first.objects("buildings").size)
    }
    /** The army preview exists so every chip state can be photographed without training on a real account: it must
     * go through the production planner and mapper, and place nothing on top of the fixture's own buildings. */
    @Test fun `army preview states reach the production chip planner over a mappable base`() {
        val now = 1_700_000_000_000L
        fun chips(state: String) = PreviewFixtures.decorate(base, render, PreviewOptions.fromExtras(null, 0, false, false, state), now).first.let { decorated ->
            val scene = SceneMapper(catalogue, render).baseScene(decorated)
            val cells = scene.buildings.flatMap { b -> (0 until b.footprintWidth.toInt()).flatMap { dx -> (0 until b.footprintHeight.toInt()).map { dy -> b.tileX.toInt() + dx to b.tileY.toInt() + dy } } }
            assertEquals("no overlapping footprints", cells.size, cells.toSet().size)
            gg.pixelkingdomwars.nativeclient.ui.kingdom.armyChips(gg.pixelkingdomwars.nativeclient.model.BaseSnapshot.from(decorated), now, gg.pixelkingdomwars.nativeclient.ui.kingdom.ArmyChipScene(home = true))
        }
        assertEquals(listOf("preview-camp" to listOf("42/108")), chips("partial").map { it.buildingId to it.labels.first() })
        assertEquals(listOf("preview-camp" to listOf("60/108"), "preview-barracks" to listOf("3 TRAINING · 4m 12s · 18/65")), chips("training").map { it.buildingId to it.labels.first() })
        assertEquals(listOf(listOf("FULL 108/108"), listOf("3 TRAINING · 1d 2h · 18/65")), chips("full").map { it.labels.first() })
        assertEquals(listOf(listOf("OVER 112/108")), chips("over").map { it.labels.first() })
        assertNull(PreviewOptions.fromExtras(null, 0, false, false, "anything-else").army)
    }
}
