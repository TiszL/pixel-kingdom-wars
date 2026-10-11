package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kit.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*

/**
 * Keep EXPAND (keep-expand.png). With the Home purchase owner ([purchase]) EXPAND raises the SOL Seal here ("EXPAND LAND ·
 * <price> SOL → <n>×<n> land · Paid from your wallet. You sign once."), RETRY / CHECK reach the same owner and a saved
 * purchase offers the stone DETAILS door ([onPurchaseDetails], recovery only). The candidate's free test expansion and a
 * mount without [purchase] keep [onReview] (the existing purchase screen) unchanged.
 */
@Composable internal fun LiveExpandHost(state: KingdomUiState, enabled: Boolean, testExpansion: Boolean,
    onReview: () -> Unit, onClose: () -> Unit, onKeep: () -> Unit, modifier: Modifier = Modifier,
    purchase: HomeSolPurchase? = null, onPurchaseDetails: (() -> Unit)? = null) {
    val live = liveExpandReview(state, enabled, testExpansion)
    var explanation by remember(state.base?.baseId) { mutableStateOf<String?>(null) }
    val height = (LocalConfiguration.current.screenHeightDp / 2).dp
    val owner = purchase?.takeIf { expandInPlace(true, testExpansion) }
    val flow = owner?.let { rememberSolPurchase(it, "expansion", state.base?.baseId, null, onFinished = onClose,
        explain = { message -> explanation = message }) }
    val recovery = flow?.recovery == true && onPurchaseDetails != null
    val ui = live?.let { if (flow != null) expandWithPurchase(it, flow.view, recovery) else it }
    val messages = (listOfNotNull(explanation) + flow?.messages.orEmpty()).distinct()
    LiveHalfSheetHost(modifier) { placed ->
        Column(placed.heightIn(max = height).verticalScroll(rememberScrollState())) {
            if (ui == null) Plate(PlateKind.WOOD, Modifier.fillMaxWidth()) {
                Column {
                    HalfSheetHeader("EXPAND LAND", onClose)
                    PkwText(liveExpandUnavailableReason(state), PkwTokens.Type.body, maxLines = 3)
                    if (recovery) SecondaryButton("DETAILS", { onPurchaseDetails?.invoke() }, Modifier.fillMaxWidth())
                }
            } else KeepExpandSheet(ui, ExpandActions(
                // Without the Home owner (and for the free test expansion) the purchase screen owns every consent, saved
                // intent and signature: these only navigate there.
                onExpand = flow?.primary ?: { if (expandPrimary(ui) == ExpandPrimaryKind.EXPAND) onReview() },
                onSealConfirm = flow?.confirm ?: onReview, onRetry = flow?.retry ?: onReview, onCheck = flow?.check ?: onReview,
                // Not bound to any tappable in KeepExpandSheet: the camera pan to the ring belongs to the scene.
                onClose = onClose, onFlyToRing = {}, onKeepUpgrade = onKeep, onExplain = { explanation = it },
                onDetails = { onPurchaseDetails?.invoke() }))
            messages.forEach { message -> Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth()) {
                PkwText(message, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = 3)
            } }
        }
        if (owner != null && flow != null) SolPurchaseOverlay(owner, flow, "EXPAND LAND", listOfNotNull(SOL_SIGN_ONCE, solFeeLine(flow.review)),
            gets = expandSealGets(flow.review?.claimTiles ?: ui?.sizeNext))
    }
}
