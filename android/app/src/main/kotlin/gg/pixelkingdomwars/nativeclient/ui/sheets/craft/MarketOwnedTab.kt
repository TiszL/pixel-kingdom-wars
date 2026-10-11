package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Market › OWNED (craft/SPEC.md §3.5, not mocked; same grammar): on-chain assets (land deeds now), each
 * row with the deed art, its royalty tag, "Trades on external marketplaces" and a blue OPEN (the system browser), plus
 * SELL for a deed (the SELL form with the SOL price). Empty: "No assets yet".
 *
 * Pointer rule: drawn inside the Market sheet's painted panel; only OPEN and SELL take touches.
 */

/** One owned on-chain asset. */
@Immutable data class OwnedAssetUi(
    val assetId: String,
    /** Its art (deeds: "itm_deed_earth"). */
    val icon: String,
    /** "LAND DEED #142". */
    val name: String,
    /** The royalty tag ("5% ROYALTY"); null draws none. */
    val royalty: String?,
    /** True when it can be listed from SELL (deeds). */
    val sellable: Boolean = false,
)

/** Market › OWNED state. */
@Immutable data class MarketOwnedUi(val assets: List<OwnedAssetUi>, val hydration: CraftHydration = CraftHydration.Ready)

/** Market › OWNED callbacks. */
@Immutable data class MarketOwnedActions(
    /** Opens the asset on an external marketplace in the system browser. */
    val onOpenExternal: (assetId: String) -> Unit = {},
    /** Opens SELL with this deed selected (SOL price, royalty line). */
    val onSellAsset: (assetId: String) -> Unit = {},
)

/** The OWNED body. */
@Composable internal fun ColumnScope.MarketOwnedBody(ui: MarketOwnedUi, on: MarketSheetActions) {
    val c = PkwTokens.Colors
    if (ui.assets.isEmpty() && ui.hydration != CraftHydration.Loading) {
        EmptyState(EmptyStateUi("itm_deed_earth", "No assets yet", "Land deeds you own appear here.", null, null), onGo = {})
        return
    }
    SectionLabel("OWNED", "on-chain, yours to keep or trade", groupDigits(ui.assets.size.toLong()))
    ui.assets.forEach { asset ->
        CreamCard(Modifier.fillMaxWidth().heightIn(min = 72.dp), contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 6.dp, bottom = 8.dp)) {
            Row(Modifier.align(Alignment.CenterStart).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Well(52.dp, flat = WELL_DARK) { CraftIcon(asset.icon, 32.dp) }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    PkwText(asset.name, PkwTokens.Type.caption, color = c.textOnParch)
                    PkwText("Trades on external marketplaces", PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
                    asset.royalty?.let { Tag(it, Verb.STONE) }
                }
                if (asset.sellable) GoButton({ on.owned.onSellAsset(asset.assetId) }, "Sell ${asset.name}", Modifier.size(64.dp, 48.dp), label = "SELL")
                GoButton({ on.owned.onOpenExternal(asset.assetId) }, "Open ${asset.name} on an external marketplace", Modifier.size(64.dp, 48.dp), label = "OPEN")
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Preview(name = "Market › OWNED", widthDp = 412, heightDp = 811)
@Composable private fun OwnedPreview() = MarketPreviewHost(CraftSamples.market(owned = CraftSamples.owned))

@Preview(name = "Market › OWNED empty", widthDp = 412, heightDp = 811)
@Composable private fun OwnedEmptyPreview() = MarketPreviewHost(CraftSamples.market(owned = MarketOwnedUi(emptyList())))
