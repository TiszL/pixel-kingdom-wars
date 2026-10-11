package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPlate
import gg.pixelkingdomwars.nativeclient.ui.economy.DisclosurePlate
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import java.math.BigDecimal
import gg.pixelkingdomwars.nativeclient.mining.MiningClaimPreparationView
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.goldforge.*
import gg.pixelkingdomwars.nativeclient.ui.kit.Celebration
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ClaimActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ClaimSeal
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ClaimSealUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.MoneyFailure
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.WalletDetailsActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.WalletDetailsSheet
import kotlinx.coroutines.Job

fun miningClaimsEntryAvailable(state: MiningClaimsState?, storageUnavailable: Boolean = false): Boolean =
    storageUnavailable || state?.let { it.journal?.operation != null || it.journal?.archives?.isNotEmpty() == true ||
        it.status?.state?.let { status -> status != "unavailable" } == true } == true

data class MiningClaimsControls(val begin: Boolean, val review: Boolean, val sign: Boolean, val submit: Boolean,
    val check: Boolean, val finish: Boolean, val archiveRefusal: Boolean, val archiveFailed: Boolean,
    /** Dead-end audit 2026-10-06: CLOSE a request with no recovered preparation (it re-reads by key first). */
    val archiveAbsent: Boolean = false)

fun miningClaimsControls(state: MiningClaimsState, actionsAllowed: Boolean, running: Boolean = false): MiningClaimsControls {
    val available = !running && !state.busy
    val op = state.journal?.operation
    if(op?.ordered!=null){val o=op.ordered;val ordinal=nextMiningOrdinal(op);val fresh=available&&actionsAllowed&&!o.held;val unsigned=ordinal!=null&&o.signed.none{it.ordinal==ordinal}&&op.claim?.transactions?.get(ordinal)?.signature==null
        return MiningClaimsControls(false,fresh&&unsigned,fresh&&unsigned&&state.review?.claimId==op.preparation?.claimId&&state.review!=null,
            fresh&&ordinal!=null&&o.signed.any{it.ordinal==ordinal},available,available&&!o.held&&op.claim?.state=="settled",
            available&&!o.held&&op.prepareRefusal!=null&&op.preparation==null&&op.claim==null&&o.signed.isEmpty(),
            available&&!o.held&&op.claim?.state=="failed"&&(op.preparation?.transactions?.size==1||orderedFailedSetup(op)),
            available&&o==MiningOrderedCustody()&&op.prepareRefusal==null&&op.preparation==null&&op.claim==null)
    }
    val ready = state.status?.let { it.state == "ready" && it.preparationAllowed } == true
    val unsettled = op != null && op.claim?.state !in setOf("retained", "settled", "failed")
    val unsigned = unsettled && op?.signed == null && op?.preparation != null
    val freshActions = available && actionsAllowed
    return MiningClaimsControls(
        begin = freshActions && state.loaded && op == null && ready,
        review = freshActions && unsigned && ready,
        sign = freshActions && ready && unsigned && state.review?.claimId == op?.preparation?.claimId && state.review != null,
        submit = freshActions && ready && op?.signed != null && !op.submitAttempted && op.claim?.state !in setOf("retained", "settled", "failed"),
        check = available,
        finish = available && op?.claim?.state == "settled",
        archiveRefusal = available && op?.prepareRefusal != null && op.preparation == null && op.signed == null,
        archiveFailed = available && op?.claim?.state == "failed" && op.preparation?.transactions?.size == 1,
        archiveAbsent = available && op != null && op.ordered == null && op.prepareRefusal == null && op.preparation == null && op.signed == null && op.claim == null,
    )
}

fun miningClaimsDecimals(state: MiningClaimsState): Int? = state.journal?.operation?.policy?.tokenDecimals ?: state.status?.decimals

fun miningClaimsKeepAmount(baseUnits: String?, decimals: Int?): String? {
    if (baseUnits == null || decimals == null) return null
    require(decimals in 0..255 && baseUnits.matches(Regex("0|[1-9][0-9]{0,19}")))
    return BigDecimal(baseUnits).movePointLeft(decimals).stripTrailingZeros().toPlainString()
}

fun miningClaimsPhase(operation: MiningClaimsOperation): String = when {
    operation.ordered?.held==true -> "ORIGINAL OUTCOME NEEDS VERIFICATION"
    operation.ordered?.continuation!=null -> "REMAINING CLAIM QUOTE SAVED"
    operation.ordered!=null&&operation.claim?.state!="settled"&&operation.preparation?.transactions?.firstOrNull()?.kind=="setup"&&operation.claim?.transactions?.firstOrNull()?.landing=="finalized" -> "SETUP FINALIZED · KEEP NOT YET PAID"
    operation.ordered?.signingStarted?.any{n->operation.ordered.signed.none{it.ordinal==n}}==true -> "WALLET OUTCOME UNKNOWN · CHECK ORIGINAL"

    operation.claim?.state == "settled" -> "CLAIM FINALIZED"
    operation.claim?.state == "failed" -> "CLAIM FAILED · NO KEEP PAID"
    operation.claim?.state == "retained" -> "CLAIM RECORDED · FINALIZATION PENDING"
    operation.submitAttempted -> "SUBMISSION OUTCOME PENDING"
    operation.signed != null -> "WALLET APPROVED · NOT SUBMITTED"
    operation.prepareRefusal != null -> "PREPARATION REFUSED"
    operation.absenceConfirmed -> "CLOSED · NO SERVER RECORD"
    operation.preparation == null -> "PREPARATION OUTCOME UNKNOWN"
    operation.signingStarted -> "CHECK SAVED WALLET APPROVAL"
    else -> "CLAIM PREPARED · REVIEW REQUIRED"
}

/** Screen actions never replay a POST. Foreground waits for late original evidence, then only GETs. */
class MiningClaimsViewModel(private val repository: MiningClaimsRepository, val wallet: MiningClaimsWallet? = null) : ScreenViewModel() {
    val state = repository.state
    private var lastAction: Job? = null
    private fun action(block: suspend () -> Unit) = run(block).also { if (it != null) lastAction = it }
    suspend fun foreground() { lastAction?.join(); refresh()?.join() }
    fun refresh() = action { repository.awaitIdle(); repository.open() }
    fun begin(ordered:Boolean=false) = action { repository.begin(ordered) }
    fun continueOriginal()=action{repository.continueOriginal()}
    fun checkContinuation()=action{repository.checkContinuation()}
    fun useContinuation()=action{repository.useContinuation()}
    fun review() = action { repository.review() }
    fun sign() = action { repository.sign() }
    fun submit() = action { repository.submit() }
    fun finish() = action { repository.finish() }
    fun archiveRefusal() = action { repository.archiveRefusal() }
    fun archiveFailed() = action { repository.archiveFailed() }
    fun archiveAbsent() = action { repository.archiveAbsent() }
    /** Invalidates consent, without cancelling a wallet callback that must preserve its original wire. */
    fun dismiss() = repository.dismiss()
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun MiningClaimsScreen(model: MiningClaimsViewModel, actionsAllowed: Boolean, onBack: () -> Unit,
    onGoSmelt: (() -> Unit)? = null, onGoSeeker: (() -> Unit)? = null, onChangeWallet: (() -> Unit)? = null) {
    val navigation = LocalGoldForgeClaimNavigation.current
    val goSmelt = onGoSmelt ?: navigation?.onGoSmelt
    val goSeeker = onGoSeeker ?: navigation?.onGoSeeker
    val changeWallet = onChangeWallet ?: navigation?.onChangeWallet
    val state by model.state.collectAsState(); val notice by model.notice.collectAsState(); val running by model.busy.collectAsState()
    val controls = miningClaimsControls(state, actionsAllowed, running)
    val operation = state.journal?.operation; val review = state.review
    val wallet = model.wallet; val mfa = wallet?.mfa?.collectAsState()?.value
    var ordered by rememberSaveable(state.journal?.identity){mutableStateOf(false)}
    var childConsent by rememberSaveable(operation?.request?.idempotencyKey){mutableStateOf(false)}
    var showHistory by rememberSaveable(state.journal?.identity) { mutableStateOf(false) }
    var showRecovery by rememberSaveable(operation?.request?.idempotencyKey) { mutableStateOf(false) }
    var showWalletDetails by remember { mutableStateOf(false) }
    var walletDetailsIdentity by remember(model) { mutableStateOf<StarterIdentity?>(null) }
    var localNotice by remember { mutableStateOf<String?>(null) }
    var feeConsent by remember(model) { mutableStateOf<MiningClaimPreparationView?>(null) }
    var sealRequested by remember(operation?.request?.idempotencyKey) { mutableStateOf(false) }
    var walletStep by remember(operation?.request?.idempotencyKey) { mutableStateOf(false) }
    var submitting by remember(operation?.request?.idempotencyKey) { mutableStateOf(false) }
    var sealAmount by remember(operation?.request?.idempotencyKey) { mutableStateOf("…") }
    var sealRaisedAt by remember(operation?.request?.idempotencyKey) { mutableStateOf(0L) }
    val designed = goldForgeClaimOwnerUi(state, actionsAllowed, running)
    // A receipt already present on entry belongs in history; only a newly observed original pays this celebration.
    var seenReceipt by rememberSaveable(state.journal?.identity) { mutableStateOf(designed.receipt?.receiptId) }
    val celebration = designed.receipt?.takeIf { it.receiptId != seenReceipt }
    val noticeLocation = remember { BringIntoViewRequester() }
    val recoveryLocation = remember { BringIntoViewRequester() }
    val historyLocation = remember { BringIntoViewRequester() }
    val back = { model.dismiss(); onBack() }
    DisposableEffect(model) { onDispose { model.dismiss() } }
    LaunchedEffect(actionsAllowed) { if (!actionsAllowed) {
        model.dismiss(); childConsent = false; ordered = false; feeConsent = null; sealRequested = false; walletStep = false
    } }
    LaunchedEffect(operation, review, state.busy, running) {
        if (operation?.signed != null || operation?.let { op -> op.ordered?.signed?.any { it.ordinal == nextMiningOrdinal(op) } } == true ||
            operation?.claim?.state in setOf("settled", "failed")) {
            feeConsent = null; sealRequested = false; walletStep = false
        }
        if (!running && !state.busy) submitting = false
        if (review !== feeConsent && !walletStep) { feeConsent = null; sealRequested = false }
    }
    LaunchedEffect(notice, state.error, localNotice) {
        if (notice?.error == true || state.error != null || localNotice != null) noticeLocation.bringIntoView()
    }
    LaunchedEffect(showRecovery) { if (showRecovery) recoveryLocation.bringIntoView() }
    LaunchedEffect(showHistory) { if (showHistory) historyLocation.bringIntoView() }
    BackHandlerAt(BackPriority.SCREEN) { back() }
    val dismissSeal = {
        feeConsent = null; sealRequested = false; walletStep = false; model.dismiss()
    }
    val closeWalletDetails = { showWalletDetails = false; walletDetailsIdentity = null }
    val walletDetails = if (showWalletDetails) goldForgeClaimWalletDetails(state, walletDetailsIdentity) else null
    LaunchedEffect(showWalletDetails, walletDetails) {
        if (showWalletDetails && walletDetails == null) closeWalletDetails()
    }
    val readSaved = {
        if (miningClaimsControls(model.state.value, actionsAllowed, model.busy.value).check) model.refresh()
        Unit
    }
    val startReview = {
        val currentControls = miningClaimsControls(model.state.value, actionsAllowed, model.busy.value)
        if (currentControls.review) {
            feeConsent = null; sealRequested = false; walletStep = false; model.review()
        } else localNotice = "Check the saved claim before another wallet review."
        Unit
    }
    val claimActions = ClaimActions(
        onClaim = {
            // Re-evaluate the current owner at the tap; a recomposition's old primary cannot create another request.
            when (goldForgeClaimOwnerUi(model.state.value, actionsAllowed, model.busy.value).primary) {
                GoldForgeClaimIntent.PREPARE -> model.begin(ordered)
                GoldForgeClaimIntent.REVIEW -> startReview()
                GoldForgeClaimIntent.CHECK -> { showRecovery = true; readSaved() }
                GoldForgeClaimIntent.NONE -> localNotice = "Check the current allocation and saved claim first."
            }
        },
        onConfirm = {
            val current = model.state.value
            if (goldForgeClaimSealAdmitted(current.review, feeConsent,
                    miningClaimsControls(current, actionsAllowed, model.busy.value))) {
                walletStep = true
                model.sign()
            } else {
                dismissSeal(); localNotice = "The claim review changed. Review the original fees again."
            }
        },
        onBack = dismissSeal,
        onReopenWallet = {
            // OPEN AGAIN returns to the exact saved original's fresh review. It never prepares or signs by itself.
            if (model.busy.value || model.state.value.busy)
                localNotice = "The original wallet request is still open. Return to your wallet, or choose BACK to cancel waiting."
            else startReview()
        },
        onRetry = readSaved,
        onGoSmelt = { goSmelt?.invoke() ?: run { localNotice = "Open the Gold Forge on Home, then choose SMELT." } },
        onGoSeeker = { goSeeker?.invoke() ?: run { localNotice = "Open World, then Seeker Island." } },
        onDestinationDetails = {
            val current = model.state.value
            walletDetailsIdentity = current.journal?.identity
            if (goldForgeClaimWalletDetails(current, walletDetailsIdentity) != null) showWalletDetails = true
            else localNotice = "Check the current wallet's saved claims before opening its details."
        },
        onHistory = { showRecovery = false; showHistory = true },
        onExplainLock = { localNotice = designed.claim?.lock?.let { "Claims open ${it.date}. ${it.reason.orEmpty()}" }
            ?: "The server has not opened this claim window yet." },
    )
    val walletStage = when {
        submitting && (running || state.busy) -> MoneyStage.SENDING
        walletStep && state.error != null && !running && !state.busy -> MoneyStage.FAILED
        walletStep -> MoneyStage.CHECK_WALLET
        else -> MoneyStage.READY
    }
    val seal = designed.claim?.takeIf {
        actionsAllowed && mfa == null && (walletStep || submitting ||
            sealRequested && goldForgeClaimSealAdmitted(review, feeConsent, controls))
    }?.copy(stage = walletStage, seal = ClaimSealUi(sealAmount, sealRaisedAt),
        failure = if (walletStage == MoneyStage.FAILED) MoneyFailure.UNCERTAIN else null)
    BackHandlerAt(BackPriority.CONFIRM, review != null || seal != null) {
        if (walletStage != MoneyStage.SENDING) dismissSeal()
    }
    BackHandlerAt(BackPriority.CONFIRM, showWalletDetails) { closeWalletDetails() }
    BackHandlerAt(BackPriority.CONFIRM, mfa != null) { mfa?.let { wallet?.cancelMfa(it) } }
    Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
    GoldForgeClaimOwner(designed.copy(claim = designed.claim?.let { body ->
        if (seal != null) body.copy(stage = walletStage, seal = seal.seal) else body
    }), claimActions, back, onHistory = { showRecovery = false; showHistory = true },
        historyAvailable = state.journal != null, canCheck = controls.check, onCheck = readSaved, modifier = Modifier.fillMaxSize()) {
        if (state.busy || running) LinearProgressIndicator(Modifier.fillMaxWidth())
        Column(Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            localNotice?.let { Text(it, color = SurfaceInk.muted) }
            notice?.let { Text(it.message, color = if (it.error) SurfaceInk.danger else SurfaceInk.text) }
            state.error?.takeIf { it != notice?.message }?.let { Text(it, color = SurfaceInk.danger) }
        }
        if (!actionsAllowed) Text("New claims are unavailable. Saved requests and receipts can still be checked.", color = SurfaceInk.muted)
        if (operation == null && state.status?.features?.claims?.ordered == 1 && actionsAllowed) {
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Checkbox(ordered, { ordered = it }, enabled = controls.begin)
                Text("Use ordered claims. Setup may need a separate SOL fee and approval; review each transaction before signing.", Modifier.weight(1f))
            }
        }
        Column(Modifier.fillMaxWidth().bringIntoViewRequester(recoveryLocation)) {
        DisclosurePlate("SAVED CLAIM & RECOVERY", showRecovery, { showRecovery = !showRecovery }) {
        operation?.let { op ->
            MiningClaimsSavedSummary(op, "Saved claim") {
                if (op.preparation == null && op.prepareRefusal == null) Text("Check this saved request before starting another claim. Checking never submits or opens your wallet.")
                if (op.signingStarted && op.signed == null && op.claim?.state !in setOf("retained", "settled", "failed"))
                    Text("No signed transaction has been recovered. Check this request, then review it again before another wallet approval.")
                if (actionsAllowed && controls.review) Button(onClick = startReview, modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp)) {
                    Text("REVIEW CLAIM & FEES")
                }
                op.ordered?.let{o->
                    o.parent?.let{Text("Remaining claim from ${it.parentClaimId.take(8)}… · the original setup receipt stays in history.",color=SurfaceInk.muted)}
                    op.preparation?.transactions?.forEach{tx->val outcome=op.claim?.transactions?.getOrNull(tx.ordinal);val signature=o.signed.singleOrNull{it.ordinal==tx.ordinal}
                        Text("${tx.ordinal+1}. ${if(tx.kind=="setup")"Create required accounts" else "Collect KEEP"} · ${marketSol((tx.feeLamports.toBigInteger()+tx.rentLamports.toBigInteger()).toString())} SOL",style=MaterialTheme.typography.titleSmall)
                        Text(when{outcome?.landing=="finalized"&&tx.kind=="setup"->"Setup confirmed. No KEEP was paid by this transaction.";outcome?.landing=="finalized"->"KEEP payment finalized.";outcome?.landing=="failed"->"Transaction failed; keep its original receipt.";signature!=null->"Approval saved. Check the original delivery.";tx.ordinal in o.signingStarted->"No signed bytes were recovered. Check and explicitly review this same transaction before another approval.";else->"Separate review and approval required."},color=SurfaceInk.muted)
                    }
                    if(controls.submit)Button(onClick={submitting=true;model.submit()},modifier=Modifier.fillMaxWidth()){Text("DELIVER EXACT SAVED TRANSACTION")}
                    if(o.continuationRequest!=null||o.continuation!=null)OutlinedButton(onClick={model.checkContinuation()},enabled=controls.check,modifier=Modifier.fillMaxWidth()){Text("CHECK ORIGINAL CONTINUATION")}
                    val setupDone=o.parent!=null||op.claim?.transactions?.firstOrNull()?.let{it.kind=="setup"&&it.landing=="finalized"}==true
                    if(actionsAllowed&&!running&&!state.busy&&!o.held&&o.continuation==null&&setupDone&&op.claim?.state!="settled")OutlinedButton(onClick={model.continueOriginal()},modifier=Modifier.fillMaxWidth()){Text(if(o.continuationRefusal!=null)"RETRY REMAINING-CLAIM QUOTE" else if(o.continuationRequest!=null)"CHECK UNCERTAIN QUOTE REQUEST" else "REQUEST QUOTE FOR REMAINING CLAIM")}
                    o.continuation?.let{next->
                        Text("New remaining-claim quote: ${marketSol(next.childPreparation.fees.totalLamports)} SOL. The original account setup is retained; this does not repeat it.",color=SurfaceInk.goldHi)
                        Row(verticalAlignment=androidx.compose.ui.Alignment.CenterVertically){Checkbox(childConsent,{childConsent=it});Text("Use this new quote, then review its exact transaction before a new approval.",Modifier.weight(1f))}
                        Button(onClick={childConsent=false;model.useContinuation()},enabled=actionsAllowed&&!running&&!state.busy&&!o.held&&childConsent,modifier=Modifier.fillMaxWidth()){Text("USE NEW REMAINING-CLAIM QUOTE")}
                    }
                }
                if (actionsAllowed && op.signed != null && !op.submitAttempted && op.claim?.state !in setOf("retained", "settled", "failed")) Button(
                    onClick = { submitting = true; model.submit() }, enabled = controls.submit, modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp)) { Text("SUBMIT SAVED CLAIM") }
                if (op.submitAttempted && op.claim?.state !in setOf("settled", "failed")) Text("The original submission may still finalize. Checking its receipt does not send another transaction.")
                if (controls.finish) OutlinedButton(onClick = { model.finish() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("KEEP RECEIPT IN HISTORY") }
                if (controls.archiveRefusal) OutlinedButton(onClick = { model.archiveRefusal() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("ARCHIVE REFUSED REQUEST") }
                if (controls.archiveFailed) OutlinedButton(onClick = { model.archiveFailed() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK & ARCHIVE FAILED CLAIM") }
                if (controls.archiveAbsent) {
                    Text("If the server has no record of this request, CLOSE checks once more and moves it to history so you can start a new claim.", color = SurfaceInk.muted)
                    OutlinedButton(onClick = { model.archiveAbsent() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CLOSE · NO SERVER RECORD") }
                }
            }
        }
        }
        }
        state.journal?.archives?.let { archives ->
            Column(Modifier.fillMaxWidth().bringIntoViewRequester(historyLocation)) {
            DisclosurePlate("CLAIM HISTORY (${archives.size})", showHistory, { showHistory = !showHistory }) {
                if (archives.isEmpty()) Text("Archived claims and refused requests will appear here. Your current allocation stays above.", color = SurfaceInk.muted)
                archives.asReversed().forEach { archived -> key(archived.request.idempotencyKey) {
                    MiningClaimsSavedSummary(archived, "Historical claim")
                } }
            }
            }
        }
    }
    ClaimSeal(seal, claimActions)
    Celebration(celebration, onDone = { seenReceipt = celebration?.receiptId },
        modifier = Modifier.align(androidx.compose.ui.Alignment.Center))
    }
    if (walletDetails != null) Dialog(onDismissRequest = closeWalletDetails,
        properties = DialogProperties(usePlatformDefaultWidth = false)) {
        // A transparent modal boundary preserves HALF styling and blocks the claim controls beneath it,
        // including accessibility focus. Outside taps and Back close details without touching the claim owner.
        Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            ModalScrim(0f, closeWalletDetails)
            WalletDetailsSheet(walletDetails, WalletDetailsActions(onClose = closeWalletDetails,
                onPastCollections = {
                    if (goldForgeClaimWalletDetails(model.state.value, walletDetailsIdentity) != null) {
                        closeWalletDetails(); showRecovery = false; showHistory = true
                    } else {
                        closeWalletDetails(); localNotice = "The current wallet changed. Open its details again."
                    }
                },
                onChangeWallet = {
                    if (goldForgeClaimWalletDetails(model.state.value, walletDetailsIdentity) != null) {
                        closeWalletDetails()
                        changeWallet?.invoke() ?: run { localNotice = "Open Profile, then WALLET to change your wallet." }
                    } else {
                        closeWalletDetails(); localNotice = "The current wallet changed. Open its details again."
                    }
                }), Modifier.align(androidx.compose.ui.Alignment.BottomCenter).widthIn(max = 600.dp).fillMaxWidth())
        }
    }
    if (seal != null && localNotice != null) AlertDialog(onDismissRequest = { localNotice = null },
        title = { Text("SAVED CLAIM") }, text = { Text(localNotice.orEmpty()) },
        confirmButton = { TextButton(onClick = { localNotice = null }) { Text("CLOSE") } })
    if (review != null && actionsAllowed && mfa == null && !sealRequested && !walletStep && controls.sign) AlertDialog(onDismissRequest = model::dismiss,
        title = { Text("APPROVE CLAIM IN WALLET") }, text = {
            PaymentPlate("Original claim · SOL costs", art = "sol", details = listOf(PaymentDetail("Wallet", review.wallet),
                PaymentDetail("Claim", review.claimId), PaymentDetail("Request", review.idempotencyKey))) {
                Text("${marketSol(review.fees.totalLamports)} SOL", Modifier.fillMaxWidth(), style = MaterialTheme.typography.headlineSmall, color = SurfaceInk.goldHi)
                Text("Total estimated network fee and rent", color = SurfaceInk.muted)
                Text("Estimated network fee: ${marketSol(review.fees.feeLamports)} SOL")
                Text("Account rent: ${marketSol(review.fees.rentLamports)} SOL")
                Text("Claims pay the original wallet shown in Details. The finalized receipt will show the exact KEEP paid.", color = SurfaceInk.muted)
                Text("Estimate expires: ${review.expiresAt} (UTC)", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
                val ordinal=operation?.let(::nextMiningOrdinal)
                if(review.format!=null&&ordinal!=null){val tx=review.transactions[ordinal];Text("Approving ${ordinal+1} of ${review.transactions.size}: ${if(tx.kind=="setup")"account setup only — no KEEP payment" else "the KEEP claim"}.",color=SurfaceInk.goldHi);Text("This transaction: ${marketSol((tx.feeLamports.toBigInteger()+tx.rentLamports.toBigInteger()).toString())} SOL. Each remaining transaction needs its own fresh review.")}
                Text("This approval signs the exact transaction. You will deliver the saved bytes in a separate step.")
            }
        }, confirmButton = { Button(onClick = {
            val current = model.state.value
            if (current.review === review && miningClaimsControls(current, actionsAllowed, model.busy.value).sign) {
                feeConsent = review; sealAmount = goldForgeClaimOwnerUi(current, actionsAllowed, false).claim?.ready ?: "…"
                sealRaisedAt = System.currentTimeMillis(); sealRequested = true
            } else { model.dismiss(); localNotice = "The claim review changed. Check the original claim again." }
        }, enabled = controls.sign, modifier = Modifier.heightIn(min = 54.dp)) { Text("CONTINUE CLAIM") } },
        dismissButton = { TextButton(onClick = model::dismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("CANCEL REVIEW") } })
    if (mfa != null) SensitiveMfaDialog(mfa, submit = { wallet.submitMfa(mfa, it) }, cancelRequest = { wallet.cancelMfa(mfa) })
}

@Composable private fun MiningClaimsSavedSummary(operation: MiningClaimsOperation, title: String,
    actions: @Composable ColumnScope.() -> Unit = {}) {
    PaymentPlate(title, pill = miningClaimsSavedPill(operation), details = miningClaimsSavedDetails(operation)) {
        Text(miningClaimsPhase(operation), style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
        if (operation.claim?.state == "failed") Text("No KEEP was paid by the failed transaction. A network fee may apply. Archiving keeps its evidence in history; it does not retry or refund the fee.", color = SurfaceInk.muted)
        miningClaimsPaidKeep(operation)?.let {
            Text("$it KEEP paid", Modifier.fillMaxWidth(), style = MaterialTheme.typography.headlineSmall, color = SurfaceInk.goldHi)
            Text("Paid to the original wallet · historical receipt", color = SurfaceInk.muted)
        }
        actions()
    }
}
