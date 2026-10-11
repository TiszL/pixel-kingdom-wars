package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.chrome.pageInsets
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetBackdrop
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RefreshLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageColors
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.drawWaves

/*
 * Owner 2026-10-06: "UI unfinished … every detail should be well developed". The Phase E owner bodies that still drew the
 * old dark GamePage on the player path (receipt history, the "storage unavailable" fallbacks) now draw the designed TALL
 * sheet: wood frame, charcoal title plate, red close square, parchment body (kit SheetFrame). Presentation only; the
 * owners, callbacks and wording are the ones the old pages used.
 */

/** The designed tall sheet a Phase E owner body draws in the fleet pane or a route: it pads the safe-drawing and keyboard
 *  insets itself (the pane sizes the form expecting that, as GamePage did) and takes the scene's touches.
 *  Owner 2026-10-06 ("every sheet is full screen", phone/v7-berth-refresh-081811.png): it is the same full-screen card as the
 *  Berth ([PhaseEFullScreenCard]): opaque wood backdrop to every screen edge, the frame edge to edge between the insets, and
 *  the living header art band (kit-2.png TALL SHEET) under the title plate and close. */
@Composable internal fun PhaseEDesignedSheet(title: String, onClose: () -> Unit, modifier: Modifier = Modifier,
    footer: (@Composable ColumnScope.() -> Unit)? = null, body: @Composable ColumnScope.() -> Unit) {
    PhaseEFullScreenCard(modifier) {
        SheetFrame(SheetFrameUi(title, null, SheetSize.TALL, emptyList(), null), onClose = onClose,
            modifier = Modifier.fillMaxSize(), header = { PhaseESeaHeader() }, footer = footer, body = body)
    }
}

/** A Phase E body as one opaque full-screen card (ui/kit/FullScreenSheet.kt, owner 2026-10-06): the backdrop reaches every
 *  screen edge (camera cut-out and navigation bar included) and swallows taps, and [content] sits between the safe-drawing
 *  and keyboard insets. Nothing of the kingdom shows around it. */
@Composable internal fun PhaseEFullScreenCard(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(modifier.fillMaxSize()) {
        FullScreenSheetBackdrop()
        Box(Modifier.fillMaxSize().pageInsets().sceneInputRegion(), content = content)
    }
}

/** The living header art band of the Phase E voyage sheets: the Berth's own sea with its wave marks (BerthSheet QuaySea,
 *  voyage SPEC §0.3), so a sheet the Berth opens (receipts, crafted controls) reads as the same place. Paint only. */
@Composable internal fun PhaseESeaHeader() {
    Canvas(Modifier.fillMaxSize().background(VoyageColors.seaHdr)) { drawWaves(31) }
}

/** The kit's quiet notice (hub SPEC §1 dim CardRow, the "All quiet" row): a read that could not refresh while what is shown
 *  stays usable. Ink-on-parchment, never the red error face; paint only. */
@Composable internal fun PhaseEQuietNotice(text: String, modifier: Modifier = Modifier) {
    CardRow(modifier, variant = RowVariant.DIM) {
        PkwIcon("ui:queue-status", 32.dp, alpha = 0.6f)
        PkwText(text, PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch2, maxLines = 4)
    }
}

/** An owner that cannot open its storage: the designed sheet with one parchment empty state saying why (never a blank page). */
@Composable internal fun PhaseEDesignedNotice(title: String, headline: String, reason: String, onClose: () -> Unit) {
    PhaseEDesignedSheet(title, onClose) {
        EmptyState(EmptyStateUi("ui:queue-status", headline, reason, null, null), onGo = {})
    }
}

/** One saved original or server receipt as a cream card: title and status, where it came from, its facts on demand, and
 *  its GET-only check. */
@Composable internal fun PhaseEReceiptCard(row: PhaseEReceiptRow, busy: Boolean, onCheck: (PhaseEReceiptCheck) -> Unit) {
    var open by rememberSaveable(row.id) { mutableStateOf(false) }
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText(row.title, PkwTokens.Type.label, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 2)
                Plate(PlateKind.VEIL, Modifier.heightIn(min = 28.dp), blocksScene = false) {
                    PkwText(row.status, PkwTokens.Type.caption, Modifier.align(Alignment.Center).padding(horizontal = 4.dp),
                        color = PkwTokens.Colors.label, outline = 1.dp)
                }
            }
            PkwText(when (row.source) {
                PhaseEReceiptSource.PENDING -> "Saved original"
                PhaseEReceiptSource.ARCHIVED -> "Archived original"
                PhaseEReceiptSource.SERVER -> "Server observation"
            }, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            row.baseId?.let { PkwText("Original kingdom: $it", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
            QuietButton(if (open) "Hide details" else "Details", { open = !open }, onParchment = true)
            if (open) {
                PkwText("Original identifier: ${row.receiptKey}", PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2, maxLines = 2)
                row.details.forEach { detail ->
                    PkwText("${detail.label}: ${detail.value}", PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2, maxLines = 3)
                }
            }
            row.check?.let { check ->
                SecondaryButton("CHECK ORIGINAL RECEIPT", { onCheck(check) }, Modifier.fillMaxWidth(), enabled = !busy)
            }
        }
    }
}

/** The receipts body on the designed sheet (shared by the PhaseEReceiptHistoryScreen owners). */
@Composable internal fun PhaseEReceiptHistoryBody(title: String, rows: List<PhaseEReceiptRow>, busy: Boolean, error: String?,
    onRefresh: () -> Unit, onCheck: (PhaseEReceiptCheck) -> Unit, onBack: () -> Unit) {
    PhaseEDesignedSheet(title, onBack, footer = {
        SecondaryButton("REFRESH RECEIPTS", onRefresh, Modifier.fillMaxWidth(), enabled = !busy)
    }) {
        // A refresh keeps the rows already shown; only the 2 dp line says it runs.
        RefreshLine(busy)
        PkwText("Saved originals and server receipts. Checking a receipt does not send the request again.", PkwTokens.Type.small,
            color = PkwTokens.Colors.textOnParch2, maxLines = 3)
        // Owner 2026-10-06: the failed fleet read is a quiet notice, not a red line; the receipts below stay usable.
        error?.let { PhaseEQuietNotice(it) }
        if (rows.isEmpty()) EmptyState(EmptyStateUi("ui:queue-status", if (busy) "Checking receipts…" else "No receipts yet",
            "No saved receipts are available.", null, null), onGo = {})
        rows.forEach { row -> PhaseEReceiptCard(row, busy, onCheck) }
    }
}
