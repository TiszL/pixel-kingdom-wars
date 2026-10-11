package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import gg.pixelkingdomwars.nativeclient.ui.kit.SheetGeometry
import gg.pixelkingdomwars.nativeclient.ui.kit.sheetEdgesDp
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * MS-M2: the SheetHost hands a FULL card a modifier already at y 60 (`sheetEdgesDp(FULL)`). HubCard used to lay its
 * 46 dp readout reserve out INSIDE that modifier, so the wood frame landed at 106 and the card lost 46 dp of body. The
 * frame must start at the modifier's top and the readouts must sit in the reserve above it (SPEC §1: readouts y 14,
 * card y 60), whatever the gesture inset.
 */
class HubCardGeometryTest {
    @Test fun `a FULL card mounted at the SheetHost edges paints its wood at y 60, not 106`() {
        val (top, _) = sheetEdgesDp(SheetSize.FULL, gestureInsetDp = 24)!!
        val g = hubCardGeometry(top)
        assertEquals(SheetGeometry.FULL_TOP_DP, g.frameTopDp)
        assertNotEquals("the reserve was applied twice (MS-M2)", top + READOUT_RESERVE_DP, g.frameTopDp)
    }

    @Test fun `the reward readouts sit in the 46 dp reserve above the frame, at the SPEC's y 14`() {
        val g = hubCardGeometry(SheetGeometry.FULL_TOP_DP)
        assertEquals(14, g.readoutTopDp)
        assertEquals(READOUT_RESERVE_DP, g.frameTopDp - g.readoutTopDp)
        assertEquals(46, READOUT_RESERVE_DP)
    }

    @Test fun `the frame always follows the modifier, so a moved host moves the card with it`() {
        listOf(0, 60, 104).forEach { top ->
            val g = hubCardGeometry(top)
            assertEquals(top, g.frameTopDp)
            assertEquals(top - READOUT_RESERVE_DP, g.readoutTopDp)
        }
    }
}
