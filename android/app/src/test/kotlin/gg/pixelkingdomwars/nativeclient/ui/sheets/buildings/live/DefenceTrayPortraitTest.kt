package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomLocal
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.PlacementDraft
import gg.pixelkingdomwars.nativeclient.ui.kingdom.sheetBuildingPortrait
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.ordinaryBuildTrayPortrait
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.buildingArtDrawable
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/** 339e7ac0, delta 2: only the five tracked defence identities are admitted to the tray. */
class DefenceTrayPortraitTest {
    private val types = listOf("archertower", "dragonnest", "electrictower", "lasertower", "powdermine")
    private fun state(): KingdomUiState {
        val pack = Json.parseToJsonElement(requireNotNull(javaClass.getResourceAsStream("/iw3/catalogue.json"))
            .bufferedReader().use { it.readText() }).jsonObject
        val raw = buildJsonObject { put("baseId", "b1"); putJsonArray("buildings") {} }
        return KingdomUiState(home = BaseState(base = BaseSnapshot("b1", null, PlayerSummary(keepLevel = 5, builders = 2),
            null, null, null, emptyList(), emptyList(), emptyList(), 1, raw)), catalogue = pack, local = KingdomLocal(buildMenu = true))
    }
    @Test fun `the five defence tray cards use their own transparent identity resources`() {
        val cards = readTrayFacts(state(), false).cards.associateBy { it.type }
        for (type in types) {
            assertEquals("ui:$type-t1-identity", ordinaryBuildTrayPortrait(type))
            assertEquals("ui:$type-t1-identity", cards.getValue(type).art)
            assertNotNull(buildingArtDrawable(cards.getValue(type).art))
        }
        assertNull("archer is the authored asset family, not another game building type", ordinaryBuildTrayPortrait("archer"))
    }
    // Rewritten 2026-10-06 (fix-builder-bug): this case pinned that the tray-only identity packet (339e7ac0 delta 2) left
    // placement on the catalogue portrait. That portrait is the old icon in a dark grey-rimmed plate, which drew the
    // placement ghost as a framed icon above the footprint (owner screenshot 3: "old grey frame"; "old building ICON is
    // used"). buildings/SPEC.md §4.1 wants the building's own art, outlined, standing on its footprint, so placement now
    // takes the same transparent identity as the tray card and never the plated portrait.
    @Test fun `defence placement ghost draws the tray card transparent identity and never the plated portrait`() {
        val state = state()
        for (type in types) {
            val placement = readPlacementFacts(state.copy(local = KingdomLocal(placement = PlacementDraft(type, 1 to 1))),
                false, 0L, false)!!
            assertEquals(type, ordinaryBuildTrayPortrait(type), placement.art)
            assertNotEquals(type, sheetBuildingPortrait(state.catalogue!!, type, 1), placement.art)
            assertNotNull(type, buildingArtDrawable(placement.art))
        }
    }
    @Test fun `Gold Forge placement ghost is its designed tier art and not the old framed portrait`() {
        // Owner screenshot 3 (2026-10-06): the Gold Forge ghost was `ui_portrait_goldforge_t1`, a dark plate with a grey rim.
        // placement.png draws `pkw_ui_goldforge_t1_idle` outlined on the footprint, the same art as its BUILD card.
        val state = state()
        val placement = readPlacementFacts(state.copy(local = KingdomLocal(placement = PlacementDraft("goldforge", 1 to 1))),
            false, 0L, false)!!
        assertEquals("ui:goldforge-t1-idle", placement.art)
        assertNotNull(buildingArtDrawable(placement.art))
        // Merged with night/fix-icons: sheetBuildingPortrait itself now names the Gold Forge's designed tier art (it no longer
        // returns the old `ui_portrait_*` plate), so "not the old framed portrait" is pinned by name, and the sheet agrees.
        assertFalse(placement.art, placement.art.startsWith("ui_portrait_"))
        assertEquals(sheetBuildingPortrait(state.catalogue!!, "goldforge", 1), placement.art)
    }
    // Owner 2026-10-06 ("old building ICON is used"): sheetBuildingPortrait now names each type's pack tier sprite
    // (BuildingIconArt.kt) instead of the old atlas portrait; the invariant kept here is that tray and placement agree.
    @Test fun `eight types awaiting the owner retain their original tray and placement art`() {
        val state = state(); val cards = readTrayFacts(state, false).cards.associateBy { it.type }
        for (type in listOf("cannon", "mortar", "airdefence", "magetower", "spiketrap", "pitfall", "airmine", "wall")) {
            assertNull(type, ordinaryBuildTrayPortrait(type))
            val expected = sheetBuildingPortrait(state.catalogue!!, type, 1)
            assertEquals(type, expected, cards.getValue(type).art)
            val placement = readPlacementFacts(state.copy(local = KingdomLocal(placement = PlacementDraft(type, 1 to 1))),
                false, 0L, false)!!
            assertEquals(type, expected, placement.art)
        }
    }
    @Test fun `new defence mappings do not replace existing ordinary or Phase E identities`() {
        for (type in listOf("mine", "vault", "barracks", "forge", "camp", "clanhall"))
            assertEquals("ui:$type-t1-identity", ordinaryBuildTrayPortrait(type))
        for (type in listOf("workshop", "lodge", "berth", "harvester", "market", "goldforge", "unknown"))
            assertNull(ordinaryBuildTrayPortrait(type))
    }
    @Test fun `five new PNGs preserve exact tracked identity bytes and RGBA format`() {
        val pins = mapOf(
            "archertower" to "3d9fa7747b75dc981ea70e528cba973cd1c00ab974c3a314d82f482949364e45",
            "dragonnest" to "eb74af23e7d24fd97d9e5ede7453ee46e6fdfc4bd5faa7bd2a8032c3cb649ead",
            "electrictower" to "4367aecb20de1379f8a3d090632157334798202b392b180ee582f45a8ab03ab8",
            "lasertower" to "ab9d3fd34f306ef18d7bfa8e42442497f980e5fb6c1eb549ed78f9ba1903473c",
            "powdermine" to "0e3a86baa164dbadba67934e62303f4cc6557df253b71acf4d7f9eb1fe7e3fc7")
        for ((type, sha) in pins) {
            val bytes = File("src/main/res/drawable-nodpi/pkw_ui_${type}_t1_identity.png").readBytes()
            assertEquals(sha, MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
            assertEquals("PNG", String(bytes.copyOfRange(1, 4), Charsets.US_ASCII))
            assertEquals(6, bytes[25].toInt())
        }
    }
}
