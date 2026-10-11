package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.kit.countUpText
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt

/**
 * Design component: the Gold Forge CLAIM tab (design/final/goldforge/SPEC.md §4, pass 2; `claim.png`,
 * `claim-locked.png`, `claim-wallet.png`, `claim-sent.png`, `error.png`): the MintTray (warm, cold, locked), the
 * FurnaceLine estimate, the DestinationRow (no address anywhere), the one big 72 dp gold CLAIM, the claim Seal with its
 * wallet step and OPEN AGAIN ([ClaimSeal]), and the WalletDetails half sheet ([WalletDetailsSheet]). The game holds no
 * balance: claimed coins go straight to the player's wallet.
 *
 * Tonight (GF-B1) the body is read-only from `GET /claims/mining/status`; the primary opens the existing single journal
 * owner (`MiningClaimsRegistration`) through `onClaim`. The sheet never calls `miningClaimsClient`. On the Home-mounted
 * sheet no claim owner can act, so the ready CLAIM is drawn off with [ClaimUi.closedReason] and a tap explains it.
 *
 * Pointer rule: the body and footer are plain layouts inside the painted parchment; only GO / TRY AGAIN / the
 * destination row / the primary take touches. [ClaimSeal] is full-screen only while shown; [WalletDetailsSheet] is a
 * HALF sheet (no scrim).
 */

/** "The mint opens {date}" (SPEC §4a): the date and the server's reason, both from the server or the MR calendar. */
@Immutable data class ClaimLockUi(val date: String, val reason: String?)

/** The claim Seal while it is up (SPEC §4c). Its stage is [ClaimUi.stage]. */
@Immutable data class ClaimSealUi(
    /** The amount being claimed ("1,240"). */
    val amount: String,
    /** Wall-clock ms the seal was raised (it arms 450 ms later). */
    val armedAtMs: Long,
)

/** Everything CLAIM draws (SPEC "CLAIM: UI state"; additions after [canResumeSaved] have defaults). */
@Immutable data class ClaimUi(
    /** Ready to claim, formatted ("1,240"); "…" until read. */
    val ready: String,
    /** "from {n} days of smelting"; null hides it. */
    val readyDays: Int?,
    /** Today's estimate ("42"); null hides the FurnaceLine. */
    val estimate: String?,
    /** The wallet app's display name from MWA ("Seeker wallet"); never an address. Null reads "your wallet". */
    val walletLabel: String?,
    /** Last 4 of the address, for [WalletDetailsSheet] only. */
    val walletLast4: String?,
    /** The not-open-yet lock (date + server reason); drawn only in [ClaimPhase.LOCKED]. */
    val lock: ClaimLockUi?,
    /** The money sequence. */
    val stage: MoneyStage,
    /** "6h 20m" to the next coins (empty tray line). */
    val nextCoinsIn: String?,
    /** A saved claim exists: the primary reads CONTINUE CLAIM and the Seal opens at the Wallet step. */
    val canResumeSaved: Boolean,
    val phase: ClaimPhase = ClaimPhase.READY,
    /** With [stage] FAILED: refused (may say nothing was sent) or uncertain (being checked). Null = uncertain. */
    val failure: MoneyFailure? = null,
    /** The claim Seal while it is up. */
    val seal: ClaimSealUi? = null,
    /** Explicit existing-owner callback/Seal handoff admission; observation alone never opens actions. */
    val actionsAllowed: Boolean = false,
    /** Why collecting cannot start here while [actionsAllowed] is false (the Home sheet: no claim owner can act). The
     *  ready CLAIM stays in place, off, with this line; a tap explains it ([claimPrimaryLook]). Null = the owner gate. */
    val closedReason: String? = null,
)

/** CLAIM callbacks (SPEC; additions after [onHistory] have defaults). */
@Immutable data class ClaimActions(
    /** CLAIM / CONTINUE CLAIM / "Check wallet" / "Checking…": open (or reopen at its Wallet step) the claim Seal. */
    val onClaim: () -> Unit = {},
    /** The armed CLAIM in the Seal. */
    val onConfirm: () -> Unit = {},
    /** BACK in the Seal (cancels waiting for the wallet), a scrim tap. */
    val onBack: () -> Unit = {},
    /** OPEN AGAIN: re-launch the wallet with the SAME prepared claim; never prepares a second claim. */
    val onReopenWallet: () -> Unit = {},
    /** Red RETRY after an authoritative refusal, and TRY AGAIN after a failed first read. */
    val onRetry: () -> Unit = {},
    val onGoSmelt: () -> Unit = {},
    /** `IslandScene("seeker")`: the first auction is on Seeker Island. */
    val onGoSeeker: () -> Unit = {},
    /** The DestinationRow: open [WalletDetailsSheet]. */
    val onDestinationDetails: () -> Unit = {},
    val onHistory: () -> Unit = {},
    /** A tap on the locked CLAIM: toast the lock reason. */
    val onExplainLock: () -> Unit = {},
)

/** The CLAIM body (inside the sheet's parchment). */
@Composable fun ClaimBody(ui: ClaimUi, on: ClaimActions) {
    val c = PkwTokens.Colors
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val dim = ui.seal != null || ui.stage == MoneyStage.CHECK_WALLET
        MintTray(ui, Modifier.alpha(if (dim) 0.55f else 1f), on.onRetry)
        if (ui.phase != ClaimPhase.LOADING && ui.phase != ClaimPhase.ERROR) ui.estimate?.let { FurnaceLine(it, locked = ui.phase == ClaimPhase.LOCKED) }
        when (ui.phase) {
            ClaimPhase.LOCKED -> {
                PkwText("Every smelt day still counts. Your coins wait here until the mint opens.", PkwTokens.Type.body,
                    Modifier.fillMaxWidth(), color = c.textOnParch, maxLines = 3)
                Column {
                    GoRow("gf:forge_ingot", "Smelt today", "more coins for you", on.onGoSmelt, "Go to SMELT")
                    GoRow("ui:seeker-navigation", "First auction", "on Seeker Island", on.onGoSeeker, "Go to Seeker Island")
                }
            }
            ClaimPhase.READY, ClaimPhase.LOADING -> DestinationRow(ui.walletLabel, on.onDestinationDetails)
            ClaimPhase.ERROR -> DestinationRow(ui.walletLabel, on.onDestinationDetails, Modifier.alpha(0.55f))
            ClaimPhase.COLLECTED -> Unit
        }
    }
}

/** The CLAIM footer: the one primary (72 dp gold when ready) and its footnote. */
@Composable fun ColumnScope.ClaimFooter(ui: ClaimUi, on: ClaimActions) {
    val look = claimPrimaryLook(ui)
    val height = when {
        // The ready face keeps its one 72 dp CLAIM (`claim.png`) even while collecting is closed.
        look.action == ForgeAction.CLAIM || (ui.phase == ClaimPhase.READY && ui.closedReason != null &&
            look.action == ForgeAction.EXPLAIN_LOCK) -> 72.dp
        ui.phase == ClaimPhase.LOCKED || ui.phase == ClaimPhase.ERROR -> 64.dp
        else -> PkwTokens.Dims.sheetPrimaryH
    }
    ForgePrimary(look, {
        when (look.action) {
            ForgeAction.CLAIM, ForgeAction.CONTINUE -> on.onClaim()
            ForgeAction.RETRY -> on.onRetry()
            ForgeAction.EXPLAIN_LOCK -> on.onExplainLock()
            else -> Unit
        }
    }, Modifier.fillMaxWidth(), height = height)
    ForgeFootnote(when (ui.phase) {
        ClaimPhase.LOCKED -> "Coins go straight to your wallet."
        ClaimPhase.COLLECTED -> "History keeps every collection (top right)."
        else -> "No game fee. You approve once in your wallet."
    })
}

/**
 * The MintTray (SPEC §4 New parts): the authored coin tray (64 art) at the whole device scale nearest 3 dp per art px
 * (2 dp when locked), up to four spilled coins (16 art) at the same density, warm rays + glow when ready, cold (85 %
 * grey, 50 % light) otherwise, and the one big number. Enter: drops 8 dp + fades in 160 ms; the number counts up over
 * 600 ms (reduced motion: neither).
 */
@Composable private fun MintTray(ui: ClaimUi, modifier: Modifier, onTryAgain: () -> Unit) {
    val c = PkwTokens.Colors
    val warm = ui.phase == ClaimPhase.READY && ui.stage != MoneyStage.SENT
    val locked = ui.phase == ClaimPhase.LOCKED
    val reduced = LocalReducedMotion.current || LocalInspectionMode.current
    val enter = remember(ui.phase) { Animatable(if (reduced) 1f else 0f) }
    LaunchedEffect(ui.phase) { enter.animateTo(1f, tween(PkwTokens.Motion.PLATE_IN, easing = PkwTokens.Motion.Out)) }
    val count = remember(ui.ready) { Animatable(if (reduced || !isPositiveAmount(ui.ready)) 1f else 0f) }
    LaunchedEffect(ui.ready) { count.animateTo(1f, tween(PkwTokens.Motion.COUNT_UP, easing = PkwTokens.Motion.Out)) }
    DarkWell(modifier.fillMaxWidth().heightIn(min = if (warm) 286.dp else 194.dp).graphicsLayer {
        alpha = enter.value
        translationY = -8.dp.toPx() * (1f - enter.value)
    }, rays = if (warm) 1f else 0f, glow = warm) {
        Column(Modifier.fillMaxWidth().align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp)) {
            TrayArt(cold = !warm, locked = locked, coins = if (warm) 4 else 0, Modifier.alpha(if (ui.phase == ClaimPhase.LOADING) 0.55f else 1f))
            when (ui.phase) {
                ClaimPhase.READY -> if (ui.stage == MoneyStage.SENT) EmptyTrayLines(ui) else {
                    val shown = countUpText("0", ui.ready, count.value)
                    Row(Modifier.clearAndSetSemantics { contentDescription = "${ui.ready} KEEP minted for you" },
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        GfIcon("gf:keep_24", 24.dp)
                        PkwText(shown, PkwTokens.Type.numeralL, color = c.gold.hi, outline = 2.dp)
                    }
                    PkwText("KEEP minted for you", PkwTokens.Type.body, color = c.text)
                    ui.readyDays?.let { PkwText(if (it == 1) "from 1 day of smelting" else "from $it days of smelting", PkwTokens.Type.small, color = c.muted) }
                }
                ClaimPhase.LOCKED -> {
                    PkwText("THE MINT OPENS", PkwTokens.Type.label, color = c.gold.hi, outline = 1.dp)
                    PkwText(ui.lock?.date ?: "…", PkwTokens.Type.lead, color = c.text)
                    ui.lock?.reason?.let { PkwText(it, PkwTokens.Type.small, color = c.muted, textAlign = TextAlign.Center, maxLines = 2) }
                }
                ClaimPhase.LOADING -> PkwText("Checking your coins…", PkwTokens.Type.body, color = c.text)
                ClaimPhase.COLLECTED -> EmptyTrayLines(ui)
                ClaimPhase.ERROR -> {
                    PkwText("The forge can't reach the server.", PkwTokens.Type.body, color = c.text, textAlign = TextAlign.Center)
                    PkwText("Your coins show again when it answers.", PkwTokens.Type.small, color = c.muted, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(4.dp))
                    SecondaryButton("TRY AGAIN", onTryAgain, Modifier.width(148.dp))
                }
            }
        }
    }
}

/** The empty tray's lines (SPEC §4d): ALL COLLECTED · The tray is empty · next coins in {t}. */
@Composable private fun EmptyTrayLines(ui: ClaimUi) {
    val c = PkwTokens.Colors
    PkwText("ALL COLLECTED", PkwTokens.Type.title, color = c.gold.hi, outline = 1.dp)
    PkwText("The tray is empty", PkwTokens.Type.body, color = c.text)
    ui.nextCoinsIn?.let { PkwText("next coins in $it", PkwTokens.Type.small, color = c.muted) }
}

/** Spilled coin left / top offsets from the tray (SPEC §4 MintTray: −124 / −102 / +70 / +94 dp from centre, y 100–114). */
private val COIN_SPILL = listOf(-124 to 104, -102 to 114, 70 to 100, 94 to 110)

/** The tray art and the spilled coins at one whole device scale ([FilterQuality.None]); paint only. */
@Composable private fun TrayArt(cold: Boolean, locked: Boolean, coins: Int, modifier: Modifier = Modifier) {
    val tray = ImageBitmap.imageResource(R.drawable.pkw_ui_gf_coin_tray_64)
    val coin = ImageBitmap.imageResource(R.drawable.pkw_ui_gf_coin_16)
    val filter = remember(cold) { if (cold) coldFilter() else null }
    val trayDp = if (locked) 128.dp else 192.dp
    Box(modifier.fillMaxWidth().height(trayDp), contentAlignment = Alignment.TopCenter) {
        Canvas(Modifier.fillMaxSize().clearAndSetSemantics { }) {
            // Whole device px per art px nearest the design's 3 dp (2 dp locked): 6 at 2.0x, 8 on the 2.625x Seeker.
            val k = maxOf(1, ((if (locked) 2f else 3f) * density).roundToInt())
            val tw = tray.width * k; val th = tray.height * k
            val tx = ((size.width - tw) / 2f).roundToInt()
            drawImage(tray, IntOffset.Zero, IntSize(tray.width, tray.height), IntOffset(tx, 0), IntSize(tw, th),
                colorFilter = filter, filterQuality = FilterQuality.None)
            val cx = size.width / 2f
            for (n in 0 until minOf(coins, COIN_SPILL.size)) {
                val (dx, dy) = COIN_SPILL[n]
                drawImage(coin, IntOffset.Zero, IntSize(coin.width, coin.height),
                    IntOffset((cx + dx.dp.toPx()).roundToInt(), (dy.dp.toPx() * th / (192.dp.toPx())).roundToInt().coerceAtLeast(0)),
                    IntSize(coin.width * k, coin.height * k), colorFilter = filter, filterQuality = FilterQuality.None)
            }
        }
        if (locked) PkwIcon("shape:lock", 48.dp, Modifier.padding(top = trayDp * 0.45f), tint = PkwTokens.Colors.gold.face)
    }
}

/** The FurnaceLine (SPEC §4): a grey KEEP 24 and "About {n} more melting today · an estimate". Never a box. */
@Composable private fun FurnaceLine(estimate: String, locked: Boolean) {
    Row(Modifier.fillMaxWidth().heightIn(min = 24.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        GfIcon("gf:keep_24", 24.dp, colorFilter = coldFilter(brightness = 1f, grayscale = 0.7f))
        PkwText(if (locked) "About $estimate KEEP melting today · an estimate" else "About $estimate more melting today · an estimate",
            PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch2)
    }
}

/**
 * The DestinationRow (SPEC §4): cream 60 dp, the drawn wallet, "To your wallet" / "{walletLabel} · details", and the
 * chevron. The whole row is one 60 dp target (opens [WalletDetailsSheet]). No address, no network words.
 */
@Composable private fun DestinationRow(walletLabel: String?, onDetails: () -> Unit, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    val label = walletLabel?.takeIf { it.isNotBlank() } ?: "your wallet"
    Row(modifier.fillMaxWidth().heightIn(min = 60.dp).sceneInputRegion()
        .clearAndSetSemantics { contentDescription = "To your wallet, $label. Details"; role = Role.Button
            onClick(label = "Wallet details") { onDetails(); true } }
        .clickable(role = Role.Button, onClick = onDetails)
        .drawBehind {
            drawRect(c.ink)
            val i = 2.dp.toPx()
            drawRect(c.cream, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
            drawRect(c.creamLo, Offset(i, size.height - i - 4.dp.toPx()), Size(size.width - 2 * i, 4.dp.toPx()))
        }.padding(start = 10.dp, end = 4.dp, top = 4.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        WalletGlyph()
        Column(Modifier.weight(1f)) {
            PkwText("To your wallet", PkwTokens.Type.body, color = c.textOnParch)
            PkwText("$label · details", PkwTokens.Type.small, color = c.textOnParch2)
        }
        Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { Chevron() }
    }
}

/** The wallet tag on the Seal's get side: the wallet app name upper-cased without "WALLET" ("SEEKER", "PHANTOM"). */
fun walletTag(walletLabel: String?): String {
    val t = walletLabel?.trim()?.uppercase().orEmpty().removeSuffix(" WALLET").trim()
    return t.ifEmpty { "WALLET" }
}

/** The shown claim seal and the stage it is at. */
private data class ClaimSealShown(val seal: ClaimSealUi, val stage: MoneyStage, val walletLabel: String?, val failure: MoneyFailure?)

/**
 * The claim Seal (SPEC §4c, `claim-wallet.png`): "CLAIM {n} KEEP", KEEP → the wallet (no address), BACK + gold CLAIM
 * arming over 450 ms. After the armed tap (stage CHECK_WALLET) the lower half shows the steps Confirm ✓ · Wallet · Sent,
 * "Approve the claim in your wallet", BACK (cancels waiting) + stone "Check wallet", and "Wallet didn't open?" + blue
 * OPEN AGAIN (the same prepared claim; never a second one). SENDING locks BACK. A FAILED stage shows the outcome line
 * ([forgeOutcomeLine]: only a refusal says nothing was sent) with RETRY (refused) or OPEN AGAIN (uncertain).
 *
 * Pointer rule: compose it always from the OverlayHost; it is full-screen (55 % scrim) only while [ClaimUi.seal] is set
 * and while it animates out. A scrim tap is BACK, ignored while sending.
 */
@Composable fun ClaimSeal(ui: ClaimUi?, on: ClaimActions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    val c = PkwTokens.Colors
    val seal = ui?.seal
    val shown = if (ui == null || seal == null) null else ClaimSealShown(seal, ui.stage, ui.walletLabel, ui.failure)
    ForgeSeal(shown, { "CLAIM ${it.seal.amount} KEEP" }, { s -> if (s.stage != MoneyStage.SENDING) on.onBack() }, modifier, onExitFinished) { s, active ->
        PayGet(left = { SealSide("gf:keep_48", s.seal.amount, "KEEP") }, right = {
            WalletGlyph()
            Spacer(Modifier.height(4.dp))
            PkwText(walletTag(s.walletLabel), PkwTokens.Type.caption, color = c.textOnParch)
            PkwText("your wallet", PkwTokens.Type.small, color = c.textOnParch2)
        })
        when (s.stage) {
            MoneyStage.READY, MoneyStage.SENT -> {
                PkwText("No game fee. You approve once in your wallet.", PkwTokens.Type.body, color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 2)
                SealButtons(active, on.onBack) {
                    ArmingButton("CLAIM", s.seal.armedAtMs, active && s.stage == MoneyStage.READY, on.onConfirm, clock, Modifier.weight(1f))
                }
            }
            MoneyStage.CHECK_WALLET, MoneyStage.SENDING ->
                WalletStep(s.stage, "claim", "CLAIM", active, on.onBack, on.onReopenWallet, sendingLine = "Your coins are on their way.")
            MoneyStage.FAILED -> {
                val failure = s.failure ?: MoneyFailure.UNCERTAIN
                StepDots(1)
                PkwText(forgeOutcomeLine("claim", failure), PkwTokens.Type.lead, color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                SealButtons(active, on.onBack) {
                    if (failure == MoneyFailure.REFUSED) MoneyButton(MoneyStage.FAILED, "CLAIM", { if (active) on.onRetry() }, Modifier.weight(1f))
                    else SecondaryButton("OPEN AGAIN", { if (active) on.onReopenWallet() }, Modifier.weight(1f), verb = Verb.BLUE)
                }
            }
        }
    }
}

/**
 * The Seal's wallet step (SPEC §4c, reused by §5b): Confirm ✓ · Wallet · Sent, "Approve the {what} in your wallet",
 * "Nothing moves until you approve there.", BACK (cancels waiting) + the stone money button, and the OPEN AGAIN row.
 * SENDING moves the dots to Sent, locks BACK and drops OPEN AGAIN.
 */
@Composable internal fun WalletStep(stage: MoneyStage, what: String, label: String, active: Boolean, onBack: () -> Unit, onReopen: () -> Unit,
    sendingLine: String) {
    val c = PkwTokens.Colors
    val sending = stage == MoneyStage.SENDING
    StepDots(if (sending) 2 else 1)
    PkwText(if (sending) "Sending the $what" else "Approve the $what in your wallet", PkwTokens.Type.lead, color = c.textOnParch,
        textAlign = TextAlign.Center, maxLines = 2)
    PkwText(if (sending) sendingLine else "Nothing moves until you approve there.", PkwTokens.Type.small,
        color = c.textOnParch2, textAlign = TextAlign.Center)
    SealButtons(active && !sending, onBack) { MoneyButton(stage, label, {}, Modifier.weight(1f)) }
    if (!sending) ReopenRow(active, onReopen)
}

/** BACK (stone, 100 dp) + the seal's right-hand primary. */
@Composable internal fun SealButtons(backEnabled: Boolean, onBack: () -> Unit, primary: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        SecondaryButton("BACK", onBack, Modifier.width(PkwTokens.Dims.sealBackW), enabled = backEnabled)
        primary()
    }
}

/** "Wallet didn't open?" + blue OPEN AGAIN 150 × 48 (SPEC §4c; critic §3 made it a real button). */
@Composable internal fun ReopenRow(active: Boolean, onReopen: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        PkwText("Wallet didn't open?", PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch2)
        SecondaryButton("OPEN AGAIN", { if (active) onReopen() }, Modifier.width(150.dp), verb = Verb.BLUE)
    }
}

/** The WalletDetails half sheet (SPEC §4 New parts; not mocked). */
@Immutable data class WalletDetailsUi(
    /** "Seeker wallet"; null reads "Your wallet". */
    val walletLabel: String?,
    /** The last four characters of the address: the ONLY place any part of it appears. */
    val last4: String?,
)

/** WalletDetails callbacks. */
@Immutable data class WalletDetailsActions(
    val onClose: () -> Unit = {},
    /** Blue "Change wallet": GO to Profile › WALLET. */
    val onChangeWallet: () -> Unit = {},
    /** Stone "Past collections": opens `WalletHistory(home = "goldforge")`. */
    val onPastCollections: () -> Unit = {},
)

/**
 * The WalletDetails half sheet: wallet name, "ends {last4}", a blue Change wallet and a stone Past collections. No
 * network or fee text.
 *
 * Pointer rule: a HALF sheet (kit [SheetFrame]): a painted panel with no scrim; the scene's own tap closes it.
 */
@Composable fun WalletDetailsSheet(ui: WalletDetailsUi, on: WalletDetailsActions, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    SheetFrame(SheetFrameUi("YOUR WALLET", null, SheetSize.HALF, emptyList(), null), on.onClose, modifier, scrollState = null) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            WalletGlyph()
            Column(Modifier.weight(1f)) {
                PkwText(ui.walletLabel?.takeIf { it.isNotBlank() } ?: "Your wallet", PkwTokens.Type.body, color = c.textOnParch)
                ui.last4?.let { PkwText("ends $it", PkwTokens.Type.small, color = c.textOnParch2) }
            }
        }
        SecondaryButton("CHANGE WALLET", on.onChangeWallet, Modifier.fillMaxWidth(), verb = Verb.BLUE)
        SecondaryButton("PAST COLLECTIONS", on.onPastCollections, Modifier.fillMaxWidth())
    }
}

@Preview(name = "CLAIM: ready", widthDp = 398, heightDp = 760)
@Composable private fun ClaimReadyPreview() = ClaimPreviewFrame(GoldForgeSamples.claimReady)

@Preview(name = "CLAIM: ready, collecting not open yet", widthDp = 398, heightDp = 760)
@Composable private fun ClaimClosedPreview() = ClaimPreviewFrame(GoldForgeSamples.claimReady.copy(
    closedReason = gg.pixelkingdomwars.nativeclient.ui.goldforge.GOLD_FORGE_CLAIM_CLOSED))

@Preview(name = "CLAIM: not open yet (locked)", widthDp = 398, heightDp = 760)
@Composable private fun ClaimLockedPreview() = ClaimPreviewFrame(GoldForgeSamples.claimLocked)

@Preview(name = "CLAIM: loading", widthDp = 398, heightDp = 760)
@Composable private fun ClaimLoadingPreview() = ClaimPreviewFrame(GoldForgeSamples.claimReady.copy(phase = ClaimPhase.LOADING, ready = "…", estimate = null))

@Preview(name = "CLAIM: first read failed", widthDp = 398, heightDp = 760)
@Composable private fun ClaimErrorPreview() = ClaimPreviewFrame(GoldForgeSamples.claimReady.copy(phase = ClaimPhase.ERROR, ready = "…"))

@Preview(name = "CLAIM: wallet step behind the seal", widthDp = 398, heightDp = 760)
@Composable private fun ClaimWalletPreview() = ClaimPreviewFrame(GoldForgeSamples.claimReady.copy(stage = MoneyStage.CHECK_WALLET))

@Preview(name = "CLAIM: sent (moss, tray empty)", widthDp = 398, heightDp = 760)
@Composable private fun ClaimSentPreview() = ClaimPreviewFrame(GoldForgeSamples.claimReady.copy(stage = MoneyStage.SENT))

@Preview(name = "CLAIM: all collected", widthDp = 398, heightDp = 760)
@Composable private fun ClaimCollectedPreview() = ClaimPreviewFrame(GoldForgeSamples.claimReady.copy(phase = ClaimPhase.COLLECTED, ready = "0"))

@Preview(name = "CLAIM: wallet refused (RETRY)", widthDp = 398, heightDp = 760)
@Composable private fun ClaimRefusedPreview() = ClaimPreviewFrame(GoldForgeSamples.claimReady.copy(stage = MoneyStage.FAILED, failure = MoneyFailure.REFUSED))

@Preview(name = "CLAIM: result uncertain (Checking…)", widthDp = 398, heightDp = 760)
@Composable private fun ClaimUncertainPreview() = ClaimPreviewFrame(GoldForgeSamples.claimReady.copy(stage = MoneyStage.FAILED, failure = MoneyFailure.UNCERTAIN))

@Preview(name = "CLAIM: saved claim found", widthDp = 398, heightDp = 760)
@Composable private fun ClaimSavedPreview() = ClaimPreviewFrame(GoldForgeSamples.claimReady.copy(canResumeSaved = true))

@Preview(name = "CLAIM seal: arming", widthDp = 412, heightDp = 700)
@Composable private fun ClaimSealPreview() = ClaimSeal(GoldForgeSamples.claimReady.copy(seal = ClaimSealUi("1,240", 0L)), ClaimActions(), clock = { 225L })

@Preview(name = "CLAIM seal: wallet step", widthDp = 412, heightDp = 700)
@Composable private fun ClaimSealWalletPreview() = ClaimSeal(GoldForgeSamples.claimReady.copy(seal = ClaimSealUi("1,240", 0L),
    stage = MoneyStage.CHECK_WALLET), ClaimActions())

@Preview(name = "CLAIM seal: refused", widthDp = 412, heightDp = 700)
@Composable private fun ClaimSealRefusedPreview() = ClaimSeal(GoldForgeSamples.claimReady.copy(seal = ClaimSealUi("1,240", 0L),
    stage = MoneyStage.FAILED, failure = MoneyFailure.REFUSED), ClaimActions())

@Preview(name = "Wallet details (half sheet)", widthDp = 412, heightDp = 360)
@Composable private fun WalletDetailsPreview() {
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg), contentAlignment = Alignment.BottomCenter) {
        WalletDetailsSheet(WalletDetailsUi("Seeker wallet", "8f2K"), WalletDetailsActions(), Modifier.fillMaxWidth())
    }
}

@Composable private fun ClaimPreviewFrame(ui: ClaimUi) {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f, fill = true)) { ClaimBody(ui, ClaimActions()) }
        ClaimFooter(ui, ClaimActions())
    }
}
