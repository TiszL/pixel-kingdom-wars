package gg.pixelkingdomwars.nativeclient.ui.phasee

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** Workshop TOOLS in the Equipment owner pane matches workshop-tools.png (craft/SPEC.md §2.6, §5): no old chrome row under
 * the designed sheet, the craft review in the half sheet, and every old door kept in a designed place. Source pins,
 * because the pane needs the registration's lifetime to compose. Authored without a build tonight. */
class EquipmentScreenDesignTest {
    private fun source(path: String): String {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
    }
    private fun screen() = source("ui/phasee/EquipmentScreen.kt")
        .substringAfter("@Composable fun EquipmentScreen(").substringBefore("@Composable private fun EquipmentSelection")

    @Test fun `the old TRIPS ORIGINALS CHECK row under the sheet is gone`() {
        // The frame ends at the sheet's own footer; a second row of old outlined buttons under it is not the design.
        val body = screen()
        for (label in listOf("TRIPS", "ORIGINALS", "CHECK")) assertFalse(label, body.contains("{ Text(\"$label\") }"))
        assertFalse(body.contains("Modifier.weight(1f).fillMaxWidth())"))
        assertTrue(body.contains("Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing))"))
    }

    @Test fun `every old door keeps a designed home so nothing became unreachable`() {
        val body = screen()
        // TRIPS: the TravelRow GO and the trips door both open the owner's expeditions.
        assertTrue(body.contains("val openTrips = { observe { overlay = EquipmentOverlay.TRIPS } }"))
        assertTrue(body.contains("onGoLodge = openTrips, onOpenTrips = openTrips"))
        // ORIGINALS: the header History and the recovery row CHECK open the owner's original requests in place, where
        // archive lives; the registration's receipt list stays one tap further.
        assertTrue(body.contains("onHistory = { observe { overlay = EquipmentOverlay.ORIGINALS } }"))
        assertTrue(body.contains("onCheckSaved = { key -> observe { overlay = EquipmentOverlay.ORIGINALS"))
        assertTrue(body.contains("TextButton(onClick = { overlay = null; observe(onHistory) }) { Text(\"EQUIPMENT RECEIPTS\") }"))
        // CHECK: the sheet's own retry.
        assertTrue(body.contains("onRetry = { observe { if (!model.busy.value && !model.state.value.busy && model.state.value.review == null) model.refresh()"))
    }

    @Test fun `refusals are toasts instead of a line of old text under the sheet`() {
        val body = screen()
        assertFalse(body.contains("explanation"))
        assertTrue(body.contains("Toasts.post(\"Return to the current Workshop before continuing.\")"))
        assertTrue(body.contains("Toasts.post(\"Wait for current tools and materials before choosing a recipe.\")"))
    }

    @Test fun `a craft review is the designed half sheet whose START is the original confirm behind the same guards`() {
        // Money-adjacent rule: no new submission path. START calls the one confirm the old dialog button called, only
        // for the current kingdom, a current sheet and allowed orders.
        val body = screen()
        assertTrue(body.contains("val craftReview = review?.let { equipmentCraftReviewUi(it, sending = !idle) }"))
        assertTrue(body.contains(".copy(review = craftReview)"))
        assertTrue(body.contains("onReviewBack = ::closeReview, onReviewConfirm = ::confirmCraft"))
        val confirm = body.substringAfter("fun confirmCraft()").substringBefore("fun closeReview()")
        assertTrue(confirm.contains("record.request[\"baseId\"] != selectedBase?.let(::JsonPrimitive)"))
        assertTrue(confirm.contains("!current() ->"))
        assertTrue(confirm.contains("!allowed ->"))
        assertTrue(confirm.contains("model.busy.value || value.busy -> Unit"))
        assertTrue(confirm.contains("else -> model.confirm()"))
        assertEquals(1, Regex("model\\.confirm\\(\\)").findAll(confirm).count())
    }

    @Test fun `trip and paid departure reviews still reach the owner dialog unchanged`() {
        val body = screen()
        val dialog = body.substringAfter("if (review != null && craftReview == null) {").substringBefore("} else if (overlay != null")
        assertTrue(dialog.contains("AlertDialog(onDismissRequest = model::dismiss, title = { Text(\"ORIGINAL EQUIPMENT REVIEW\") }"))
        assertTrue(dialog.contains("EquipmentConfirmation(review, selectedBase, idle && allowed && current(), model, Modifier)"))
        assertTrue(dialog.contains("Text(\"BACK · KEEP DRAFT\")"))
        // A craft in the half sheet never also opens an overlay dialog on top of it.
        assertTrue(body.contains("} else if (overlay != null && review == null) {"))
    }

    @Test fun `back from the craft review keeps the draft and re reads instead of leaving an empty frame`() {
        val body = screen()
        val back = body.substringAfter("fun closeReview()").substringBefore("val retained")
        assertTrue(back.contains("model.dismiss()"))
        assertTrue(back.contains("if (craft && current()) model.refresh()"))
        assertTrue(body.contains("BackHandlerAt(BackPriority.CONFIRM, review != null) { closeReview() }"))
    }

    @Test fun `a refresh keeps the last tools drawn instead of blanking them`() {
        val body = screen()
        assertTrue(body.contains("val baseUi = equipmentRetainedSheetUi(fresh, retained[0], reading = !idle)"))
        assertTrue(body.contains("remember(identity, selectedBase, generation, contentIdentity) { arrayOfNulls<WorkshopToolsUi>(1) }"))
    }

    @Test fun `the trips door draws only when its owner bound a handler so it is never a dead GO`() {
        val tools = source("ui/sheets/craft/WorkshopToolsTab.kt")
        assertTrue(tools.contains("} else if (door != null && trips != null) {"))
        assertTrue(tools.contains("val onOpenTrips: (() -> Unit)? = null,"))
        assertTrue(tools.contains("FooterNote(\"Tools never wear out. They come home with the boat.\")"))
    }
}
