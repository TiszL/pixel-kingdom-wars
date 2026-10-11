package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pixelkingdomwars.nativeclient.data.HarvesterReview
import gg.pixelkingdomwars.nativeclient.data.HarvesterState
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.economy.starterLabel
import gg.pixelkingdomwars.nativeclient.ui.kit.*
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.BackRegistry
import gg.pixelkingdomwars.nativeclient.ui.nav.LocalBackRegistry
import java.math.BigDecimal
import java.math.RoundingMode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Borrows the session owner's reviewed callbacks. Only the exact review opened here can be confirmed here;
 * no journal, command builder, repository, payment model, or mutation retry policy is introduced. */
internal class HomeHarvesterReviewController(
    private val identity: HomeRouteIdentity,
    private val current: () -> HomeRouteIdentity?,
    private val admitted: () -> Boolean,
    private val state: () -> HarvesterState,
    private val selectedHarvester: () -> String?,
    private val reviewSelection: suspend (String) -> Unit,
    private val reviewSaved: suspend () -> Unit,
    private val confirmReview: suspend (HarvesterReview) -> Unit,
    private val dismissReview: () -> Unit,
) {
    private var owned: HarvesterReview? by mutableStateOf(null)
    private var opening by mutableStateOf(false)
    private var confirming by mutableStateOf(false)
    private var retirement = 0L
    var refreshRevision by mutableIntStateOf(0)
        private set
    val working: Boolean get() = opening || confirming || state().busy
    val holding: Boolean get() = opening || confirming || review != null
    private fun contextAdmitted() = current() == identity && admitted()
    fun currentAndAdmitted(): Boolean = contextAdmitted() &&
        (state().review == null || state().review === review)
    val review: HarvesterReview? get() = owned?.takeIf {
        current() == identity && state().review === it && it.generation == identity.baseSelectionGeneration &&
            it.command.request.baseId == identity.baseId && state().journal.operation?.command == it.command &&
            it.view.wallet == state().journal.identity.wallet && it.view.baseId == identity.baseId
    }

    suspend fun open(renderedHarvester: String?): Boolean {
        if (!currentAndAdmitted() || opening || confirming) return false
        val before = state()
        if (before.busy || before.review != null || !before.advertised) return false
        val view = before.view?.takeIf { it.baseId == identity.baseId && it.wallet == before.journal.identity.wallet } ?: return false
        if (!view.acceptingSelections || view.home == null) return false
        val selected = selectedHarvester()
        if (selected != null && renderedHarvester != selected) return false
        val target = if (renderedHarvester != null) view.facilities.singleOrNull { it.harvesterId == renderedHarvester }
            else view.facilities.singleOrNull()
        target ?: return false
        val saved = before.journal.operation
        if (saved != null && (saved.command.request.baseId != identity.baseId ||
                saved.command.request.harvesterId != target.harvesterId || saved.proof != null || saved.refusal != null)) return false
        val begun = retirement
        opening = true
        try {
            if (saved == null) reviewSelection(target.harvesterId) else reviewSaved()
            val next = state().review ?: return false
            if (next.command.request.baseId != identity.baseId || next.command.request.harvesterId != target.harvesterId ||
                next.generation != identity.baseSelectionGeneration || state().journal.operation?.command != next.command ||
                (saved != null && next.command != saved.command)) return false
            owned = next
            if (retirement != begun || !currentAndAdmitted()) {
                if (state().review === next) dismissReview()
                owned = null
                return false
            }
            return true
        } finally { opening = false }
    }

    suspend fun confirm(rendered: HarvesterReview): Boolean {
        if (!currentAndAdmitted() || opening || confirming || state().busy || review !== rendered) return false
        confirming = true
        try { confirmReview(rendered) }
        finally { confirming = false; refreshRevision++ }
        return true
    }

    /** Ordinary Back cannot invalidate an in-flight confirmation; STOP/disposal retain the owner's existing epoch rule. */
    fun cancel(force: Boolean = false) {
        if (!force && (state().busy || opening || confirming)) return
        retirement++
        val held = owned
        if ((held != null && state().review === held) || opening) dismissReview()
        owned = null
    }
}

/** Only this actual Back registration is exempt from the sheet's own review hold. */
internal class HomeHarvesterReviewPresence {
    var painted by mutableStateOf(false)
    var back: BackRegistry.Registration? by mutableStateOf(null)
    fun ownsBack(active: BackRegistry.Registration?) = active != null && active === back
}

/** Full frozen consent from the original owner, formatted only. Future yield is never described as current stock. */
internal fun homeHarvesterReviewLines(review: HarvesterReview, attempted: Boolean): List<String> {
    val command = review.command
    val policy = command.policy
    val percent = BigDecimal.valueOf(policy.islandPoolBps).multiply(BigDecimal.valueOf(100))
        .divide(BigDecimal.valueOf(policy.taxBasisPoints), 6, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()
    return buildList {
        add("${starterLabel(command.realmId)} home resource")
        add("Up to ${fmtN(policy.grossPerCadence)} gross every ${fmtDur(policy.cadenceSec)}.")
        add("${fmtN(policy.grossPerWalletUtcDay)} gross per wallet per UTC day · $percent% to the island pool.")
        add("${policy.producingSourcesPerWallet} producing source per wallet · up to ${fmtDur(policy.maxLeaseSec)} unattended. Only completed earning periods count.")
        add("Wallet-wide limits and tax rounding continue across kingdom and Harvester changes. Extra facilities do not raise them.")
        add("Producing kingdom: ${command.request.baseId}\nHarvester: ${command.request.harvesterId}\nCompleted (UTC): ${command.facility.harvesterCompletedAt}")
        add("Original request: ${command.key}\nPolicy version: ${policy.policyVersion}\nTax policy: ${policy.taxPolicyVersion} · ${policy.islandPoolBps}/${policy.taxBasisPoints}")
        command.replacedSource?.let { previous ->
            add("This closes the previous source and starts a new interval. Already earned units stay owed to their producing kingdom.")
            add("Source being replaced: ${previous.sourceId}\nKingdom: ${previous.baseId}\nHarvester: ${previous.harvesterId}\n${starterLabel(previous.resourceId)} · ${starterLabel(previous.realmId)}\nSelected (UTC): ${previous.admittedAt}\nInterval ends (UTC): ${previous.leaseExpiresAt}")
        } ?: add("No existing wallet source will be replaced.")
        add("Earning may stop earlier when the operating term ends or kingdom authority changes. Future earnings are not spendable stock.")
        if (attempted) add("This explicitly resends the same saved selection only after its original receipt is checked.")
    }
}

/** The designed in-place review plate has a scrolling body: no policy or replacement consent is ellipsized.
 * It is mounted in Home's existing overlay, while the Harvester sheet and its saved-history owner remain mounted. */
@Composable internal fun HomeHarvesterReviewOverlay(controller: HomeHarvesterReviewController?, state: HarvesterState?,
    presence: HomeHarvesterReviewPresence, modifier: Modifier = Modifier, explain: (String) -> Unit) {
    val review = controller?.review
    val visible = controller?.holding == true
    val registry = LocalBackRegistry.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    SideEffect { presence.painted = visible }
    DisposableEffect(controller, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) controller?.cancel(force = true) }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); controller?.cancel(force = true); presence.painted = false }
    }
    DisposableEffect(registry, controller, visible) {
        val registration = registry.register(BackPriority.CONFIRM, visible) { controller?.cancel() }
        presence.back = registration
        onDispose { registry.unregister(registration); if (presence.back === registration) presence.back = null }
    }
    BackHandler(visible) { registry.dispatch() }
    val admitted = controller?.currentAndAdmitted() == true
    LaunchedEffect(controller, state?.review, admitted) { if (!admitted) controller?.cancel() }
    if (!visible) return
    val busy = controller?.working == true || state?.busy == true || review == null
    val lines = review?.let { homeHarvesterReviewLines(it, state?.journal?.operation?.attemptRevision != null) }
        ?: listOf("Checking this Harvester and its original source before review. Saved requests remain preserved.")
    BoxWithConstraints(modifier) {
        Plate(PlateKind.WOOD, Modifier.align(Alignment.BottomCenter).fillMaxWidth().heightIn(max = maxHeight * 0.84f)
            .semantics { paneTitle = "Review Harvester selection" }, contentPadding = PaddingValues(9.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText(if (review == null) "PREPARING REVIEW" else "START GATHERING", PkwTokens.Type.title,
                    color = PkwTokens.Colors.text, maxLines = 2)
                Plate(PlateKind.PARCHMENT, Modifier.weight(1f, fill = false).fillMaxWidth(), blocksScene = false) {
                    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        lines.forEach { line -> PkwText(line, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch, maxLines = Int.MAX_VALUE) }
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton("BACK", { controller?.cancel() }, Modifier.width(PkwTokens.Dims.sealBackW), enabled = !busy)
                    PrimaryButton("START", {
                        if (controller != null && review != null) scope.launch {
                            try {
                                if (!controller.confirm(review)) explain("Review this Harvester selection again before confirming.")
                            } catch (cancelled: CancellationException) { throw cancelled }
                            catch (error: Exception) { explain(error.message ?: "The source selection could not be confirmed. Check its saved receipt.") }
                        }
                    }, Modifier.weight(1f), state = when {
                        busy -> CommandState.BUSY
                        !admitted -> CommandState.DISABLED
                        else -> CommandState.ENABLED
                    })
                }
            }
        }
    }
}
