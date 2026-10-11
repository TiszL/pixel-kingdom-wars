package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedTextField
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentActions
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.keepDepositPlan
import gg.pixelkingdomwars.nativeclient.ui.chrome.PayFailure
import gg.pixelkingdomwars.nativeclient.ui.chrome.paymentProgressLine
import gg.pixelkingdomwars.nativeclient.ui.chrome.paymentUncertain
import gg.pixelkingdomwars.nativeclient.ui.chrome.keepDepositPill

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.*
import gg.pixelkingdomwars.nativeclient.ui.attack.shortWallet
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import java.time.Instant

/** DEPOSIT N KEEP is one explicit gold tap that chains the repository's own quote and pay actions (web DepositScreen).
 * The money rules stay below this class and are unchanged: the full quote is saved before any wallet opens, `pay()`
 * persists `attempted` first and refuses a second attempt, and the store clears only an unpaid or a credited deposit
 * (an attempted one the server expired unpaid is retired by the repository alone, on its own proof: UnpaidAttempt).
 * Nothing here retries a mutation or opens a wallet from a lifecycle callback; only an ATTEMPTED deposit is polled. */
class KeepDepositViewModel(private val repository: KeepDepositRepository) : ScreenViewModel() {
    val state = repository.state
    /** True only while the explicit DEPOSIT tap is running (quote, wallet pre-flight, the wallet sheet, first check). */
    private val _paying = MutableStateFlow(false)
    val paying: StateFlow<Boolean> = _paying.asStateFlow()
    /** The DEPOSIT tap's own failure sentence (it carries the wallet's reason), shown until that deposit changes status.
     * `state.error` cannot hold it: every repository action clears it, and the check poll acts within one tick. */
    private val _payFailure = MutableStateFlow<PayFailure<Pair<String, String?>>?>(null)
    val payFailure: StateFlow<String?> = combine(_payFailure, state) { failure, s -> failure?.shownFor(mark(s)) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)
    private fun mark(s: KeepDepositState) = s.saved?.let { it.quote.id to it.receipt?.status }
    suspend fun foreground(bounds: KeepDepositBounds?) {
        repository.open(); if (!active) settle()
        if (bounds == null) { awaitCancellation() }
        var polls = 0; var ticks = 0
        while (kotlinx.coroutines.currentCoroutineContext().isActive) {
            delay(bounds.pollMs); ticks++
            val s = state.value
            if (s.uncertain && s.saved?.receipt == null && polls < POLL_BUDGET) { polls++; repository.check() }
            // Credited but its balance refresh failed: GET-only, and it is what lets the deposit close.
            else if (s.saved?.receipt?.status == "credited" && !s.hydrated && polls < POLL_BUDGET) { polls++; repository.check() }
            // The server ended an attempted deposit unpaid: GET-only and slow, until the repository can prove that
            // nothing was sent and retires it (UnpaidAttempt), so it never blocks the next deposit.
            else if (s.saved?.unpaidEnd == true && !s.paymentFound && ticks % UNPAID_END_EVERY == 0 && polls < POLL_BUDGET) { polls++; repository.check() }
            if (!active) settle()
        }
    }
    /** The gold DEPOSIT tap: quote, then straight to the wallet. Stops at the first error. */
    fun deposit(amount: String, sender: KeepDepositSender) = run {
        settle()
        if (state.value.saved != null) return@run
        repository.create(amount)
        // The chain stops at the first error: a quote that did not come back clean never opens a wallet.
        if (state.value.error == null) payIfReady(sender)
    }
    /** RETRY after a decline: the same saved quote, one explicit tap, only while the repository still says canPay. */
    fun retryPay(sender: KeepDepositSender) = run { payIfReady(sender) }
    private suspend fun payIfReady(sender: KeepDepositSender) {
        if (state.value.canPay) {
            _paying.value = true; _payFailure.value = null
            try { repository.pay(sender) } finally { _paying.value = false }
            state.value.let { s -> _payFailure.value = mark(s)?.let { mark -> s.error?.let { PayFailure(it, mark) } } }
        }
        settle()
    }
    /** Closes what the store allows, so a finished deposit never blocks the next one: a credited and refreshed one
     * (toast), or a never-attempted quote that the server ended or whose local window is over. */
    private suspend fun settle() {
        val s = state.value; val saved = s.saved ?: return
        val credited = saved.receipt?.status == "credited" && s.hydrated
        // A never-attempted quote is provably unpaid, and its window is process-local: once it is over it can never be paid.
        val ended = !saved.attempted && s.loaded && !s.busy && (saved.receipt?.status in setOf("failed", "expired") || !s.quoteFresh)
        if (!credited && !ended) return
        repository.close()
        if (state.value.saved != null || state.value.error != null) return
        if (credited) toast("DEPOSITED ${fmtN(saved.quote.amount)} KEEP")
    }
    fun create(amount: String) = run { repository.create(amount) }
    fun close() = run { repository.close() }
    fun pay(sender: KeepDepositSender) = run { repository.pay(sender) }
    fun check() = run { repository.check(); settle() }
    private companion object {
        /** Client polling budget per visit (about ten minutes at the catalogue cadence); not a game number. */
        const val POLL_BUDGET = 240
        /** An attempted deposit the server ended unpaid is re-checked every this many ticks (about 30 s); not a game number. */
        const val UNPAID_END_EVERY = 12
    }
}

/** Web menu.tsx DepositScreen: PLAY BALANCE chip, the whole-KEEP amount plate with +100 / +1K / CLEAR, one gold
 * DEPOSIT button that goes straight to the wallet, then it confirms and closes by itself. The ON-CHAIN KEEP chip
 * reads the wallet page's own `/wallet/balances` field (`economy`, GET only — no client RPC). */
@Composable fun KeepDepositScreen(model: KeepDepositViewModel, sender: KeepDepositWallet, wallet: String,
    bounds: KeepDepositBounds?, onBack: () -> Unit, economy: EconomyRepository? = null) {
    val state by model.state.collectAsState()
    val paying by model.paying.collectAsState()
    val payFailure by model.payFailure.collectAsState()
    val running by model.busy.collectAsState()
    val mfa by sender.mfa.collectAsState()
    val funds = economy?.state?.collectAsState()?.value
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var amount by rememberSaveable(wallet) { mutableStateOf("") }
    val saved = state.saved
    val status = saved?.receipt?.status
    val busy = state.busy || running
    BackHandlerAt(BackPriority.SCREEN) { onBack() }
    BackHandlerAt(BackPriority.CONFIRM, mfa != null) { mfa?.let { sender.cancelMfa(it) } }
    LaunchedEffect(model, bounds, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(bounds) }
    }
    // The wallet page's read, refreshed on entry and after a credited deposit changes both balances.
    LaunchedEffect(economy, lifecycle, status, saved == null) {
        economy ?: return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try { economy.refresh(EconomyPage.WALLET) } catch (c: kotlinx.coroutines.CancellationException) { throw c } catch (_: Exception) { /* state.errors carries the read failure */ }
        }
    }
    // A finished deposit clears the amount, so a second tap can never repeat it by accident.
    var hadSaved by remember { mutableStateOf(false) }
    LaunchedEffect(saved != null) { if (saved != null) hadSaved = true else if (hadSaved) { hadSaved = false; amount = "" } }
    val chainKeep = onChainKeep(funds?.wallet)
    DesignedPage("DEPOSIT KEEP", onBack) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            HudChip("keep", "PLAY BALANCE", funds?.balances?.keep?.let(::fmtN) ?: "…", Modifier.weight(1f), kind = "keep")
            HudChip("sol", "IN YOUR WALLET", chainKeep?.let { if (it == "UNAVAILABLE") it else fmtN(it) } ?: "…", Modifier.weight(1f),
                valueColor = if (chainKeep == null || chainKeep == "UNAVAILABLE") SurfaceInk.faint else SurfaceInk.goldHi)
        }
        funds?.errors?.get("/wallet/balances")?.let { Notice("$it The wallet amount may be out of date.", NoticeKind.WARN) }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        // The DEPOSIT tap's failure sentence, exactly as the repository worded it; it outlives the polls that clear state.error.
        payFailure?.let { DismissableNotice(it, true) }
        state.error?.takeIf { it != payFailure }?.let { DismissableNotice(it, true) }
        state.notice?.let { DismissableNotice(it, false) }
        if (bounds == null) Notice("Update the game content to deposit. Nothing is lost.", NoticeKind.WARN)
        if (saved == null) {
            val editable = state.loaded && !busy && bounds != null
            PixelPlate("shard", Modifier.fillMaxWidth(), PaddingValues(10.dp)) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("HOW MUCH KEEP?", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint)
                    OutlinedTextField(amount, { input -> if (input.length <= 40) amount = input }, Modifier.fillMaxWidth(), enabled = editable,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 32.sp), placeholder = { Text("0", fontSize = 32.sp) },
                        leadingIcon = { GameArt("keep", Modifier.size(24.dp)) }, singleLine = true,
                        isError = amount.isNotEmpty() && bounds?.let { runCatching { it.amount(amount) }.isFailure } == true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                    if (amount.isNotEmpty() && bounds != null) runCatching { bounds.amount(amount) }.exceptionOrNull()?.let { Text(it.message?.uppercase() ?: "ENTER A VALID WHOLE KEEP AMOUNT", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.danger) }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(100L to "+100", 1_000L to "+1K").forEach { (delta, label) ->
                            OutlinedButton(onClick = { bounds?.let { b -> keepDepositShortcut(amount, delta, b.maximum)?.let { amount = it } } }, Modifier.weight(1f), enabled = editable,
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 6.dp)) { Text(label) }
                        }
                        OutlinedButton(onClick = { amount = "" }, Modifier.weight(1f), enabled = editable && amount.isNotEmpty(), contentPadding = PaddingValues(horizontal = 8.dp, vertical = 6.dp)) { Text("CLEAR") }
                    }
                }
            }
            Button(onClick = { model.deposit(amount, sender) }, modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp), enabled = editable && bounds?.let { runCatching { it.amount(amount) }.isSuccess } == true) {
                GameArt("keep", Modifier.size(20.dp)); Text(if (busy) "GETTING READY…" else bounds?.let { runCatching { "DEPOSIT ${fmtN(it.amount(amount))} KEEP" }.getOrNull() } ?: "DEPOSIT KEEP")
            }
            Text("YOUR WALLET ASKS YOU TO APPROVE. IT ALSO PAYS A SMALL SOL NETWORK FEE.", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint)
        } else {
            val quote = saved.quote
            val keepAmount = fmtN(quote.amount)
            val plan = keepDepositPlan(status, saved.attempted, state.canPay, bounds != null, busy, state.hydrated, keepAmount, paying)
            // The same plate as market and base purchases: KEEP hero line, one status line, identifiers under DETAILS.
            PaymentPlate("KEEP DEPOSIT", art = "keep", pill = keepDepositPill(status, saved.attempted, paymentUncertain(saved.attempted, saved.signature != null, paying)),
                amount = keepAmount, unit = "KEEP", amountArt = "keep", feeLine = state.feeLamports?.let { "NETWORK FEE ≈ ${marketSol(it)} SOL" } ?: "+ SMALL SOL NETWORK FEE",
                actions = plan.actions, detailActions = plan.detailActions,
                onAction = { when (it) { PaymentActions.PAY -> model.retryPay(sender); PaymentActions.CHECK -> model.check(); PaymentActions.FINISH, PaymentActions.CLOSE -> model.close() } },
                details = listOfNotNull(
                    PaymentDetail("Deposit", quote.id), PaymentDetail("Reference", quote.reference), PaymentDetail("Wallet", quote.wallet),
                    PaymentDetail("From token account", quote.source), PaymentDetail("To custody token account", quote.destination),
                    PaymentDetail("Mint", quote.mint), PaymentDetail("Network", quote.cluster),
                    saved.signature?.let { PaymentDetail("Transaction", it) })) {
                when (status) {
                    "credited" -> Text("DEPOSITED $keepAmount KEEP.", style = PkwType.readable, color = SurfaceInk.success)
                    // An attempted deposit the server ended unpaid clears by itself once nothing can have been sent;
                    // support is only for a transfer the server received (`failed`) or one the network does know.
                    "failed", "expired" -> if (!saved.attempted) Text("DEPOSIT ENDED — NOTHING WAS SENT.", style = PkwType.readable, color = SurfaceInk.muted)
                        else if (saved.unpaidEnd && !state.paymentFound) Text(UnpaidAttempt.CHECKING_DEPOSIT, style = PkwType.readable, color = SurfaceInk.muted)
                        else Notice("This deposit ended while your payment was being checked. Contact support@pixelkingdomwars.com with the deposit under DETAILS before sending again.", NoticeKind.WARN)
                    else -> paymentProgressLine(true, saved.attempted, saved.signature != null, paying)?.let { Text(it, style = PkwType.readable, color = SurfaceInk.goldHi) }
                }
            }
        }
    }
    mfa?.let { request -> SensitiveMfaDialog(request, submit = { sender.submitMfa(request, it) }, cancelRequest = { sender.cancelMfa(request) }) }
}
