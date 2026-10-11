package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.model.MineStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveHalfSheetHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.DailyCacheActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.DailyCacheSheet
import kotlinx.coroutines.Job
import kotlinx.serialization.json.JsonObject

@Composable internal fun LiveDailyCacheHost(catalogue: JsonObject?, mine: MineStatus?, busy: Boolean, now: Long,
    blockedReason: String?, onClaim: () -> Job?, onClose: () -> Unit, modifier: Modifier = Modifier) {
    // Observe the existing owner's job; a dropped tap returns null and a poll never owns this flag.
    var submittedClaim by remember { mutableStateOf<Job?>(null) }
    LaunchedEffect(busy) { if (!busy) submittedClaim = null }
    LaunchedEffect(submittedClaim) { submittedClaim?.join(); submittedClaim = null }
    val ui = dailyCacheUi(catalogue, mine, busy, now, blockedReason, sent = submittedClaim?.isActive == true)
    val height = (LocalConfiguration.current.screenHeightDp / 2).dp
    LiveHalfSheetHost(modifier) { placed ->
        Column(placed.heightIn(max = height).verticalScroll(rememberScrollState())) {
            DailyCacheSheet(ui, DailyCacheActions(
                // The original ViewModel owns its active-action guard and the single POST/status reconciliation.
                onClaim = { if (submittedClaim?.isActive != true && dailyCacheCanClaim(ui)) submittedClaim = onClaim() },
                onClose = onClose))
        }
    }
}
