package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.sheetBuildingInfo
import gg.pixelkingdomwars.nativeclient.ui.roster.CodexData
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

/** A completed building that opens INFO must have an authored catalogue entry, not the fallback field report. */
class PhaseEBuildingInfoCatalogueTest {
    private val catalogue = json(requireNotNull(javaClass.getResource("/iw3/catalogue.json")).readText())
    private val roles = mapOf(
        "lodge" to "Plans expeditions and keeps their departure and return records.",
        "berth" to "A mooring for expedition vessels.",
        "harvester" to "Gathers the local materials of this kingdom.",
        "workshop" to "Refines Shards into Forge Ingots for the Gold Forge.",
    )

    @Test fun `every exported structure has INFO prose or an explicit pending owner wording decision`() {
        val structures = (catalogue["constants"] as JsonObject)["STRUCTURES"] as JsonObject
        // Web r8 BuildingInfo.tsx:26-32 and screens/codex.tsx:157-201 have no authored entry for these types.
        // c718dedd forbids inventing their copy. Keep ONE explicit set: a new type or a removed exemption must fail.
        val pendingOwnerWording = setOf(
            "goldforge", // Also pinned as deliberately absent by CodexDataTest.
            "heroaltar", // Hero biography is not a building description.
            "siegestool", // Hero biography is not a building description.
            "market", // Trading-screen action copy is not an authored building entry.
        )
        assertTrue("Remove exemptions for structures the catalogue no longer exports", structures.keys.containsAll(pendingOwnerWording))
        for (type in structures.keys) {
            val entry = sheetBuildingInfo(catalogue, type)
            if (type in pendingOwnerWording) {
                assertNull("$type now has approved prose: remove its exemption", entry)
            } else {
                assertNotNull("Open INFO structure $type needs approved catalogue prose or an explicit owner decision", entry)
                assertTrue("$type must not hide behind an empty report", requireNotNull(entry).who.isNotBlank())
            }
        }
    }

    @Test fun `Phase E upgrade cards do not advertise a new look from a placeholder next portrait`() {
        for (type in roles.keys) {
            val building = Building("selected", type, 1, 0, 0)
            val raw = json("""{"baseId":"home","buildings":[{"id":"selected","type":"$type","level":1}]}""")
            val state = KingdomUiState(home = BaseState(base = BaseSnapshot("home", null,
                PlayerSummary(keepLevel = 3, builders = 2), null, null, null,
                listOf(building), emptyList(), emptyList(), 1, raw)), catalogue = catalogue)
            val scene = BaseScene(listOf(RenderBuilding("selected", "logical-$type", 0f, 0f, 2f, 2f,
                type = type, level = 1, service = RenderServiceIdentity(type, if (type == "berth") null else 1))),
                8, 8, 32f, baseId = "home", visual = RealmVisual("crownlands", 2),
                services = RenderServiceFacts(phaseEArtEnabled = true))
            for (current in listOf(scene, null)) {
                val facts = requireNotNull(readBuildingFacts(state, building, false, 0L, current))
                assertEquals("$type has no separately admitted next-tier preview", facts.artNow, facts.artNext)
                // Isolate the pure card mapper from live service admission; this fixture authorizes no order.
                val card = requireNotNull(liveUpgradeUi(facts.copy(canShowUpgrade = true, paidStep = false,
                    upgradeCost = "1", upgradeCostRaw = "1", upgradePriced = true)))
                assertFalse("$type must not show NEW LOOK, including while its current scene prepares", card.newLook)
                assertEquals(card.artNow, card.artNext)
            }
        }
    }

    @Test fun `every A2 completed structure the live sheet opens has a catalogue role and bundled portrait`() {
        val structures = (catalogue["constants"] as JsonObject)["STRUCTURES"] as JsonObject
        for ((type, role) in roles) {
            assertTrue("The exported catalogue admits $type", type in structures)
            val building = Building("selected", type, 1, 0, 0)
            val raw = json("""{"baseId":"home","buildings":[{"id":"selected","type":"$type","level":1}]}""")
            val state = KingdomUiState(home = BaseState(base = BaseSnapshot("home", null,
                PlayerSummary(keepLevel = 3, builders = 2), null, null, null,
                listOf(building), emptyList(), emptyList(), 1, raw)), catalogue = catalogue)
            val scene = BaseScene(listOf(RenderBuilding("selected", "logical-$type", 0f, 0f, 2f, 2f,
                type = type, level = 1, service = RenderServiceIdentity(type, if (type == "berth") null else 1))),
                8, 8, 32f, baseId = "home", visual = RealmVisual("crownlands", 2),
                services = RenderServiceFacts(phaseEArtEnabled = true))
            val entry = requireNotNull(sheetBuildingInfo(catalogue, type)) { "Open INFO structure $type lacks a Codex entry" }
            val facts = requireNotNull(readBuildingFacts(state, building, false, 0L, scene))
            val ui = liveBuildingInfoUi(facts)
            assertEquals(role, entry.who)
            assertEquals("INFO must consume its entry rather than separate placeholder copy", entry.who, ui.role)
            assertFalse(ui.role.contains("Field reports"))
            assertEquals(listOf(requireNotNull(phaseEBuildingInfoPortrait("home", building, scene))), ui.headerFrames)
            assertFalse("A completed $type cannot reach the unknown-art placeholder", facts.artNow.startsWith("building-"))
        }
    }

    @Test fun `descriptions never create a missing structure and tags follow catalogue retuning`() {
        assertTrue(CodexData.buildings(json("""{"constants":{"STRUCTURES":{}}}""")).isEmpty())
        for (type in roles.keys) {
            assertNull(sheetBuildingInfo(json("""{"constants":{}}"""), type))
            val tuned = json("""{"constants":{"STRUCTURES":{"$type":{"footprint":[3,4],"maxLevel":7}}}}""")
            val entry = requireNotNull(sheetBuildingInfo(tuned, type))
            assertEquals("3×4 · L1–L7", entry.tag)
            assertEquals(roles.getValue(type), entry.who)
            assertFalse("Prose must not hide copied gameplay numbers", (entry.who + entry.strat.orEmpty()).any(Char::isDigit))
        }
    }

    @Test fun `a missing tag constant does not invent a building entry`() {
        for (type in roles.keys) {
            assertNull(sheetBuildingInfo(json("""{"constants":{"STRUCTURES":{"$type":{"maxLevel":7}}}}"""), type))
            assertNull(sheetBuildingInfo(json("""{"constants":{"STRUCTURES":{"$type":{"footprint":[3,4]}}}}"""), type))
        }
    }
}
