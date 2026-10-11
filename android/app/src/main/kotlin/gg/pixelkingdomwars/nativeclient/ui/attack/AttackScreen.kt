@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package gg.pixelkingdomwars.nativeclient.ui.attack

import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.ModalBottomSheet
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.unit.sp
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.BattleRecord
import gg.pixelkingdomwars.nativeclient.model.CampaignStage
import gg.pixelkingdomwars.nativeclient.model.PendingMarch
import gg.pixelkingdomwars.nativeclient.network.RaidCreateTarget
import gg.pixelkingdomwars.nativeclient.network.RaidInterlockState
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.*
import gg.pixelkingdomwars.nativeclient.content.ContentLease
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** Attack tab: the RAID destination chooser (web RaidChooser), campaign stages (server-authored unlocks, stars and
 * recommended points) and the permanent battle history with replays, revenge and unfinished marches (web raidlog). */
class AttackViewModel(private val battle: BattleRepository, private val account: AccountRepository? = null, private val base: BaseRepository? = null,
                      private val content: ContentRepository? = null, private val interlock: StateFlow<RaidInterlockState>? = null,
                      private val campaignArt: (suspend (ContentState, (WorldContentProgress) -> Unit) -> ContentLease)? = null) : ScreenViewModel() {
    constructor(graph: AppGraph, session: SessionGraph) : this(session.battle, graph.account, session.base, graph.content, session.interlock.state, { generation, onProgress -> graph.worldContent.acquire(generation, session.api, onProgress) })
    /** The optional globe generation the campaign map crops from: its download/verify phase while the lease is pending
     * (owner 2026-09-17: the Seeker showed a bare ground colour with no word about the art still arriving). */
    val campaignArtProgress = MutableStateFlow<WorldContentProgress?>(null)
    val state: StateFlow<BattleDomainState> = battle.state.stateIn(viewModelScope, SharingStarted.Eagerly, battle.state.value)
    val accountState = account?.state
    val baseState = base?.state
    val contentState = content?.state
    val interlockState = interlock
    private val _chooser = MutableStateFlow(false)
    val chooser: StateFlow<Boolean> = _chooser.asStateFlow()
    private class ReadNotice {
        var revision = 0
        val error = MutableStateFlow<String?>(null)
        fun reset() { revision++; error.value = null }
    }
    private val campaignRead = ReadNotice()
    private val historyRead = ReadNotice()
    private var refreshJob: Job? = null
    val campaignReadError = campaignRead.error.asStateFlow()
    val historyReadError = historyRead.error.asStateFlow()
    private fun selectedScope() = account?.state?.value?.let { Triple(it.session, it.wallet, it.selectedBaseId) }
    init {
        viewModelScope.launch {
            if (account == null) readBoards()
            else account.state.map { Triple(it.session, it.wallet, it.selectedBaseId) }.distinctUntilChanged().collectLatest {
                campaignRead.reset(); historyRead.reset()
                readBoards()
            }
        }
    }
    // Read notices have their own lifetime: a successful background refresh must never erase an
    // uncertain attack/scout action, nor leave an earlier failed board load above fresh progress.
    private suspend fun read(notice: ReadNotice, block: suspend () -> Unit) {
        val scope = selectedScope()
        val revision = ++notice.revision
        fun current() = revision == notice.revision && scope == selectedScope()
        try {
            block()
            currentCoroutineContext().ensureActive()
            if (current()) notice.error.value = null
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            currentCoroutineContext().ensureActive()
            if (current()) notice.error.value = error.message ?: "Battle information is unavailable. Refresh to retry."
            throw error
        }
    }
    private suspend fun readBoards() {
        try { readCampaign(); read(historyRead) { battle.refreshHistory() } }
        catch (error: CancellationException) { throw error }
        catch (_: Exception) { /* The corresponding scoped read notice owns this failure. */ }
    }
    suspend fun readCampaign() = read(campaignRead) { battle.refreshCampaign() }
    suspend fun acquireCampaignArt(content: ContentState): ContentLease = requireNotNull(campaignArt) { "World artwork is unavailable" }(content) { campaignArtProgress.value = it }
    fun refresh(): Job? {
        if (active || refreshJob?.isActive == true) return null
        return viewModelScope.launch { readBoards() }.also { refreshJob = it }
    }
    fun attack(stage: Int) = run { battle.campaignBattle(stage) }
    fun scout(stage: Int) = run { battle.previewStage(stage) }
    fun recover() = run { battle.recoverBattle() }
    fun openReplay(raidId: String) = run { battle.openReplay(raidId) }
    fun openReplay(row: BattleRecord) = run { battle.openReplay(row) }
    fun resume(march: PendingMarch) = run { battle.resumePending(march.id) }
    /** FIND ME A TARGET: the automatic stable match; the server partitions the pools by land ownership. */
    fun autoMatch() { _chooser.value = false; run { battle.pvpBattle(RaidCreateTarget.Pvp()) } }
    /** REVENGE / ATTACK BACK: exactly the map's target; the server's createRaid stays the only attackability gate. */
    fun revenge(row: BattleRecord) { val target = revengeTarget(row) ?: return; run { battle.pvpBattle(target) } }
    fun scout(row: BattleRecord) { val target = revengeTarget(row) ?: return; run {
        val history = state.value.history
        check(row in history.deed || row in history.participant) { "Refresh battle history before scouting this target." }
        check(account == null || history.baseId == account.state.value.selectedBaseId) { "The selected base changed. Refresh its history." }
        battle.scoutTarget(requireNotNull(target.defenderWallet), target.defenderBaseId)
    } }
    /** WATCH LIVE from the defender interlock: the selected deed's raid as a read-only participant. */
    fun watchLive(raidId: String, baseId: String) = run { battle.watchLive(raidId, baseId) }
    fun loadOlderDeed() = run { battle.loadOlderDeedBattles() }
    fun loadOlderParticipant() = run { battle.loadOlderParticipantBattles() }
    fun openChooser() { _chooser.value = true }
    fun closeChooser() { _chooser.value = false }
}


/** Web RaidUI.tsx attack hub as a real game page: a forged header bar (‹ BASE always returns to the kingdom, RAID opens
 * the chooser), the campaign hero card, an unfinished-march recovery plate only when the server holds one, and the
 * battle history as riveted panels. Wide/landscape viewports keep the campaign and the history side by side. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun AttackScreen(model: AttackViewModel, requests: HomeRequests? = null, onOpenWorld: () -> Unit = {}, onOpenLand: () -> Unit = {}, historyOnly: Boolean = false, onBack: () -> Unit = {}, onRaidLog: (() -> Unit)? = null) {
    if (historyOnly && gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ArmyLive.ENABLED) {
        gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.BattleLogLiveHost(model, onBack)
        return
    }
    val state by model.state.collectAsState()
    val busy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val campaignReadError by model.campaignReadError.collectAsState()
    val historyReadError by model.historyReadError.collectAsState()
    val chooser by model.chooser.collectAsState()
    val account = model.accountState?.collectAsState()?.value
    val home = model.baseState?.collectAsState()?.value
    val content = model.contentState?.collectAsState()?.value
    val interlock = model.interlockState?.collectAsState()?.value
    val constants = content?.catalogue?.get("constants") as? JsonObject
    val now = displayClock()
    val request = requests?.pending?.collectAsState()?.value
    var campaignShown by remember(account?.session, account?.selectedBaseId) { mutableStateOf(false) }
    fun returnBase() = onBack()
    gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt(gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority.SCREEN, enabled = campaignShown && !chooser) { returnBase() }
    // Web: the chooser request is consumed only once this owner of the chooser has mounted.
    LaunchedEffect(request) {
        when (request) {
            HomeRequest.RaidChooser -> { model.openChooser(); requests?.consume(request) }
            HomeRequest.Campaign -> { campaignShown = true; requests?.consume(request) }
            else -> {}
        }
    }
    val landOwned = account?.landOwned == true
    val onboarding = home?.tutorial?.onboarding?.templateCode == "first_raid"
    val stages = state.campaign?.takeIf { account == null || it.baseId == account.selectedBaseId }?.stages.orEmpty()
    if (!historyOnly && campaignShown) {
        FantasyCampaignScreen(model, stages, content, account?.session to account?.selectedBaseId, busy || state.loading,
            notice?.message ?: campaignReadError ?: state.error, onOpenWorld, ::returnBase, { campaignShown = false }, model::openChooser,
            !busy && (interlock?.actionsAllowed ?: true))
    } else BoxWithConstraints(Modifier.fillMaxSize().background(Palette.backdrop)) {
        val wide = !historyOnly && maxWidth >= 720.dp && maxWidth > maxHeight
        val history = state.history.takeIf { account == null || it.baseId == account.selectedBaseId } ?: BattleHistoryState(loading = true)
        val banners: @Composable () -> Unit = {
            notice?.let { Notice(it.message, it.error, model::dismissNotice) }
            (historyReadError ?: campaignReadError ?: state.error)?.takeIf { notice == null }?.let { Notice(it, error = true) }
        }
        val lead: @Composable () -> Unit = {
            if (!historyOnly) CampaignHeroCard(stages, constants) { campaignShown = true }
            // Web raidlog: recovery is offered only while the server still holds an unfinished march for this scope.
            if (history.pending.isNotEmpty()) RecoverMarchPlate(!busy, model::recover)
        }
        val log: @Composable () -> Unit = {
            BattleHistorySection(history, constants, now, busy, onReplay = model::openReplay, onRevenge = model::revenge, onResume = model::resume,
                onMoreDeed = model::loadOlderDeed, onMoreParticipant = model::loadOlderParticipant, onScout = model::scout)
        }
        Column(Modifier.fillMaxSize()) {
            AttackHeader(if (historyOnly) Copy.BATTLE_HISTORY else "ATTACK", onBack, !busy, model::refresh,
                raid = if (historyOnly) null else model::openChooser, raidEnabled = !busy && (interlock?.actionsAllowed ?: true))
            // Web BaseHud RAID: disabled while the deed's raid lock is unknown or held.
            if (busy || state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (wide) Row(Modifier.fillMaxSize()) {
                Column(Modifier.width(330.dp).fillMaxHeight().verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { banners(); lead() }
                Column(Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState()).padding(top = 12.dp, end = 12.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { log() }
            } else Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { banners(); lead(); log() }
        }
    }
    if (chooser && !historyOnly && gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ArmyLive.ENABLED) {
        // Same Need-more rule as the Home raid mount: SHORT Shards opens the Gold Forge where Home's dispatcher is provided.
        val routeDispatcher = gg.pixelkingdomwars.nativeclient.ui.home.LocalHomeRouteDispatcher.current
        gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.RaidChooserLiveHost(model, home, landOwned, onboarding, constants,
            actionsAllowed = interlock?.actionsAllowed ?: true,
            onOpenWorld = { requests?.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.Rivals)) ?: onOpenWorld() },
            onOpenCampaignMap = { campaignShown = true },
            onOpenArmy = { requests?.request(HomeRequest.Tab(HomeTab.ARMY)) },
            onTrain = { requests?.request(HomeRequest.Training) },
            onRaidLog = { onRaidLog?.invoke() ?: model.refresh() },
            onNeedMore = { price ->
                if (price.icon != "energy" && routeDispatcher?.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("goldforge.open")) == true) model.closeChooser()
                else gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post(
                    if (price.icon == "energy") "No raid energy left right now." else "Not enough Shards for this raid.") })
    } else if (chooser && !historyOnly) RaidChooserSheet(landOwned, onboarding, home?.base?.energy?.let { it.free.toString() to it.max.toString() }, home?.base?.player?.keepLevel, constants,
        onAuto = model::autoMatch, onMap = { model.closeChooser(); requests?.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.Rivals)) ?: onOpenWorld() }, onCampaign = { model.closeChooser(); campaignShown = true },
        onBuyLand = { model.closeChooser(); onOpenLand() }, onClose = model::closeChooser)
}

/** Forged page bar: ‹ BASE on the left, the page title, the refresh glyph and (attack hub only) the primary RAID button. */
@Composable private fun AttackHeader(title: String, onBack: () -> Unit, refreshEnabled: Boolean, onRefresh: () -> Unit, raid: (() -> Unit)?, raidEnabled: Boolean) {
    PixelPlate("bar", Modifier.fillMaxWidth(), PaddingValues(horizontal = 8.dp, vertical = 6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            TextButton(onClick = onBack, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) { Text("‹ BASE", fontSize = 16.sp) }
            Text(title, Modifier.weight(1f), color = Palette.gold, style = MaterialTheme.typography.titleLarge, maxLines = 1)
            TextButton(onClick = onRefresh, enabled = refreshEnabled, modifier = Modifier.size(44.dp), contentPadding = PaddingValues(0.dp)) { GameArt("replay", Modifier.size(22.dp), "Refresh") }
            raid?.let { Button(onClick = it, enabled = raidEnabled, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp)) { GameArt("attack", Modifier.size(18.dp)); Text(Copy.RAID) } }
        }
    }
}

/** Web attack hub campaign entry: progress from the server-authored stages, the total from the catalogue when none loaded. */
@Composable private fun CampaignHeroCard(stages: List<CampaignStage>, constants: JsonObject?, onContinue: () -> Unit) {
    val total = stages.size.takeIf { it > 0 } ?: (constants?.get("CAMPAIGN") as? JsonObject)?.string("totalStages")?.toIntOrNull()
    val cleared = stages.count { it.bestStars > 0 }
    PixelPanel(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            PixelPlate("gold", Modifier.size(64.dp)) { GameArt("star", Modifier.align(Alignment.Center).size(36.dp)) }
            Column(Modifier.weight(1f)) {
                Text("SINGLE PLAYER", color = Palette.textFaint, fontSize = 13.sp, lineHeight = 15.sp, letterSpacing = 1.sp)
                Text("THE FOUR REALM CAMPAIGN", style = MaterialTheme.typography.titleMedium, color = Palette.goldHi)
                Text("$cleared/${total ?: "—"} CLEARED · ${stages.sumOf { it.bestStars }} ★", fontSize = 16.sp, lineHeight = 19.sp, color = Palette.muted)
            }
        }
        LinearProgressIndicator(progress = if (total != null && total > 0) cleared.toFloat() / total else 0f, modifier = Modifier.fillMaxWidth())
        Text("FREE · NO ENERGY · YOUR BASE IS NEVER AT RISK", fontSize = 14.sp, lineHeight = 17.sp, color = Palette.muted)
        Button(onClick = onContinue, modifier = Modifier.fillMaxWidth()) { Text(if (cleared > 0) Copy.CONTINUE else "BEGIN") }
    } }
}

@Composable private fun RecoverMarchPlate(enabled: Boolean, onRecover: () -> Unit) {
    PixelPlate("tab", Modifier.fillMaxWidth(), PaddingValues(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            GameArt("timer", Modifier.size(22.dp))
            Column(Modifier.weight(1f)) {
                Text("ACTIVE MARCH", color = Palette.gold, style = MaterialTheme.typography.labelMedium)
                Text("A SERVER-SAVED MARCH IS WAITING", fontSize = 13.sp, lineHeight = 16.sp, color = Palette.muted)
            }
            OutlinedButton(onClick = onRecover, enabled = enabled, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)) { Text("RECOVER", fontSize = 16.sp) }
        }
    }
}

/** Web RaidChooser.tsx as a bottom sheet: the budget up front (energy from the same server snapshot the map reads, the
 * entry ante from the catalogue table), the three destinations as illustrated plates, and for a landless keep the honest
 * BUY LAND line at the bottom. Gating and every callback are unchanged; X, Back and the scrim all close it. */
@Composable fun RaidChooserSheet(landOwned: Boolean, onboarding: Boolean, energy: Pair<String, String>?, keepLevel: Int?, constants: JsonObject?,
                                 onAuto: () -> Unit, onMap: () -> Unit, onCampaign: () -> Unit, onBuyLand: () -> Unit, onClose: () -> Unit) {
    val entryCost = raidEntryCostLabel(constants, keepLevel)
    ModalBottomSheet(onDismissRequest = onClose, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                GameArt("attack", Modifier.size(24.dp))
                Text(Copy.RAID, Modifier.weight(1f), color = Palette.gold, style = MaterialTheme.typography.titleLarge)
                TextButton(onClick = onClose, modifier = Modifier.size(44.dp), contentPadding = PaddingValues(0.dp)) { GameArt("close", Modifier.size(22.dp), "Close") }
            }
            energy?.let { (free, max) -> PixelPlate("tab", Modifier.fillMaxWidth(), PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    GameArt("energy", Modifier.size(20.dp)); Spacer(Modifier.width(8.dp))
                    Text(Copy.FREE_ENERGY, Modifier.weight(1f), color = Palette.muted)
                    Text("$free/$max", color = if (free == "0") Palette.danger else Palette.gold, style = MaterialTheme.typography.titleMedium)
                }
            } }
            // A pack without the entry table cannot state the ante: say so and keep PvP closed rather than invent a number.
            if (entryCost == null) Notice("GAME CONTENT UPDATE NEEDED — THIS PACK LACKS THE PVP ENTRY COST TABLE. PVP STAYS OFF UNTIL IT IS APPLIED.", NoticeKind.WARN)
            else PixelPlate("tab", Modifier.fillMaxWidth(), PaddingValues(horizontal = 12.dp, vertical = 8.dp)) { Column {
                Text("${Copy.EACH_PVP_TARGET} · $entryCost", color = Palette.gold)
                Text(Copy.ENTRY_COST_NOTE, style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            } }
            raidChoices(landOwned, onboarding).forEach { choice ->
                val enabled = choice.id != "auto" || entryCost != null
                val chip = when (choice.id) { "auto" -> entryCost ?: "PVP OFF"; "map" -> if (choice.preview) "LOOK ONLY" else "SCOUT FIRST"; else -> "FREE" }
                RaidChoicePlate(choice, chip, enabled, reason = if (enabled) null else "PVP ENTRY COST UNKNOWN") {
                    when (choice.id) { "auto" -> onAuto(); "map" -> onMap(); else -> onCampaign() }
                }
            }
            if (!landOwned) TextButton(onClick = onBuyLand, modifier = Modifier.fillMaxWidth()) { Text(Copy.BUY_LAND_TO_RAID, color = Palette.gold) }
            Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
        }
    }
}

@Composable private fun RaidChoicePlate(choice: RaidChoice, chip: String, enabled: Boolean, reason: String?, onClick: () -> Unit) {
    val gold = choice.gold && enabled
    val ink = if (gold) Palette.ink else Palette.text
    PixelPlate(if (gold) "gold" else "tab", Modifier.fillMaxWidth().alpha(if (enabled) 1f else .55f)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick), PaddingValues(12.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            PixelPlate("shard", Modifier.size(52.dp)) { GameArt(when (choice.id) { "auto" -> "attack"; "map" -> "map"; else -> "star" }, Modifier.align(Alignment.Center).size(30.dp)) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(choice.title, style = MaterialTheme.typography.titleMedium, color = ink)
                Text(choice.sub, fontSize = 14.sp, lineHeight = 17.sp, color = if (gold) Palette.ink.copy(alpha = .8f) else Palette.muted)
                reason?.let { Text(it, fontSize = 13.sp, lineHeight = 16.sp, color = Palette.danger) }
            }
            PixelPlate("shard", contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
                Text(chip, Modifier.widthIn(max = 96.dp), fontSize = 13.sp, lineHeight = 15.sp, color = Palette.goldHi, textAlign = TextAlign.Center)
            }
        }
    }
}

@Composable private fun SectionPlate(title: String, sub: String? = null, art: String? = null) {
    PixelPlate("tab", Modifier.fillMaxWidth(), PaddingValues(horizontal = 10.dp, vertical = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            art?.let { GameArt(it, Modifier.size(20.dp)) }
            Column {
                Text(title, color = Palette.gold, style = MaterialTheme.typography.labelMedium)
                sub?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = Palette.muted) }
            }
        }
    }
}
@Composable private fun EmptyPlate(text: String) {
    PixelPlate("tab", Modifier.fillMaxWidth(), PaddingValues(14.dp)) {
        Text(text, Modifier.fillMaxWidth(), color = Palette.muted, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
    }
}
@Composable private fun ValueChip(text: String, color: androidx.compose.ui.graphics.Color = Palette.text) {
    PixelPlate("shard", contentPadding = PaddingValues(horizontal = 8.dp, vertical = 3.dp)) { Text(text, fontSize = 14.sp, lineHeight = 16.sp, color = color) }
}

/** Web raidlog.tsx `BattleHistoryView`: unfinished marches first, the selected deed's record, then prior participation. */
@Composable fun BattleHistorySection(history: BattleHistoryState, constants: JsonObject?, now: Long, busy: Boolean, onReplay: (BattleRecord) -> Unit,
                                     onRevenge: (BattleRecord) -> Unit, onResume: (PendingMarch) -> Unit, onMoreDeed: () -> Unit, onMoreParticipant: () -> Unit,
                                     onScout: ((BattleRecord) -> Unit)? = null) {
    SectionPlate(Copy.BATTLE_HISTORY, art = "shield")
    history.error?.let { Notice(it, error = true) }
    history.pending.forEach { march -> PixelPanel(Modifier.fillMaxWidth()) { Row(Modifier.padding(12.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        GameArt("timer", Modifier.size(22.dp))
        Column(Modifier.weight(1f)) { Text(Copy.UNFINISHED_MARCH, color = Palette.gold); Text(Copy.UNFINISHED_MARCH_SUB, style = MaterialTheme.typography.bodySmall, color = Palette.muted) }
        Button(onClick = { onResume(march) }, enabled = !busy, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)) { Text(Copy.CONTINUE, fontSize = 16.sp) }
    } } }
    SectionPlate(if (history.stable) Copy.SELECTED_DEED_HISTORY else Copy.WALLET_RAID_HISTORY)
    if (!history.loading && history.stable && !history.deedSelected) EmptyPlate(Copy.NO_DEED_SELECTED)
    if (!history.loading && history.deedSelected && history.deed.isEmpty() && history.pending.isEmpty()) EmptyPlate(Copy.NO_DEED_BATTLES)
    history.deed.forEach { BattleRow(it, participant = false, constants, now, busy, onReplay, onRevenge, onScout) }
    history.deedCursor?.let { OutlinedButton(onClick = onMoreDeed, enabled = !history.loadingMoreDeed && !busy, modifier = Modifier.fillMaxWidth()) { Text(if (history.loadingMoreDeed) Copy.LOADING else Copy.LOAD_OLDER_DEED, fontSize = 16.sp) } }
    if (history.stable) {
        SectionPlate(Copy.PRIOR_PARTICIPATION, Copy.PRIOR_PARTICIPATION_SUB)
        if (!history.loading && history.participant.isEmpty() && history.participantCursor == null) EmptyPlate(Copy.NO_PARTICIPATED)
        history.participant.forEach { BattleRow(it, participant = true, constants, now, busy, onReplay, onRevenge, onScout) }
        history.participantCursor?.let { OutlinedButton(onClick = onMoreParticipant, enabled = !history.loadingMoreParticipant && !busy, modifier = Modifier.fillMaxWidth()) { Text(if (history.loadingMoreParticipant) Copy.LOADING else Copy.LOAD_OLDER_PARTICIPATED, fontSize = 16.sp) } }
    }
    if (history.loading) EmptyPlate(Copy.LOADING_HISTORY)
    Text(Copy.HISTORY_FOOTER, Modifier.fillMaxWidth(), style = MaterialTheme.typography.labelSmall, color = Palette.textFaint, textAlign = TextAlign.Center)
}

/** One battle as a riveted panel: the verdict word (VICTORY gold, DEFEAT ember), the star row, who attacked whom, the
 * destruction and settled-loot chips, the relative time, then REPLAY and — on a PvP defence — SCOUT / REVENGE. */
@Composable private fun BattleRow(row: BattleRecord, participant: Boolean, constants: JsonObject?, now: Long, busy: Boolean, onReplay: (BattleRecord) -> Unit, onRevenge: (BattleRecord) -> Unit, onScout: ((BattleRecord) -> Unit)?) {
    val (attacker, seeker) = battleAttacker(row)
    val won = row.result == "victory"
    val verdict = (row.result ?: "").uppercase()
    val stars = (row.stars ?: 0).coerceIn(0, 3)
    PixelPanel(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GameArt(if (row.role == "defender") "shield" else "attack", Modifier.size(20.dp))
            Text(verdict.ifEmpty { "UNSETTLED" }, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium,
                color = if (won) Palette.gold else if (verdict == "DEFEAT") Palette.danger else Palette.muted)
            Text("★".repeat(stars) + "☆".repeat(3 - stars), color = Palette.goldHi, fontSize = 18.sp)
        }
        Text(if (row.role == "attacker") "YOU VS ${opponentLabel(row)}" else "ATTACKER · ${if (seeker) "✦ " else ""}$attacker", style = MaterialTheme.typography.bodyMedium)
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            ValueChip("${row.destructionPct ?: "0"}% DESTROYED")
            ValueChip(settledLootLabel(row), if (row.lootRedacted) Palette.muted else if (row.role == "attacker") Palette.gold else Palette.danger)
            ValueChip(relTime(row.createdAt, now), Palette.muted)
        }
        if (participant) Text("FOUGHT FROM DEED ${row.baseId.orEmpty().take(8).uppercase()}", style = MaterialTheme.typography.labelSmall, color = Palette.muted)
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val small = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
            if (revengeTarget(row) != null && onScout != null) OutlinedButton(onClick = { onScout(row) }, enabled = !busy, contentPadding = small) { GameArt("scout", Modifier.size(16.dp)); Text("SCOUT", fontSize = 16.sp) }
            if (revengeTarget(row) != null) revengeLabel(row, constants, now)?.let { label -> Button(onClick = { onRevenge(row) }, enabled = !busy, contentPadding = small) { Text(label, fontSize = 16.sp) } }
            OutlinedButton(onClick = { onReplay(row) }, enabled = !busy, contentPadding = small) { GameArt("replay", Modifier.size(16.dp)); Text(Copy.REPLAY, fontSize = 16.sp) }
        }
    } }
}
