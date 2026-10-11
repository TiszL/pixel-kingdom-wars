package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton

/*
 * Design component: Berth › SERVICE, RE-DONE (design/final/voyage/berth-service.png; SPEC "Round 2 additions — Part two:
 * network cost only inside the Seal"). The body is unchanged (the committed `BerthServiceBody`: vehicle chips, the hero
 * card with the trips meter, RESTORE / UPGRADE cards, YOU HAND IN). What changed: the pinned primary's sub-line was
 * "network fee about 0.00002 SOL"; it is now "uses up 1 Cargo Cutter T2" (what the player gives, in game language), for
 * UPGRADE too ([servicePrimaryV2], [BerthServiceFooterV2]); the cost moved into the service Seal's fine print
 * ([serviceSealV2] → [VoyageSealV2], the same box as the install Seal). Replaces `BerthServiceFooter` and the service use
 * of `VoyageSeal.kt`.
 *
 * Errors (design correction 7): only an authoritative refusal says nothing was sent; an uncertain result says it is
 * being checked and keeps CHECK (the by-key read), never a fresh request.
 *
 * Pointer rule: the footer is drawn inside the Berth sheet's painted panel; only the primary (or CHECK) takes touches.
 * The service Seal is the OverlayHost's: full-screen with its 55 % scrim only while shown; a scrim tap is BACK.
 */

/** The pinned RESTORE TRIPS / UPGRADE TO Tn ("uses up 1 Cargo Cutter T2"), the money sequence while it runs, or CHECK
 *  after an uncertain result. */
@Composable fun ColumnScope.BerthServiceFooterV2(ui: BerthServiceUi, on: BerthServiceActions) {
    val c = PkwTokens.Colors
    val v = ui.installed.firstOrNull { it.installationId == ui.selectedInstallationId } ?: ui.installed.firstOrNull() ?: return
    val opt = ui.options.firstOrNull { it.op == ui.selectedOp }
    val look = servicePrimaryV2(ui.selectedOp, opt?.available ?: false, opt?.reason, opt?.resultTier, ui.handIn != null, vehicleTitle(v),
        v.status == VehicleStatus.AWAY, v.returnsAt?.let { "Service when it is docked · back $it" }) ?: return
    val error = ui.error
    when (ui.sealState) {
        VoyageSealState.CHECK_WALLET, VoyageSealState.SENDING, VoyageSealState.SENT ->
            MoneyButton(moneyStage(ui.sealState), look.label, {}, Modifier.fillMaxWidth())
        VoyageSealState.ERROR -> {
            // No error detail = not known to be an authoritative refusal: CHECK (by-key read), never a fresh request.
            if (error == null || error.recoverable) SecondaryButton("CHECK", on.onRecover, Modifier.fillMaxWidth(), contentDescription = "Check the service request")
            else MoneyButton(moneyStage(ui.sealState), look.label, on.onServiceConfirm, Modifier.fillMaxWidth())
            if (error != null) PkwText(moneyErrorLine(error), PkwTokens.Type.small, Modifier.fillMaxWidth(),
                color = if (error.authoritative) c.shortText else c.textOnParch2, textAlign = TextAlign.Center, maxLines = 2)
        }
        VoyageSealState.IDLE, VoyageSealState.ARMED ->
            PrimaryButton(look.label, on.onServiceConfirm, Modifier.fillMaxWidth(), verb = look.verb, sub = look.sub, state = look.state, reason = look.reason)
    }
}

/**
 * The re-done service Seal, for the OverlayHost: [serviceSealV2] of the SERVICE state while [shown], drawn by
 * [VoyageSealV2] (keep composing it with `shown = false` through its exit).
 *
 * Pointer rule: full-screen with its 55 % scrim only while shown or animating out; a scrim tap is BACK.
 */
@Composable fun BerthServiceSealV2(ui: BerthServiceUi?, shown: Boolean, armedAtMs: Long, on: VoyageSealV2Actions, modifier: Modifier = Modifier,
    shortLine: String? = null, pausedReason: String? = null, clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    VoyageSealV2(if (shown && ui != null) serviceSealV2(ui, armedAtMs, shortLine, pausedReason) else null, on, modifier, clock, onExitFinished)
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Composable private fun ServicePreviewHost(ui: BerthServiceUi, seal: Boolean = false) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        BerthSheetServiceV2Preview(ui)
        if (seal) BerthServiceSealV2(ui, shown = true, armedAtMs = 0L, on = VoyageSealV2Actions(), clock = { 10_000L })
    }
}

/** The committed Berth frame with SERVICE selected and the re-done footer (what the one-line wiring change produces). */
@Composable private fun BerthSheetServiceV2Preview(ui: BerthServiceUi) {
    gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame(
        gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi("BERTH", null, gg.pixelkingdomwars.nativeclient.ui.model.SheetSize.TALL,
            berthTabs(VoyageR2Samples.berth(tab = BerthSheetUi.TAB_SERVICE, service = ui)), BerthSheetUi.TAB_SERVICE, titleTag = "LV 5", history = true),
        onClose = {}, modifier = Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp, top = PkwTokens.Dims.tallSheetTop),
        footer = { BerthServiceFooterV2(ui, BerthServiceActions()) }) {
        BerthServiceBody(ui, BerthServiceActions())
    }
}

@Preview(name = "Berth › SERVICE, re-done footer (berth-service.png)", widthDp = 412, heightDp = 915)
@Composable private fun ServiceV2Preview() = ServicePreviewHost(VoyageR2Samples.service)

@Preview(name = "Berth › SERVICE, UPGRADE selected", widthDp = 412, heightDp = 915)
@Composable private fun ServiceV2UpgradePreview() = ServicePreviewHost(VoyageR2Samples.service.copy(selectedOp = ServiceOp.UPGRADE))

@Preview(name = "Berth › SERVICE, hand-in missing", widthDp = 412, heightDp = 915)
@Composable private fun ServiceV2MissingPreview() = ServicePreviewHost(VoyageR2Samples.service.copy(handIn = null, walletCount = 0))

@Preview(name = "Berth › SERVICE Seal, network cost in the fine print", widthDp = 412, heightDp = 915)
@Composable private fun ServiceV2SealPreview() = ServicePreviewHost(VoyageR2Samples.service, seal = true)

@Preview(name = "Berth › SERVICE, uncertain (CHECK, being checked)", widthDp = 412, heightDp = 915)
@Composable private fun ServiceV2UncertainPreview() = ServicePreviewHost(VoyageR2Samples.service.copy(sealState = VoyageSealState.ERROR,
    error = VoyageMoneyErrorUi("The wallet didn't answer in time", authoritative = false)))

@Preview(name = "Berth › SERVICE, refused (authoritative RETRY)", widthDp = 412, heightDp = 915)
@Composable private fun ServiceV2RefusedPreview() = ServicePreviewHost(VoyageR2Samples.service.copy(sealState = VoyageSealState.ERROR,
    error = VoyageMoneyErrorUi("This Cutter is no longer in your wallet", authoritative = true)))
