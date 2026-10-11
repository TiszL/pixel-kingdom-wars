package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens

/*
 * Design component: Berth › FLEET › CHOOSE A <FAMILY> + install Seal, RE-DONE (design/final/voyage/berth-install.png;
 * SPEC "Round 2 additions — Part two: network cost only inside the Seal"). The picker body is unchanged (the committed
 * `BerthInstallBody`); what changed is the Seal: it no longer has a separate SOL-icon line "Network fee about 0.00002
 * SOL" — the network cost lives in the Seal's fine print ("Paid from your wallet with a tiny network cost (about 0.00002
 * SOL). You sign once."; "(network cost being checked)" while unknown; INSUFFICIENT_SOL turns the box rim #A3261A with
 * "Need about 0.00002 more SOL in your wallet" + blue GO to Profile › WALLET). States of SPEC §8 are otherwise unchanged.
 * Replaces the install use of `VoyageSeal.kt` (mounted by the OverlayHost): build the Seal with [installSealV2] and draw
 * it with [BerthInstallSealV2].
 *
 * Pointer rule: the Seal is full-screen with its 55 % scrim only while shown (a scrim tap is BACK, ignored while the
 * wallet works); with no seal nothing is composed. The picker stays inside the Berth sheet's painted panel.
 */

/** Everything the install Seal needs beyond the picker's [InstallUi] (the asset whose Seal is up and the money result). */
data class InstallSealArgs(
    /** The wallet vehicle whose card raised the Seal (`InstallUi.selectedAssetId`). */
    val asset: OwnedVehicleUi,
    /** Wall-clock ms the Seal was raised (re-stamp it when the fee review lands, so it arms 450 ms after the fee shows). */
    val armedAtMs: Long,
    /** The failed or uncertain step (state ERROR). */
    val error: VoyageMoneyErrorUi? = null,
    /** INSUFFICIENT_SOL: "Need about 0.00002 more SOL in your wallet". */
    val shortLine: String? = null,
    /** PAUSED: "Installs are paused. Your saved request is kept.". */
    val pausedReason: String? = null,
)

/** The install Seal for the picker's state: null while no card's Seal is up. */
fun installSealFor(ui: InstallUi, args: InstallSealArgs?): VoyageSealV2Ui? = args?.let {
    installSealV2(ui.family, it.asset, ui.feeSol, ui.sealState, it.armedAtMs, it.error, it.shortLine, it.pausedReason)
}

/**
 * The re-done install Seal, for the OverlayHost (keep composing it with null through its exit).
 *
 * Pointer rule: full-screen with its 55 % scrim only while shown or animating out; a scrim tap is BACK.
 */
@Composable fun BerthInstallSealV2(ui: InstallUi?, args: InstallSealArgs?, on: VoyageSealV2Actions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    VoyageSealV2(ui?.let { installSealFor(it, args) }, on, modifier, clock, onExitFinished)
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Composable private fun InstallPreviewHost(ui: InstallUi, args: InstallSealArgs?) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        BerthSheet(VoyageR2Samples.berth(install = ui), BerthSheetActions(),
            Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp, top = PkwTokens.Dims.tallSheetTop))
        BerthInstallSealV2(ui, args, VoyageSealV2Actions(), clock = { 10_000L })
    }
}

@Preview(name = "Berth › install Seal, network cost in the fine print (berth-install.png)", widthDp = 412, heightDp = 915)
@Composable private fun InstallV2Preview() = InstallPreviewHost(VoyageR2Samples.install, VoyageR2Samples.installArgs)

@Preview(name = "Berth › install Seal, network cost being checked", widthDp = 412, heightDp = 915)
@Composable private fun InstallV2FeeUnknownPreview() = InstallPreviewHost(VoyageR2Samples.install.copy(feeSol = null), VoyageR2Samples.installArgs)

@Preview(name = "Berth › install Seal, INSUFFICIENT_SOL", widthDp = 412, heightDp = 915)
@Composable private fun InstallV2ShortPreview() = InstallPreviewHost(VoyageR2Samples.install,
    VoyageR2Samples.installArgs.copy(shortLine = "Need about 0.00002 more SOL in your wallet"))

@Preview(name = "Berth › install Seal, sending", widthDp = 412, heightDp = 915)
@Composable private fun InstallV2SendingPreview() = InstallPreviewHost(VoyageR2Samples.install.copy(sealState = VoyageSealState.SENDING), VoyageR2Samples.installArgs)

@Preview(name = "Berth › install Seal, uncertain (CHECK)", widthDp = 412, heightDp = 915)
@Composable private fun InstallV2UncertainPreview() = InstallPreviewHost(VoyageR2Samples.install.copy(sealState = VoyageSealState.ERROR),
    VoyageR2Samples.installArgs.copy(error = VoyageMoneyErrorUi("The wallet didn't answer in time", authoritative = false)))

@Preview(name = "Berth › install picker, no Seal", widthDp = 412, heightDp = 915)
@Composable private fun InstallV2PickerPreview() = InstallPreviewHost(VoyageR2Samples.install.copy(selectedAssetId = null, sealState = VoyageSealState.IDLE), null)
