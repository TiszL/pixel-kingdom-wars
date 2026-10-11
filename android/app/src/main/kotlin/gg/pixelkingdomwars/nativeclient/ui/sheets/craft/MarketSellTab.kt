package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyName
import gg.pixelkingdomwars.nativeclient.ui.kit.tileCount
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileState
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import java.util.Locale

/*
 * Design component: Market › SELL (craft/SPEC.md §3.3, market-sell.png): YOUR STORES strip (counts = available; reserved
 * units are never sellable), the lowest-lot info card, HOW MANY and PRICE EACH wide steppers (price steps one server
 * tick; a hold repeats every 80 ms after 400 ms), the ProceedsRow (fee from the server's feeBps, rounded so "You get"
 * never flatters), and LIST. Listing moves no money, so it uses the review half sheet, not a Seal.
 *
 * Pointer rule: drawn inside the Market sheet's painted panel; only tiles, steppers and the primary take touches.
 */

/** One sellable stock entry (`sellable[{itemId, available, reserved}]`). */
@Immutable data class SellableUi(val itemId: String, val available: Long?, val reserved: Long?)

/** Listing slots (`slots{used, max}`); null on the sheet = no limit (the slot UI hides). */
@Immutable data class MarketSlotsUi(val used: Int, val max: Int)

/** Market › SELL state (SPEC §3.3; fields after `listingAllowed` were added). Prices are base units with [decimals]. */
@Immutable data class MarketSellUi(
    val sellable: List<SellableUi>,
    val selectedItemId: String?,
    /** The chosen quantity (clamped to 1..available). */
    val qty: Long,
    /** Price per unit, base units; null = not set yet. */
    val unitPrice: Long?,
    /** The server's price tick, base units. */
    val tick: Long?,
    /** The cheapest lot of this item now, base units; null = none listed. */
    val lowestOffer: Long?,
    /** Market fee in basis points (server); null = unknown ("…"). */
    val feeBps: Int?,
    val slots: MarketSlotsUi?,
    /** False = no deeded kingdom selected: "Pick a kingdom you own to list." */
    val listingAllowed: Boolean,
    val decimals: Int = 9,
    val currency: Currency = Currency.KEEP,
    val items: Map<String, CraftItemUi> = emptyMap(),
    val hydration: CraftHydration = CraftHydration.Ready,
    /** The LIST request's state. */
    val submit: SubmitUi = SubmitUi(busyLabel = "Listing"),
    /** Deeds only: the royalty in basis points for the "{royalty}% royalty" line. */
    val royaltyBps: Int? = null,
)

/** Market › SELL callbacks (SPEC §3.3). */
@Immutable data class MarketSellActions(
    val onSelectItem: (String) -> Unit = {},
    /** ±1; the view model clamps to 1..available. */
    val onQty: (Long) -> Unit = {},
    /** ±1 tick (`stepPrice`). */
    val onPrice: (direction: Int) -> Unit = {},
    /** Opens the review half sheet (`listReview`), whose confirm submits. */
    val onList: () -> Unit = {},
)

/** The SELL body. */
@Composable internal fun ColumnScope.MarketSellBody(ui: MarketSellUi, on: MarketSheetActions) {
    val c = PkwTokens.Colors
    if (ui.sellable.isEmpty() && ui.hydration != CraftHydration.Loading) {
        EmptyState(EmptyStateUi("ui:market-menu", "Nothing to list yet", "Refined materials and kits you hold can be listed here.", null, null), onGo = {})
        return
    }
    val known = ui.hydration != CraftHydration.Loading
    val selected = selectedSellable(ui)
    SectionLabel("YOUR STORES", "tap one to list it")
    TileStrip(ui.sellable.map { s ->
        val item = ui.items[s.itemId]
        val available = if (known) s.available else null
        RecipeTile(ItemTileUi(s.itemId, item?.icon ?: craftItemIcon(s.itemId), available?.let { "x" + tileCount(it) } ?: "…",
            "${item?.name ?: s.itemId}, ${available ?: "count unknown"} free to list",
            if (s.itemId == selected?.itemId) ItemTileState.SELECTED else ItemTileState.OWNED), false)
    }, on.sell.onSelectItem)
    val item = selected?.let { ui.items[it.itemId] }
    val name = item?.name ?: selected?.itemId ?: "…"
    if (selected != null) {
        CreamCard(Modifier.fillMaxWidth().heightIn(min = 76.dp), contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 8.dp, bottom = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Well(64.dp) { CraftIcon(item?.icon ?: craftItemIcon(selected.itemId), 64.dp) }
                Column(Modifier.weight(1f)) {
                    PkwText(name.uppercase(Locale.US), PkwTokens.Type.label, color = c.textOnParch)
                    PkwText(ui.lowestOffer?.let { "Lowest lot now: ${formatUnits(it, ui.decimals)} ${currencyName(ui.currency)} each" } ?: "No lots of it listed now",
                        PkwTokens.Type.small, color = c.textOnParch2)
                    PkwText("You hold ${groupDigits(if (known) selected.available else null)}.", PkwTokens.Type.small, color = c.textOnParch2)
                }
            }
        }
        val qty = sellQuantity(ui)
        val available = selected.available
        SectionLabel("HOW MANY")
        WideStepper(item?.icon ?: craftItemIcon(selected.itemId), groupDigits(qty), "of ${groupDigits(if (known) available else null)}",
            { on.sell.onQty(-1L) }, { on.sell.onQty(1L) }, "quantity", minusEnabled = qty > 1L, plusEnabled = available != null && qty < available)
        SectionLabel("PRICE EACH")
        val tick = ui.tick
        WideStepper(currencyIcon(ui.currency), formatUnits(ui.unitPrice, ui.decimals), currencyName(ui.currency),
            { on.sell.onPrice(-1) }, { on.sell.onPrice(1) }, "price", repeat = true,
            minusEnabled = tick != null && (ui.unitPrice ?: 0L) > tick, plusEnabled = tick != null)
        val (get, line) = proceedsLines(ui)
        CreamCard(Modifier.fillMaxWidth().heightIn(min = 52.dp), rim = CardRim.NOTE, contentPadding = PaddingValues(start = 8.dp, top = 4.dp, end = 8.dp, bottom = 6.dp)) {
            Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PkwIcon(currencyIcon(ui.currency), 24.dp)
                Column {
                    PkwText(get, PkwTokens.Type.body, color = c.textOnParch)
                    PkwText(line, PkwTokens.Type.small, color = c.textOnParch2)
                }
            }
        }
    }
}

/** The SELL footer: the full-width LIST and the note. */
@Composable internal fun ColumnScope.MarketSellFooter(ui: MarketSellUi, on: MarketSheetActions, primary: CraftPrimaryUi?) {
    if (primary != null) {
        CraftPrimaryButton(primary, { action ->
            when (action) {
                PrimaryAction.START -> on.sell.onList()
                PrimaryAction.OPEN_ORDERS -> on.onTab(MarketTab.ORDERS)
                PrimaryAction.RETRY -> on.onRetry()
                else -> Unit
            }
        }, Modifier.fillMaxWidth())
    }
    val notice = submitNotice(ui.submit) ?: (ui.hydration as? CraftHydration.Error)?.message
    if (notice != null) FooterNote(notice, danger = true)
    else FooterNote("Listed items leave your stores. Take back unsold ones any time.")
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Preview(name = "Market › SELL (market-sell.png)", widthDp = 412, heightDp = 811)
@Composable private fun SellPreview() = MarketPreviewHost(CraftSamples.market(sell = CraftSamples.sell))

@Preview(name = "Market › SELL review half sheet", widthDp = 412, heightDp = 811)
@Composable private fun SellReviewPreview() = MarketPreviewHost(CraftSamples.market(sell = CraftSamples.sell).copy(review = listReview(CraftSamples.sell)))

@Preview(name = "Market › SELL slots full", widthDp = 412, heightDp = 811)
@Composable private fun SellSlotsFullPreview() = MarketPreviewHost(CraftSamples.market(sell = CraftSamples.sell.copy(slots = MarketSlotsUi(5, 5))))

@Preview(name = "Market › SELL no deeded kingdom (locked)", widthDp = 412, heightDp = 811)
@Composable private fun SellLockedPreview() = MarketPreviewHost(CraftSamples.market(sell = CraftSamples.sell.copy(listingAllowed = false)))

@Preview(name = "Market › SELL loading", widthDp = 412, heightDp = 811)
@Composable private fun SellLoadingPreview() = MarketPreviewHost(CraftSamples.market(sell = CraftSamples.sell.copy(hydration = CraftHydration.Loading)))

@Preview(name = "Market › SELL refused (authoritative)", widthDp = 412, heightDp = 811)
@Composable private fun SellRefusedPreview() = MarketPreviewHost(CraftSamples.market(sell = CraftSamples.sell.copy(
    submit = SubmitUi(SubmitStage.REFUSED, message = "The price moved under the market floor. Nothing was listed."))))

@Preview(name = "Market › SELL empty", widthDp = 412, heightDp = 811)
@Composable private fun SellEmptyPreview() = MarketPreviewHost(CraftSamples.market(sell = CraftSamples.sell.copy(sellable = emptyList())))
