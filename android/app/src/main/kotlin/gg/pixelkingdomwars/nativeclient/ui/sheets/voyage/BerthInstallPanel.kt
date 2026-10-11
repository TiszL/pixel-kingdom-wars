package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.PixelShapes
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Berth › FLEET › CHOOSE A <FAMILY> (design/final/voyage/berth-install.png, SPEC §8, picker part): the
 * crafted vehicles of the selected empty family found in the wallet, as 120 × 122 asset cards. One tap on a card raises the
 * install Seal at once ([VoyageSeal], mounted by the OverlayHost); there is no separate primary on the picker. The FLEET
 * panel cross-fades to this picker in place (120 ms, [BerthSheet]).
 *
 * States: no matching assets (empty state with the family idle at 40 % + blue GO "Craft one at Solana Island"), loading
 * (dots, the last list kept), more pages (a stone MORE row at the end), the seal's money sequence and errors (shown by
 * [VoyageSeal]; a process death mid-sign reopens on the seal's recovery state, never a fresh INSTALL).
 *
 * Pointer rule: only the back square, the cards, MORE and GO take touches.
 */

/** Everything the install picker draws (SPEC §8 Data `InstallUi`; added fields after `sealState`). */
@Immutable data class InstallUi(
    /** The empty family being filled. */
    val family: VehicleFamily,
    /** Wallet vehicles of [family] (any tier). */
    val assets: List<OwnedVehicleUi>,
    /** The next page cursor; non-null draws MORE. */
    val cursor: String?,
    /** The card whose Seal is up (gold rim). */
    val selectedAssetId: String?,
    /** SPEC `feeLamportsEstimate`, formatted in SOL ("0.00002"); null = not reviewed yet ("…", INSTALL waits). */
    val feeSol: String?,
    /** Where the install stands (the card shows dots while CHECK_WALLET / SENDING). */
    val sealState: VoyageSealState,
    /** Added: the wallet list is loading. */
    val loading: Boolean = false,
)

/** The picker's callbacks (SPEC §8 Callbacks; the seal's own ones are on [VoyageSealActions]). */
@Immutable data class InstallActions(
    /** Back to FLEET. */
    val onBack: () -> Unit = {},
    /** A card: raise the install Seal for it. */
    val onPickAsset: (assetId: String) -> Unit = {},
    /** MORE: the next page. */
    val onMore: () -> Unit = {},
    /** The empty state's GO → Solana Island Public Workshop. */
    val onCraftLink: () -> Unit = {},
)

/** The picker body. */
@Composable fun ColumnScope.BerthInstallBody(ui: InstallUi, on: InstallActions) {
    val c = PkwTokens.Colors
    val short = familyShortName(ui.family)
    BackTitleRow("CHOOSE A ${short.uppercase()}", if (ui.loading) "From your wallet · …" else "From your wallet · ${ui.assets.size} found", on.onBack, "Back to fleet")
    if (ui.assets.isEmpty() && !ui.loading) {
        Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            VehicleSprite(ui.family, 1, 2, Modifier.size(96.dp, 96.dp), alpha = 0.4f)
            PkwText("No ${short.lowercase()}s in your wallet", PkwTokens.Type.body, color = c.textOnParch, textAlign = TextAlign.Center)
            SecondaryButton("GO", on.onCraftLink, Modifier.fillMaxWidth(), verb = Verb.BLUE, contentDescription = "Craft one at Solana Island")
            PkwText("Craft one at Solana Island", PkwTokens.Type.small, color = c.textOnParch2)
        }
        return
    }
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ui.assets.forEach { a -> AssetCard(ui.family, a, a.assetId == ui.selectedAssetId, ui.sealState) { on.onPickAsset(a.assetId) } }
        if (ui.loading) Box(Modifier.size(120.dp, 122.dp), contentAlignment = Alignment.Center) { BusyDots() }
    }
    if (ui.cursor != null) SecondaryButton("MORE", on.onMore, Modifier.fillMaxWidth(), contentDescription = "Show more ${short.lowercase()}s")
}

/** One 120 × 122 asset card: a sea well with the idle at k 2, the blue Tn tag and the family's short name. */
@Composable private fun AssetCard(family: VehicleFamily, asset: OwnedVehicleUi, selected: Boolean, sealState: VoyageSealState, onTap: () -> Unit) {
    val c = PkwTokens.Colors
    val busy = selected && (sealState == VoyageSealState.CHECK_WALLET || sealState == VoyageSealState.SENDING)
    Plate(PlateKind.CREAM, Modifier.width(120.dp).heightIn(min = 122.dp)
        .then(if (selected) Modifier.border(3.dp, c.gold.face, PixelShapes.M) else Modifier)
        .clearAndSetSemantics { contentDescription = "${familyName(family)} ${tierTag(asset.tier)}. Install it"; role = Role.Button
            this.selected = selected; onClick(label = null, action = { onTap(); true }) }
        .clickable(role = Role.Button, onClick = onTap), tint = if (selected) c.selectedTint else null) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            SeaWell(Modifier.fillMaxWidth().height(80.dp), waves = asset.assetId.hashCode()) {
                VehicleSprite(family, asset.tier, 2, Modifier.fillMaxSize())
                if (busy) BusyDots(Modifier.align(Alignment.BottomCenter).padding(bottom = 4.dp))
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Tag(tierTag(asset.tier), Verb.BLUE)
                PkwText(familyShortName(family), PkwTokens.Type.small, color = c.textOnParch)
            }
        }
    }
}
