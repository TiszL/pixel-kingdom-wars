package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.model.BaseJob
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kit.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*

/**
 * The Builders half sheet (builders.png). Every job is a row of the one list: owned builder slots first, then any job no
 * slot holds; a row tap is [onViewJob] (the mount flies to the job's building). With the Home purchase owner ([purchase])
 * HIRE BUILDER n raises the SOL Seal here and its money sequence runs on the primary; a saved or uncertain purchase shows
 * "Being checked" + CHECK and the stone DETAILS door ([onPurchaseDetails], recovery only). Without [purchase], HIRE keeps
 * [onHire] (the old purchase screen) as the fallback.
 */
@Composable internal fun LiveBuildersHost(state: KingdomUiState, busy: Boolean, canHire: Boolean, now: Long,
    onHire: () -> Unit, onViewJob: (BaseJob) -> Unit, onFinish: (BaseJob) -> Unit, onBuild: () -> Unit,
    onClose: () -> Unit, modifier: Modifier = Modifier, purchase: HomeSolPurchase? = null, onPurchaseDetails: (() -> Unit)? = null) {
    val review = liveBuildersReview(state, busy, canHire, now)
    var explanation by remember(state.base?.baseId) { mutableStateOf<String?>(null) }
    val height = (LocalConfiguration.current.screenHeightDp / 2).dp
    val flow = purchase?.let { owner -> rememberSolPurchase(owner, "builder", state.base?.baseId, null, onFinished = onClose,
        explain = { message -> explanation = message }) }
    val recovery = flow?.recovery == true && onPurchaseDetails != null
    val messages = (listOfNotNull(explanation) + flow?.messages.orEmpty()).distinct()
    LiveHalfSheetHost(modifier) { placed ->
        Column(placed.heightIn(max = height).verticalScroll(rememberScrollState())) {
            if (review != null) {
                val ui = if (flow != null) buildersWithPurchase(review.ui, flow.view, recovery) else review.ui
                BuildersSheet(ui.copy(error = (listOfNotNull(ui.error) + messages).joinToString("\n").ifBlank { null }), BuildersActions(
                    onFinish = { number -> review.jobsByNumber[number]?.let(onFinish) },
                    onRow = { token -> review.jobsByNumber.values.firstOrNull { it.id == token.value }?.let(onViewJob) },
                    onBuild = onBuild, onHire = { if (flow != null) flow.primary() else onHire() }, onClose = onClose,
                    onExplain = { explanation = it }, onDetails = { onPurchaseDetails?.invoke() }))
            } else Plate(PlateKind.WOOD, Modifier.fillMaxWidth()) {
                Column {
                    HalfSheetHeader("BUILDERS", onClose, icon = "builder")
                    PkwText("Builder details are unavailable. Refresh your kingdom to load its current roster.", PkwTokens.Type.body, maxLines = 3)
                    messages.forEach { PkwText(it, PkwTokens.Type.small, maxLines = 3) }
                    if (recovery) SecondaryButton("DETAILS", { onPurchaseDetails?.invoke() }, Modifier.fillMaxWidth())
                }
            }
        }
        if (purchase != null && flow != null) {
            val number = flow.review?.expectedCount?.plus(1) ?: review?.ui?.hire?.number
            SolPurchaseOverlay(purchase, flow, listOfNotNull("HIRE BUILDER", number?.toString()).joinToString(" "),
                listOfNotNull(SOL_BUILDERS_STAY, SOL_SIGN_ONCE, solFeeLine(flow.review)))
        }
    }
}
