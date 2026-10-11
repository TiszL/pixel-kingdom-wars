package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview

/**
 * Design component: the Settings card with the round-2 HELP tab (design/final/hub/SPEC.md part two §B;
 * settings-help.png), composed WITHOUT editing the committed `SettingsSheet.kt`: GAME and ACCOUNT render the committed
 * [SettingsSheet] unchanged; HELP renders the same frame (the [HubCard] with the CompactHeader Back + "SETTINGS" + close,
 * the same tabs, the sign-out confirm layer) around [SettingsHelpTab].
 *
 * Replaces: the committed HELP branch of `SettingsBody` (the generic `helpRows` + HELP toggles + version line). The
 * cleaner merge is the one-line slot change in MOUNT-r2-r2-map-hub.md, after which this wrapper can be deleted.
 *
 * Pointer rule: the root is a plain Box (the [HubCard] Column plus the confirm); only painted rows, tiles and buttons take
 * touches. The confirm's scrim exists only while [SettingsUi.confirm] is set; the FULL-card scrim is the SheetHost's.
 */
@Composable fun SettingsSheetR2(ui: SettingsUi, help: SettingsHelpUi, on: SettingsActions, helpOn: SettingsHelpActions, modifier: Modifier = Modifier) {
    if (ui.tab != "HELP") {
        SettingsSheet(ui, on, modifier)
        return
    }
    Box(modifier) {
        HubCard(Modifier.fillMaxSize(), tabs = ui.tabs, selectedTab = ui.tab, onTab = on.onTab,
            header = { CompactHeader("SETTINGS", "settings", on.onClose, onBack = on.onBack) }) {
            SettingsHelpTab(help, helpOn)
        }
        HubConfirmDialog(ui.confirm, on.onConfirm, on.onConfirmBack, Modifier.fillMaxSize())
    }
}

// ---- Previews (settings-help.png numbers) ----

private val sampleSettingsForHelp = SettingsUi(tab = "HELP", toggles = emptyList(), version = "Version 0.6.5 (31)", accountRows = emptyList(), helpRows = emptyList())

@Preview(name = "Settings: HELP (settings-help.png)", widthDp = 412, heightDp = 915)
@Composable private fun SettingsHelpR2Preview() {
    HubPreviewStage { SettingsSheetR2(sampleSettingsForHelp, sampleSettingsHelp, SettingsActions(), SettingsHelpActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Settings HELP: unread loading, a locked chapter, no unread", widthDp = 412, heightDp = 915)
@Composable private fun SettingsHelpStatesPreview() {
    HubPreviewStage {
        SettingsSheetR2(sampleSettingsForHelp, sampleSettingsHelp.copy(feedbackUnread = null, feedbackLoading = true,
            codexChapters = defaultCodexChapters().map { if (it.id == "islands") it.copy(locked = true) else it }),
            SettingsActions(), SettingsHelpActions(), Modifier.fillMaxSize())
    }
}
