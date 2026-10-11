package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomLocal
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.PlacementDraft
import gg.pixelkingdomwars.nativeclient.ui.kingdom.sheetBuildingPortrait
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.buildingPortrait
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.readPlacementFacts
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The one building → art rule (BuildingIconArt.kt). Owner, 2026-10-06: "in some cases old building ICON is used for
 * example barracks". These cases fail if any building path can again reach the old 56 px dark-box atlas portrait, if the
 * rule names a pack frame the pinned pack does not carry (the icon would silently fall back), or if the rule starts
 * swallowing designed portraits that are NOT building art (troops, the hub/map keep emblem, garrison mini portraits).
 */
class BuildingIconArtTest {
    private fun resource(path: String) = requireNotNull(javaClass.getResourceAsStream(path)).bufferedReader().use { it.readText() }
    private val catalogue = Json.parseToJsonElement(resource("/iw3/catalogue.json")).jsonObject
    private val artV2 = (catalogue["constants"] as JsonObject)["ART_V2"] as JsonObject
    private val perTier = artV2.getValue("levelsPerTier").jsonPrimitive.int
    private val tiers = artV2.getValue("tiers").jsonPrimitive.int
    private fun tierOf(level: Int) = minOf((level - 1) / perTier + 1, tiers)

    /** Every type sheetBuildingPortrait tiers (its own `tiered` set). */
    private val tiered = listOf("cannon", "mortar", "airdefence", "airmine", "forge", "archertower", "barracks", "camp",
        "clanhall", "dragonnest", "electrictower", "goldforge", "keep", "lasertower", "magetower", "mine", "pitfall",
        "powdermine", "spiketrap", "vault")

    @Test fun `every tiered building at every level draws designed art and never an old atlas portrait`() {
        for (type in tiered) for (level in 1..perTier * tiers) {
            val name = sheetBuildingPortrait(catalogue, type, level)
            assertFalse("$type L$level -> $name", name.startsWith("ui_portrait_") || name.startsWith("building-"))
            assertTrue("$type L$level -> $name is drawn by BuildingArt", ownsBuildingArt(name))
            when (type) {
                "keep" -> { assertEquals(keepArtName(level), name); assertNotNull(r2ArtDrawable(name)) }
                "goldforge" -> assertNotNull(name, buildingArtDrawable(name))
                else -> assertEquals("$type L$level", PackBuildingRef(type, tierOf(level)), packBuildingRef(name))
            }
        }
    }

    @Test fun `every pack frame the rule can name is pinned by the pack and drawn by the base scene`() {
        val manifest = Json.parseToJsonElement(resource("/iw3/manifest.json")).jsonObject
        val pinned = manifest.getValue("files").jsonArray.map { it.jsonObject.getValue("path").jsonPrimitive.content }.toSet()
        val render = resource("/iw3/render-catalog.json")
        for (type in PACK_BUILDING_TYPES) for (tier in 1..tiers) {
            val frame = requireNotNull(packBuildingFrame(type, tier)) { "$type t$tier" }
            assertTrue("$type t$tier atlas ${frame.atlas}", frame.atlas in pinned)
            assertTrue("$type t$tier sheet", frame.atlas.removeSuffix(".json") + ".png" in pinned)
            assertTrue("$type t$tier frame ${frame.frame}", "\"${frame.frame}\"" in render)
        }
        assertNull(packBuildingFrame("keep", 1))
        assertNull(packBuildingFrame("barracks", 0))
    }

    @Test fun `pack names round trip and nothing else parses as one`() {
        for (type in PACK_BUILDING_TYPES) assertEquals(PackBuildingRef(type, 3), packBuildingRef(packBuildingArtName(type, 3)))
        for (name in listOf("pack:workshop-t1", "pack:barracks-t0", "pack:barracks", "pack:Barracks-t1", "ui_portrait_barracks_t1",
            "barracks", "pack:barracks-t1-idle"))
            assertNull(name, packBuildingRef(name))
    }

    @Test fun `army headers draw the current tier world sprite of their building`() {
        for (level in 1..perTier * tiers) {
            assertEquals(packBuildingArtName("barracks", tierOf(level)), buildingPortrait(catalogue, "barracks", level))
            assertEquals(packBuildingArtName("camp", tierOf(level)), buildingPortrait(catalogue, "camp", level))
            assertEquals(packBuildingArtName("forge", tierOf(level)), buildingPortrait(catalogue, "forge", level))
        }
        // An unread level or rule draws tier 1, still the world sprite.
        assertEquals("pack:barracks-t1", buildingPortrait(null, "barracks", null))
    }

    @Test fun `the Gold Forge placement ghost is its designed tier one art, not the old framed portrait`() {
        val raw = buildJsonObject { put("baseId", "b1"); putJsonArray("buildings") {} }
        val state = KingdomUiState(home = BaseState(base = BaseSnapshot("b1", null, PlayerSummary(keepLevel = 5, builders = 2),
            null, null, null, emptyList(), emptyList(), emptyList(), 1, raw)), catalogue = catalogue,
            local = KingdomLocal(placement = PlacementDraft("goldforge", 1 to 1)))
        val art = requireNotNull(readPlacementFacts(state, false, 0L, false)).art
        assertEquals("ui:goldforge-t1-idle", art)
        assertNotNull(buildingArtDrawable(art))
    }

    @Test fun `older building glyphs resolve to designed art but the Keep emblem is left to its designed portrait`() {
        assertEquals("pack:barracks-t1", legacyBuildingGlyphArt("building-barracks"))
        assertEquals("ui:goldforge-t1-idle", legacyBuildingGlyphArt("building-goldforge"))
        for (name in listOf("building-keep", "building-wall", "building-heroaltar", "building-siegestool", "building-workshop", "barracks"))
            assertNull(name, legacyBuildingGlyphArt(name))
    }

    @Test fun `designed portraits that are not building art stay with their own renderers`() {
        // Troop portraits, the hub and map keep emblem, the clan hall emblem and the campaign garrison mini portraits are
        // designed dark-well portraits (army, hub, account and map SPECs); walls, heroes and kit glyphs have their own art.
        for (name in listOf("ui_portrait_highlander_t2", "ui_portrait_keep_t3", "ui_portrait_clanhall_t2", "ui_portrait_cannon_t2",
            "building-keep", "wall5_t1_straight_intact_f1", "hero_vex_portrait", "shape:hammer", "builder", "ui:workshop-menu"))
            assertFalse(name, ownsBuildingArt(name))
        for (name in listOf("building-barracks", "ui:barracks-t1-identity", "ui:keep-l3-idle", "pack:cannon-t2", "ui:workshop-t2-idle",
            "ui:goldforge-t4-idle"))
            assertTrue(name, ownsBuildingArt(name))
    }
}
