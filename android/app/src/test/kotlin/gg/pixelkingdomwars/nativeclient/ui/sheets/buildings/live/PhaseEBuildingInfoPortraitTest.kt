package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.PreparedBaseSceneResult
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.buildingArtDrawable
import org.junit.Assert.*
import org.junit.Test

/** INFO uses the current scene's completed appearance; a stale scene cannot lend it an installed family. */
class PhaseEBuildingInfoPortraitTest {
    private fun building(type: String = "lodge", level: Int = 6) = Building("selected", type, level, 0, 0)
    private fun scene(building: Building = building(), tier: Int? = 2, realm: String = "crownlands",
        facts: RenderServiceFacts = RenderServiceFacts(phaseEArtEnabled = true)): BaseScene = BaseScene(
        listOf(RenderBuilding(building.id, "logical-${building.type}", 0f, 0f, 2f, 2f,
            type = building.type, level = building.level, underConstruction = building.underConstruction,
            service = RenderServiceIdentity(building.type, tier))),
        8, 8, 32f, baseId = "home", visual = RealmVisual(realm, 2), services = facts)

    @Test fun `Lodge and Workshop portraits use the scene tier rather than a duplicated level table`() {
        for (type in listOf("lodge", "workshop")) for (tier in 1..4) {
            val b = building(type)
            val portrait = phaseEBuildingInfoPortrait("home", b, scene(b, tier))
            assertEquals("ui:$type-t$tier-idle", portrait)
            assertNotNull(buildingArtDrawable(requireNotNull(portrait)))
        }
    }

    @Test fun `Harvester portraits use every bundled realm and the current completed tier`() {
        for (realm in listOf("cinderfall", "crownlands", "elderwood", "frostveil", "seeker-reach", "stormcairn", "sunscar", "thornwake")) {
            for (tier in 1..4) {
                val b = building("harvester")
                val portrait = phaseEBuildingInfoPortrait("home", b, scene(b, tier, realm))
                assertEquals("ui:harv-$realm-t$tier-idle", portrait)
                assertNotNull(buildingArtDrawable(requireNotNull(portrait)))
            }
        }
    }

    @Test fun `APK004 completed Berth without vehicle facts shows the authored starter mooring`() {
        val b = building("berth", 1)
        assertEquals("ui:berth-starter-intact", phaseEBuildingInfoPortrait("home", b, scene(b, null)))
    }

    @Test fun `Berth portrait shares A1 family selection including every installed advanced family`() {
        val b = building("berth", 1)
        for (family in listOf("survey_balloon", "cargo_cutter", "courier_airship", "expedition_barge")) {
            for (presence in RenderAdvancedPresence.entries) {
                val facts = RenderServiceFacts(phaseEArtEnabled = true, currentAdvancedBerths = listOf(
                    RenderAdvancedBerth(b.id, RenderAdvancedInstallation(family, 1, presence))))
                val s = scene(b, null, facts = facts)
                val selected = requireNotNull(completedBerthAppearance(s.buildings.single(), facts))
                val portrait = phaseEBuildingInfoPortrait("home", b, s)
                assertEquals("ui:berth-${selected.removeSuffix("-berth")}-intact", portrait)
                assertNotNull("Every admitted family must resolve to real bundled pixels", buildingArtDrawable(requireNotNull(portrait)))
            }
        }
    }

    @Test fun `starter occupied and away have the same intact portrait without enabling a journey`() {
        val b = building("berth", 1)
        for (presence in RenderStarterPresence.entries) {
            val facts = RenderServiceFacts(phaseEArtEnabled = true,
                berths = listOf(RenderBerthPresentation(b.id, RenderStarterInstallation("starter", presence))))
            assertEquals("ui:berth-starter-intact", phaseEBuildingInfoPortrait("home", b, scene(b, null, facts = facts)))
        }
    }

    @Test fun `unknown contradictory and duplicate Berth facts cannot become a guessed portrait`() {
        val b = building("berth", 1)
        val starter = RenderBerthPresentation(b.id, RenderStarterInstallation("starter", RenderStarterPresence.AWAY))
        val advanced = RenderAdvancedBerth(b.id, RenderAdvancedInstallation("cargo_cutter", 1, RenderAdvancedPresence.OCCUPIED))
        val invalid = listOf(
            RenderServiceFacts(true, berths = listOf(starter, starter)),
            RenderServiceFacts(true, berths = listOf(starter), currentAdvancedBerths = listOf(advanced)),
            RenderServiceFacts(true, currentAdvancedBerths = listOf(advanced, advanced)),
            RenderServiceFacts(true, currentAdvancedBerths = listOf(advanced.copy(installation = advanced.installation!!.copy(family = "future_ship")))),
        )
        for (facts in invalid) assertNull(phaseEBuildingInfoPortrait("home", b, scene(b, null, facts = facts)))
    }

    @Test fun `base building type and completed level must match the current scene`() {
        val b = building()
        val s = scene(b)
        assertNull(phaseEBuildingInfoPortrait("another-home", b, s))
        assertNull(phaseEBuildingInfoPortrait(null, b, s.copy(baseId = null)))
        assertNull(phaseEBuildingInfoPortrait("home", b.copy(id = "another"), s))
        assertNull(phaseEBuildingInfoPortrait("home", b.copy(type = "workshop"), s))
        assertNull(phaseEBuildingInfoPortrait("home", b.copy(level = b.level + 1), s))
        assertNull(phaseEBuildingInfoPortrait("home", b, null))
    }

    @Test fun `construction and missing or inconsistent service identity refuse the completed portrait`() {
        val b = building()
        val s = scene(b)
        assertNull(phaseEBuildingInfoPortrait("home", b.copy(underConstruction = true), s))
        assertNull(phaseEBuildingInfoPortrait("home", b, s.copy(buildings = listOf(s.buildings.single().copy(underConstruction = true)))))
        assertNull(phaseEBuildingInfoPortrait("home", b, s.copy(buildings = listOf(s.buildings.single().copy(service = null)))))
        assertNull(phaseEBuildingInfoPortrait("home", b, s.copy(buildings = listOf(s.buildings.single().copy(service = RenderServiceIdentity("workshop", 2))))))
        val job = RenderJob("new", "build", 0f, 0f, 2f, 2f, 0L, 1000L, b.id)
        assertNull(phaseEBuildingInfoPortrait("home", b, s.copy(jobs = listOf(job))))
        assertEquals("ui:lodge-t2-idle", phaseEBuildingInfoPortrait("home", b, s.copy(jobs = listOf(job.copy(kind = "upgrade")))))
        val zero = building(level = 0)
        assertNull(phaseEBuildingInfoPortrait("home", zero, scene(zero)))
    }

    @Test fun `missing unknown or unsupported tier and realm never use unknown-art fallback`() {
        val b = building()
        for (tier in listOf(null, 0, 99)) assertNull(phaseEBuildingInfoPortrait("home", b, scene(b, tier)))
        val harvester = building("harvester")
        assertNull(phaseEBuildingInfoPortrait("home", harvester, scene(harvester, realm = "future_realm")))
        assertNull(phaseEBuildingInfoPortrait("home", harvester, scene(harvester).copy(visual = null)))
        val cannon = building("cannon")
        assertNull(phaseEBuildingInfoPortrait("home", cannon, scene(cannon)))
    }

    @Test fun `disabled unknown and retained stale service facts cannot publish a portrait`() {
        val b = building()
        for (enabled in listOf(false, null)) {
            assertNull(phaseEBuildingInfoPortrait("home", b, scene(b, facts = RenderServiceFacts(phaseEArtEnabled = enabled))))
        }
        val raw = json("""{"baseId":"home","revision":1}""")
        val retained = PreparedBaseSceneResult(scene(b), rawSource = raw)
        assertEquals("ui:lodge-t2-idle", phaseEBuildingInfoPortrait("home", b, retained.forSource(raw).scene))
        assertNull(phaseEBuildingInfoPortrait("home", b, retained.forSource(json("""{"baseId":"home","revision":2}""")).scene))
    }

    @Test fun `live info and scene surface receive the same single prepared scene`() {
        val source = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/KingdomScreen.kt").readText()
        assertEquals(1, Regex("rememberPreparedBaseScene\\(").findAll(source).count())
        assertTrue(source.contains("readBuildingFacts(state, it, busy, now, preparedScene?.scene)"))
        assertTrue(source.contains("preparedScene.scene?.let { mapped ->"))
        assertTrue(source.contains("SceneSurface(assets, mapped,"))
        assertTrue(source.indexOf("val preparedScene =") < source.indexOf("val liveFacts ="))
    }
}
