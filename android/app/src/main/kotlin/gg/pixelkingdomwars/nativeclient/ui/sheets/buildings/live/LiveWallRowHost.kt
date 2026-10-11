package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*

@Composable internal fun LiveWallRowHost(state: KingdomUiState, busy: Boolean, message: String?, onPurchase: () -> Unit,
    onRetry: () -> Unit, onCancel: () -> Unit, onRecheck: () -> Unit, onGoToMine: (String) -> Unit,
    onOpenBuild: () -> Unit, modifier: Modifier = Modifier) {
    val quote = state.local.wallRowQuote ?: return
    val ui = liveWallRowReview(quote, state.catalogue, busy,
        wallRowReviewAllowed(quote, state.base?.baseId, state.ordersAllowed, state.deedActionsAllowed),
        state.wallRowRetry, message, buildersLine(state.base?.freeBuilders, state.base?.player?.builders))
    val mine = readMineFact(state)
    var moreOpen by remember(quote.quoteId) { mutableStateOf(false) }
    val more = if (moreOpen) liveShardsNeedMore("Wall row", quote.balanceShards, ui.total.amount ?: "…", quote.totalCostShards, mine) else null
    BackHandlerAt(BackPriority.SHEET, enabled = more != null) { moreOpen = false }
    val maxHeight = (LocalConfiguration.current.screenHeightDp / 2).dp
    LiveHalfSheetHost(modifier) { placed ->
        val body = placed.heightIn(max = maxHeight).verticalScroll(rememberScrollState())
        if (more != null) NeedMoreSheet(more, NeedMoreActions(onDoor = { door ->
            moreOpen = false; onCancel(); needMoreDoorTarget(door, mine)?.let(onGoToMine) ?: onOpenBuild()
        }, onClose = { moreOpen = false }), body)
        // The quote is one server row (one wall id in, the whole run out): a toggle explains instead of leaving a wall out.
        else WallRowQuoteSheet(ui, WallRowActions(onToggleWall = wallRowToggle { Toasts.post(it) },
            onUpgrade = { if (quoteLook(ui.state, ui.total, ui.reason, ui.count <= 0).sends)
                submitWallRowReview(state.wallRowRetry, onPurchase, onRetry) },
            onCancelRow = { if (!busy) onCancel() }, onGetMore = {
                if (liveShardsNeedMore("Wall row", quote.balanceShards, ui.total.amount ?: "…", quote.totalCostShards, mine) != null) moreOpen = true
                else { onCancel(); mine.mineBuildingId?.let(onGoToMine) ?: onOpenBuild() }
            },
            onRecheck = { if (!busy && !state.wallRowRetry) onRecheck() }), body)
    }
}
