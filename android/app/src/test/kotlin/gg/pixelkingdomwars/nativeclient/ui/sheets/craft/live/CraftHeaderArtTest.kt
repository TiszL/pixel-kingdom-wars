package gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live

import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.BenchSprite
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHeaderUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftSamples
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftWellUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.IngotJobState
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.IngotJobUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.workshopBenchSprite
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.workshopHeaderArt
import org.junit.Assert.*
import org.junit.Test

/** The craft headers draw the player's own building: the tier must follow the catalogue's level mapping exactly as the
 *  scene does, and the realm key must be the server's, or the sheet shows a different building from the one on the map. */
class CraftHeaderArtTest {
    private fun catalogue(tiers: String = "4", levelsPerTier: String = "3") =
        json("""{"constants":{"ART_V2":{"tiers":$tiers,"levelsPerTier":$levelsPerTier}}}""")

    @Test fun `tier follows the exported level mapping at every boundary`() {
        val art = catalogue()
        // Same rule as the scene mapper: a level-3 building is still tier 1, level 4 starts tier 2.
        assertEquals(1, craftBuildingArtTier(art, 1))
        assertEquals(1, craftBuildingArtTier(art, 3))
        assertEquals(2, craftBuildingArtTier(art, 4))
        assertEquals(4, craftBuildingArtTier(art, 12))
        // Above the last tier the art stays at the top tier rather than naming art that does not exist.
        assertEquals(4, craftBuildingArtTier(art, 13))
        assertEquals(4, craftBuildingArtTier(art, 40))
        assertEquals(2, craftBuildingArtTier(catalogue(tiers = "2", levelsPerTier = "5"), 9))
    }

    @Test fun `no level or no valid mapping gives no tier instead of a tier one guess`() {
        // A guessed tier would draw a wrong building; null keeps the honest grass-only header.
        assertNull(craftBuildingArtTier(catalogue(), 0))
        assertNull(craftBuildingArtTier(catalogue(), -2))
        assertNull(craftBuildingArtTier(catalogue(), null))
        assertNull(craftBuildingArtTier(null, 5))
        assertNull(craftBuildingArtTier(json("""{"constants":{}}"""), 5))
        assertNull(craftBuildingArtTier(json("""{"ART_V2":{"tiers":4,"levelsPerTier":3}}"""), 5))
        assertNull(craftBuildingArtTier(catalogue(tiers = "\"4\""), 5))
        assertNull(craftBuildingArtTier(catalogue(levelsPerTier = "0"), 5))
        assertNull(craftBuildingArtTier(catalogue(tiers = "null"), 5))
    }

    @Test fun `harvester art key is the server realm exactly as sent`() {
        val base = json("""{"visualContext":{"version":1,"realmId":"frostveil","artVersion":2}}""")
        assertEquals("frostveil", harvesterHeaderArtKey(base))
        // No alias is applied: the sprite lookup draws nothing for a key the bundled art does not cover.
        assertEquals("solana-reach", harvesterHeaderArtKey(json("""{"visualContext":{"version":1,"realmId":"solana-reach","artVersion":1}}""")))
    }

    @Test fun `a missing or malformed visual context gives no harvester art key`() {
        assertNull(harvesterHeaderArtKey(null))
        assertNull(harvesterHeaderArtKey(json("""{"baseId":"b"}""")))
        assertNull(harvesterHeaderArtKey(json("""{"visualContext":{"version":1,"artVersion":2}}""")))
        assertNull(harvesterHeaderArtKey(json("""{"visualContext":{"version":1,"realmId":"","artVersion":2}}""")))
        assertNull(harvesterHeaderArtKey(json("""{"visualContext":{"version":0,"realmId":"frostveil","artVersion":2}}""")))
    }

    @Test fun `the bench sprite follows the sheet's own observed jobs`() {
        // Ready ingots outrank a running batch: the player must see that something waits to be collected.
        assertEquals(BenchSprite.READY, workshopBenchSprite(CraftSamples.workshop(CraftSamples.refineWorking, ingots = CraftSamples.ingotsReady)))
        assertEquals(BenchSprite.WORKING, workshopBenchSprite(CraftSamples.workshop(CraftSamples.refineWorking)))
        assertEquals(BenchSprite.WORKING, workshopBenchSprite(CraftSamples.workshop(ingots = CraftSamples.ingots.copy(
            job = IngotJobUi("job-c", 4, CraftSamples.NOW + 95_000L, IngotJobState.RUNNING)))))
        assertEquals(BenchSprite.IDLE, workshopBenchSprite(CraftSamples.workshop(CraftSamples.refine)))
        assertEquals(BenchSprite.IDLE, workshopBenchSprite(CraftSamples.workshop(ingots = CraftSamples.ingots)))
    }

    @Test fun `host header art fills only a sheet without its own sprite and keeps the tab wells`() {
        val wells = CraftHeaderUi(null, input = CraftWellUi("shards", 1f, "Input: Shards"), output = CraftWellUi("craft:inv_forge_ingot", 1f, "Output"))
        val bare = CraftSamples.workshop(ingots = CraftSamples.ingotsReady).copy(header = wells)
        val drawn = workshopHeaderArt(bare, 2)
        assertEquals("craft:workshop_t2_ready", drawn.sprite)
        assertEquals(wells.input, drawn.input); assertEquals(wells.output, drawn.output)
        // A working bench plays its loop; no host tier keeps grass only; a sheet's own sprite always wins.
        assertNotNull(workshopHeaderArt(CraftSamples.workshop(CraftSamples.refineWorking).copy(header = CraftHeaderUi(null)), 3).loop)
        assertNull(workshopHeaderArt(bare, null).sprite)
        val own = CraftSamples.workshop(CraftSamples.refine)
        assertSame(own.header, workshopHeaderArt(own, 4))
    }
}
