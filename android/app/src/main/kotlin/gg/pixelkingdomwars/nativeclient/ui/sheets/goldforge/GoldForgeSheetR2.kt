package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens

/*
 * Design component: the Gold Forge sheet with the round-2 LEGACY tab composed in (goldforge/SPEC.md "E1.1 Gold Forge
 * LEGACY tab"; UX-ARCHITECTURE §7.3 `Destination.GoldForge(tab)`). An EXTENSION of the committed `GoldForgeSheet.kt` (not
 * an edit): it calls `GoldForgeSheet` with a `bridge` that draws [LegacyV2Body] on the LEGACY tab (and hands any other
 * bridged tab to the caller's own bridge, or "Checking the forge…"). The tab row must offer LEGACY:
 * `goldForgeTabs(claimReady, gemsWaiting, legacy = legacy != null)`; the hero's live chip says "Furnace lit" only on this
 * tab (the mapper's `HeroStatusUi`). LEGACY has no footer (no gold primary). The ConfirmDialog is the OverlayHost's
 * ([LegacyReturnConfirm]).
 *
 * Pointer rule: the root is the kit SheetFrame inside `GoldForgeSheet` (a painted panel, never full-screen, no scrim of
 * its own); only its painted parts take touches. The TALL scrim is the SheetHost's; the ConfirmDialog's 55 % scrim the
 * OverlayHost's, only while it shows.
 */

/**
 * The Gold Forge sheet, round 2. [legacy] null = no round-2 LEGACY (the committed sheet as is). Other parameters are the
 * committed `GoldForgeSheet`'s.
 *
 * Pointer rule: see the file comment — no full-screen clickable, pointerInput, draggable or scrim here.
 */
@Composable fun GoldForgeSheetR2(ui: GoldForgeSheetUi, legacy: LegacyV2Ui?, on: GoldForgeSheetActions, legacyOn: LegacyV2Actions,
    modifier: Modifier = Modifier, scene: GoldForgeSceneUi = GoldForgeSceneUi(), scrollState: ScrollState? = rememberScrollState(),
    bridge: (@Composable ColumnScope.(tab: String) -> Unit)? = null) {
    if (legacy == null) {
        GoldForgeSheet(ui, on, modifier, scene, scrollState, bridge)
        return
    }
    GoldForgeSheet(ui, on, modifier, scene, scrollState) { tab ->
        when {
            tab == GoldForgeTabs.LEGACY -> LegacyV2Body(legacy, legacyOn)
            bridge != null -> bridge.invoke(this, tab)
            else -> PkwText("Checking the forge…", PkwTokens.Type.body, Modifier.padding(8.dp), color = PkwTokens.Colors.textOnParch2)
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Composable private fun LegacyPreviewFrame(legacy: LegacyV2Ui) {
    val plan = goldForgeScenePlan()
    val ui = GoldForgeSamples.sheet.copy(selectedTab = GoldForgeTabs.LEGACY, tabs = goldForgeTabs(claimReady = false, gemsWaiting = 0, legacy = true),
        heroStatus = HeroStatusUi(HeroStatusKind.FORGING, time = "6h 20m"))
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg)) {
        GoldForgeSheetR2(ui, legacy, GoldForgeSheetActions(), LegacyV2Actions(),
            Modifier.fillMaxSize().padding(start = 4.dp, top = PkwTokens.Dims.tallSheetTop, end = 4.dp),
            scene = GoldForgeSceneUi(plan, previewSceneArt(plan)))
    }
}

@Preview(name = "Gold Forge › LEGACY (legacy.png)", widthDp = 412, heightDp = 915)
@Composable private fun LegacyV2Preview() = LegacyPreviewFrame(GoldForgeR2Samples.legacy)

@Preview(name = "Gold Forge › LEGACY, nothing saved, withdrawals left", widthDp = 412, heightDp = 915)
@Composable private fun LegacyNothingSavedPreview() = LegacyPreviewFrame(GoldForgeR2Samples.legacy.copy(saved = "0"))

@Preview(name = "Gold Forge › LEGACY, after the update (DONE)", widthDp = 412, heightDp = 915)
@Composable private fun LegacyConvertedPreview() = LegacyPreviewFrame(GoldForgeR2Samples.legacy.copy(convertedLine = "Turned into 1,820 Gems on 14 Oct",
    withdrawals = GoldForgeR2Samples.legacy.withdrawals.map { it.copy(state = WithdrawalState.SENT, line = "In your wallet since 12 Sep") }))

@Preview(name = "Gold Forge › LEGACY, loading (… never 0)", widthDp = 412, heightDp = 915)
@Composable private fun LegacyLoadingPreview() = LegacyPreviewFrame(GoldForgeR2Samples.legacy.copy(saved = null, loading = true))

@Preview(name = "Gold Forge › LEGACY, can't reach the server (as of 14:20)", widthDp = 412, heightDp = 915)
@Composable private fun LegacyErrorPreview() = LegacyPreviewFrame(GoldForgeR2Samples.legacy.copy(asOf = "14:20"))

@Preview(name = "Gold Forge › LEGACY, date set", widthDp = 412, heightDp = 915)
@Composable private fun LegacyDatedPreview() = LegacyPreviewFrame(GoldForgeR2Samples.legacy.copy(cutoverAt = "14 Oct", withdrawals = emptyList()))
