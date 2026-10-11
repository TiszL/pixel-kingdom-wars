package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: the Gold Forge GEMS tab (design/final/goldforge/SPEC.md §5; `gems.png`, `gems-seal.png`,
 * `gems-sent.png`): buy Gems 1:1 with wallet KEEP (`gems_buy`): the rate tag, the dark pay → get well, the amount stepper
 * (hold repeats), the quick chips, the "left in your wallet after" line, the Gems → Shards CONVERT door (its own Seal,
 * never a second primary), the short-wallet door, the pending-purchase callout, and the buy Seal ([GemsSeal]) with the
 * shared wallet step. Gems stay in the game.
 *
 * Pointer rule: the body and footer are plain layouts inside the painted parchment; only the steppers, chips, CONVERT,
 * GO and the primary take touches. [GemsSeal] is full-screen only while shown.
 */

/** The buy Seal while it is up (SPEC §5b). Its stage is [GemsUi.stage]. */
@Immutable data class GemsSealUi(
    /** Gems bought ("500"). */
    val amount: String,
    /** KEEP paid ("500"). */
    val pay: String,
    /** Wall-clock ms the seal was raised (it arms 450 ms later). */
    val armedAtMs: Long,
    /** The reviewed network-fee estimate ("Estimated network fee: … SOL. Your wallet shows its final fee."), drawn under
     *  the frame's two lines: the pay owner ties consent to that fee. Null draws nothing. */
    val feeLine: String? = null,
)

/** Everything GEMS draws (SPEC "GEMS: UI state"; additions after [swapOffered] have defaults). */
@Immutable data class GemsUi(
    /** The rate tag from `GEMS.gemsPerKeep`, never hard-coded ("1 KEEP = 1 GEM"). */
    val rate: String,
    /** Gems to buy ("500"); "…" while unknown. */
    val amount: String,
    /** KEEP to pay ("500"). */
    val pay: String,
    /** Wallet KEEP now ("2,480"); the HUD stack shows it too. */
    val walletKeep: String,
    /** Wallet KEEP after the buy ("1,980"). */
    val walletAfter: String,
    /** The quick chips ("100", "500", "1,000", "MAX"). MAX = min(wallet KEEP, server max). */
    val quick: List<String>,
    val selectedQuick: String?,
    val min: String,
    val max: String,
    /** Opened from a shortfall: the Gems needed ("120"). */
    val short: String?,
    /** What the shortfall is for ("Workshop finish"). */
    val shortfallFor: String?,
    val stage: MoneyStage,
    /** A purchase waits for the wallet: red "1" on the tab, the callout and CONTINUE. */
    val pendingRecovery: Boolean,
    /** Gems → SHARDS is available (the CONVERT row). */
    val toShardsAvailable: Boolean,
    /** The server advertises an embedded swap ("Get KEEP"). */
    val swapOffered: Boolean,
    val phase: GemsPhase = GemsPhase.READY,
    /** The server reason while Gems are off. */
    val offReason: String? = null,
    /** With [stage] FAILED: refused or uncertain (null = uncertain). */
    val failure: MoneyFailure? = null,
    /** The amount is more than wallet KEEP: the value turns red and the primary is off with the reason. */
    val walletShort: Boolean = false,
    /** The buy Seal while it is up. */
    val seal: GemsSealUi? = null,
    /** Explicit existing-owner callback/Seal handoff admission; observation alone never opens actions. */
    val actionsAllowed: Boolean = false,
    /** Why the owner refuses the primary ("Choose a whole amount from …"): it replaces the generic read-only reason under
     *  an off primary while [actionsAllowed] is false. */
    val primaryReason: String? = null,
)

/** GEMS callbacks (SPEC; additions after [onRetry] have defaults). */
@Immutable data class GemsActions(
    val onMinus: () -> Unit = {},
    val onPlus: () -> Unit = {},
    val onQuick: (String) -> Unit = {},
    /** BUY {n} GEMS: raise the Seal. */
    val onBuy: () -> Unit = {},
    /** The armed BUY in the Seal. */
    val onConfirm: () -> Unit = {},
    val onBack: () -> Unit = {},
    /** OPEN AGAIN: the same prepared purchase; never a second one. */
    val onReopenWallet: () -> Unit = {},
    /** CONVERT: the existing Gems → SHARDS flow in its own Seal (`section = toShards`). */
    val onConvert: () -> Unit = {},
    /** Red RETRY (an authoritative refusal or a failed read). */
    val onRetry: () -> Unit = {},
    /** CONTINUE / "Check wallet" / "Checking…": reopen the pending purchase at its Wallet step. */
    val onContinue: () -> Unit = {},
    /** "Get KEEP" (only when the server advertises a swap). */
    val onGetKeep: () -> Unit = {},
    /** "Claim payouts on CLAIM": switch tabs. */
    val onGoClaim: () -> Unit = {},
    /** A tap on an off primary: say its reason (a door never does nothing). */
    val onExplain: (String) -> Unit = {},
)

/** The GEMS body (inside the sheet's parchment). */
@Composable fun GemsBody(ui: GemsUi, on: GemsActions) {
    val c = PkwTokens.Colors
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (ui.phase == GemsPhase.OFF) {
            ForgeEmpty("gf:gem_64", "Gems open soon", ui.offReason)
            return@Column
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            PkwText("BUY GEMS", PkwTokens.Type.label, color = c.textOnParch)
            Spacer(Modifier.weight(1f))
            Tag(ui.rate, Verb.STONE)
        }
        PkwText("Gems finish timers and buy supplies. They stay in the game.", PkwTokens.Type.small, Modifier.fillMaxWidth(),
            color = c.textOnParch2, maxLines = 2)
        if (ui.pendingRecovery) CalloutRow("gf:gem_24", "A purchase is waiting for your wallet", "Continue it below")
        DarkWell(Modifier.fillMaxWidth().heightIn(min = 104.dp), rays = 0.6f, rayCenter = 0.5f) {
            PayGet(left = {
                GfIcon("gf:keep_48", 48.dp)
                PkwText("${ui.pay} KEEP", PkwTokens.Type.title, color = c.gold.hi, outline = 1.dp)
            }, right = {
                GfIcon("gf:gem_48", 48.dp)
                PkwText("${ui.amount} GEMS", PkwTokens.Type.title, color = GoldForgeColors.gemText, outline = 1.dp)
            }, modifier = Modifier.align(Alignment.Center), arrow = c.gold.hi)
        }
        if (ui.short != null && ui.shortfallFor != null) PkwText("You need ${ui.short} for ${ui.shortfallFor}", PkwTokens.Type.small,
            color = c.textOnParch, maxLines = 2)
        val busy = ui.stage == MoneyStage.CHECK_WALLET || ui.stage == MoneyStage.SENDING
        Row(Modifier.fillMaxWidth().heightIn(min = 60.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            RepeatSquare("shape:minus", "Fewer Gems", on.onMinus, Modifier.size(48.dp, 60.dp), enabled = !busy)
            Plate(PlateKind.CREAM, Modifier.weight(1f).heightIn(min = 60.dp)
                .clearAndSetSemantics { contentDescription = "${ui.amount} Gems" + if (ui.walletShort) ", more than your wallet has" else "" }) {
                Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    PkwText(ui.amount, PkwTokens.Type.primary, color = if (ui.walletShort) c.shortText else c.textOnParch)
                    PkwText("Gems", PkwTokens.Type.small, color = c.textOnParch2)
                }
            }
            RepeatSquare("shape:plus", "More Gems", on.onPlus, Modifier.size(48.dp, 60.dp), enabled = !busy)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ui.quick.forEach { q -> QuickChip(q, q == ui.selectedQuick, !busy, { on.onQuick(q) }, Modifier.weight(1f)) }
        }
        Row(Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = "Left in your wallet after: ${ui.walletAfter} KEEP" },
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PkwText("Left in your wallet after", PkwTokens.Type.body, Modifier.weight(1f), color = c.textOnParch)
            GfIcon("gf:keep_24", 24.dp)
            PkwText(ui.walletAfter, PkwTokens.Type.caption, color = c.textOnParch)
        }
        if (ui.walletShort) {
            if (ui.swapOffered) GoRow("gf:keep_24", "Get KEEP", "for your wallet", on.onGetKeep, "Get KEEP")
            else GoRow("gf:keep_24", "Claim payouts on CLAIM", "minted KEEP goes to your wallet", on.onGoClaim, "Go to CLAIM")
        }
        if (ui.toShardsAvailable) ConvertRow(on.onConvert)
    }
}

/** The GEMS footer: the one primary and its footnote (none while Gems are off). */
@Composable fun ColumnScope.GemsFooter(ui: GemsUi, on: GemsActions) {
    val look = gemsFooterLook(ui) ?: return
    ForgePrimary(look, { gemsFooterTap(look, ui, on) }, Modifier.fillMaxWidth())
    ForgeFootnote("No game fee. You approve once in your wallet.")
}

/** The GEMS primary as drawn: an owner refusal ([GemsUi.primaryReason]) replaces the generic read-only reason, so the off
 *  primary says why (SPEC §5a: the primary turns off with the reason). */
internal fun gemsFooterLook(ui: GemsUi): ForgePrimaryLook? = gemsPrimaryLook(ui)?.let { look ->
    val reason = ui.primaryReason
    if (reason != null && !ui.actionsAllowed && look.state == CommandState.DISABLED) look.copy(reason = reason) else look
}

/** One tap on the GEMS primary. BUY, CONTINUE and RETRY go to their callbacks; an off face with a reason explains it; the
 *  moss SENT face asks the owner to finish the credited purchase (CONTINUE). Only the BUSY face (no tap) does nothing. */
internal fun gemsFooterTap(look: ForgePrimaryLook, ui: GemsUi, on: GemsActions) {
    val reason = look.reason
    when {
        look.action == ForgeAction.BUY -> on.onBuy()
        look.action == ForgeAction.CONTINUE -> on.onContinue()
        look.action == ForgeAction.RETRY -> on.onRetry()
        reason != null && (look.state == CommandState.DISABLED || look.state == CommandState.LOCKED) -> on.onExplain(reason)
        ui.stage == MoneyStage.SENT -> on.onContinue()
    }
}

/** A quick amount chip (SPEC §2 QuickChips): cream chunky 48 tall; selected = 3 dp gold inner rim on `#FFF3C8`. */
@Composable private fun QuickChip(label: String, selected: Boolean, enabled: Boolean, onTap: () -> Unit, modifier: Modifier) {
    val c = PkwTokens.Colors
    HoldBox(if (selected) "$label Gems, selected" else "$label Gems", onTap, null, modifier.height(48.dp), enabled = enabled) { pressed ->
        Box(Modifier.fillMaxSize().drawBehind {
            val w = size.width; val h = size.height; val i = 2.dp.toPx()
            val top = if (pressed) 2.dp.toPx() else 0f
            fillStepped(0f, top, w, h, CornerProfiles.M, c.ink)
            insideStepped(i, top + i, w - i, h - i, CornerProfiles.S) {
                drawRect(if (selected) c.selectedTint else c.cream)
                band(i, w - i, h - i - 4.dp.toPx(), 4.dp.toPx(), c.creamLo)
                if (selected) {
                    val r = 3.dp.toPx()
                    val g = c.gold.face
                    drawRect(g, Offset(i, top + i), Size(w - 2 * i, r)); drawRect(g, Offset(i, h - i - r), Size(w - 2 * i, r))
                    drawRect(g, Offset(i, top + i), Size(r, h - 2 * i - top)); drawRect(g, Offset(w - i - r, top + i), Size(r, h - 2 * i - top))
                }
            }
        }, contentAlignment = Alignment.Center) {
            PkwText(label, PkwTokens.Type.caption, Modifier.padding(bottom = 3.dp), color = c.textOnParch)
        }
    }
}

/** "Need Shards? / Gems into Shards" + stone CONVERT 104 × 44 (SPEC §5a.6). */
@Composable private fun ConvertRow(onConvert: () -> Unit) {
    val c = PkwTokens.Colors
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).drawBehind {
        drawRect(c.ink)
        val i = 2.dp.toPx()
        drawRect(c.cream, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
    }.padding(start = 10.dp, end = 6.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        GfIcon("gf:gem_24", 24.dp)
        GfIcon("shards", 24.dp)
        Column(Modifier.weight(1f)) {
            PkwText("Need Shards?", PkwTokens.Type.body, color = c.textOnParch)
            PkwText("Gems into Shards", PkwTokens.Type.small, color = c.textOnParch2)
        }
        SecondaryButton("CONVERT", onConvert, Modifier.width(104.dp), contentDescription = "Convert Gems into Shards")
    }
}

/** The shown buy seal and its stage. */
private data class GemsSealShown(val seal: GemsSealUi, val stage: MoneyStage, val failure: MoneyFailure?)

/**
 * The buy-Gems Seal (SPEC §5b, `gems-seal.png`): "BUY {n} GEMS", "KEEP you pay" → "Gems you get", "Paid from your wallet.
 * You sign once.", "Gems stay in the game and can't be sent out.", BACK + gold BUY arming over 450 ms; then the shared
 * wallet step ("Approve the purchase in your wallet", OPEN AGAIN). FAILED shows the outcome line: only a refusal says
 * nothing was spent (design correction 7).
 *
 * Pointer rule: compose it always from the OverlayHost; full-screen (55 % scrim) only while [GemsUi.seal] is set and
 * while it animates out. A scrim tap is BACK, ignored while sending.
 */
@Composable fun GemsSeal(ui: GemsUi?, on: GemsActions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    val c = PkwTokens.Colors
    val seal = ui?.seal
    val shown = if (ui == null || seal == null) null else GemsSealShown(seal, ui.stage, ui.failure)
    ForgeSeal(shown, { "BUY ${it.seal.amount} GEMS" }, { s -> if (s.stage != MoneyStage.SENDING) on.onBack() }, modifier, onExitFinished) { s, active ->
        PayGet(left = { SealSide("gf:keep_48", s.seal.pay, "KEEP you pay") }, right = { SealSide("gf:gem_48", s.seal.amount, "Gems you get") })
        when (s.stage) {
            MoneyStage.READY, MoneyStage.SENT -> {
                PkwText("Paid from your wallet. You sign once.", PkwTokens.Type.body, color = c.textOnParch, textAlign = TextAlign.Center)
                PkwText("Gems stay in the game and can't be sent out.", PkwTokens.Type.small, color = c.textOnParch2, textAlign = TextAlign.Center)
                s.seal.feeLine?.let { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2,
                    textAlign = TextAlign.Center, maxLines = 3) }
                SealButtons(active, on.onBack) {
                    ArmingButton("BUY", s.seal.armedAtMs, active && s.stage == MoneyStage.READY, on.onConfirm, clock, Modifier.weight(1f))
                }
            }
            MoneyStage.CHECK_WALLET, MoneyStage.SENDING ->
                WalletStep(s.stage, "purchase", "BUY", active, on.onBack, on.onReopenWallet, sendingLine = "Your Gems arrive with the receipt.")
            MoneyStage.FAILED -> {
                val failure = s.failure ?: MoneyFailure.UNCERTAIN
                PkwText(forgeOutcomeLine("purchase", failure), PkwTokens.Type.lead, color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                SealButtons(active, on.onBack) {
                    if (failure == MoneyFailure.REFUSED) SecondaryButton("RETRY", { if (active) on.onRetry() }, Modifier.weight(1f), verb = Verb.RED)
                    else SecondaryButton("OPEN AGAIN", { if (active) on.onReopenWallet() }, Modifier.weight(1f), verb = Verb.BLUE)
                }
            }
        }
    }
}

@Preview(name = "GEMS: buy", widthDp = 398, heightDp = 820)
@Composable private fun GemsBuyPreview() = GemsPreviewFrame(GoldForgeSamples.gems)

@Preview(name = "GEMS: wallet short", widthDp = 398, heightDp = 820)
@Composable private fun GemsShortPreview() = GemsPreviewFrame(GoldForgeSamples.gems.copy(amount = "3,000", pay = "3,000", walletAfter = "…",
    walletShort = true, selectedQuick = null))

@Preview(name = "GEMS: opened from a shortfall", widthDp = 398, heightDp = 820)
@Composable private fun GemsShortfallPreview() = GemsPreviewFrame(GoldForgeSamples.gems.copy(amount = "120", pay = "120", walletAfter = "2,360",
    short = "120", shortfallFor = "Workshop finish", selectedQuick = null))

@Preview(name = "GEMS: loading", widthDp = 398, heightDp = 820)
@Composable private fun GemsLoadingPreview() = GemsPreviewFrame(GoldForgeSamples.gems.copy(phase = GemsPhase.LOADING, walletKeep = "…", walletAfter = "…"))

@Preview(name = "GEMS: off (server gate)", widthDp = 398, heightDp = 500)
@Composable private fun GemsOffPreview() = GemsPreviewFrame(GoldForgeSamples.gems.copy(phase = GemsPhase.OFF, offReason = "Gems open with the next season."))

@Preview(name = "GEMS: purchase waiting for the wallet", widthDp = 398, heightDp = 860)
@Composable private fun GemsPendingPreview() = GemsPreviewFrame(GoldForgeSamples.gems.copy(pendingRecovery = true))

@Preview(name = "GEMS: error (RETRY)", widthDp = 398, heightDp = 820)
@Composable private fun GemsErrorPreview() = GemsPreviewFrame(GoldForgeSamples.gems.copy(phase = GemsPhase.ERROR))

@Preview(name = "GEMS: sent", widthDp = 398, heightDp = 820)
@Composable private fun GemsSentPreview() = GemsPreviewFrame(GoldForgeSamples.gems.copy(stage = MoneyStage.SENT))

@Preview(name = "GEMS seal: arming", widthDp = 412, heightDp = 700)
@Composable private fun GemsSealPreview() = GemsSeal(GoldForgeSamples.gems.copy(seal = GemsSealUi("500", "500", 0L,
    feeLine = "Estimated network fee: 0.000005 SOL. Your wallet shows its final fee.")), GemsActions(), clock = { 270L })

@Preview(name = "GEMS seal: wallet step", widthDp = 412, heightDp = 700)
@Composable private fun GemsSealWalletPreview() = GemsSeal(GoldForgeSamples.gems.copy(seal = GemsSealUi("500", "500", 0L),
    stage = MoneyStage.CHECK_WALLET), GemsActions())

@Preview(name = "GEMS seal: result uncertain", widthDp = 412, heightDp = 700)
@Composable private fun GemsSealUncertainPreview() = GemsSeal(GoldForgeSamples.gems.copy(seal = GemsSealUi("500", "500", 0L),
    stage = MoneyStage.FAILED, failure = MoneyFailure.UNCERTAIN), GemsActions())

@Composable private fun GemsPreviewFrame(ui: GemsUi) {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f, fill = true)) { GemsBody(ui, GemsActions()) }
        GemsFooter(ui, GemsActions())
    }
}
