package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.NeedMoreSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.NeedMoreUi

/*
 * The command bar's SHORT pill (SPEC §1.5 "SHORT: tap → NeedMore for non-upgrade costs; never auto-spends"): the same
 * NeedMore half sheet the INFO / UPGRADE / BUILD hosts push, standing on its own for a bar command (a spent trap's
 * REARM the known balance cannot pay). The caller builds [NeedMoreUi] with `liveShardsNeedMore` (null = not short: do not
 * compose this) and removes the host on close.
 */

/**
 * The bar's Need-more: [LiveHalfSheetHost] + [NeedMoreSheet], Back closes it. Every door only navigates: GO TO MINES
 * selects [mine]'s Mine ([onGoToMine]); BUILD A MINE opens the BUILD tray ([onOpenBuild]); each closes the sheet first.
 */
@Composable internal fun LiveShardsNeedMoreHost(ui: NeedMoreUi, mine: MineFact, onGoToMine: (String) -> Unit, onOpenBuild: () -> Unit,
    onClose: () -> Unit, modifier: Modifier = Modifier) {
    BackHandlerAt(BackPriority.SHEET) { onClose() }
    LiveHalfSheetHost(modifier) { placed ->
        NeedMoreSheet(ui, needMoreActions(mine, onGoToMine, onOpenBuild, onClose), placed)
    }
}
