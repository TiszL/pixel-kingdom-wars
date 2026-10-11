package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/*
 * Design component: the Harvester tall sheet with the round-2 HISTORY tab composed in (craft/SPEC.md "E1.3 Harvester
 * HISTORY"; UX-ARCHITECTURE §7.3 `Destination.Harvester(tab)`). An EXTENSION of the committed `HarvesterSheet.kt` (not
 * an edit of it): YIELD is drawn by the committed `HarvesterSheet`; HISTORY, when [HarvesterSheetR2Ui.historyTab] is set,
 * is drawn in the same `CraftSheetFrame` with the same header stage and live chip, with [HarvesterHistoryTabBody] and its
 * pinned recovery footer. With `historyTab` null the round-1 HISTORY body is drawn (so the integrator can switch over).
 *
 * Note: the two tabs are two call sites, so a YIELD ↔ HISTORY switch re-creates the frame (no 120 ms body cross-fade).
 * The one-line alternative in MOUNT-r2-r2-craft-voyage-goldforge.md wires the tab into `HarvesterSheet` itself.
 *
 * Pointer rule: the root is the painted wood frame (a scene-input region), never full-screen, with no scrim of its own
 * (the TALL 40 % scrim is the SheetHost's). Only CHECK and MORE take touches on HISTORY.
 */

/** The Harvester sheet with its round-2 HISTORY state. */
@Immutable data class HarvesterSheetR2Ui(
    /** The round-1 sheet (frame, header, YIELD state, review, celebration). Its `frame.selectedTab` decides the tab. */
    val sheet: HarvesterSheetUi,
    /** HISTORY round 2; null keeps the round-1 HISTORY body. */
    val historyTab: HarvesterHistoryTabUi?,
)

/** The Harvester sheet's callbacks: round 1 plus HISTORY's. */
@Immutable data class HarvesterSheetR2Actions(
    val sheet: HarvesterSheetActions = HarvesterSheetActions(),
    val history: HarvesterHistoryTabActions = HarvesterHistoryTabActions(),
)

/**
 * The Harvester tall sheet, round 2. [modifier] must give it a bounded height (SheetHost: y 104 to the bottom edge).
 *
 * Pointer rule: the root is the painted wood frame, never full-screen; no clickable, pointerInput, draggable or scrim on
 * it. The TALL scrim is the SheetHost's.
 */
@Composable fun HarvesterSheetR2(ui: HarvesterSheetR2Ui, on: HarvesterSheetR2Actions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }) {
    val history = ui.historyTab
    val sheet = ui.sheet
    if (sheet.frame.selectedTab != HarvesterTab.HISTORY || history == null) {
        HarvesterSheet(sheet, on.sheet, modifier, clock)
        return
    }
    val now = rememberNow(clock)
    CraftSheetFrame(sheet.frame.copy(live = harvesterLive(sheet.harvest, now, sheet.frame.live), history = false, stackedTabs = false),
        // One tab callback only (the sheet's): HarvesterHistoryTabActions.onTab is for a host that mounts the body alone.
        on.sheet.onClose, on.sheet.onTab, {}, modifier,
        headerArt = { HeaderStage(sheet.header, null, null, 182.dp, (-20).dp, "The ${sheet.harvest.realmName} Harvester") },
        footer = { HarvesterHistoryTabFooter(history, on.history) },
    ) {
        HarvesterHistoryTabBody(history, on.history)
    }
}

/** Renders the round-2 Harvester sheet the way the SheetHost does on the 412 × 915 phone, with a fixed clock. */
@Composable internal fun HarvesterR2PreviewHost(ui: HarvesterSheetR2Ui) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        HarvesterSheetR2(ui, HarvesterSheetR2Actions(), Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp), clock = { CraftSamples.NOW })
    }
}
