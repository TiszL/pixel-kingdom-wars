package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.attack.shortWallet
import androidx.compose.ui.text.style.TextOverflow
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedTextField
import gg.pixelkingdomwars.nativeclient.ui.chrome.FilterChip
import gg.pixelkingdomwars.nativeclient.ui.chrome.Switch
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.ForgeScene
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.data.EconomyPage
import gg.pixelkingdomwars.nativeclient.data.SecurityWalletConfirmation
import gg.pixelkingdomwars.nativeclient.data.WithdrawalAuthorization
import gg.pixelkingdomwars.nativeclient.data.WithdrawalReview
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.*
import gg.pixelkingdomwars.nativeclient.ui.Notice
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.land.LandNotice
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.awaitCancellation
import java.time.Instant
import java.math.BigDecimal

/** Wallet observations remain reachable without a deed; each spend requires negotiated recovery. */
@Composable fun EconomyScreen(model: EconomyViewModel, referrals: ReferralViewModel, claims: ForgeClaimsViewModel, unwind: WithdrawalUnwindViewModel, wallet: String, baseId: String?, landOwned: Boolean, keepConfirm: KeepConfirmPreference,
    confirmations: SecurityWalletConfirmation, onDeposit: () -> Unit, onShop: () -> Unit, onMarket: () -> Unit, onFaucet: () -> Unit, onBack: () -> Unit, initialPage: EconomyPage = EconomyPage.WALLET, catalogue: kotlinx.serialization.json.JsonObject? = null,
    /** The land gate (web: the 402 prompt); a landless player on a gated page reaches it from the gold BUY LAND notice. */
    onBuyLand: (() -> Unit)? = null, onGems: (() -> Unit)? = null, gemsPending: Boolean = false, onWorkshop: (() -> Unit)? = null, onOrdinaryCrafting: (() -> Unit)? = null,
    onStarterFleet: (() -> Unit)? = null, onStarterExpeditions: (() -> Unit)? = null, onHarvesters: (() -> Unit)? = null, miningContributionEntry: (@Composable () -> Unit)? = null) {
    val state by model.state.collectAsState()
    val clipboard = LocalClipboardManager.current
    var shareNotice by remember(wallet) { mutableStateOf<String?>(null) }
    val notice by model.notice.collectAsState()
    val busy by model.busy.collectAsState()
    val review by model.review.collectAsState()
    val withdrawalReview by model.withdrawalReview.collectAsState()
    val mfa by confirmations.mfa.collectAsState()
    val interrupted by model.interrupted.collectAsState()
    val pending = interrupted.filter { it.kind in setOf(IntentKind.KEEP_CONVERSION, IntentKind.FORGE_CONTRIBUTION, IntentKind.WITHDRAWAL) }
    val keepSpend = rememberKeepSpendConfirm(keepConfirm)
    var pageName by rememberSaveable(initialPage) { mutableStateOf(initialPage.name) }
    val page = EconomyPage.valueOf(pageName)
    var forgeTab by rememberSaveable(wallet, baseId) { mutableStateOf(ForgeTab.DEPLOY) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val uri = LocalUriHandler.current
    BackHandlerAt(BackPriority.SCREEN) { onBack() }
    BackHandlerAt(BackPriority.CONFIRM, review != null || withdrawalReview != null || keepSpend.pending != null) { model.dismissReview(); keepSpend.cancel() }
    LaunchedEffect(wallet, baseId) { model.dismissReview(); keepSpend.cancel() }
    LaunchedEffect(review) {
        review?.takeIf { it.action == EconomyAction.CONVERT }?.let { frozen ->
            model.dismissReview()
            keepSpend.confirm(KeepSpendIntent(frozen.amount,
                "CONVERT INTO SHARDS FOR ${frozen.baseId?.let { "KINGDOM $it" } ?: "YOUR WALLET"}. CURRENT RATE: ${frozen.rate} SHARDS PER KEEP; THE RATE AT PROCESSING SETS THE OUTPUT. THIS CANNOT BE REVERSED",
                immediate = false, alwaysReview = true) { model.confirm(frozen) })
        }
    }
    LaunchedEffect(model, page, baseId, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(page); awaitCancellation() }
    }
    LaunchedEffect(model, page, forgeTab, baseId, lifecycle) {
        if (page == EconomyPage.FORGE && forgeTab == ForgeTab.CYCLE)
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.refreshGlobal(); awaitCancellation() }
    }
    val paths = when (page) {
        EconomyPage.WALLET -> listOf("/balances", "/wallet/balances")
        EconomyPage.FORGE -> listOf("/balances", "/forge", "/forge/allocations")
        EconomyPage.WITHDRAWALS -> listOf("/withdrawals", "/withdrawals/status", "/2fa/status")
        EconomyPage.OVERVIEW -> listOf("/economy/stats")
        EconomyPage.SUPPORT -> listOf("/devnet-faucet/status", "/referrals/code")
    }
    // Second old-screen sweep (owner 2026-10-06): the designed page replaces the dark page and its header (the Gold Forge
    // LEGACY "wallet sends", CLAIM / SMELT controls, Supplies ECONOMY and the referral doors all land here).
    DesignedPage(when (page) {
            EconomyPage.WALLET -> "KEEP WALLET"
            EconomyPage.FORGE -> "GOLD FORGE${state.forge?.takeIf { state.baseId == baseId }?.let { if (it.level > 0) " · L${it.level}" else " · NOT BUILT" } ?: ""}"
            EconomyPage.WITHDRAWALS -> "WITHDRAW KEEP"
            EconomyPage.OVERVIEW -> "KEEP ECONOMY"
            EconomyPage.SUPPORT -> "FAUCET & REFERRALS"
        }, onBack) {
        if (page == EconomyPage.FORGE) PlateTabs(ForgeTab.entries.map { it to it.label }, forgeTab) { forgeTab = it }
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            if (page != EconomyPage.WALLET) TextButton(onClick = { pageName = EconomyPage.WALLET.name }) { GameArt("keep", Modifier.size(18.dp)); Text("‹ KEEP WALLET") }
            else Spacer(Modifier.weight(1f))
            TextButton(onClick = {
                if (page == EconomyPage.FORGE && forgeTab == ForgeTab.CYCLE) model.refreshGlobal(state.forgeGlobalDay) else model.refresh(page)
            }, enabled = !state.loading && !state.forgeGlobalLoading && !busy) { Text("REFRESH") }
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        notice?.let { DismissableNotice(it.message, it.error, model::dismissNotice) }
        InterruptedBanner(pending, busy, model::check, { kind -> model.close(kind) }, {})
        state.accepted?.let { accepted -> EconomyCard("CONFIRMED ${accepted.action.title.uppercase()}", art = "keep") {
            Text("Original kingdom: ${accepted.baseId ?: "wallet balance"}")
            if (accepted.action == EconomyAction.CONVERT) Text("${accepted.amount} KEEP converted to ${accepted.outputShards} SHARDS · accepted rate ${accepted.rate}")
            else Text("${accepted.amount} SHARDS accepted for cycle ${accepted.day}. Allocation and payout are tracked separately.")
        } }
        // A landless player on a gated page sees one gold gate with BUY LAND; stale reads are a caution, never red.
        val readNotices = economyReadNotices(page, landOwned, paths, state.errors)
        readNotices.gate?.let { LandNotice(it, onBuyLand?.let { open -> "BUY LAND" to open }) }
        readNotices.stale.forEach { Notice(it) }
        when (page) {
            EconomyPage.WALLET -> {
                val funds = state.balances?.takeIf { state.baseId == baseId }
                val chain = state.wallet
                if (onGems != null && (funds?.features?.gems?.supported == true || gemsPending))
                    PlateRow(if (funds?.features?.gems?.supported == true) "GEMS WALLET" else "RECOVER SAVED GEMS REQUEST", "gem", note = "${funds?.gems ?: "…"} GEMS · LEDGER CONVERSIONS & TASKS", onClick = onGems)
                onWorkshop?.let { open ->
                    PlateRow("WORKSHOP & RECEIPTS", "shard", note = "REFINE SHARDS · COLLECT INGOTS · ORIGINAL REQUEST HISTORY", onClick = open)
                }
                onOrdinaryCrafting?.let { open ->
                    OutlinedButton(onClick = open, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("ORDINARY REFINING & RECEIPTS") }
                }
                onStarterFleet?.let { open ->
                    OutlinedButton(onClick = open, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("STARTER FLEET & RECEIPTS") }
                }
                onStarterExpeditions?.let { open ->
                    OutlinedButton(onClick = open, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("STARTER EXPEDITIONS & RETURNS") }
                }
                onHarvesters?.let { open ->
                    OutlinedButton(onClick = open, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("HARVESTERS & EARNING HISTORY") }
                }
                // Web wallet.tsx: the HUD's three chips, in-game first (deposits credit the KEEP balance), then the chain read.
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    HudChip("keep", "KEEP", funds?.keep?.let(::fmtN) ?: "…", Modifier.weight(1f), kind = "keep")
                    HudChip("shards", "SHARDS", funds?.shards?.let(::fmtN) ?: "…", Modifier.weight(1f))
                }
                KeepConversionPanel(funds, state.keepRate, wallet, baseId,
                    state.baseId == baseId && state.conversionSupported && !busy && !state.loading && pending.none { it.kind == IntentKind.KEEP_CONVERSION }, model::prepare)
                Text("KEEP — Pixel Kingdom Gold — is the kingdom currency. Earn it in-game; move it on-chain.", color = SurfaceInk.faint, style = MaterialTheme.typography.labelSmall)
                ForgeSection("BUY KEEP WITH SOL", art = "sol") {
                    Text("TEMPORARILY UNAVAILABLE · RESERVE-BACKED SALES ARE BEING PREPARED. NO SOL PAYMENT WILL BE REQUESTED.", color = SurfaceInk.muted, style = MaterialTheme.typography.labelSmall)
                }
                PlateRow("DEPOSIT KEEP ← WALLET", "keep", note = "MOVE WALLET KEEP INTO THE GAME", onClick = onDeposit)
                PlateRow("WITHDRAW KEEP → WALLET", "sol", note = "ESCROW, THEN ON-CHAIN PAYOUT", onClick = { pageName = EconomyPage.WITHDRAWALS.name })
                PlateRow("GOLD FORGE", "streak", note = "DEPLOY SHARDS · POUR KEEP", onClick = { pageName = EconomyPage.FORGE.name })
                PlateRow("KEEP ECONOMY", "trophy", note = "SUPPLY & FLOWS", onClick = { pageName = EconomyPage.OVERVIEW.name })
                PlateRow("COLLECTION & MARKET", "shards", note = "ITEM MARKET · LAND DEEDS", onClick = onMarket)
                PlateRow("SHOP", "shop", onClick = onShop)
                PlateRow("FAUCET & REFERRALS", "referral", onClick = { pageName = EconomyPage.SUPPORT.name })
                ForgeSection("CONNECTED WALLET", note = shortWallet(wallet), art = "settings") { Selectable(wallet) }
                ForgeSection("ON-CHAIN BALANCES", note = chain?.let { "SERVER READ" }, art = "sol") {
                    Text("On-chain balances of your connected wallet. In-game KEEP and SHARDS live above.", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint)
                    if (chain == null) EmptyPlate(if (state.loading) "READING THE CHAIN…" else "NO SERVER READ YET — REFRESH.")
                    else {
                        HudChip("sol", "SOL", chain.sol ?: "UNAVAILABLE", note = "GAME CLUSTER", valueColor = if (chain.sol != null) SurfaceInk.goldHi else SurfaceInk.faint)
                        chain.tokens.forEach { (symbol, value) ->
                            HudChip(if (symbol.equals("KEEP", true)) "keep" else "star", symbol, value ?: "UNAVAILABLE",
                                kind = if (symbol.equals("KEEP", true)) "keep" else "shard", note = if (value == null) "UNAVAILABLE — REFRESH" else null,
                                valueColor = if (value != null) SurfaceInk.goldHi else SurfaceInk.faint)
                        }
                        Text("Server read: ${Instant.ofEpochMilli(chain.asOf)}", color = SurfaceInk.faint, style = MaterialTheme.typography.labelSmall)
                    }
                    OutlinedButton(onClick = { runCatching { uri.openUri("https://jup.ag") }.onFailure { model.linkFailed() } }, modifier = Modifier.fillMaxWidth()) { Text("OPEN JUPITER IN BROWSER ↗") }
                    Text("Jupiter is a separate exchange. In-game KEEP and SHARDS are not wallet token balances.", color = SurfaceInk.faint, style = MaterialTheme.typography.labelSmall)
                }
            }
            EconomyPage.FORGE -> {
                miningContributionEntry?.invoke()
                ForgeClaimsPanel(claims, wallet, baseId, if (landOwned) baseId else null,
                    state.allocations?.takeIf { state.baseId == baseId && state.allocationBaseId == (if (landOwned) baseId else null) && state.forgeReady && !state.loading }, showDays = forgeTab == ForgeTab.LEDGER,
                    nextExpiresAt = state.forge?.takeIf { state.baseId == baseId }?.expiresAt)
                if (state.baseId == baseId) when (forgeTab) {
                    ForgeTab.DEPLOY -> state.forge?.let { forge -> ForgeDeploy(forge, wallet, baseId,
                        state.contributionSupported && !busy && !state.loading && pending.none { it.kind == IntentKind.FORGE_CONTRIBUTION }, catalogue, model::prepare) }
                        ?: Text(if (state.loading) "LOADING THE GOLD FORGE…" else "A Land Deed and an available Gold Forge unlock new contributions. Saved allocation claims remain above.", color = SurfaceInk.muted)
                    ForgeTab.LEDGER -> state.allocations?.let { allocations -> ForgeLedger(allocations, !state.loading) { model.moreAllocations() } }
                    ForgeTab.CYCLE -> ForgeGlobalPanel(state.forgeGlobal, state.forgeGlobalDay, state.forgeGlobalLoading, state.forgeGlobalError,
                        { model.refreshGlobal(it) }, { model.moreGlobal() })
                }
            }
            EconomyPage.WITHDRAWALS -> {
                state.confirmedWithdrawal?.let { confirmed -> EconomyCard("WITHDRAWAL ACCEPTED", art = "keep") {
                    Text("${confirmed.quote.gross} KEEP entered withdrawal escrow. This does not yet confirm a payout.")
                    Selectable("Request: ${confirmed.withdrawalId}")
                    Text("Original network: ${confirmed.quote.cluster}"); Selectable("Original mint: ${confirmed.quote.mint}")
                    Text("Original maturity: ${confirmed.unbondsAt}.")
                    val lifecycleRow = state.withdrawals?.find { it.id == confirmed.withdrawalId }
                    Text(if (lifecycleRow == null) "Current payout status is unavailable in the returned history. Escrow acceptance does not imply a sent or refunded payout."
                        else "Current lifecycle: ${lifecycleRow.status}. See the history below for payout details.")
                } }
                state.allowance?.let { limit ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        HudChip("keep", "REMAINING TODAY", "${fmtN(limit.remaining)} KEEP", Modifier.weight(1f), kind = "keep")
                        HudChip("timer", "DAILY LIMIT", "${fmtN(limit.limit)} KEEP", Modifier.weight(1f))
                    }
                    Text("USED ${fmtN(limit.used)} KEEP · GOVERNING KEEP LEVEL ${limit.governingLevel}${limit.nextAt?.let { " · NEXT $it" } ?: ""}", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint)
                }
                if (state.withdrawalSupported && state.allowance != null) ForgeSection("WITHDRAW KEEP", gold = true, art = "sol") {
                    WithdrawalForm(wallet, baseId, state.instantEligible,
                        !busy && !state.loading && pending.none { it.kind == IntentKind.WITHDRAWAL }, model::prepareWithdrawal)
                } else Text("New withdrawals require a Land Deed and server recovery support. Existing history stays available.", color = SurfaceInk.faint, style = MaterialTheme.typography.labelSmall)
                Text("WITHDRAWAL HISTORY", style = MaterialTheme.typography.labelMedium, color = SurfaceInk.gold)
                state.withdrawals?.let { rows ->
                    if (rows.isEmpty()) EmptyPlate("NO WITHDRAWALS YET.")
                    rows.forEach { row -> EconomyCard("${row.gross} KEEP", note = row.status.uppercase(), art = "sol") {
                        Text("Net ${row.net} KEEP · fee ${row.fee} KEEP", style = MaterialTheme.typography.bodySmall); Selectable("Destination: ${row.destination}")
                        Text("Requested ${row.createdAt}", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted); row.unbondsAt?.let { Text("Unbonds $it", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted) }
                        row.completedAt?.let { Text("Completed $it", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted) }; row.mint?.let { Selectable("Mint: $it") }
                        row.signature?.let { Selectable("Transaction: $it") }
                    } }
                }
                WithdrawalUnwindPanel(unwind, wallet, baseId) { model.refresh(EconomyPage.WITHDRAWALS) }
            }
            EconomyPage.OVERVIEW -> state.totals?.metrics?.groupBy { it.currency }?.forEach { (currency, metrics) ->
                EconomyCard(currency.uppercase(), art = if (currency.equals("KEEP", true)) "keep" else "shards") { metrics.forEach { ForgeStat(it.label.uppercase(), "${fmtN(it.amount)} $currency") } }
            }
            EconomyPage.SUPPORT -> {
                state.faucet?.let { faucet -> ForgeSection("DEVNET SOL FAUCET", art = "sol",
                    note = if (!faucet.enabled) "DISABLED" else if (faucet.eligible) "ELIGIBLE" else faucet.reason.replace('_', ' ').uppercase()) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        HudChip("sol", "GRANT", "${faucet.grantSol} SOL", Modifier.weight(1f), valueColor = if (faucet.eligible) SurfaceInk.success else SurfaceInk.goldHi)
                        HudChip("star", "RECEIVED", "${faucet.grantedSol} / ${faucet.lifetimeCapSol}", Modifier.weight(1f), note = "LIFETIME CAP")
                    }
                    Text(if (!faucet.enabled) "The faucet is disabled." else if (faucet.eligible) "Your wallet is eligible for a grant." else "Status: ${faucet.reason.replace('_', ' ')}", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
                    faucet.nextAt?.let { ForgeStat("NEXT ELIGIBLE", it) }
                    faucet.last?.let { last -> ForgeStat("LAST GRANT", "${last.status.uppercase()} · ${last.lamports} LAMPORTS"); last.signature?.let { Selectable(it) }; last.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = SurfaceInk.danger) } }
                    PlateRow("OPEN FAUCET & REQUEST STATUS", "sol", accent = true, onClick = onFaucet)
                } }
                state.referrals?.let { referral -> ForgeSection("YOUR REFERRAL CODE", art = "referral", gold = true) {
                    PixelPlate("keep", Modifier.fillMaxWidth(), PaddingValues(horizontal = 12.dp, vertical = 10.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            GameArt("referral", Modifier.size(22.dp))
                            SelectionContainer(Modifier.weight(1f)) { Text(referral.code, style = MaterialTheme.typography.titleLarge, color = SurfaceInk.goldHi, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = {
                            shareNotice = runCatching { clipboard.setText(AnnotatedString(referral.code)); "Referral code copied" }
                                .getOrElse { "Copy failed. Long-press the referral code." }
                        }, modifier = Modifier.weight(1f)) { Text("COPY CODE") }
                        Button(onClick = {
                            shareNotice = runCatching { clipboard.setText(AnnotatedString(referralShareUrl(referral.code))); "Referral link copied" }
                                .getOrElse { "Could not copy the referral link. Try again." }
                        }, modifier = Modifier.weight(1f)) { Text("SHARE LINK") }
                    }
                    shareNotice?.let { DismissableNotice(it) }
                    ForgeStat("ACTIVE MINING BONUS", "${BigDecimal(referral.bonusBps).movePointLeft(2)}%", true)
                    ForgeStat("PER QUALIFIED REFERRAL", "${BigDecimal(referral.perReferralBps).movePointLeft(2)}%")
                    Text("Share this code with another player.", color = SurfaceInk.faint, style = MaterialTheme.typography.labelSmall)
                } }
                ReferralPanel(referrals, wallet)
            }
        }
        }
    }
    review?.takeIf { it.action == EconomyAction.CONTRIBUTE }?.let { frozen ->
        AlertDialog(onDismissRequest = model::dismissReview, title = { Text("Contribute ${frozen.amount} SHARDS?") },
            text = { Text("Kingdom: ${frozen.baseId ?: "wallet balance"}. These SHARDS enter the UTC cycle active at server acceptance, which may be the next cycle if midnight passes. Any KEEP allocation is determined by the server after settlement.") },
            confirmButton = { TextButton(onClick = { model.confirm(frozen) }, enabled = !busy) { Text("Contribute") } },
            dismissButton = { TextButton(onClick = model::dismissReview) { Text("Cancel") } })
    }
    KeepSpendConfirmDialog(keepSpend)
    withdrawalReview?.let { frozen -> WithdrawalConfirm(frozen, busy, model::dismissReview) { code ->
        model.confirmWithdrawal(frozen, code) { intent -> WithdrawalAuthorization(confirmations.authorizeWithdrawal(intent)) }
    } }
    mfa?.let { SensitiveMfaDialog(it, confirmations) }
}

@Composable private fun WithdrawalForm(wallet: String, baseId: String?, instantEligible: Boolean, enabled: Boolean,
    prepare: (String, String, Boolean) -> Unit) {
    var amount by rememberSaveable(wallet, baseId) { mutableStateOf("") }
    var destination by rememberSaveable(wallet, baseId) { mutableStateOf(wallet) }
    var instant by rememberSaveable(wallet, baseId) { mutableStateOf(false) }
    LaunchedEffect(instantEligible) { if (!instantEligible) instant = false }
    OutlinedTextField(amount, { if (it.length <= 32) amount = it }, label = { Text("Gross KEEP amount") }, enabled = enabled,
        singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
    OutlinedTextField(destination, { if (it.length <= 44) destination = it }, label = { Text("Destination Solana wallet") }, enabled = enabled,
        singleLine = true, modifier = Modifier.fillMaxWidth())
    if (instantEligible) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Switch(instant, { instant = it }, enabled = enabled); Text("Request instant withdrawal")
    } else Text("Standard withdrawal. Instant mode requires an eligible PKW authenticator and an available payout service.", color = SurfaceInk.muted)
    Button(onClick = { prepare(amount, destination, instant) }, enabled = enabled && amount.isNotEmpty() && destination.isNotEmpty()) { Text("Review withdrawal") }
}

@Composable private fun WithdrawalConfirm(review: WithdrawalReview, busy: Boolean, dismiss: () -> Unit, confirm: (String) -> Unit) {
    var code by remember(review) { mutableStateOf("") }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, review) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) code = "" }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer); code = "" }
    }
    val quote = review.quote
    AlertDialog(onDismissRequest = dismiss, title = { Text("Confirm withdrawal") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Gross ${quote.gross} KEEP · fee ${quote.fee} KEEP · net ${quote.net} KEEP")
            Selectable("Destination: ${quote.destination}"); Text("Network: ${quote.cluster}"); Selectable("Mint: ${quote.mint}")
            Text(if (quote.instant) "Instant processing requested; payout completion is tracked separately." else "Unbonding hold: ${quote.hours} hours before payout processing.")
            Text("Your wallet will sign these exact details. The request is sent once; interrupted results can be checked from this screen.")
            if (quote.instant) OutlinedTextField(code, { if (it.length <= 8) code = it }, label = { Text("Current PKW authenticator code") },
                singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword))
        }
    }, confirmButton = { TextButton(enabled = !busy && (!quote.instant || code.matches(Regex("[0-9]{6,8}"))), onClick = {
        val ephemeral = code; code = ""; confirm(ephemeral)
    }) { Text("Confirm with wallet") } }, dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } })
}

@Composable private fun EconomyActionForm(action: EconomyAction, wallet: String, baseId: String?, enabled: Boolean,
    review: (EconomyAction, String) -> Unit) {
    var amount by rememberSaveable(wallet, baseId, action) { mutableStateOf("") }
    OutlinedTextField(amount, { if (it.length <= 32) amount = it }, enabled = enabled, singleLine = true,
        label = { Text(if (action == EconomyAction.CONVERT) "KEEP amount" else "SHARDS amount") },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
    Button(onClick = { review(action, amount) }, enabled = enabled && amount.isNotEmpty()) { Text("Review ${action.title.lowercase()}") }
}

@Composable private fun EconomyCard(title: String, note: String? = null, art: String? = null, content: @Composable ColumnScope.() -> Unit) =
    TitledPlate(title, note = note, art = art, content = content)
@Composable private fun Selectable(text: String) { SelectionContainer { Text(text, style = MaterialTheme.typography.bodySmall) } }

private enum class ForgeTab(val label: String) { DEPLOY("DEPLOY"), LEDGER("MY LEDGER"), CYCLE("THIS CYCLE") }

/** Web Panel9 section on the riveted plate; `gold` marks the page's primary action panel. */
@Composable private fun ForgeSection(title: String, note: String? = null, gold: Boolean = false, art: String? = null, content: @Composable ColumnScope.() -> Unit) =
    TitledPlate(title, Modifier.then(if (gold) Modifier.border(2.dp, SurfaceInk.gold) else Modifier), note = note, gold = gold, art = art, content = content)

@Composable private fun ForgeStat(label: String, value: String, accent: Boolean = false) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(label, Modifier.weight(1f), color = SurfaceInk.muted, fontSize = 15.sp)
        Text(value, color = if (accent) SurfaceInk.goldHi else SurfaceInk.muted, fontSize = if (accent) 28.sp else 19.sp)
    }
}

@Composable private fun ForgeGauge(fraction: Float, color: Color = SurfaceInk.gold) {
    Box(Modifier.fillMaxWidth().height(5.dp).background(SurfaceInk.well).border(1.dp, SurfaceInk.rule)) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(fraction.coerceIn(0f, 1f)).background(color))
    }
}

@Composable private fun KeepConversionPanel(balances: Balances?, rate: Long?, wallet: String, baseId: String?, enabled: Boolean,
    prepare: (EconomyAction, String) -> Unit) {
    var amount by rememberSaveable(wallet, baseId) { mutableStateOf("") }
    val parsed = amount.toBigDecimalOrNull()
    val keep = balances?.keep?.toBigDecimalOrNull()
    val valid = enabled && parsed != null && parsed.signum() > 0 && keep != null && parsed <= keep
    ForgeSection("KEEP → SHARDS", gold = true, art = "keep", note = "1 KEEP = ${rate?.let(::fmtN) ?: "…"} SHARDS") {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            GameArt("keep", Modifier.size(18.dp)); Text("${balances?.keep?.let(::fmtN) ?: "…"} KEEP", color = SurfaceInk.goldHi, style = MaterialTheme.typography.bodyMedium)
            Text("→", color = SurfaceInk.faint, style = MaterialTheme.typography.bodyMedium)
            GameArt("shards", Modifier.size(18.dp)); Text("${balances?.shards?.let(::fmtN) ?: "…"} SHARDS", color = SurfaceInk.muted, style = MaterialTheme.typography.bodyMedium)
        }
        Text("ONE-WAY: converted KEEP becomes building and troop currency. Shards cannot be withdrawn; only the capped Gold Forge can turn them back into KEEP.", color = SurfaceInk.muted, fontSize = 13.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(amount, { next -> if (next.length <= 32 && next.all { it in '0'..'9' }) amount = next }, Modifier.weight(1f), enabled = enabled,
                placeholder = { Text("KEEP TO CONVERT") }, leadingIcon = { GameArt("keep", Modifier.size(18.dp)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
            Button(onClick = { prepare(EconomyAction.CONVERT, amount) }, enabled = valid) { Text("CONVERT") }
        }
        if (!enabled) Text("Conversion is unavailable while balances or a saved request need checking.", color = SurfaceInk.muted, fontSize = 13.sp)
    }
}

@Composable private fun ForgeDeploy(forge: ForgeOverview, wallet: String, baseId: String?, enabled: Boolean, catalogue: kotlinx.serialization.json.JsonObject?, prepare: (EconomyAction, String) -> Unit) {
    var amount by rememberSaveable(wallet, baseId) { mutableStateOf("") }
    val balance = forge.balance.toBigDecimal()
    val contributed = forge.myShards.toBigDecimal()
    val cap = forge.dailyCap.toBigDecimal()
    val headroom = (cap - contributed).max(BigDecimal.ZERO)
    val maximum = balance.min(headroom).max(BigDecimal.ZERO)
    val parsed = amount.toBigDecimalOrNull() ?: BigDecimal.ZERO
    val total = forge.totalShards.toBigDecimal()
    val emission = forge.emission.toBigDecimal()
    val softCap = forge.softCapShards?.toBigDecimalOrNull()?.takeIf { it.signum() > 0 }
    val denominator = softCap?.let { (total + parsed).max(it) }
    val projected = denominator?.let { (contributed + parsed).multiply(emission).divide(it, 0, java.math.RoundingMode.DOWN) }
    val rate = denominator?.let { emission.divide(it, 3, java.math.RoundingMode.HALF_UP).toPlainString() }
    val now = displayClock()
    val secondsLeft = runCatching { ((Instant.parse(forge.cycleEndsAt).toEpochMilli() - now + 999) / 1_000).coerceAtLeast(0) }.getOrNull()
    val capFraction = if (cap.signum() > 0) contributed.divide(cap, 6, java.math.RoundingMode.HALF_UP).toFloat().coerceIn(0f, 1f) else 0f
    val valid = enabled && forge.level > 0 && parsed.signum() > 0 && parsed <= maximum
    val controls: @Composable ColumnScope.() -> Unit = {
        ForgeSection("DEPLOY SHARDS", "before UTC midnight", gold = true) {
            OutlinedTextField(amount, { next -> if (next.length <= 32 && next.all { it in '0'..'9' }) amount = next }, Modifier.fillMaxWidth(),
                enabled = enabled && forge.level > 0, textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 40.sp),
                leadingIcon = { GameArt("shards", Modifier.size(22.dp)) }, trailingIcon = { Text("SHARDS", color = SurfaceInk.muted, fontSize = 15.sp) },
                placeholder = { Text("0", fontSize = 40.sp) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf(25, 50, 100).forEach { pct -> TextButton(onClick = {
                    amount = maximum.multiply(BigDecimal(pct)).divide(BigDecimal(100), 0, java.math.RoundingMode.DOWN).toPlainString()
                }, modifier = Modifier.weight(1f), enabled = enabled && forge.level > 0 && maximum.signum() > 0, contentPadding = PaddingValues(horizontal = 4.dp, vertical = 6.dp)) {
                    Text(if (pct == 100) "MAX · ${fmtN(maximum.toPlainString())}" else "$pct%", fontSize = 15.sp)
                } }
            }
            ForgeStat("PROJECTED AT TODAY'S POOL", projected?.toPlainString()?.let(::fmtN) ?: "…", true)
            Text("KEEP · ${rate ?: "…"}/shard", color = SurfaceInk.muted, fontSize = 14.sp)
            Button(onClick = { prepare(EconomyAction.CONTRIBUTE, amount) }, enabled = valid, modifier = Modifier.fillMaxWidth()) { Text("DEPLOY", fontSize = 24.sp) }
            Text("Every remaining shard participates. Raid theft reduces this deed's stake before the pour.", color = SurfaceInk.muted, fontSize = 14.sp)
            Text("The UTC cycle at server acceptance determines settlement. The current projection is not a payout guarantee.", color = SurfaceInk.muted, fontSize = 13.sp)
        }
        ForgeSection("TODAY", "settles at UTC midnight") {
            ForgeStat("NEXT POUR", secondsLeft?.let { if (it == 0L) "SMELTING…" else fmtDur(it).uppercase() } ?: "…", true)
            secondsLeft?.let { ForgeGauge((1f - it.toFloat() / java.time.Duration.ofDays(1).seconds).coerceIn(0f, 1f)) }
            ForgeStat("TODAY'S POOL", "${fmtN(forge.totalShards)} SHARDS")
            softCap?.let {
                val fraction = total.divide(it, 6, java.math.RoundingMode.HALF_UP).toFloat().coerceIn(0f, 1f)
                ForgeStat("SOFT CAP", "${(fraction * 100).toInt()}%")
                ForgeGauge(fraction)
                Text(if (total < it) "Below the cap the rate is fixed — the pool is not diluting you yet." else "Above the cap each added shard shares the fixed daily emission.", color = SurfaceInk.muted, fontSize = 13.sp)
            }
            ForgeStat("MY FORGE CAP", "${fmtN(forge.myShards)} / ${fmtN(forge.dailyCap)}")
            ForgeGauge(capFraction, Color(0xFFBBD0D6))
            Text(if (forge.level > 0) "Upgrade the Gold Forge to raise the daily cap." else "Build a Gold Forge to deploy shards.", color = SurfaceInk.muted, fontSize = 13.sp)
            ForgeStat("MY SHARD BALANCE", fmtN(forge.balance))
            ForgeStat("DAY'S EMISSION", "${fmtN(forge.emission)} KEEP")
        }
        forge.yesterday?.takeIf { forge.claimableDays == 0 && it.status != "nothing" }?.let { yesterday ->
            ForgeSection("YESTERDAY") {
                Text(if (yesterday.status == "expired") "EXPIRED" else "+${fmtN(yesterday.keepPaid)} KEEP", color = SurfaceInk.goldHi, fontSize = 26.sp)
                Text(if (yesterday.status == "expired") "Unclaimed KEEP returned to the emission pool." else yesterday.status.uppercase(), color = SurfaceInk.muted, fontSize = 13.sp)
            }
        }
    }
    val art: @Composable ColumnScope.() -> Unit = {
        ForgeSection("THE CRUCIBLE", if (forge.level <= 0) "LOCKED" else if (contributed.signum() > 0) "SMELTING" else "READY") {
            ForgeScene(forge.level > 0, Modifier.fillMaxWidth())
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(Triple("1 DEPLOY", "shards", "Feed shards to the hopper before UTC midnight."),
                    Triple("2 SMELT", "streak", "Overnight the crucible melts the realm's whole haul."),
                    Triple("3 POUR", "keep", "At dawn KEEP pours out by your share. Relics drop.")).forEach { (label, icon, detail) ->
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        GameArt(icon, Modifier.size(17.dp)); Text(label, color = SurfaceInk.gold, fontSize = 15.sp); Text(detail, color = SurfaceInk.muted, fontSize = 13.sp)
                    }
                }
            }
        }
        if (forge.drops.isNotEmpty()) ForgeSection("DAILY DROPS", "INDEPENDENT PER DEED") {
            val highest = forge.drops.values.maxOrNull()?.coerceAtLeast(1) ?: 1
            forge.drops.forEach { (itemId, bps) ->
                val item = (((catalogue?.get("constants") as? kotlinx.serialization.json.JsonObject)?.get("ITEMS") as? kotlinx.serialization.json.JsonObject)?.get(itemId) as? kotlinx.serialization.json.JsonObject)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    item?.string("asset")?.let { GameArt(it, Modifier.size(24.dp)) }
                    Column(Modifier.weight(1f)) {
                        Text(item?.string("name") ?: itemId, color = SurfaceInk.muted, fontSize = 15.sp)
                        ForgeGauge(bps.toFloat() / highest, Color(0xFFBBD0D6))
                    }
                    Text("${BigDecimal(bps).movePointLeft(2).setScale(2)}%", color = Color(0xFFBBD0D6), fontSize = 19.sp)
                }
            }
            Text("Every positive deed position rolls every relic independently. Splitting a contribution creates no extra rolls, and more than one relic may drop.", color = SurfaceInk.muted, fontSize = 13.sp)
        }
    }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        if (maxWidth > 900.dp) Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Column(Modifier.weight(1.18f), verticalArrangement = Arrangement.spacedBy(14.dp), content = controls)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(14.dp), content = art)
        } else Column(verticalArrangement = Arrangement.spacedBy(14.dp)) { controls(); art() }
    }
}

@Composable private fun ForgeLedger(allocations: ForgeAllocations, enabled: Boolean, more: () -> Unit) {
    ForgeSection("MY LEDGER") {
        ForgeStat("CLAIMED", "${fmtN(allocations.claimed)} KEEP")
        ForgeStat("CLAIMABLE", "${fmtN(allocations.claimable)} KEEP")
        allocations.shardsBurned?.let { ForgeStat("SHARDS BURNED", fmtN(it)) }
        allocations.itemsWon?.let { ForgeStat("RELICS WON", it.toString()) }
        ForgeStat("EXPIRED", "${fmtN(allocations.expired)} KEEP")
    }
    if (allocations.days.isEmpty()) Text("No cycles yet — deploy shards and come back after the pour.", color = SurfaceInk.muted)
    allocations.days.forEach { day -> ForgeSection(day.day, forgeStatus(day.status)) {
        ForgeStat("SHARDS IN", fmtN(day.shards)); ForgeStat("KEEP", "+${fmtN(day.keep)}")
        if (day.items.isNotEmpty()) Text("Relics: ${day.items.joinToString()}", color = SurfaceInk.goldHi)
        day.expiresAt?.let { Text("Expires ${it.take(10)}", color = SurfaceInk.muted, fontSize = 13.sp) }
    } }
    if (allocations.nextBefore != null) OutlinedButton(onClick = more, enabled = enabled, modifier = Modifier.fillMaxWidth()) { Text("LOAD MORE") }
}

@Composable private fun ForgeGlobalPanel(global: ForgeGlobal?, requestedDay: String?, busy: Boolean, error: String?, select: (String?) -> Unit, more: () -> Unit) {
    error?.let { Notice(it, true); TextButton(onClick = { select(requestedDay) }, enabled = !busy) { Text("RETRY THIS CYCLE") } }
    if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    if (global == null) { if (!busy && error == null) Text("LOADING SETTLED CYCLES…", color = SurfaceInk.muted); return }
    if (global.day == null) { Text("No settled cycles yet — the first pour is at UTC midnight.", color = SurfaceInk.muted); return }
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        global.days.forEach { day -> FilterChip(global.day == day, { select(day) }, enabled = !busy, label = { Text(day.drop(5)) }) }
    }
    Text("${global.contributors} KINGDOMS · ${fmtN(global.totalShards)} SHARDS · ${fmtN(global.distributedKeep)} KEEP POURED", color = SurfaceInk.muted, fontSize = 14.sp)
    global.me?.let { ForgeGlobalRowView(it, true) }
    global.rows.forEach { ForgeGlobalRowView(it, false) }
    if (global.nextCursor != null) OutlinedButton(onClick = more, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("LOAD MORE") }
}

@Composable private fun ForgeGlobalRowView(row: ForgeGlobalRow, mine: Boolean) {
    Row(Modifier.fillMaxWidth().background(SurfaceInk.card).border(2.dp, if (mine) SurfaceInk.gold else SurfaceInk.rule).padding(horizontal = 10.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("#${row.rank}", color = if (mine) SurfaceInk.gold else SurfaceInk.muted)
        Column(Modifier.weight(1f)) { Text(row.name.ifBlank { row.walletShort }); Text(row.walletShort, color = SurfaceInk.muted, fontSize = 11.sp) }
        Column(horizontalAlignment = Alignment.End) { Text(fmtN(row.shards), color = SurfaceInk.muted, fontSize = 13.sp); Text("+${fmtN(row.keepPaid)} KEEP", color = SurfaceInk.goldHi, fontSize = 14.sp) }
    }
}

private fun forgeStatus(status: String): String = when (status) {
    "open" -> "SMELTING"; "claimable" -> "READY"; "claimed" -> "CLAIMED"; "paid_legacy" -> "PAID"; "expired" -> "EXPIRED"; "nothing" -> "—"; else -> status.uppercase()
}
