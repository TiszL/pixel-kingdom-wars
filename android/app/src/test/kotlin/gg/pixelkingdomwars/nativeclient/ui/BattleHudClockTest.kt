package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.ui.battle.battleHudPlayhead
import org.junit.Assert.*
import org.junit.Test

class BattleHudClockTest {
    @Test fun `60 display frames publish only source tick changes without predicting a later tick`() {
        val values = (0 until 60).map { battleHudPlayhead(it * 1_000.0 / 60, 100f) }
        assertEquals(10, values.distinct().size)
        assertEquals(0.0, battleHudPlayhead(99.999, 100f), 0.0)
        assertEquals(100.0, battleHudPlayhead(100.0, 100f), 0.0)
        assertEquals(100.0, battleHudPlayhead(149.0, 50f), 0.0)
    }
    @Test fun `loading clock is whole seconds and backwards authoritative corrections remain visible`() {
        assertEquals(1_000.0, battleHudPlayhead(1_999.0, null), 0.0)
        assertEquals(200.0, battleHudPlayhead(200.0, 100f), 0.0)
        assertEquals(100.0, battleHudPlayhead(199.0, 100f), 0.0)
    }
}
