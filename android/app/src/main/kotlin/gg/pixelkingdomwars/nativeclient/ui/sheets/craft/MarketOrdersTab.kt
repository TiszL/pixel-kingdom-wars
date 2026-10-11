package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Market › ORDERS (craft/SPEC.md §3.4, market-orders.png): SOLD rows (green, paid to the wallet), ON
 * SALE rows with a sold/listed bar and a stone TAKE BACK (or a gold PAYING tag while a buyer pays: a sale in progress
 * cannot be taken back), FREE SLOTS (hidden without a server limit), and SELL MORE. TAKE BACK confirms in the review half
 * sheet (`takeBackReview`), then the row shows dots until the server list drops it.
 *
 * Pointer rule: drawn inside the Market sheet's painted panel; only TAKE BACK and the primary take touches.
 */

/** A lot sold since the last visit (`sold[{listingId, itemId, qty, proceeds, currency, at}]`); amounts pre-formatted. */
@Immutable data class SoldOrderUi(
    val listingId: String,
    val itemId: String,
    val qty: Long,
    /** Proceeds as shown ("14.4"). */
    val proceeds: String,
    val currency: Currency,
    /** When, relative ("2h ago"). */
    val at: String,
)

/** An open listing's state (`state(OPEN|PAYING)`). */
enum class OpenOrderState { OPEN, PAYING }

/** One open listing (`open[{listingId, itemId, listed, sold, unitPrice, currency, state, baseId}]`). */
@Immutable data class OpenOrderUi(
    val listingId: String,
    val itemId: String,
    val listed: Long,
    val sold: Long,
    /** Unit price as shown ("1.9"). */
    val unitPrice: String,
    val currency: Currency,
    val state: OpenOrderState,
    val baseId: String,
)

/** Market › ORDERS state (SPEC §3.4; fields after `slots` were added). */
@Immutable data class MarketOrdersUi(
    val sold: List<SoldOrderUi>,
    val open: List<OpenOrderUi>,
    /** null = no slot limit (FREE SLOTS hides). */
    val slots: MarketSlotsUi?,
    val items: Map<String, CraftItemUi> = emptyMap(),
    /** Listings whose TAKE BACK is in flight (dots in place of the button). */
    val takingBack: Set<String> = emptySet(),
    val hydration: CraftHydration = CraftHydration.Ready,
)

/** Market › ORDERS callbacks (SPEC §3.4). */
@Immutable data class MarketOrdersActions(
    /** Opens the take-back review (`takeBackReview(order, item)`); its confirm takes the lot back. */
    val onTakeBack: (listingId: String) -> Unit = {},
    /** SELL MORE (also switches to SELL). */
    val onSellMore: () -> Unit = {},
    /** Called when the ORDERS tab leaves the screen (tab switch or close): the SOLD rows are now seen. */
    val onMarkSoldSeen: () -> Unit = {},
)

/** The ORDERS body. */
@Composable internal fun ColumnScope.MarketOrdersBody(ui: MarketOrdersUi, on: MarketSheetActions) {
    val c = PkwTokens.Colors
    val markSeen by rememberUpdatedState(on.orders.onMarkSoldSeen)
    DisposableEffect(Unit) { onDispose { markSeen() } }
    if (ui.sold.isEmpty() && ui.open.isEmpty() && ui.hydration != CraftHydration.Loading) {
        EmptyState(EmptyStateUi("ui:queue-status", "No orders yet", "List spare stock from SELL.", null, null), onGo = {})
        return
    }
    if (ui.sold.isNotEmpty()) {
        SectionLabel("SOLD", "paid to your wallet")
        ui.sold.forEach { order ->
            val item = ui.items[order.itemId]
            OrderRow(item?.icon ?: craftItemIcon(order.itemId), orderTitle(item?.name ?: order.itemId, order.qty), soldLine(order), CardRim.READY) {
                Tag("SOLD", Verb.MOSS)
            }
        }
    }
    if (ui.open.isNotEmpty()) {
        SectionLabel("ON SALE", right = ui.slots?.let { "${it.used} of ${it.max} slots" })
        ui.open.forEach { order ->
            val item = ui.items[order.itemId]
            OrderRow(item?.icon ?: craftItemIcon(order.itemId), orderTitle(item?.name ?: order.itemId, order.listed), openLine(order), CardRim.NONE,
                bar = if (order.state == OpenOrderState.OPEN) openProgress(order) else null) {
                when {
                    order.state == OpenOrderState.PAYING -> Tag("PAYING", Verb.GOLD)
                    order.listingId in ui.takingBack -> PrimaryButton("Taking back", {}, Modifier.width(114.dp), state = CommandState.BUSY)
                    else -> SecondaryButton("TAKE BACK", { on.orders.onTakeBack(order.listingId) }, Modifier.width(114.dp),
                        contentDescription = "Take back ${item?.name ?: order.itemId}")
                }
            }
        }
    }
    freeSlotsLine(ui.slots)?.let { line ->
        SectionLabel("FREE SLOTS")
        DashedBox { PkwText(line, PkwTokens.Type.body, Modifier.fillMaxWidth(), color = c.textOnParch2, textAlign = TextAlign.Center) }
    }
}

/** OrderRow (72 tall): a 52 well with the 32 item, PS 11 title, VT 18 line, an optional 12 dp bar, and a trailing slot. */
@Composable private fun OrderRow(icon: String, title: String, line: String, rim: CardRim, bar: Float? = null, trailing: @Composable () -> Unit) {
    val c = PkwTokens.Colors
    CreamCard(Modifier.fillMaxWidth().heightIn(min = 72.dp), rim = rim, contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 8.dp, bottom = 8.dp)) {
        Row(Modifier.align(Alignment.CenterStart).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Well(52.dp, flat = WELL_DARK) { CraftIcon(icon, 32.dp) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                PkwText(title, PkwTokens.Type.caption, color = c.textOnParch)
                PkwText(line, PkwTokens.Type.small, color = c.textOnParch2)
                if (bar != null) ProgressBar(bar, "$title: $line", Modifier.width(140.dp))
            }
            trailing()
        }
    }
}

/** The ORDERS footer: gold SELL MORE ("opens SELL") and the note. */
@Composable internal fun ColumnScope.MarketOrdersFooter(ui: MarketOrdersUi, on: MarketSheetActions) {
    CraftPrimaryButton(ordersPrimary(), { action ->
        if (action == PrimaryAction.OPEN_SELL) { on.orders.onSellMore(); on.onTab(MarketTab.SELL) }
    }, Modifier.fillMaxWidth())
    FooterNote(if (ui.open.any { it.state == OpenOrderState.PAYING }) "A sale in progress can't be taken back." else "Take back unsold lots any time.")
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Preview(name = "Market › ORDERS (market-orders.png)", widthDp = 412, heightDp = 811)
@Composable private fun OrdersPreview() = MarketPreviewHost(CraftSamples.market(orders = CraftSamples.orders, sold = true))

@Preview(name = "Market › ORDERS take-back review", widthDp = 412, heightDp = 811)
@Composable private fun OrdersTakeBackPreview() = MarketPreviewHost(CraftSamples.market(orders = CraftSamples.orders).copy(
    review = takeBackReview(CraftSamples.orders.open.first(), CraftSamples.items["frostglass"])))

@Preview(name = "Market › ORDERS taking back (busy)", widthDp = 412, heightDp = 811)
@Composable private fun OrdersBusyPreview() = MarketPreviewHost(CraftSamples.market(orders = CraftSamples.orders.copy(takingBack = setOf("l-1"))))

@Preview(name = "Market › ORDERS empty", widthDp = 412, heightDp = 811)
@Composable private fun OrdersEmptyPreview() = MarketPreviewHost(CraftSamples.market(orders = MarketOrdersUi(emptyList(), emptyList(), null)))
