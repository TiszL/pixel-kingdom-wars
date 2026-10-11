package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.*
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** The craft review moved from the owner's dialog into the designed half sheet (craft/SPEC.md §2.1, §2.6). Authored
 * without a build tonight; execution belongs to the next compile. */
class EquipmentReviewMapperTest {
    private val f = EquipmentFixtures

    @Test fun `a saved craft reviews in the sheet with the owners own consent sentence and a START confirm`() {
        // The half sheet replaces the dialog's look, never its consent: the player still reads that materials are
        // consumed and that an accepted job cannot be cancelled before the START that sends it.
        val review = requireNotNull(equipmentCraftReviewUi(f.record(), sending = false))
        assertEquals("CRAFT ROUTE COMPASS", review.title)
        assertTrue(review.line.startsWith(EQUIPMENT_CRAFT_CONSENT))
        assertTrue(review.line.endsWith(EQUIPMENT_RESULT_STAYS))
        assertEquals("START", review.confirmLabel)
        assertEquals("BACK", review.backLabel)
        assertFalse(review.sending)
    }

    @Test fun `the half sheet consent is word for word the original confirmation sentence`() {
        // If either copy drifts, the in-sheet review would promise something the owner's saved terms do not say.
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/phasee/EquipmentScreen.kt"
        val screen = listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
        assertTrue(screen.contains("\"$EQUIPMENT_CRAFT_CONSENT\""))
        assertTrue(screen.contains("footnote=\"$EQUIPMENT_RESULT_STAYS\""))
    }

    @Test fun `trip and paid realm departures stay in their owner dialog`() {
        // Departures carry route, cargo, permit and access terms the half sheet cannot show, so they never map here.
        assertNull(equipmentCraftReviewUi(f.record("starter"), sending = false))
        assertNull(equipmentCraftReviewUi(f.record("advanced"), sending = false))
        val collect = EquipmentRecord("collect", f.request.idempotencyKey, buildJsonObject { put("baseId", f.base) }, f.policy.raw)
        assertNull(equipmentCraftReviewUi(collect, sending = true))
    }

    @Test fun `a craft record without its frozen recipe is not reviewable in the sheet`() {
        // The START must confirm exactly the saved terms; without them there is nothing honest to show.
        assertNull(equipmentCraftReviewUi(f.record().copy(recipe = null), sending = false))
    }

    @Test fun `a confirm in flight marks the START busy so a second tap cannot send twice`() {
        assertTrue(requireNotNull(equipmentCraftReviewUi(f.record(), sending = true)).sending)
    }
}
