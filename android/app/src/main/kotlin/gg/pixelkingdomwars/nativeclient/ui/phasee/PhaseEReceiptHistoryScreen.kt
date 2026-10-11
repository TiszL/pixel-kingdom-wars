package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.runtime.Composable
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority

/** Display-only surface. Owners supply GET refresh/receipt observation callbacks;
 * mutation-capable models, commands and wallet objects are not accepted here.
 * Owner 2026-10-06: drawn on the designed tall sheet ([PhaseEReceiptHistoryBody]); the old dark GamePage is gone. */
@Composable
internal fun PhaseEReceiptHistoryScreen(
    title: String,
    rows: List<PhaseEReceiptRow>,
    busy: Boolean,
    error: String? = null,
    onRefresh: () -> Unit,
    onCheck: (PhaseEReceiptCheck) -> Unit,
    onBack: () -> Unit,
) {
    BackHandlerAt(BackPriority.SHEET) { onBack() }
    PhaseEReceiptHistoryBody(title, rows, busy, error, onRefresh, onCheck, onBack)
}
