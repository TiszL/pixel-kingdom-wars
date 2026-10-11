package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.MiningTaxClaimsAppPolicy
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetScrim
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.FinePrintSeal
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.FinePrintSealUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.IslandRewardsActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.IslandRewardsSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.IslandRewardsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapColors
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.RewardsTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.islandRewardsSheetTopDp
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.SHARE_CLAIM_WORKING_LINE
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.SavedClaimStep
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.SeekerRewardsDisplay
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.firstDue
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.islandRewardsKingdom
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.islandRewardsOriginalRequired
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.islandRewardsShown
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.islandRewardsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.realmCutDisplay
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.savedClaimRecovery
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.savedClaimStep
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.savedDraftRefusal
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.seekerMaterialsDisplay
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.seekerShardsDisplay
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.shareClaimRefusal
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.shareClaimSealUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.rewardsTabOf

/** The Phase E owner of each ISLAND REWARDS tab: one registration per tab. */
internal fun islandRewardsActivity(tab: RewardsTab): PhaseEActivity = when (tab) {
    RewardsTab.MATERIALS -> PhaseEActivity.RESOURCES
    RewardsTab.SHARDS -> PhaseEActivity.SHARDS
    RewardsTab.REALMS_CUT -> PhaseEActivity.MINING_TAX
}

/** A tab tap: the owner's own tab stays put (null); another tab names the registration that opens it. */
internal fun islandRewardsSibling(owner: RewardsTab, tappedId: String): PhaseEActivity? =
    rewardsTabOf(tappedId).takeIf { it != owner }?.let(::islandRewardsActivity)

/** The share projection with recovery rows that say what their in-place button does. */
private fun inPlace(display: SeekerRewardsDisplay, step: SavedClaimStep?): SeekerRewardsDisplay =
    if (step == null) display else display.copy(recovery = display.recovery.map { savedClaimRecovery(it, step) })

/** The original dialogs' amount grouping; a value it cannot group is shown as the server sent it, never dropped. */
private fun shareAmount(value: String): String = runCatching { seekerShardsAmount(value) }.getOrDefault(value)

/** The original dialogs' term line. */
private fun shareTerm(startsAt: String, endsAt: String): String = "${islandShareTime(startsAt)} – ${islandShareTime(endsAt)}"

/** SEEKER RESOURCE SHARES home: the designed MATERIALS tab, claimed in place. CLAIM reviews the first row with something due
 *  and the Seal confirms it through [model] (a server order: no wallet, no price); a saved claim is finished, checked or
 *  reopened from its recovery row. History opens [SeekerResourceClaimsScreen] (archives, paging, cancelling an unsent
 *  review), and its BACK returns here. */
@Composable internal fun SeekerResourceRewardsHome(model: SeekerResourceClaimsViewModel, selectedBase: String?, allowed: Boolean,
    onSibling: (PhaseEActivity) -> Unit, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val running by model.busy.collectAsState(); val notice by model.notice.collectAsState()
    var original by rememberSaveable { mutableStateOf(false) }
    val busy = running || state.busy
    val step = state.journal.operation?.let { savedClaimStep(it.receipt != null, it.attemptRevision != null) }
    val fresh = islandRewardsUi(RewardsTab.MATERIALS, inPlace(seekerMaterialsDisplay(state, null), step), null, busy,
        islandRewardsKingdom(selectedBase), paused = !allowed || state.view?.claimsEnabled == false, error = notice?.takeIf { it.error }?.message)
    if (original) {
        SeekerResourceClaimsScreen(model, selectedBase, allowed) { original = false }
        return
    }
    val review = state.review
    val armedAt = remember(review) { System.currentTimeMillis() }
    IslandRewardsHomeBody(fresh, busy, onSibling, onBack, onRetry = { model.refresh() },
        onClaim = {
            val row = firstDue(state.view?.rows.orEmpty()) { it.dueQuantity }
            val refusal = shareClaimRefusal(running || state.busy, row != null, seekerResourceCanReview(state, selectedBase, allowed), fresh.primary.reason)
            if (row != null && refusal == null) model.review(row) else Toasts.post(refusal ?: SHARE_CLAIM_WORKING_LINE)
        },
        onCheckSaved = { _ ->
            val saved = state.journal.operation
            if (running || state.busy) Toasts.post(SHARE_CLAIM_WORKING_LINE)
            else if (saved == null) model.refresh()
            else when (savedClaimStep(saved.receipt != null, saved.attemptRevision != null)) {
                // The owner clears its page when it archives the receipt; read it again so the sheet shows what is left.
                SavedClaimStep.SAVE_RECEIPT -> model.finish()?.invokeOnCompletion { if (model.state.value.journal.operation == null) model.refresh() }
                SavedClaimStep.CHECK -> model.check()
                SavedClaimStep.REVIEW_DRAFT -> {
                    val refusal = savedDraftRefusal(allowed, saved.command.request.baseId, selectedBase)
                    if (refusal != null) Toasts.post(refusal) else model.reviewSaved()
                }
            }
        },
        seal = review?.let { r ->
            shareClaimSealUi(false, shareAmount(r.row.dueQuantity), shareTerm(r.row.startsAt, r.row.endsAt), r.command.request.baseId,
                armedAt, busy, canConfirm = !busy && allowed, item = "${islandShareResource(r.row.resourceId)} · Spot ${r.row.spotId + 1}")
        },
        onSealConfirm = { state.review?.let { model.confirm(it) } },
        onSealBack = { if (running || state.busy) Toasts.post(SHARE_CLAIM_WORKING_LINE) else model.dismiss() }) { original = true }
}

/** SEEKER SHARDS home: the designed SHARDS tab, claimed in place through [model] exactly as the MATERIALS tab; History opens
 *  [SeekerShardsClaimsScreen] and its BACK returns here. */
@Composable internal fun SeekerShardsRewardsHome(model: SeekerShardsClaimsViewModel, selectedBase: String?, allowed: Boolean,
    onSibling: (PhaseEActivity) -> Unit, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val running by model.busy.collectAsState(); val notice by model.notice.collectAsState()
    var original by rememberSaveable { mutableStateOf(false) }
    val busy = running || state.busy
    val step = state.journal.operation?.let { savedClaimStep(it.receipt != null, it.attemptRevision != null) }
    val fresh = islandRewardsUi(RewardsTab.SHARDS, inPlace(seekerShardsDisplay(state, null), step), null, busy, islandRewardsKingdom(selectedBase),
        paused = !allowed || state.view?.claimsEnabled == false, error = notice?.takeIf { it.error }?.message)
    if (original) {
        SeekerShardsClaimsScreen(model, selectedBase, allowed) { original = false }
        return
    }
    val review = state.review
    val armedAt = remember(review) { System.currentTimeMillis() }
    IslandRewardsHomeBody(fresh, busy, onSibling, onBack, onRetry = { model.refresh() },
        onClaim = {
            val row = firstDue(state.view?.rows.orEmpty()) { it.dueQuantity }
            val refusal = shareClaimRefusal(running || state.busy, row != null, seekerShardsCanReview(state, selectedBase, allowed), fresh.primary.reason)
            if (row != null && refusal == null) model.review(row) else Toasts.post(refusal ?: SHARE_CLAIM_WORKING_LINE)
        },
        onCheckSaved = { _ ->
            val saved = state.journal.operation
            if (running || state.busy) Toasts.post(SHARE_CLAIM_WORKING_LINE)
            else if (saved == null) model.refresh()
            else when (savedClaimStep(saved.receipt != null, saved.attemptRevision != null)) {
                // The owner clears its page when it archives the receipt; read it again so the sheet shows what is left.
                SavedClaimStep.SAVE_RECEIPT -> model.finish()?.invokeOnCompletion { if (model.state.value.journal.operation == null) model.refresh() }
                SavedClaimStep.CHECK -> model.check()
                SavedClaimStep.REVIEW_DRAFT -> {
                    val refusal = savedDraftRefusal(allowed, saved.command.request.baseId, selectedBase)
                    if (refusal != null) Toasts.post(refusal) else model.reviewSaved()
                }
            }
        },
        seal = review?.let { r ->
            shareClaimSealUi(true, shareAmount(r.row.dueQuantity), shareTerm(r.row.startsAt, r.row.endsAt), r.command.request.baseId,
                armedAt, busy, canConfirm = !busy && allowed, item = "Spot ${r.row.spotId + 1}")
        },
        onSealConfirm = { state.review?.let { model.confirm(it) } },
        onSealBack = { if (running || state.busy) Toasts.post(SHARE_CLAIM_WORKING_LINE) else model.dismiss() }) { original = true }
}

/** KEEP TAX CLAIMS home: the designed REALM'S CUT tab. Preparation, SOL limits, wallet approval, submission and receipts
 *  all stay with [MiningTaxClaimsScreen]; an open review, saved history or MFA prompt draws it at once. */
@Composable internal fun MiningTaxRewardsHome(model: MiningTaxClaimsViewModel, allowed: Boolean, policy: MiningTaxClaimsAppPolicy?,
    onSibling: (PhaseEActivity) -> Unit, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val running by model.busy.collectAsState(); val notice by model.notice.collectAsState()
    val history by model.history.collectAsState(); val mfa = model.wallet?.mfa?.collectAsState()?.value
    var original by rememberSaveable { mutableStateOf(false) }
    val busy = running || state.busy
    val fresh = islandRewardsUi(RewardsTab.REALMS_CUT, null, realmCutDisplay(state), busy, null, paused = !allowed,
        keepDecimals = policy?.tokenDecimals, error = notice?.takeIf { it.error }?.message ?: state.error)
    val required = islandRewardsOriginalRequired(fresh.recovery.isNotEmpty(), state.review != null || history != null || mfa != null)
    SideEffect { if (required && !original) original = true }
    if (required || original) {
        MiningTaxClaimsScreen(model, allowed, policy) { original = false; onBack() }
        return
    }
    IslandRewardsHomeBody(fresh, busy, onSibling, onBack, onRetry = { model.refresh() }) { original = true }
}

/**
 * The designed sheet in the TALL slot (top per [islandRewardsSheetTopDp], the 40 % scrim above it closes like BACK). With
 * [onClaim] / [onCheckSaved] the share tabs act in place and [seal] is their open review; without them (REALM'S CUT) every
 * claim, check, history and kingdom control opens the original owner. A disabled primary explains itself; a tab tap hands
 * over to its own registration.
 */
@Composable private fun IslandRewardsHomeBody(fresh: IslandRewardsUi, busy: Boolean, onSibling: (PhaseEActivity) -> Unit,
    onBack: () -> Unit, onRetry: () -> Unit, onClaim: (() -> Unit)? = null, onCheckSaved: ((String) -> Unit)? = null,
    seal: FinePrintSealUi? = null, onSealConfirm: () -> Unit = {}, onSealBack: () -> Unit = {}, onOriginal: () -> Unit) {
    var kept by remember { mutableStateOf<IslandRewardsUi?>(null) }
    SideEffect { if (!busy) kept = fresh }
    val ui = islandRewardsShown(fresh, kept, busy)
    BackHandlerAt(BackPriority.SCREEN) { onBack() }
    // Back on an open Seal is the Seal's BACK, never a close of the sheet under it.
    BackHandlerAt(BackPriority.CONFIRM, seal != null) { onSealBack() }
    BoxWithConstraints(Modifier.fillMaxSize().background(MapColors.stage)) {
        SheetScrim(SheetSize.TALL, onBack)
        IslandRewardsSheet(ui, IslandRewardsActions(
            onTab = { id -> islandRewardsSibling(fresh.tab, id)?.let(onSibling) },
            onChangeKingdom = onOriginal, onClaim = onClaim ?: onOriginal,
            // The tax Seal is never drawn here (MiningTaxClaimsScreen owns that consent); the share Seal is [seal] below.
            onSealConfirm = onOriginal, onSealBack = onOriginal,
            onCheckSaved = onCheckSaved ?: { _: String -> onOriginal() }, onHistory = onOriginal, onClose = onBack, onRetry = onRetry,
            onReport = { Toasts.post("Use FEEDBACK in your profile to report this.") },
            onExplain = { reason -> Toasts.post(reason) }),
            Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom))
                .padding(start = 4.dp, end = 4.dp, top = islandRewardsSheetTopDp(maxHeight.value).dp))
        FinePrintSeal(seal, onSealConfirm, onSealBack)
    }
}
