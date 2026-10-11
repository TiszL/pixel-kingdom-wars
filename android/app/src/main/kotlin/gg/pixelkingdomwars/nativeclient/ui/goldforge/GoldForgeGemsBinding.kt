package gg.pixelkingdomwars.nativeclient.ui.goldforge

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pixelkingdomwars.nativeclient.data.GemsBuyBalances
import gg.pixelkingdomwars.nativeclient.data.GemsBuyState
import gg.pixelkingdomwars.nativeclient.data.GemsBuyWallet
import gg.pixelkingdomwars.nativeclient.data.KeepDepositBounds
import gg.pixelkingdomwars.nativeclient.model.GemsCapability
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.economy.GemsBuyReview
import gg.pixelkingdomwars.nativeclient.ui.economy.GemsBuyViewModel
import gg.pixelkingdomwars.nativeclient.ui.economy.GoldForgeGemsRecovery
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteIdentity
import gg.pixelkingdomwars.nativeclient.ui.hud.HudGeometry
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.CelebrationUi
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ForgeCelebrationKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemsActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemsSeal
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GoldForgeCelebration
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemsUi
import kotlinx.coroutines.launch

/*
 * The Home-mounted Gold Forge GEMS tab buying in place (design/final/goldforge/SPEC.md §5a-5c, §6b; `gems.png`,
 * `gems-seal.png`, `gems-sent.png`, `speedup-short.png`). The binding is a callback adapter over the existing purchase
 * owner: GemsBuyViewModel reviews, pays (through GemsBuyWallet), checks, abandons and finishes; nothing here signs, submits
 * or prices. It ports the A4 route face (GemsBuyScreen) with the same guards, minus the route hop: BUY raises the designed
 * Seal as soon as the requested review lands, the wallet step runs in the Seal, and the credited receipt plays the
 * '+n GEMS' celebration plus a '+n' rise beside the HUD GEMS row. A Gem-spend shortfall arrives prefilled.
 */

/** A Gem-spend shortfall handed to the GEMS tab (SPEC §6b GET GEMS): [gems] is the raw whole Gems still needed, [forWhat]
 *  the line's subject ("Workshop finish"), [originBuildingId] the building to return to once the purchase is credited. */
internal data class GoldForgeGemsShortfall(val identity: HomeRouteIdentity, val gems: String, val forWhat: String?,
    val originBuildingId: String?)

/** The one pending shortfall of a Home session. The binding clears it once the player edits the amount or a purchase is
 *  credited; offering again replaces it. */
internal class GoldForgeGemsShortfallBox {
    private val held = mutableStateOf<GoldForgeGemsShortfall?>(null)
    val pending: GoldForgeGemsShortfall? get() = held.value
    fun offer(value: GoldForgeGemsShortfall) { held.value = value }
    fun clear() { held.value = null }
}

/**
 * What the mount composes. [ui] null means the saved purchase needs the recovery plate: draw [recovery] in the GEMS body
 * (it is non-null exactly then). [reviewOpen] holds the sheet open while a frozen review or payment is up. [overlay] goes
 * above the sheet: the Seal, the celebration over its scrim, the wallet-help plate and the MFA dialog.
 */
internal data class GoldForgeGemsBinding(
    val ui: GemsUi?,
    val actions: GemsActions,
    val reviewOpen: Boolean,
    val pendingBadge: Int,
    val gain: String?,
    val recovery: (@Composable ColumnScope.() -> Unit)?,
    val overlay: @Composable () -> Unit,
)

internal const val GEMS_PAYING_BACK = "Complete or decline the existing request in your wallet. It stays saved here."
internal const val GEMS_PAYING_REOPEN = "Return to your wallet to finish the existing request. This screen will not send another request."
internal const val GEMS_WAIT = "Finish the current loading or review step, then try again."
internal const val GEMS_CONVERT_CLOSED = "Gems into Shards is not open here yet."

/** The amount the owner sees: while a shortfall is pending it is blank, so the owner prefills from the server rate. */
internal fun goldForgeGemsAmountArg(amount: String, shortfall: GoldForgeGemsShortfall?): String = if (shortfall != null) "" else amount

/** Why an amount edit is refused (stepper, chips), or null when the amount may change. */
internal fun goldForgeGemsEditRefusal(state: GemsBuyState, running: Boolean, paying: Boolean): String? = when {
    paying -> GEMS_PAYING_BACK
    state.saved != null -> "Check the original saved purchase first."
    running || state.busy -> "A wallet purchase is already being checked."
    !state.available || state.capability == null -> "Purchase availability has not been confirmed. Refresh status to try again."
    else -> null
}

/** A chip tap's new raw amount, or the reason it cannot apply. MAX resolves from wallet KEEP ([goldForgeGemsMax]). */
internal fun goldForgeGemsQuickPick(label: String, cap: GemsCapability, funds: WalletFunds?): Pair<String?, String?> =
    when (val raw = goldForgeGemsQuickRaw(label, cap)) {
        null -> null to "Choose a whole amount from ${exactAmount(cap.minConvertKeep.toString())} to " +
            "${exactAmount(cap.maxConvertKeepPerTx.toString())} KEEP."
        GOLD_FORGE_GEMS_MAX -> goldForgeGemsMax(funds, cap)?.let { it to null } ?: (null to "Refresh your wallet balance before choosing MAX.")
        else -> raw to null
    }

/** The Seal rises for the review the player asked for (BUY / CONTINUE), never for one that merely exists; while the
 *  wallet already holds a request, its wallet step is shown again. */
internal fun goldForgeGemsShouldFreeze(review: GemsBuyReview?, frozen: GemsBuyReview?, requested: Boolean, state: GemsBuyState,
    wallet: String, paying: Boolean, running: Boolean): Boolean {
    if (review == null || frozen === review) return false
    if (paying) return true
    return requested && goldForgeGemsCanConfirm(review, review, state, wallet, paying = false, running = running)
}

/** What CONTINUE (and the sheet's "Check wallet" / moss SENT faces) does. */
internal enum class GoldForgeGemsContinue { RAISE_SEAL, FINISH, CHECK, REVIEW_SAVED, EXPLAIN }

internal fun goldForgeGemsContinue(ui: GoldForgeGemsOwnerUi, state: GemsBuyState, paying: Boolean): GoldForgeGemsContinue = when {
    paying || ui.canPay -> GoldForgeGemsContinue.RAISE_SEAL
    ui.canFinish -> GoldForgeGemsContinue.FINISH
    state.saved?.attempted == true -> if (ui.canCheck) GoldForgeGemsContinue.CHECK else GoldForgeGemsContinue.EXPLAIN
    ui.canReviewSaved -> GoldForgeGemsContinue.REVIEW_SAVED
    ui.canCheck -> GoldForgeGemsContinue.CHECK
    else -> GoldForgeGemsContinue.EXPLAIN
}

/** The celebration plays only for a credited receipt that was not already in the owner's store at entry. */
internal fun goldForgeGemsCelebrationShown(ui: GoldForgeGemsOwnerUi, seenAtEntry: String?): GoldForgeGemsCelebration? =
    ui.celebration?.takeIf { it.key != seenAtEntry }

/** SPEC §5c copy: "+{n} GEMS", "Added to your Gems", drawn by the forge celebration (`gem_64`, the gem-green ribbon). */
internal fun goldForgeGemsCelebrationUi(shown: GoldForgeGemsCelebration?): CelebrationUi? =
    shown?.let { CelebrationUi(it.key, "gf:gem_64", "+${exactAmount(it.amount)} GEMS", "Added to your Gems") }

/** The "+n" beside the HUD GEMS row while the celebration shows. */
internal fun goldForgeGemsGain(shown: GoldForgeGemsCelebration?): String? = shown?.let { "+" + exactAmount(it.amount) }

/** The designed face, or null when only the recovery plate can act on the saved purchase. CONVERT shows only with a door. */
internal fun goldForgeGemsBindingUi(owner: GoldForgeGemsOwnerUi, state: GemsBuyState, convertDoor: Boolean): GemsUi? =
    if (owner.recoveryOnly) null
    else owner.gems.copy(toShardsAvailable = convertDoor && state.available && state.capability != null)

/**
 * The GEMS tab over the existing purchase owner. [current] is the host's session, identity and lifecycle witness (not its
 * review hold). [shortfall] is the pending Gem-spend shortfall for this identity; [onShortfallUsed] clears it. [onReturn]
 * gets the shortfall's building once its purchase is credited. [onExplain] carries every refusal and owner notice to the
 * forge's toast zone.
 */
@Composable internal fun rememberGoldForgeGemsBinding(model: GemsBuyViewModel, sender: GemsBuyWallet, balances: GemsBuyBalances,
    wallet: String, bounds: KeepDepositBounds?, current: () -> Boolean, shortfall: GoldForgeGemsShortfall?,
    onShortfallUsed: () -> Unit, onConvert: (() -> Unit)?, onGoClaim: () -> Unit, onReturn: ((String) -> Unit)?,
    onExplain: (String) -> Unit): GoldForgeGemsBinding {
    val state by model.state.collectAsState(); val review by model.review.collectAsState()
    val notice by model.notice.collectAsState(); val running by model.busy.collectAsState()
    val paying by model.paying.collectAsState(); val funds by balances.state.collectAsState()
    val mfa by sender.mfa.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val isCurrent by rememberUpdatedState(current)
    val latestShortfall by rememberUpdatedState(shortfall)
    val latestBounds by rememberUpdatedState(bounds)
    val explain by rememberUpdatedState(onExplain)
    val shortfallUsed by rememberUpdatedState(onShortfallUsed)
    val convertDoor by rememberUpdatedState(onConvert)
    val claimDoor by rememberUpdatedState(onGoClaim)
    val returnDoor by rememberUpdatedState(onReturn)
    var amount by rememberSaveable(wallet) { mutableStateOf("") }
    var seenReceipt by rememberSaveable(wallet) { mutableStateOf(goldForgeGemsReceiptAtEntry(model.state.value, wallet)) }
    var frozenReview by remember(model, wallet) { mutableStateOf<GemsBuyReview?>(null) }
    var armedAtMs by remember(model, wallet) { mutableStateOf<Long?>(null) }
    var requested by remember(model, wallet) { mutableStateOf(false) }
    var walletHelp by remember(model, wallet) { mutableStateOf<String?>(null) }
    // The shortfall's building outlives an amount edit (which clears the shortfall line) until the purchase is credited.
    var origin by remember(model, wallet) { mutableStateOf<String?>(null) }
    var announced by remember(model) { mutableStateOf(model.notice.value) }
    // background() hides the shared owner (a review prepared while hidden is refused) and only foreground() clears that.
    // The host refreshes the repository, so foreground() runs only right before an explicit review after a stop or entry.
    var ownerHidden by remember(model) { mutableStateOf(true) }
    val selectedReview = frozenReview?.takeIf { it === review }
    val owner = goldForgeGemsOwner(state, review, wallet, funds, goldForgeGemsAmountArg(amount, shortfall), bounds, running, paying,
        error = notice?.takeIf { it.error }?.message, sealArmedAtMs = armedAtMs.takeIf { selectedReview != null },
        shortfallGems = shortfall?.gems, shortfallFor = shortfall?.forWhat)
    val currentOwner = {
        val pending = latestShortfall
        goldForgeGemsOwner(model.state.value, model.review.value, wallet, balances.state.value, goldForgeGemsAmountArg(amount, pending),
            latestBounds, model.busy.value, model.paying.value, shortfallGems = pending?.gems, shortfallFor = pending?.forWhat)
    }
    val admitted: () -> Boolean = { if (isCurrent()) true else { explain(GEMS_WAIT); false } }
    val closeSeal: () -> Unit = { frozenReview = null; armedAtMs = null; requested = false; walletHelp = null }
    val edit: ((GemsCapability, String) -> Pair<String?, String?>) -> Unit = { next ->
        val refusal = goldForgeGemsEditRefusal(model.state.value, model.busy.value, model.paying.value)
        val cap = model.state.value.capability
        if (admitted()) {
            if (refusal != null || cap == null) explain(refusal ?: GEMS_WAIT)
            else {
                val (value, reason) = next(cap, currentOwner().amountInput)
                if (value != null) { amount = value; shortfallUsed() } else if (reason != null) explain(reason)
            }
        }
    }
    val checkOriginal: () -> Unit = {
        if (admitted()) { val now = currentOwner(); if (now.canCheck) model.check() else explain(now.explanation ?: GEMS_WAIT) }
    }
    val raiseSeal: () -> Unit = {
        val selected = model.review.value
        if (selected != null && (model.paying.value || goldForgeGemsCanConfirm(selected, selected, model.state.value, wallet,
                paying = false, running = model.busy.value))) { frozenReview = selected; armedAtMs = System.currentTimeMillis() }
        else if (model.paying.value) walletHelp = GEMS_PAYING_REOPEN
        else explain(currentOwner().explanation ?: GEMS_WAIT)
    }
    val finish: (GoldForgeGemsCelebration?) -> Unit = { shown ->
        // Not current (another screen or the wallet is in front): keep the celebration for the next tap.
        if (isCurrent()) {
            val back = origin.takeIf { shown != null }
            if (shown != null) seenReceipt = shown.key
            if (currentOwner().canFinish) { closeSeal(); amount = ""; model.finish() }
            if (back != null) { origin = null; returnDoor?.invoke(back) }
        }
    }
    // Explicit review requests only; foreground() first when the owner may still be hidden.
    val requestReview: (Boolean) -> Unit = { saved ->
        scope.launch {
            if (ownerHidden) { ownerHidden = false; model.foreground() }
            val now = currentOwner()
            val allowed = if (saved) now.canReviewSaved else now.canReview
            if (!isCurrent()) explain(GEMS_WAIT)
            else if (!allowed) explain(now.explanation ?: GEMS_WAIT)
            else {
                requested = true; walletHelp = null
                if (saved) model.reviewSaved() else model.review(now.amountInput)
            }
        }
    }
    val actions = GemsActions(
        onMinus = { edit { cap, input -> goldForgeGemsStep(input, -1, cap) to null } },
        onPlus = { edit { cap, input -> goldForgeGemsStep(input, 1, cap) to null } },
        onQuick = { label -> edit { cap, _ -> goldForgeGemsQuickPick(label, cap, balances.state.value) } },
        onBuy = {
            if (admitted()) { val now = currentOwner(); if (now.canReview) requestReview(false) else explain(now.explanation ?: GEMS_WAIT) }
        },
        onConfirm = {
            val selected = frozenReview
            if (admitted()) {
                if (selected != null && goldForgeGemsCanConfirm(selected, model.review.value, model.state.value, wallet,
                        model.paying.value, model.busy.value)) model.pay(selected, sender)
                else explain("Review the original purchase before paying.")
            }
        },
        onBack = { if (model.paying.value) walletHelp = GEMS_PAYING_BACK else { closeSeal(); model.dismiss() } },
        // The owner has no wallet-reopen API. Recovery checks the saved request and never calls pay again.
        onReopenWallet = { if (model.paying.value) walletHelp = GEMS_PAYING_REOPEN else checkOriginal() },
        onConvert = {
            val door = convertDoor
            if (admitted()) {
                if (model.paying.value) walletHelp = GEMS_PAYING_BACK
                else if (door == null || !model.state.value.available) explain(GEMS_CONVERT_CLOSED)
                else { model.dismiss(); door() }
            }
        },
        onRetry = {
            if (admitted()) {
                if (!model.busy.value && !model.state.value.busy && !model.paying.value) model.refresh() else explain(GEMS_WAIT)
            }
        },
        onContinue = {
            if (admitted()) {
                val now = currentOwner()
                when (goldForgeGemsContinue(now, model.state.value, model.paying.value)) {
                    GoldForgeGemsContinue.RAISE_SEAL -> raiseSeal()
                    GoldForgeGemsContinue.FINISH -> finish(null)
                    GoldForgeGemsContinue.CHECK -> checkOriginal()
                    GoldForgeGemsContinue.REVIEW_SAVED -> requestReview(true)
                    GoldForgeGemsContinue.EXPLAIN -> explain(now.explanation ?: GEMS_WAIT)
                }
            }
        },
        // No embedded swap is advertised, so "Get KEEP" never shows; it would lead to the same CLAIM tab as the fallback row.
        onGetKeep = { if (admitted()) { if (model.paying.value) walletHelp = GEMS_PAYING_BACK else claimDoor() } },
        onGoClaim = { if (admitted()) { if (model.paying.value) walletHelp = GEMS_PAYING_BACK else claimDoor() } },
        onExplain = { explain(it) },
    )
    val shown = goldForgeGemsCelebrationShown(owner, seenReceipt)
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            // Never drops an in-flight payment: background() keeps a paying review and its consent.
            if (event == Lifecycle.Event.ON_STOP) { ownerHidden = true; model.background() }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.background() }
    }
    LaunchedEffect(shortfall) { shortfall?.let { origin = it.originBuildingId } }
    LaunchedEffect(review, paying, running, state) {
        if (goldForgeGemsShouldFreeze(review, frozenReview, requested, state, wallet, paying, running)) {
            frozenReview = review; armedAtMs = System.currentTimeMillis(); requested = false
        } else if (frozenReview != null && frozenReview !== review && !paying) { frozenReview = null; armedAtMs = null }
    }
    LaunchedEffect(notice) {
        val next = notice
        if (next != null && next !== announced) { announced = next; explain(next.message) }
    }
    LaunchedEffect(shown?.key) { if (shown != null) shortfallUsed() }
    BackHandlerAt(BackPriority.CONFIRM, frozenReview != null || paying) { actions.onBack() }
    BackHandlerAt(BackPriority.CONFIRM, mfa != null) { mfa?.let(sender::cancelMfa) }
    val ui = goldForgeGemsBindingUi(owner, state, onConvert != null)
    val savedRecovery: @Composable ColumnScope.() -> Unit = {
        state.saved?.let { saved ->
            GoldForgeGemsRecovery(saved, owner, review, state.feeLamports, paying, onCheck = checkOriginal,
                onCancel = {
                    if (admitted()) {
                        val now = currentOwner()
                        if (now.canAbandon) { closeSeal(); model.abandon() } else explain(now.explanation ?: GEMS_WAIT)
                    }
                },
                explanation = owner.explanation, checkEnabled = true, cancelEnabled = true)
        }
    }
    val overlay: @Composable () -> Unit = {
        GemsSeal(ui, actions)
        Box(Modifier.fillMaxSize()) {
            if (shown != null) ModalScrim(PkwTokens.Scrim.SEAL, { finish(shown) })
            // gems-sent.png: the forge's own celebration (wood frame, gem_64, gem-green ribbon, "tap to continue").
            GoldForgeCelebration(goldForgeGemsCelebrationUi(shown), ForgeCelebrationKind.GEMS, onDone = { finish(shown) },
                modifier = Modifier.align(Alignment.Center))
            walletHelp?.takeIf { paying }?.let { help ->
                // The toast zone a tall sheet leaves open (SPEC §7.8), above the Seal's scrim.
                Plate(PlateKind.CREAM, Modifier.align(Alignment.TopStart).padding(start = 8.dp, top = 10.dp).width(272.dp)) {
                    PkwText(help, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch, maxLines = 4)
                }
            }
        }
        mfa?.let { request -> SensitiveMfaDialog(request, submit = { sender.submitMfa(request, it) }, cancelRequest = { sender.cancelMfa(request) }) }
    }
    return GoldForgeGemsBinding(ui, actions, reviewOpen = frozenReview != null || paying,
        pendingBadge = if (owner.gems.pendingRecovery) 1 else 0, gain = goldForgeGemsGain(shown),
        recovery = if (ui == null && state.saved != null) savedRecovery else null, overlay = overlay)
}

/**
 * The '+n' rise beside the forge's two-row HUD stack (SPEC §5c, §7.9): green, the caption display type, rising 12 dp and
 * fading over 450 ms (reduced motion: a fade in place). Its right edge sits left of the stack (gutter + stack + gutter from
 * the screen's right edge); [row] 0 is the GEMS row, 1 the KEEP row. Paint only; null draws nothing.
 */
@Composable internal fun GoldForgeStackGain(gain: String?, row: Int, modifier: Modifier = Modifier) {
    if (gain == null) return
    val reduced = LocalReducedMotion.current
    val t = remember(gain) { Animatable(0f) }
    LaunchedEffect(gain) {
        t.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.GAIN_RISE, easing = PkwTokens.Motion.Out))
    }
    val rise: @Composable () -> Unit = {
        PkwText(gain, PkwTokens.Type.caption, Modifier.graphicsLayer {
            translationY = if (reduced) 0f else -PkwTokens.Motion.GAIN_RISE_DP * density * t.value
            alpha = 1f - t.value
        }, color = PkwTokens.Colors.green.hi, outline = 1.dp)
    }
    // Owner 2026-10-06 full-screen sheets: the forge's GEMS and KEEP pills share one row on the shelf, so the "+n" sits left
    // of that row (never on the GEMS pill); the framed (wide-window) path keeps the two-row stack geometry.
    if (gg.pixelkingdomwars.nativeclient.ui.kit.LocalFullScreenSheets.current?.active == true) {
        androidx.compose.foundation.layout.BoxWithConstraints(modifier) {
            val end = goldForgeShelfGainEndDp(maxWidth.value)
            Box(Modifier.align(Alignment.TopEnd).padding(top = gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetGeometry.SHELF_PAD_DP.dp,
                end = end.dp).height(gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetGeometry.PILL_H_DP.dp)
                .clearAndSetSemantics { }, contentAlignment = Alignment.CenterEnd) { rise() }
        }
        return
    }
    val top = HudGeometry.STACK_TOP + row.coerceIn(0, 1) * (HudGeometry.ROW_H + HudGeometry.ROW_GAP)
    Box(modifier.padding(top = top.dp, end = (HudGeometry.GUTTER + HudGeometry.STACK_W + HudGeometry.GUTTER).dp)
        .height(HudGeometry.ROW_H.dp).clearAndSetSemantics { }, contentAlignment = Alignment.CenterEnd) { rise() }
}

/** The "+n" right edge on a full-screen sheet's shelf (dp from the right of a [widthDp] wide frame): left of the forge's two
 *  pills (GEMS, wallet KEEP) and one pill gap. */
internal fun goldForgeShelfGainEndDp(widthDp: Float): Float {
    val g = gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetGeometry
    val pill = g.pillWidthDp(2, widthDp)
    return g.GUTTER_DP + 2f * pill + 2f * g.PILL_GAP_DP
}
