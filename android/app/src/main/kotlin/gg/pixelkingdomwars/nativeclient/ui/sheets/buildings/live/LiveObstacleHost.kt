package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.model.Obstacle
import gg.pixelkingdomwars.nativeclient.renderer.BaseScene
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*

@Composable internal fun LiveObstacleHost(state: KingdomUiState, obstacle: Obstacle, busy: Boolean, scene: BaseScene?,
    onRemove: () -> Unit, onClose: () -> Unit, onBuilders: () -> Unit, onGoToMine: (String) -> Unit,
    onOpenBuild: () -> Unit, modifier: Modifier = Modifier, sheetModifier: Modifier = Modifier,
    sent: Boolean = false, onSent: () -> Unit = {}) {
    val ui = liveObstacleReview(state, obstacle, busy, scene, sent) ?: return
    val mine = readMineFact(state)
    var moreOpen by remember(obstacle.id) { mutableStateOf(false) }
    val cost = state.catalogue?.let { gg.pixelkingdomwars.nativeclient.network.obstacleTier(it, obstacle.spriteKey.orEmpty()) }?.costShards?.toString()
    val more = if (moreOpen) liveShardsNeedMore("Remove obstacle", state.home.balances?.shards, ui.price.amount ?: "…", cost, mine) else null
    BackHandlerAt(BackPriority.SHEET, enabled = more != null) { moreOpen = false }
    val height = (LocalConfiguration.current.screenHeightDp / 2).dp
    LiveHalfSheetHost(modifier) { placed ->
        val body = placed.heightIn(max = height).then(sheetModifier).verticalScroll(rememberScrollState())
        if (more != null) NeedMoreSheet(more, NeedMoreActions(onDoor = { door ->
            moreOpen = false; onClose(); needMoreDoorTarget(door, mine)?.let(onGoToMine) ?: onOpenBuild()
        }, onClose = { moreOpen = false }), body)
        else ObstacleRemoveSheet(ui, ObstacleActions(
            onRemove = { if (quoteLook(ui.state, ui.price, ui.reason).sends && !sent) { onSent(); onRemove() } },
            onBuilders = { onClose(); onBuilders() }, onGetMore = { moreOpen = true },
            onClose = { if (!busy || !sent) onClose() }), body)
    }
}
