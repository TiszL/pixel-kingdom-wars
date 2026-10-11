package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetBackdrop
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetEffect
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetGeometry
import gg.pixelkingdomwars.nativeclient.ui.kit.fullScreenSheetShelf
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.ui.attack.AttackViewModel
import gg.pixelkingdomwars.nativeclient.ui.attack.FantasyCampaignScreen
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.RAID_TAB_CAMPAIGN
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import kotlinx.serialization.json.JsonObject

/** Presentation only: the queue still has one head, and TRAIN retains its composer-owned consumption. */
internal data class ArmyHomeRequest(val sheet: String, val consumeAtMount: Boolean)
internal fun armyHomeRequest(request: HomeRequest?): ArmyHomeRequest? = when (request) {
    HomeRequest.Army -> ArmyHomeRequest("army", true)
    HomeRequest.Training -> ArmyHomeRequest("army", false)
    HomeRequest.RaidChooser -> ArmyHomeRequest("raid", true)
    HomeRequest.Campaign -> ArmyHomeRequest("campaign", true)
    else -> null
}

/** Preserve the current shared resource projection; this host does not create a second balance mapper. */
internal fun armyHomeHud(ui: gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi, open: Boolean) =
    if (open) ui.copy(deckVisible = false, toolsOpen = false, herald = null, context = null) else ui

/** The whole window for the army group. Owner 2026-10-06 ("make it full screen"): the owned Tall slot
 * (ArmyLiveTallSlot) now applies the safe-drawing insets itself, so it can paint one opaque full-screen card with the
 * resource pills on its shelf; on a wide window it keeps the former framed geometry (safe top + 24 dp + the 104 dp world
 * strip). Half sheets and Seals in this group apply their own insets. */
@Composable internal fun ArmyHomeFrame(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize()) { content() }
}

/** Existing full-page review owners have no Tall slot of their own. Preserve the same readable world strip: the safe top
 *  and sides, the 24 dp the army frame used to add, then the 104 dp strip (unchanged geometry). */
@Composable internal fun ArmyHomeLegacyFrame(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
        .padding(top = 24.dp).padding(top = 104.dp)) { content() }
}

/** The full campaign map is a scene (SPEC §6 MAP), not a sheet over a world strip. Owner 2026-10-06 ("dark overlap on
 *  camera place is ugly ... make it full screen"): on a phone-width window it fills the screen inside the safe insets over
 *  the opaque full-screen backdrop (kit FullScreenSheet.kt), with no dimmed kingdom strip above it; a wide window keeps
 *  the former framed geometry ([ArmyHomeLegacyFrame]). */
@Composable internal fun ArmyHomeSceneFrame(content: @Composable () -> Unit) {
    val fills = FullScreenSheetGeometry.fillsScreen(SheetSize.FULL, LocalConfiguration.current.screenWidthDp.toFloat())
    FullScreenSheetEffect(active = fills)
    if (!fills) { ArmyHomeLegacyFrame(content); return }
    val shelf = fullScreenSheetShelf()
    Box(Modifier.fillMaxSize()) {
        FullScreenSheetBackdrop()
        Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(top = shelf)) { content() }
    }
}

/** The existing raid owner and optional full campaign map, with Kingdom retained beneath both.
 * No battle/recovery command is reimplemented here. The existing model remains the only action owner. */
@Composable internal fun ArmyHomeRaidMount(
    model: AttackViewModel, home: BaseState?, landOwned: Boolean, onboarding: Boolean,
    constants: JsonObject?, actionsAllowed: Boolean, campaign: Boolean, onClose: () -> Unit,
    onOpenWorld: () -> Unit, onOpenArmy: () -> Unit, onTrain: () -> Unit,
    onRaidLog: () -> Unit, onNeedMore: (PriceUi) -> Unit,
    armyState: gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState? = null,
) {
    val account = model.accountState?.collectAsState()?.value
    val state by model.state.collectAsState()
    val content = model.contentState?.collectAsState()?.value
    val busy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val campaignError by model.campaignReadError.collectAsState()
    val chooser by model.chooser.collectAsState()
    var mapShown by rememberSaveable(account?.session, account?.selectedBaseId) { mutableStateOf(false) }
    // autoMatch closes its own chooser before the existing battle route takes over. Close our presentation too.
    LaunchedEffect(chooser, mapShown) { if (!chooser && !mapShown) onClose() }
    val close: () -> Unit = { model.closeChooser(); onClose() }
    if (mapShown) {
        val stages = state.campaign?.takeIf { account == null || it.baseId == account.selectedBaseId }?.stages.orEmpty()
        BackHandlerAt(BackPriority.SHEET) { mapShown = false; model.openChooser() }
        ArmyHomeSceneFrame {
            FantasyCampaignScreen(model, stages, content, account?.session to account?.selectedBaseId,
                busy || state.loading, notice?.message ?: campaignError ?: state.error,
                onWorld = { close(); onOpenWorld() }, onBack = close,
                onHistory = { close(); onRaidLog() },
                onChooser = { mapShown = false; model.openChooser() },
                chooserEnabled = !busy && actionsAllowed)
        }
    } else {
        RaidChooserLiveHost(model, home, landOwned, onboarding, constants, actionsAllowed,
            onOpenWorld = { onClose(); onOpenWorld() },
            onOpenCampaignMap = { mapShown = true },
            onOpenArmy = { onClose(); onOpenArmy() },
            onTrain = { onClose(); onTrain() },
            onRaidLog = { onClose(); onRaidLog() }, onNeedMore = onNeedMore,
            initialTab = if (campaign) RAID_TAB_CAMPAIGN else null, onClose = close, armyState = armyState)
    }
}
