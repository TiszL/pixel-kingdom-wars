package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.sealAccepts
import gg.pixelkingdomwars.nativeclient.ui.kit.sealArmFraction
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: the voyage Seal (design/final/voyage/berth-install.png, SPEC §8 seal, §9 primary, §3 permit): the kit
 * Seal's consent (DESIGN-SYSTEM §6 ConfirmDialog) with the cluster's pay → get art — a vehicle in a 64 dp sea well → the
 * family berth with that vehicle docked, or the "1 → 10 trips" meter, or the Tn+1 idle — the fee line ("Network fee about
 * 0.00002 SOL", "…" while unreviewed), "Paid from your wallet. You sign once.", stone BACK and the gold primary that arms
 * over 450 ms (taps before [sealAccepts] are ignored, never queued). Then the money sequence (DESIGN-SYSTEM §6): stone
 * "Check wallet" → dots "Sending" → moss SENT after the server's result. The kit Seal draws only currency tokens, so this
 * is the missing kit part for SOL actions that consume a vehicle (added in the cluster, built from kit parts).
 *
 * Errors (design correction 7): an authoritative refusal shows red RETRY and may say "Nothing was sent."; an uncertain one
 * (timeout, lost response, process death mid-sign) says it is being checked and offers CHECK (the by-key read), never a
 * fresh INSTALL. PAUSED is LOCKED "Installs are paused. Your saved request is kept."
 *
 * Pointer rule: the OverlayHost composes this only while a seal is shown; then (and only then) its root carries the kit
 * [ModalScrim] at the 55 % seal alpha. A scrim tap is BACK (never confirm) and is ignored while the wallet or server is
 * working. Back must cancel too (OverlayHost `BackHandlerAt`).
 */
@Immutable data class VoyageSealUi(
    /** PS title ("INSTALL SURVEY BALLOON", "RESTORE CARGO CUTTER", "REALM PERMIT"). */
    val title: String,
    /** What the player gives (the wallet vehicle, or SOL for a permit). */
    val pay: VoyageSealArtUi,
    /** What the player gets; null draws the pay side only. */
    val gets: VoyageSealArtUi?,
    /** VT lines ("Balloon T2 goes into this Berth for good. The wallet item is used up."). */
    val lines: List<String>,
    /** The fee in SOL ("0.00002"); null = not reviewed yet ("…", the primary waits). Hidden when [free]. */
    val feeSol: String?,
    /** The primary's label ("INSTALL", "RESTORE", "UPGRADE", "SEND"). */
    val confirmLabel: String,
    /** Wall-clock ms the seal was raised (it arms 450 ms later). */
    val armedAtMs: Long,
    /** Where the request stands. */
    val state: VoyageSealState,
    /** The failed or uncertain step (state ERROR). */
    val error: VoyageMoneyErrorUi? = null,
    /** `INSUFFICIENT_SOL`: the danger fee line ("Need about 0.00002 more SOL in your wallet"). */
    val feeShortLine: String? = null,
    /** `PAUSED`: the LOCKED reason ("Installs are paused. Your saved request is kept."). */
    val pausedReason: String? = null,
    /** The starter install if the server asks for a signature (SPEC §10): "Free · You sign once", no fee line. */
    val free: Boolean = false,
)

/** One side of the seal's pay → get. */
@Immutable data class VoyageSealArtUi(
    val kind: Kind,
    val family: VehicleFamily? = null,
    val tier: Int? = null,
    /** TRIPS: the meter's caption ("1 → 10 trips"); SOL: the amount ("0.03"). */
    val text: String? = null,
) {
    enum class Kind {
        /** The vehicle idle in a 64 dp sea well (k 2). */
        VEHICLE,
        /** The family berth with that vehicle docked, 88 × 120 well (k 2, 82 × 114 window). */
        BERTH,
        /** A full trips meter with its caption. */
        TRIPS,
        /** The SOL token and amount (a realm permit). */
        SOL,
    }
}

/** The seal's callbacks. */
@Immutable data class VoyageSealActions(
    /** The armed primary (INSTALL / RESTORE / UPGRADE / permit SEND). */
    val onConfirm: () -> Unit = {},
    /** BACK, a scrim tap or system Back (ignored by this composable while CHECK_WALLET / SENDING). */
    val onBack: () -> Unit = {},
    /** Red RETRY after an authoritative refusal. */
    val onRetry: () -> Unit = {},
    /** CHECK after an uncertain result (the by-key read). */
    val onRecover: () -> Unit = {},
)

/** The voyage seal. Compose it only while a seal is shown.
 *  Pointer rule: its root carries the kit ModalScrim (55 %) only while composed (a seal is modal); a scrim tap is BACK. */
@Composable fun VoyageSeal(ui: VoyageSealUi, on: VoyageSealActions, modifier: Modifier = Modifier, clock: () -> Long = { System.currentTimeMillis() }) {
    val c = PkwTokens.Colors
    val reduced = LocalReducedMotion.current
    val enter = remember { Animatable(if (reduced) 1f else 0f) }
    LaunchedEffect(Unit) { enter.animateTo(1f, tween(PkwTokens.Motion.SEAL_IN, easing = PkwTokens.Motion.Out)) }
    val working = ui.state == VoyageSealState.CHECK_WALLET || ui.state == VoyageSealState.SENDING
    val back: () -> Unit = { if (!working) on.onBack() }
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        ModalScrim(PkwTokens.Scrim.SEAL * enter.value, onTap = back)
        Plate(PlateKind.WOOD, Modifier.padding(horizontal = 24.dp).widthIn(max = 364.dp).fillMaxWidth()
            .semantics { paneTitle = ui.title; liveRegion = LiveRegionMode.Assertive }
            .graphicsLayer { alpha = enter.value; val s = if (reduced) 1f else 0.96f + 0.04f * enter.value; scaleX = s; scaleY = s }) {
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                Column(Modifier.fillMaxWidth().padding(6.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText(ui.title, PkwTokens.Type.title, color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        SealArt(ui.pay)
                        ui.gets?.let { PkwIcon("shape:go", 24.dp, tint = c.textOnParch); SealArt(it) }
                    }
                    ui.lines.forEach { PkwText(it, PkwTokens.Type.body, color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 3) }
                    if (ui.free) PkwText("Free · You sign once.", PkwTokens.Type.small, color = c.textOnParch2)
                    else {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            PkwIcon("sol", 24.dp)
                            PkwText(ui.feeShortLine ?: "Network fee about ${ui.feeSol ?: UNKNOWN} SOL", PkwTokens.Type.body,
                                color = if (ui.feeShortLine != null) c.danger else c.textOnParch2, maxLines = 2)
                        }
                        PkwText("Paid from your wallet. You sign once.", PkwTokens.Type.small, color = c.textOnParch2)
                    }
                    val error = ui.error
                    if (ui.state == VoyageSealState.ERROR && error != null) PkwText(moneyErrorLine(error), PkwTokens.Type.small, color = c.danger,
                        textAlign = TextAlign.Center, maxLines = 2)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        SecondaryButton("BACK", back, Modifier.width(PkwTokens.Dims.sealBackW), enabled = !working)
                        SealPrimary(ui, on, clock, Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

/** The primary for the current state (see [VoyageSeal]). */
@Composable private fun SealPrimary(ui: VoyageSealUi, on: VoyageSealActions, clock: () -> Long, modifier: Modifier) {
    val error = ui.error
    when {
        ui.pausedReason != null -> PrimaryButton(ui.confirmLabel, {}, modifier, state = CommandState.LOCKED, reason = ui.pausedReason)
        // No error detail = not known to be an authoritative refusal: offer the by-key CHECK, never a fresh send.
        ui.state == VoyageSealState.ERROR && (error == null || error.recoverable) ->
            PrimaryButton("CHECK", on.onRecover, modifier, verb = Verb.STONE)
        ui.state == VoyageSealState.ERROR -> MoneyButton(MoneyStage.FAILED, ui.confirmLabel, on.onRetry, modifier)
        ui.state == VoyageSealState.CHECK_WALLET || ui.state == VoyageSealState.SENDING || ui.state == VoyageSealState.SENT ->
            MoneyButton(moneyStage(ui.state), ui.confirmLabel, {}, modifier)
        !ui.free && ui.feeSol == null -> PrimaryButton("Checking fee", {}, modifier, verb = Verb.STONE, state = CommandState.BUSY)
        ui.feeShortLine != null -> PrimaryButton(ui.confirmLabel, {}, modifier, state = CommandState.DISABLED, reason = "Add SOL to your wallet first")
        else -> ArmingPrimary(ui, on.onConfirm, clock, modifier)
    }
}

/** The gold primary with its 450 ms arming bar (an ink bar fills inside the lip); taps before [sealAccepts] are ignored. */
@Composable private fun ArmingPrimary(ui: VoyageSealUi, onConfirm: () -> Unit, clock: () -> Long, modifier: Modifier) {
    val still = LocalInspectionMode.current
    val arm = remember(ui.armedAtMs) { Animatable(if (still) 1f else sealArmFraction(clock(), ui.armedAtMs)) }
    LaunchedEffect(ui.armedAtMs) {
        val remaining = ((1f - arm.value) * PkwTokens.Motion.SEAL_ARM).toInt()
        if (remaining > 0) arm.animateTo(1f, tween(remaining, easing = PkwTokens.Motion.Linear))
    }
    ChunkyBox(PkwTokens.Colors.gold, { if (sealAccepts(clock(), ui.armedAtMs)) onConfirm() }, ui.confirmLabel,
        modifier.heightIn(min = PkwTokens.Dims.secondaryH).drawWithContent {
            drawContent()
            val a = arm.value
            if (a < 1f) {
                val inset = 6.dp.toPx()
                drawRect(PkwTokens.Colors.ink, Offset(inset, size.height - 6.dp.toPx()), Size((size.width - 2 * inset) * a, 4.dp.toPx()))
            }
        }) {
        PkwText(ui.confirmLabel, PkwTokens.Type.primary, color = PkwTokens.Colors.label, outline = 2.dp)
    }
}

/** One side of pay → get. */
@Composable private fun SealArt(art: VoyageSealArtUi) {
    val c = PkwTokens.Colors
    when (art.kind) {
        VoyageSealArtUi.Kind.VEHICLE -> SeaWell(Modifier.size(64.dp)) {
            art.family?.let { VehicleSprite(it, art.tier, 2, Modifier.fillMaxSize()) }
        }
        VoyageSealArtUi.Kind.BERTH -> SeaWell(Modifier.size(88.dp, 120.dp)) {
            art.family?.let { f ->
                PixelSprite(berthArt(f), 2, Modifier.size(82.dp, 114.dp), 56f, 54f, bottomArtY = 94)
                VehicleSprite(f, art.tier, 2, Modifier.size(82.dp, 114.dp))
            }
        }
        VoyageSealArtUi.Kind.TRIPS -> Column(Modifier.width(96.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            TripsMeter(10, 10, Modifier.fillMaxWidth(), height = 14.dp)
            PkwText(art.text ?: UNKNOWN, PkwTokens.Type.small, color = c.textOnParch)
        }
        VoyageSealArtUi.Kind.SOL -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PkwIcon("sol", 48.dp)
            PkwText(art.text ?: UNKNOWN, PkwTokens.Type.numeralL, color = c.textOnParch)
        }
    }
}

private val sampleInstallSeal = VoyageSealUi("INSTALL SURVEY BALLOON",
    VoyageSealArtUi(VoyageSealArtUi.Kind.VEHICLE, VehicleFamily.SURVEY_BALLOON, 2),
    VoyageSealArtUi(VoyageSealArtUi.Kind.BERTH, VehicleFamily.SURVEY_BALLOON, 2),
    listOf("Balloon T2 goes into this Berth for good. The wallet item is used up."), "0.00002", "INSTALL", 0L, VoyageSealState.ARMED)

@Composable private fun SealPreviewHost(ui: VoyageSealUi) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) { VoyageSeal(ui, VoyageSealActions()) }
}

@Preview(name = "Voyage seal: install (berth-install.png)", widthDp = 412, heightDp = 640)
@Composable private fun VoyageSealInstallPreview() = SealPreviewHost(sampleInstallSeal)

@Preview(name = "Voyage seal: restore, sending", widthDp = 412, heightDp = 640)
@Composable private fun VoyageSealRestorePreview() = SealPreviewHost(sampleInstallSeal.copy(title = "RESTORE CARGO CUTTER",
    pay = VoyageSealArtUi(VoyageSealArtUi.Kind.VEHICLE, VehicleFamily.CARGO_CUTTER, 2),
    gets = VoyageSealArtUi(VoyageSealArtUi.Kind.TRIPS, text = "1 → 10 trips"),
    lines = listOf("A Cargo Cutter T2 from your wallet is used up. This Cutter keeps its berth."), confirmLabel = "RESTORE", state = VoyageSealState.SENDING))

@Preview(name = "Voyage seal: uncertain result (CHECK, no 'Nothing was sent')", widthDp = 412, heightDp = 640)
@Composable private fun VoyageSealUncertainPreview() = SealPreviewHost(sampleInstallSeal.copy(state = VoyageSealState.ERROR,
    error = VoyageMoneyErrorUi("The wallet didn't answer in time", authoritative = false)))

@Preview(name = "Voyage seal: wallet declined (authoritative)", widthDp = 412, heightDp = 640)
@Composable private fun VoyageSealDeclinedPreview() = SealPreviewHost(sampleInstallSeal.copy(state = VoyageSealState.ERROR,
    error = VoyageMoneyErrorUi("You declined in the wallet", authoritative = true)))

@Preview(name = "Voyage seal: fee unknown / short SOL / paused", widthDp = 412, heightDp = 640)
@Composable private fun VoyageSealFeePreview() = SealPreviewHost(sampleInstallSeal.copy(feeSol = null))

@Preview(name = "Voyage seal: not enough SOL", widthDp = 412, heightDp = 640)
@Composable private fun VoyageSealShortPreview() = SealPreviewHost(sampleInstallSeal.copy(feeShortLine = "Need about 0.00002 more SOL in your wallet"))

@Preview(name = "Voyage seal: installs paused", widthDp = 412, heightDp = 640)
@Composable private fun VoyageSealPausedPreview() = SealPreviewHost(sampleInstallSeal.copy(pausedReason = "Installs are paused. Your saved request is kept."))

@Preview(name = "Voyage seal: realm permit", widthDp = 412, heightDp = 640)
@Composable private fun VoyageSealPermitPreview() = SealPreviewHost(VoyageSealUi("REALM PERMIT",
    VoyageSealArtUi(VoyageSealArtUi.Kind.SOL, text = "0.03"), null, listOf("Realm permit for Cinderfall, this trip."), "0.000005", "SEND", 0L, VoyageSealState.ARMED))
