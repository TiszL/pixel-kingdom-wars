package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.EquipmentRecord
import gg.pixelkingdomwars.nativeclient.ui.phasee.equipmentRecordTitle
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftReviewUi
import java.util.Locale

/** The consent sentence the original equipment confirmation prints under its saved terms (EquipmentScreen
 * `EquipmentSavedTerms`). The half sheet repeats it word for word; it is not new consent wording. */
internal const val EQUIPMENT_CRAFT_CONSENT = "Materials are consumed when crafting starts. The accepted job cannot be cancelled."

/** The original confirmation's footnote (EquipmentScreen `EquipmentConfirmation`), kept with the consent so no risk
 * line of the old dialog is lost. */
internal const val EQUIPMENT_RESULT_STAYS = "The result stays with its receiving kingdom if ownership changes."

/** A saved craft record as the in-sheet review half sheet (craft/SPEC.md §2.1, §2.6: no money moves, so not a Seal).
 * Trip and paid-realm departures return null: their review keeps the owner's original dialog with its route, cargo and
 * access terms. A record without its frozen recipe is not a craft review either. [sending] is the owner's confirm in
 * flight (the START shows dots and ignores taps). */
internal fun equipmentCraftReviewUi(record: EquipmentRecord, sending: Boolean): CraftReviewUi? {
    if (record.kind != "craft" || record.recipe == null) return null
    return CraftReviewUi(equipmentRecordTitle(record).uppercase(Locale.US), "$EQUIPMENT_CRAFT_CONSENT $EQUIPMENT_RESULT_STAYS",
        confirmLabel = "START", backLabel = "BACK", sending = sending)
}
