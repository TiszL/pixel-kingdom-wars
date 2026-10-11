package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import gg.pixelkingdomwars.nativeclient.ui.attack.AttackViewModel
import gg.pixelkingdomwars.nativeclient.ui.attack.revengeLabel
import gg.pixelkingdomwars.nativeclient.ui.attack.revengeTarget
import gg.pixelkingdomwars.nativeclient.ui.displayClock
import gg.pixelkingdomwars.nativeclient.ui.kit.*
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.*
import kotlinx.serialization.json.JsonObject

/** Full designed log over the existing AttackViewModel. No repository, review or battle owner is created here.
 *  [onFocusBuilding] (a wall's id) and [onOpenLand] are the DEFENCE empty states' doors (GO TO WALLS; the landless GO);
 *  while a caller does not pass one, that GO is not drawn. */
@Composable internal fun BattleLogLiveHost(model: AttackViewModel, onClose: () -> Unit,
    onFocusBuilding: ((String) -> Unit)? = null, onOpenLand: (() -> Unit)? = null) {
    val state by model.state.collectAsState()
    val busy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val readError by model.historyReadError.collectAsState()
    val account = model.accountState?.collectAsState()?.value
    val home = model.baseState?.collectAsState()?.value?.takeIf { it.base?.baseId == account?.selectedBaseId }
    val content = model.contentState?.collectAsState()?.value
    val interlock = model.interlockState?.collectAsState()?.value
    val constants = content?.catalogue?.get("constants") as? JsonObject
    val now = displayClock()
    var tab by rememberSaveable(account?.session, account?.selectedBaseId) { mutableStateOf(LOG_TAB_DEFENCE) }
    var requested by remember(account?.session, account?.selectedBaseId) { mutableStateOf<String?>(null) }
    val history = currentBattleHistory(state.history, account?.selectedBaseId)
    val toasts = rememberLiveToasts()
    NoticeToToast(notice, toasts, model::dismissNotice)
    BackHandlerAt(BackPriority.SHEET, onBack = onClose)
    fun currentHistory() = currentBattleHistory(model.state.value.history, model.accountState?.value?.selectedBaseId)
    fun explain(message: String) = toasts.post("battle-log", message)
    fun currentWall(): String? = model.baseState?.value?.takeIf { it.base?.baseId == model.accountState?.value?.selectedBaseId }
        ?.base?.buildings?.firstOrNull { it.type == "wall" }?.id
    val actions = BattleLogActions(
        onTab = { tab = it }, onClose = onClose, onExplain = ::explain,
        onGo = { id ->
            when (id) {
                LOG_GO_WALLS -> {
                    val wall = currentWall()
                    if (wall != null && onFocusBuilding != null) onFocusBuilding(wall) else explain("Build a wall first.")
                }
                LOG_GO_LAND -> onOpenLand?.invoke() ?: explain("Land opens from the world map.")
                else -> explain("This is not open yet.")
            }
        },
        onReplay = { id ->
            // A tap never does nothing: busy or a row that left the refreshed history says why.
            val record = battleLogRecord(currentHistory(), id)
            when {
                model.busy.value -> explain("An action is in progress.")
                record == null -> explain("Refresh battle history before watching this replay.")
                else -> model.openReplay(record)
            }
        },
        onRevenge = { id ->
            val row = battleLogRecord(currentHistory(), id)
            val freshHome = model.baseState?.value?.takeIf { it.base?.baseId == model.accountState?.value?.selectedBaseId }
            val gate = raidRevengeLiveUi(currentHistory(), freshHome, constants, System.currentTimeMillis(), model.busy.value,
                model.interlockState?.value?.actionsAllowed == true).gate
            if (gate == null && row != null && revengeTarget(row) != null && revengeLabel(row, constants, System.currentTimeMillis()) != null) {
                requested = id; model.revenge(row)
            } else explain(gate ?: "Refresh battle history before answering this raid.")
        },
        onWatch = { id ->
            val current = model.interlockState?.value
            val baseId = model.accountState?.value?.selectedBaseId
            val raid = current?.activeRaid
            if (!model.busy.value && current?.known == true && raid != null && raid.raidId == id && raid.state == "live" && baseId != null)
                model.watchLive(id, baseId)
            else explain(if (model.busy.value) "An action is in progress." else "This raid has ended. Its result appears here once it is scored.")
        },
    )
    val live = interlock?.activeRaid?.takeIf { interlock?.known == true && it.state == "live" && home != null && !history.loading }
        ?.let { LiveDefenceUi("A rival", "shield", it.raidId) }
    // Landless only on the server's explicit "no entry paid"; an identity still loading is never shown as locked.
    val landless = account?.identity?.entryPaid == false
    val wallsDoor = onFocusBuilding != null && home?.base?.buildings?.any { it.type == "wall" } == true
    val ui = battleLogLiveUi(tab, history, home, constants, now, busy, interlock?.actionsAllowed == true,
        requested.takeIf { busy }, live, landless = landless, wallsDoor = wallsDoor, landDoor = onOpenLand != null)
        .copy(error = readError ?: history.error)
    val prior = history.participant
    // Owner 2026-10-06 ("dark overlap on camera place is ugly ... make it full screen"): on a phone-width window the log is
    // one opaque full-screen card (kit FullScreenSheet.kt, as the army sheets), edge to edge inside the safe insets, with
    // no scrim over an empty route. A wide window keeps the framed FULL card over the 60 % scrim.
    val fills = FullScreenSheetGeometry.fillsScreen(SheetSize.FULL, LocalConfiguration.current.screenWidthDp.toFloat())
    FullScreenSheetEffect(active = fills)
    val shelf = fullScreenSheetShelf()
    Box(Modifier.fillMaxSize()) {
        if (fills) FullScreenSheetBackdrop() else SheetScrim(SheetSize.FULL, onClose)
        BattleLogSheet(ui, actions, if (fills) Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(top = shelf)
                .zIndex(PkwTokens.Z.SHEET)
            else Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.navigationBars)
                .padding(start = 8.dp, end = 8.dp, top = PkwTokens.Dims.fullSheetTop, bottom = PkwTokens.Dims.fullSheetBottom)
                .zIndex(PkwTokens.Z.SHEET),
            leading = {
                SecondaryButton("REFRESH", { model.refresh() }, enabled = !busy && !history.loading, icon = "replay")
                history.pending.forEach { march ->
                    ArmyCard(Modifier.fillMaxWidth()) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Column(Modifier.weight(1f)) {
                                PkwText("Unfinished march", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                                PkwText("A server-saved march is waiting.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                            }
                            SecondaryButton("RESUME", {
                                if (!model.busy.value) currentHistory().pending.firstOrNull { it.id == march.id }?.let(model::resume)
                            }, enabled = !busy, verb = Verb.BLUE)
                        }
                    }
                }
            },
            trailing = {
                if (history.deedCursor != null) SecondaryButton(if (history.loadingMoreDeed) "LOADING…" else "LOAD OLDER", {
                    if (!model.busy.value && currentHistory().deedCursor != null) model.loadOlderDeed()
                }, Modifier.fillMaxWidth(), enabled = !busy && !history.loadingMoreDeed)
                if (history.stable) {
                    SectionLine("PRIOR PARTICIPATION")
                    PkwText("Replays remain available after a deed changes hands.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                    if (tab == LOG_TAB_DEFENCE) {
                        val rows = prior.filter { it.role == "defender" }
                        if (rows.isEmpty()) PkwText("No prior defences loaded.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                        rows.forEach { row -> DefenceEntryRow(defenceLiveRow(row, constants, now, requested.takeIf { busy }), ui.revengeGate,
                            compact = false, onRevenge = actions.onRevenge, onReplay = actions.onReplay, onExplain = actions.onExplain) }
                    } else AttackTab(ui.copy(attacks = prior.filter { it.role == "attacker" }.map { attackLiveRow(it, now) }), actions)
                    if (history.participantCursor != null) SecondaryButton(if (history.loadingMoreParticipant) "LOADING…" else "LOAD OLDER PARTICIPATION", {
                        if (!model.busy.value && currentHistory().participantCursor != null) model.loadOlderParticipant()
                    }, Modifier.fillMaxWidth(), enabled = !busy && !history.loadingMoreParticipant)
                }
            })
        ToastHost(toasts.list, onGo = {}, onReport = {}, Modifier.align(Alignment.BottomCenter).padding(bottom = 100.dp).zIndex(PkwTokens.Z.TOAST))
    }
}
