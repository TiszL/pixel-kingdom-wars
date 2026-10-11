package gg.pixelkingdomwars.nativeclient.ui.more

import gg.pixelkingdomwars.nativeclient.ui.chrome.GamePage
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.Card
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.home.HOME_MENU_FOLDED
import gg.pixelkingdomwars.nativeclient.ui.home.MenuCellSpec
import gg.pixelkingdomwars.nativeclient.ui.home.MenuGrid
import gg.pixelkingdomwars.nativeclient.ui.home.menuArt
import gg.pixelkingdomwars.nativeclient.ui.home.menuColumns
import gg.pixelkingdomwars.nativeclient.ui.home.menuLabel

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.Quest
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.*
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import gg.pixelkingdomwars.nativeclient.ui.kingdom.questLabel
import kotlinx.serialization.json.JsonObject

/** BASES and ACCOUNT stay routable (deep links, raid interlock, world map) but are folded out of the menu grid: LAND is
 * the single land/base entry and the profile hub carries the account (home/HomeScaffold.kt HOME_MENU_FOLDED). */
enum class MoreDestination(val label: String) { LAND("Your land"), BASES("Your bases"), RESEARCH("Alchemy Lab"), HEROES("Heroes"), INVENTORY("Inventory"), SHOP("Shop"), ECONOMY("KEEP wallet"), MARKET("Market & collection"), TESTER("Tester program"), FEEDBACK("Player feedback"), CLANS("Clans"), CHAT("Chat"), MAIL("Mail"), LEAGUES("Leagues"), CODEX("Codex"), QUESTS("Quests"), ACCOUNT("Account"), ABOUT("About, legal & support"), SETTINGS("Settings") }

/** The MORE tab is the player menu's grid again (home/MenuGrid.kt), not a column of form buttons; the
 * "MORE" title and the MENU control already sit in the scaffold's bar above it. */
@Composable fun MoreScreen(onOpen: (MoreDestination) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val columns = menuColumns((maxWidth - 32.dp).value.toInt())
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            MenuGrid(MoreDestination.entries.filter { it !in HOME_MENU_FOLDED }.map { destination ->
                MenuCellSpec(menuArt(destination), menuLabel(destination), description = destination.label, onClick = { onOpen(destination) })
            }, columns)
        }
    }
}

class QuestsViewModel(private val base: BaseRepository, private val content: ContentRepository) : ScreenViewModel() {
    constructor(graph: AppGraph, session: SessionGraph) : this(session.base, graph.content)
    val state = combine(base.state, content.state) { home, content -> home to content.catalogue }.stateIn(viewModelScope, SharingStarted.Eagerly, base.state.value to content.state.value.catalogue)
    /** The board the Quests sheet's own scoped read last accepted, with its owner scope: display only, so a reopened sheet
     * shows it while its fresh read runs (QuestsHub [retainedQuestsBoard]); it never admits a claim. */
    internal var lastAccepted: Pair<QuestsScope, BaseState>? = null
    init { refresh() }
    fun refresh() = run { base.refreshQuests() }
    fun claim(questId: String, requireCurrent: () -> Unit = {}) = run { requireCurrent(); base.claimQuest(questId) }
    /** Web `claimAll`: the reviewed ready quests are frozen at the tap and claimed one by one; a lost reply
     * stops the batch (each claim already reconciles itself against the board) and the count is honest.
     * [requireCurrent] checks captured ownership only, so this operation's own busy flag cannot cancel it. */
    fun claimAll(requireCurrent: () -> Unit = {}) = run {
        requireCurrent()
        val ids = state.value.first.quests?.quests.orEmpty().filter { it.completed && !it.claimed }.mapNotNull { it.questIdentity }
        if (ids.isEmpty()) return@run
        var confirmed = 0; var interrupted = false; var cancelled = false
        try { for (id in ids) { requireCurrent(); base.claimQuest(id); confirmed++ } }
        catch (error: kotlinx.coroutines.CancellationException) { cancelled = true; throw error }
        catch (_: Exception) { interrupted = true }
        finally {
            // A cancelled claim retains its original cancellation; cleanup must not replace it or target a new owner.
            if (!cancelled) {
                requireCurrent()
                try { base.refreshQuests() }
                catch (error: kotlinx.coroutines.CancellationException) { throw error }
                catch (_: Exception) { /* Each submitted claim already reconciles its own outcome. */ }
                requireCurrent()
                notify(if (interrupted) "$confirmed CLAIMS CONFIRMED — REFRESHING; RETRY REMAINING QUESTS" else "$confirmed ${if (confirmed == 1) "QUEST" else "QUESTS"} CLAIMED")
            }
        }
    }
}

/** Web `chainIndex`: the chain's authored order from `QUESTS.onboardingTemplates`; an unknown code sorts last. */
internal fun chainIndex(catalogue: JsonObject?, templateCode: String): Int {
    val templates = ((catalogue?.get("constants") as? JsonObject)?.get("QUESTS") as? JsonObject)?.get("onboardingTemplates") as? kotlinx.serialization.json.JsonArray
    val ids = templates?.mapNotNull { (it as? JsonObject)?.string("id") }.orEmpty()
    return ids.indexOf(templateCode).let { if (it == -1) ids.size else it }
}

/** Web `QuestsScreen` order: claimable first, then in progress by closeness, then untouched, claimed last. */
internal fun dailyRank(quest: Quest): Int = when {
    quest.completed && !quest.claimed -> 0
    !quest.completed && (quest.progress?.toDoubleOrNull() ?: 0.0) > 0 -> 1
    !quest.completed -> 2
    else -> 3
}

/** Standalone recovery entry uses the same designed live card as the Home sheet. */
@Composable fun QuestsScreen(model: QuestsViewModel, onBack: () -> Unit, onBuild: () -> Unit,
    onTrain: () -> Unit, onCampaign: () -> Unit, onLand: () -> Unit, graph: AppGraph, session: SessionGraph,
    onReport: () -> Unit = {}) {
    QuestsHub(graph, session, model, onBack, onBuild, onTrain, onCampaign, onLand, onReport = onReport)
}

class AccountViewModel(private val graph: AppGraph, private val session: SessionGraph?) : ScreenViewModel() {
    val account = graph.account.state
    val content = graph.content.state
    val bases get() = graph.account.state.value.directory?.bases.orEmpty()
    fun loadSecurity() = run { graph.account.loadSecurity() }
    fun checkContentUpdates() = run { session?.api?.let { graph.content.checkUpdates(it, force = true) } }
    /** Web menu.tsx replayTutorial/toggleGuidance: the switch reads the server's answer through the Home read, but REPLAY changes
     * nothing visible on this page, so each action announces itself (web toasts). A failure keeps [run]'s notice instead. */
    fun tutorialAction(action: String) = run {
        val base = session?.base ?: return@run
        base.tutorialAction(action)
        when (action) { "reset" -> toast(Copy.TUTORIAL_RESTARTED); "guide/skip" -> toast(Copy.GUIDANCE_OFF); "guide/resume" -> toast(Copy.GUIDANCE_ON) }
    }
    fun selectBase(id: String) = run { graph.account.selectBase(id); session?.base?.refreshWithoutJourneys() } // selection hydration: no journey publication (N-C5)
    /** The wallet is captured before the local sign-out clears it, so a social account's Privy session is ended too. */
    fun logout(mwa: WalletLogin?) { val wallet = account.value.wallet; run { graph.account.logout { graph.releaseLocalCredentials(mwa, wallet) } } }
    fun unlink(mwa: WalletLogin?) = run { graph.account.unlink { mwa?.clearAuthorization() } }
}
