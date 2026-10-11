package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.GemsBuyBalances
import gg.pixelkingdomwars.nativeclient.data.GemsBuyWallet
import gg.pixelkingdomwars.nativeclient.data.KeepDepositBounds
import gg.pixelkingdomwars.nativeclient.data.SavedGemsBuy
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPill
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import gg.pixelkingdomwars.nativeclient.ui.chrome.pageInsets
import gg.pixelkingdomwars.nativeclient.ui.goldforge.GOLD_FORGE_GEMS_MAX
import gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeGemsOwnerUi
import gg.pixelkingdomwars.nativeclient.ui.goldforge.goldForgeGemsCanConfirm
import gg.pixelkingdomwars.nativeclient.ui.goldforge.goldForgeGemsMax
import gg.pixelkingdomwars.nativeclient.ui.goldforge.goldForgeGemsOwner
import gg.pixelkingdomwars.nativeclient.ui.goldforge.goldForgeGemsQuickRaw
import gg.pixelkingdomwars.nativeclient.ui.goldforge.goldForgeGemsReceiptAtEntry
import gg.pixelkingdomwars.nativeclient.ui.goldforge.goldForgeGemsStep
import gg.pixelkingdomwars.nativeclient.ui.kit.*
import gg.pixelkingdomwars.nativeclient.ui.model.CelebrationUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.*
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch

// Retained for existing presentation callers and their tests; the designed face uses receipt validation below.
internal fun gemsBuySavedPill(saved: SavedGemsBuy, paying: Boolean) = when {
    saved.observed?.receipt != null -> PaymentPill("CREDITED", PaymentTone.DONE)
    paying -> PaymentPill("WALLET OPEN", PaymentTone.SENT)
    saved.attempted -> PaymentPill("CHECK PAYMENT", PaymentTone.TROUBLE)
    else -> PaymentPill("REVIEW", PaymentTone.OPEN)
}

/** The designed face delegates every payment and recovery action to the existing purchase owner. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun GemsBuyScreen(model: GemsBuyViewModel, sender: GemsBuyWallet, balances: GemsBuyBalances,
    wallet: String, network: String, bounds: KeepDepositBounds?, onClaim: (() -> Unit)? = null,
    onConvert: (() -> Unit)? = null, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val review by model.review.collectAsState()
    val notice by model.notice.collectAsState(); val running by model.busy.collectAsState()
    val paying by model.paying.collectAsState(); val funds by balances.state.collectAsState()
    val mfa by sender.mfa.collectAsState(); val lifecycle = LocalLifecycleOwner.current.lifecycle
    var amount by rememberSaveable(wallet) { mutableStateOf("") }
    var dismissedReceipt by rememberSaveable(wallet) {
        mutableStateOf(goldForgeGemsReceiptAtEntry(model.state.value, wallet))
    }
    var frozenReview by remember(model, wallet) { mutableStateOf<GemsBuyReview?>(null) }
    var armedAtMs by remember(model, wallet) { mutableStateOf<Long?>(null) }
    var localNotice by remember(model, wallet) { mutableStateOf<String?>(null) }
    var walletHelp by remember(model, wallet) { mutableStateOf<String?>(null) }
    val scroll = rememberScrollState(); val scope = rememberCoroutineScope()
    val noticeLocation = remember { BringIntoViewRequester() }
    val detailsLocation = remember { BringIntoViewRequester() }
    val busy = running || state.busy || paying
    val selectedReview = frozenReview?.takeIf { it === review }
    val ui = goldForgeGemsOwner(state, review, wallet, funds, amount, bounds, running, paying,
        error = notice?.takeIf { it.error }?.message, sealArmedAtMs = armedAtMs.takeIf { selectedReview != null })
    val gems = ui.gems.copy(toShardsAvailable = onConvert != null && state.available && state.capability != null)
    val latestBounds by rememberUpdatedState(bounds)
    val currentUi = {
        goldForgeGemsOwner(model.state.value, model.review.value, wallet, balances.state.value, amount,
            latestBounds, model.busy.value, model.paying.value)
    }
    val active = { lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) }
    val canEdit = { active() && model.state.value.saved == null && !model.state.value.busy &&
        !model.busy.value && !model.paying.value && model.state.value.available }
    val showDetails = { scope.launch { detailsLocation.bringIntoView() }; Unit }
    val checkOriginal = { if (active() && currentUi().canCheck) model.check(); Unit }
    val closeSeal = {
        if (!model.paying.value) { frozenReview = null; armedAtMs = null; walletHelp = null }
        else walletHelp = "Complete or decline the existing request in your wallet. It stays saved here."
        Unit
    }
    val back = { if (!model.paying.value) { frozenReview = null; armedAtMs = null; model.dismiss(); onBack() }; Unit }
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) model.background() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.background() }
    }
    LaunchedEffect(model, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(); awaitCancellation() }
    }
    LaunchedEffect(review, ui.celebration?.key) {
        if (review != null) detailsLocation.bringIntoView()
        if (ui.celebration != null) scroll.scrollTo(0)
        if (frozenReview !== review && !paying) { frozenReview = null; armedAtMs = null }
    }
    LaunchedEffect(notice, localNotice) { if (notice?.error == true || localNotice != null) noticeLocation.bringIntoView() }
    BackHandlerAt(BackPriority.SCREEN) { if (frozenReview != null) closeSeal() else back() }
    BackHandlerAt(BackPriority.CONFIRM, mfa != null) { mfa?.let(sender::cancelMfa) }
    val on = GemsActions(
        onMinus = { if (canEdit()) model.state.value.capability?.let { amount = goldForgeGemsStep(currentUi().amountInput, -1, it) } },
        onPlus = { if (canEdit()) model.state.value.capability?.let { amount = goldForgeGemsStep(currentUi().amountInput, 1, it) } },
        // The chips are the designed presets inside the server bounds, then MAX (goldForgeGemsQuickChips).
        onQuick = { choice ->
            val cap = model.state.value.capability
            if (canEdit() && cap != null) {
                val raw = goldForgeGemsQuickRaw(choice, cap)
                if (raw == GOLD_FORGE_GEMS_MAX) {
                    val max = goldForgeGemsMax(balances.state.value, cap)
                    if (max != null) amount = max else localNotice = "Refresh your wallet balance before choosing MAX."
                } else if (raw != null) amount = raw
            }
        },
        onBuy = { val current = currentUi(); if (active() && current.canReview) { localNotice = null; model.review(current.amountInput) } },
        onConfirm = {
            val selected = frozenReview
            if (active() && goldForgeGemsCanConfirm(selected, model.review.value, model.state.value, wallet,
                    model.paying.value, model.busy.value)) selected?.let { model.pay(it, sender) }
        },
        onBack = closeSeal,
        // The owner has no wallet-reopen API. Recovery checks the saved request and never calls pay again.
        onReopenWallet = {
            if (model.paying.value) walletHelp = "Return to your wallet to finish the existing request. This screen will not send another request."
            else checkOriginal()
        },
        onContinue = {
            if (active()) {
                val current = currentUi()
                when {
                    current.canPay -> showDetails()
                    model.state.value.saved?.attempted == true -> checkOriginal()
                    current.canReviewSaved -> model.reviewSaved()
                    current.canCheck -> checkOriginal()
                    else -> Unit
                }
            }
        },
        onRetry = { if (active() && !model.busy.value && !model.state.value.busy && !model.paying.value) model.refresh() },
        onGoClaim = {
            if (active() && !model.paying.value) {
                if (onClaim != null) { model.dismiss(); onClaim() }
                else localNotice = "Close this purchase and choose CLAIM at the Gold Forge to see your payouts."
            }
        },
        onConvert = {
            if (active() && !model.paying.value && model.state.value.available) onConvert?.let { model.dismiss(); it() }
        },
        onExplain = { localNotice = it },
    )
    Box(Modifier.fillMaxSize().pageInsets().blockSceneInput()) {
        SheetFrame(SheetFrameUi("GOLD FORGE", null, SheetSize.FULL,
            goldForgeTabs(false, if (ui.gems.pendingRecovery) 1 else 0, false).filter { it.id == GoldForgeTabs.GEMS },
            GoldForgeTabs.GEMS), back, Modifier.fillMaxSize(), scrollState = scroll, footer = {
            if (paying) {
                PrimaryButton(if (gems.stage == gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage.CHECK_WALLET) "Check wallet" else "Sending",
                    {}, Modifier.fillMaxWidth(), state = CommandState.BUSY)
            } else if (ui.needsBalanceRefresh) {
                PrimaryButton("REFRESH CREDITED BALANCES", checkOriginal, Modifier.fillMaxWidth(),
                    state = if (ui.canCheck) CommandState.ENABLED else CommandState.BUSY)
            } else if (state.saved == null && !ui.canReview && gems.phase == GemsPhase.READY && !gems.walletShort) {
                PrimaryButton("BUY ${gems.amount} GEMS", on.onBuy, Modifier.fillMaxWidth(),
                    state = CommandState.DISABLED, reason = ui.explanation)
            } else GemsFooter(gems, on)
            if (ui.celebration != null) SecondaryButton("FINISH", {
                if (active() && currentUi().canFinish) { model.finish(); amount = ""; closeSeal() }
            }, Modifier.fillMaxWidth(), enabled = ui.canFinish)
        }) {
            (localNotice ?: notice?.message)?.let { message ->
                PkwText(message, PkwTokens.Type.body, Modifier.fillMaxWidth().bringIntoViewRequester(noticeLocation)
                    .semantics { liveRegion = LiveRegionMode.Polite }, color = if (notice?.error == true) PkwTokens.Colors.shortText else PkwTokens.Colors.textOnParch,
                    maxLines = Int.MAX_VALUE)
            }
            GemsBody(gems, on)
            ui.explanation?.let { GemsOwnerText(it) }
            if (state.saved == null) {
                Plate(PlateKind.CREAM, Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        GemsOwnerText("PURCHASE DETAILS", heading = true)
                        GemsOwnerText("Wallet: $wallet")
                        GemsOwnerText("Network: $network")
                        GemsOwnerText("${ui.gems.walletKeep} wallet KEEP. In-game KEEP is separate.")
                        OutlinedTextField(ui.amountInput, { if (canEdit()) amount = it.filter(Char::isDigit).take(32) },
                            label = { Text("Wallet KEEP to spend") }, enabled = !busy && state.available,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
                        GemsOwnerText("Review saves a quote. You see its accounts, fee and expiry before opening the BUY confirmation.")
                    }
                }
            } else {
                GoldForgeGemsRecovery(requireNotNull(state.saved), ui, review, state.feeLamports, paying,
                    onCheck = checkOriginal,
                    onCancel = { if (active() && currentUi().canAbandon) { closeSeal(); model.abandon() } },
                    modifier = Modifier.bringIntoViewRequester(detailsLocation),
                    onOpenConfirmation = {
                        val selected = model.review.value
                        if (active() && goldForgeGemsCanConfirm(selected, selected, model.state.value, wallet,
                                model.paying.value, model.busy.value)) {
                            frozenReview = selected; armedAtMs = System.currentTimeMillis()
                        }
                    })
            }
            SecondaryButton("REFRESH STATUS", {
                if (active() && !model.busy.value && !model.state.value.busy && !model.paying.value) model.refresh()
            }, Modifier.fillMaxWidth(), enabled = !busy)
        }
        GemsSeal(gems, on)
        walletHelp?.takeIf { paying }?.let { help ->
            Plate(PlateKind.CREAM, Modifier.align(Alignment.TopCenter).fillMaxWidth().padding(8.dp)) {
                GemsOwnerText(help)
            }
        }
        val celebration = ui.celebration?.takeIf { it.key != dismissedReceipt }
        if (celebration != null) ModalScrim(0.55f, { dismissedReceipt = celebration.key })
        Celebration(celebration?.let { CelebrationUi(it.key, "gem-32", "+${it.amount} GEMS", "Added to your Gems") },
            onDone = { celebration?.let { dismissedReceipt = it.key } }, modifier = Modifier.align(Alignment.Center))
    }
    mfa?.let { request -> SensitiveMfaDialog(request, submit = { sender.submitMfa(request, it) }, cancelRequest = { sender.cancelMfa(request) }) }
}

/**
 * The ORIGINAL PURCHASE plate: the saved purchase's accounts, fee, expiry and one-way terms, and its recovery buttons.
 * Shared by this route and the Gold Forge GEMS binding, which shows it only for saved states the designed face cannot act
 * on. [explanation] is the binding's owner line (the route draws its own). [onOpenConfirmation] is the route's extra step;
 * the binding raises its Seal directly and passes null. [checkEnabled] / [cancelEnabled] false paint the button off; the
 * binding keeps them on and explains a refusal instead.
 */
@Composable internal fun GoldForgeGemsRecovery(saved: SavedGemsBuy, ui: GoldForgeGemsOwnerUi, review: GemsBuyReview?,
    feeLamports: String?, paying: Boolean, onCheck: () -> Unit, onCancel: () -> Unit, modifier: Modifier = Modifier,
    explanation: String? = null, onOpenConfirmation: (() -> Unit)? = null, checkEnabled: Boolean = ui.canCheck,
    cancelEnabled: Boolean = ui.canAbandon) {
    val quote = saved.quote
    val receipt = saved.observed?.receipt
    Plate(PlateKind.CREAM, modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            GemsOwnerText("ORIGINAL PURCHASE", heading = true)
            explanation?.let { GemsOwnerText(it) }
            GemsOwnerText("Original wallet: ${saved.draft.wallet}")
            GemsOwnerText("Network: ${saved.draft.cluster}")
            GemsOwnerText("Original request: ${saved.draft.idempotencyKey}")
            quote?.let {
                GemsOwnerText("Payee · Gems reserve token account: ${it.destination}")
                GemsOwnerText("KEEP mint: ${it.mint}")
                GemsOwnerText("Source token account: ${it.source}")
                GemsOwnerText("Quote expires: ${it.expiresAt}")
            }
            saved.signature?.let { GemsOwnerText("Submitted signature: $it") }
            receipt?.let { GemsOwnerText("Settled signature: ${it.txSignature}") }
            if (quote != null && receipt == null) {
                val fee = review?.feeLamports ?: feeLamports
                GemsOwnerText("Estimated network fee: ${fee?.let { "${marketSol(it)} SOL" } ?: "review to estimate"}")
                // The a51 risk sentences, verbatim (eb01cf65 GemsBuyScreen.kt lines 82 and 112).
                GemsOwnerText("Your wallet shows its final fee. Quote expires ${quote.expiresAt}; signing closes earlier for network safety.")
                GemsOwnerText("One-way purchase. Gems stay in the game and cannot be withdrawn or converted back to KEEP.")
            }
            if (paying) GemsOwnerText("Complete the request in your wallet. Returning here never sends another payment.")
            ui.celebration?.let { GemsOwnerText("Original credit confirmed: +${it.amount} Gems, funded by ${it.fundedKeep} wallet KEEP.") }
            if (onOpenConfirmation != null && ui.canPay) SecondaryButton("OPEN BUY CONFIRMATION", onOpenConfirmation, Modifier.fillMaxWidth())
            SecondaryButton(if (receipt != null) "REFRESH CREDITED BALANCES" else "CHECK ORIGINAL PAYMENT",
                onCheck, Modifier.fillMaxWidth(), enabled = checkEnabled)
            if (!saved.attempted && receipt == null) SecondaryButton("CANCEL UNPAID REVIEW", onCancel, Modifier.fillMaxWidth(),
                enabled = cancelEnabled)
        }
    }
}

@Composable private fun GemsOwnerText(text: String, heading: Boolean = false) {
    PkwText(text, if (heading) PkwTokens.Type.label else PkwTokens.Type.body, Modifier.fillMaxWidth(),
        color = PkwTokens.Colors.textOnParch, maxLines = Int.MAX_VALUE)
}
