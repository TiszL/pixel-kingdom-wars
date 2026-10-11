package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.ui.army.troopCellStats
import gg.pixelkingdomwars.nativeclient.ui.army.troopCostLine
import gg.pixelkingdomwars.nativeclient.ui.army.troopTrainTime
import org.junit.Assert.*
import org.junit.Test

/** The Barracks cell prints the price and time the server charges, read from the pack by the names
 * constants.ts exports; a troop the pack does not price gets no invented line. */
class TrainingCellsTest {
    private val catalogue = json("""{"constants":{
        "TROOPS":{"highlander":{"pts":2,"costKeep":12,"trainSec":12,"hp":120,"dps":18,"speedTilesPerSec":1.2,"range":"melee"},
            "bowman":{"pts":1,"costKeep":10,"trainSec":9,"hp":45,"dps":14,"speedTilesPerSec":1.4,"range":3.5},
            "kegrunner":{"pts":1,"costKeep":10,"trainSec":7.5,"hp":25,"dps":45,"speedTilesPerSec":2.4,"range":"melee"},
            "direwyvern":{"pts":25,"costKeep":1900,"trainSec":90,"hp":1,"dps":1,"speedTilesPerSec":1,"range":"melee"},
            "unpriced":{"pts":1,"hp":1,"dps":1}},
        "TROOP_LEVELING":{"statMultPerLevel":1.2,"maxLevel":20}}}""")

    @Test fun `the cost line is shards then the training time in the shared duration words`() {
        assertEquals("12 SHARDS · 12s", troopCostLine(catalogue, "highlander"))
        assertEquals("Thousands are grouped like every other price", "1,900 SHARDS · 1m 30s", troopCostLine(catalogue, "direwyvern"))
        assertEquals("A fractional pack time is printed exactly, never rounded up", "10 SHARDS · 7.5s", troopCostLine(catalogue, "kegrunner"))
        assertEquals("2m", troopTrainTime(120.0))
    }
    @Test fun `an unpriced or unknown troop gets no price line`() {
        assertNull(troopCostLine(catalogue, "unpriced"))
        assertNull(troopCostLine(catalogue, "tunneler"))
        assertNull(troopCostLine(null, "highlander"))
    }
    @Test fun `hp and damage appear only at a real server level and scale like the web`() {
        assertEquals("SPD 1.2 · RNG M · 2 PTS", troopCellStats(catalogue, "highlander", null))
        assertEquals("HP 144 · DMG 22 · SPD 1.2 · RNG M · 2 PTS", troopCellStats(catalogue, "highlander", 2))
        assertEquals("Ranged troops print their range in tiles", "HP 45 · DMG 14 · SPD 1.4 · RNG 3.5 · 1 PTS", troopCellStats(catalogue, "bowman", 1))
        assertNull(troopCellStats(catalogue, "tunneler", 1))
    }
}
