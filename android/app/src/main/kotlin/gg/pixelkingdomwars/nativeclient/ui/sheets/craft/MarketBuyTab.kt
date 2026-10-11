package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Seal
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyName
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.tileCount
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import java.util.Locale

/*
 * Design component: Market › BUY (craft/SPEC.md §3.1 market-buy.png, §3.2 market-seal.png): the FilterChip row
 * (MATERIALS · TOOLS · FRAGMENTS in KEEP, DEEDS in SOL; a grid never mixes currencies), the LotGrid of LotTiles (new
 * ItemTile variant, SPEC 0.4), the LotCard of the selected lot, and the stepper + BUY primary with the money sequence.
 * The Seal itself is raised by the OverlayHost from `buySeal(…)` when BUY is tapped (money consents are not sheet state).
 *
 * Pointer rule: drawn inside the Market sheet's painted panel; only chips, lot tiles, MORE, steppers and the primary
 * take touches. Each FilterChip has a 48 dp hit area around its 40 dp face.
 */

/** One filter chip (MATERIALS, TOOLS, FRAGMENTS, DEEDS). */
@Immutable data class MarketCategoryUi(
    /** Category id handed back by `onCategory`. */
    val id: String,
    /** PS 11 label. */
    val label: String,
    /** Optional 24 dp icon (DEEDS: "sol"). */
    val icon: String? = null,
)

/** One lot (SPEC §3.1 `offers[…]`). Amounts are integers in base units with [decimals]. */
@Immutable data class MarketOfferUi(
    val offerId: String,
    val itemId: String,
    /** Units in the lot. */
    val quantity: Long,
    /** Price per unit, base units. */
    val unitPrice: Long,
    val decimals: Int,
    /** KEEP or SOL. */
    val currency: Currency,
    val sellerBaseId: String,
    /** The seller's kingdom name ("Ashford"). */
    val sellerName: String,
    /** The smallest purchase (≥ 1). */
    val minimumPurchase: Long,
    /** The player's own lot: "Your lot · manage it in ORDERS", no primary. */
    val isMine: Boolean,
)

/** The player's wallet as BUY needs it (`wallet{linked, keep?, sol?}` + base-unit balances added for the SHORT check). */
@Immutable data class MarketWalletUi(
    val linked: Boolean,
    /** Formatted KEEP balance; null = unknown. */
    val keep: String? = null,
    /** Formatted SOL balance; null = unknown. */
    val sol: String? = null,
    /** KEEP balance in base units; null = unknown (never SHORT). */
    val keepBaseUnits: Long? = null,
    /** SOL balance in lamports; null = unknown. */
    val solBaseUnits: Long? = null,
)

/** Market › BUY state (SPEC §3.1 `MarketUiState.Buy`; fields after `feeBps` were added). */
@Immutable data class MarketBuyUi(
    /** The active category id. */
    val category: String,
    /** Lots of that category, cheapest first (server order). */
    val offers: List<MarketOfferUi>,
    /** Non-null = more lots exist (MORE loads them). */
    val nextCursor: String?,
    val selectedOfferId: String?,
    /** The chosen quantity (clamped to the lot's bounds). */
    val quantity: Long,
    /** Held count by catalogue id. */
    val held: Map<String, Long>,
    val wallet: MarketWalletUi,
    /** The kingdom the order delivers to (recorded with the order; not drawn). */
    val deliveryBaseId: String?,
    /** False = wallet payments are not in this build. */
    val paymentsAvailable: Boolean,
    /** Market fee (server); not drawn on BUY. */
    val feeBps: Int?,
    val categories: List<MarketCategoryUi> = emptyList(),
    val items: Map<String, CraftItemUi> = emptyMap(),
    /** The total lot count for "48"; null draws none. */
    val totalLots: Long? = null,
    /** True while the next page loads (placeholders with "…" prices). */
    val loadingMore: Boolean = false,
    val hydration: CraftHydration = CraftHydration.Ready,
    /** The BUY money sequence (READY → CHECK_WALLET → SENDING → SENT "BOUGHT", or FAILED "RETRY"). */
    val money: MoneyStage = MoneyStage.READY,
)

/** Market › BUY callbacks (SPEC §3.1). */
@Immutable data class MarketBuyActions(
    val onCategory: (String) -> Unit = {},
    val onSelectOffer: (String) -> Unit = {},
    /** ±1; the view model clamps to the lot's bounds. */
    val onQty: (Long) -> Unit = {},
    /** BUY (and RETRY): the host raises `buySeal(offer, quantity, item, now)`; its BUY runs the wallet payment. */
    val onBuy: (offerId: String, quantity: Long) -> Unit = { _, _ -> },
    /** Loads the next page. */
    val onMore: () -> Unit = {},
    /** Reloads the lots. */
    val onRefresh: () -> Unit = {},
)

/** The BUY body. [offersLabel] is the visible name of the tab where the player's own lots are managed (round 2: OFFERS). */
@Composable internal fun ColumnScope.MarketBuyBody(ui: MarketBuyUi, on: MarketSheetActions, offersLabel: String = "ORDERS") {
    if (ui.categories.isNotEmpty()) {
        LazyRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), contentPadding = PaddingValues(end = 8.dp)) {
            items(ui.categories, key = { it.id }) { cat -> FilterChip(cat, cat.id == ui.category, on.buy.onCategory) }
        }
    }
    if (ui.offers.isEmpty() && ui.hydration != CraftHydration.Loading) {
        EmptyState(EmptyStateUi("ui:market-menu", "No lots right now", "List your own spare stock.", "GO TO SELL", FeatureId("market.trade")),
            onGo = { on.onTab(MarketTab.SELL) })
        return
    }
    SectionLabel("LOTS", "cheapest first", ui.totalLots?.let(::groupDigits))
    val selected = selectedOffer(ui)
    val tiles: List<MarketOfferUi?> = ui.offers + if (ui.loadingMore) List(4) { null } else emptyList()
    tiles.chunked(4).forEach { row ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            row.forEach { offer ->
                if (offer == null) LotPlaceholder(Modifier.weight(1f))
                else LotTile(offer, ui.items[offer.itemId], offer.offerId == selected?.offerId, on.buy.onSelectOffer, Modifier.weight(1f))
            }
            repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
        }
    }
    if (ui.nextCursor != null && !ui.loadingMore) SecondaryButton("MORE", on.buy.onMore, Modifier.fillMaxWidth(), contentDescription = "More lots")
    if (selected != null) LotCard(selected, ui.held[selected.itemId], ui.items[selected.itemId], ui.deliveryBaseId, offersLabel)
}

/** FilterChip (SPEC 0.5): a 40 dp face inside a 48 dp hit area; active = blue (navigation), inactive = parchment chip. */
@Composable private fun FilterChip(cat: MarketCategoryUi, active: Boolean, onSelect: (String) -> Unit) {
    val c = PkwTokens.Colors
    Box(Modifier.heightIn(min = PkwTokens.Dims.minTap).sceneInputRegion()
        .clearAndSetSemantics {
            contentDescription = cat.label; role = Role.Tab; selected = active
            onClick(label = null, action = { onSelect(cat.id); true })
        }
        .clickable(role = Role.Tab) { onSelect(cat.id) }, contentAlignment = Alignment.Center) {
        Row(Modifier.height(40.dp).drawBehind {
            val w = size.width; val h = size.height; val i = 2.dp.toPx()
            fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
            insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                drawRect(if (active) c.blue.face else c.cream)
                band(i, w - i, i, 2.dp.toPx(), if (active) c.blue.hi else c.parchmentHi)
                band(i, w - i, h - i - 3.dp.toPx(), 3.dp.toPx(), if (active) c.blue.lo else c.creamLo)
            }
        }.padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            cat.icon?.let { PkwIcon(it, 24.dp) }
            if (active) PkwText(cat.label, PkwTokens.Type.caption, color = c.label, outline = 1.dp)
            else PkwText(cat.label, PkwTokens.Type.caption, color = c.textOnParch)
        }
    }
}

/** LotTile (SPEC 0.4): CreamCard 85 × 104, the item at 64, a stone "x20" tag top-right, the currency 24 + unit price.
 *  Selected: gold rim. Its own target. */
@Composable private fun LotTile(offer: MarketOfferUi, item: CraftItemUi?, selected: Boolean, onSelect: (String) -> Unit, modifier: Modifier) {
    val c = PkwTokens.Colors
    val name = item?.name ?: offer.itemId
    val price = formatUnits(offer.unitPrice, offer.decimals, roundUp = true)
    Box(modifier.heightIn(min = 104.dp)) {
        CreamCard(Modifier.fillMaxWidth().heightIn(min = 104.dp)
            .clearAndSetSemantics {
                contentDescription = "$name, ${offer.quantity} in the lot, $price ${currencyName(offer.currency)} each"
                role = Role.Button; this.selected = selected
                onClick(label = null, action = { onSelect(offer.offerId); true })
            }
            .clickable(role = Role.Button) { onSelect(offer.offerId) },
            rim = if (selected) CardRim.SELECTED else CardRim.NONE, contentPadding = PaddingValues(start = 2.dp, top = 8.dp, end = 2.dp, bottom = 8.dp)) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                CraftIcon(item?.icon ?: craftItemIcon(offer.itemId), 64.dp)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    PkwIcon(currencyIcon(offer.currency), 24.dp)
                    PkwText(price, PkwTokens.Type.caption, color = c.textOnParch)
                }
            }
        }
        Tag("x" + tileCount(offer.quantity), Verb.STONE, Modifier.align(Alignment.TopEnd).offset(x = (-4).dp, y = 4.dp))
    }
}

/** A loading tile: parchment, "…" price (the frame never blanks). */
@Composable private fun LotPlaceholder(modifier: Modifier) {
    CreamCard(modifier.heightIn(min = 104.dp).clearAndSetSemantics { contentDescription = "Loading a lot" }) {
        PkwText(UNKNOWN, PkwTokens.Type.label, Modifier.align(Alignment.Center), color = PkwTokens.Colors.textOnParch2)
    }
}

/** LotCard (SPEC §3.1, CreamCard 76): the item at 64 in a well, "FROSTGLASS x20", the price + seller, what you hold.
 *  The player's own lot names the tab that manages it ([offersLabel]); a lot listed from another of the player's kingdoms
 *  can be managed only from that kingdom (the owner returns stock to where it came from). */
@Composable private fun LotCard(offer: MarketOfferUi, held: Long?, item: CraftItemUi?, deliveryBaseId: String?, offersLabel: String) {
    val c = PkwTokens.Colors
    val (first, lotSecond) = lotLines(offer, held, item)
    val second = when {
        !offer.isMine -> lotSecond
        offer.sellerBaseId == deliveryBaseId -> "Your lot · manage it in $offersLabel"
        else -> "Your listing · open the original kingdom to manage it."
    }
    CreamCard(Modifier.fillMaxWidth().heightIn(min = 76.dp), contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 8.dp, bottom = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Well(64.dp) { CraftIcon(item?.icon ?: craftItemIcon(offer.itemId), 64.dp) }
            Column(Modifier.weight(1f)) {
                PkwText(orderTitle(item?.name ?: offer.itemId, offer.quantity), PkwTokens.Type.label, color = c.textOnParch)
                PkwText(first, PkwTokens.Type.small, color = c.textOnParch2)
                PkwText(second, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
            }
        }
    }
}

/** The BUY footer: stepper ("of 20") + BUY, and the note. Hidden primary for the player's own lot. */
@Composable internal fun ColumnScope.MarketBuyFooter(ui: MarketBuyUi, on: MarketSheetActions, primary: CraftPrimaryUi?) {
    val offer = selectedOffer(ui)
    if (offer != null && primary != null) {
        val qty = buyQuantity(ui, offer)
        val (min, max) = buyBounds(offer)
        val stepper = ui.money == MoneyStage.READY && ui.wallet.linked && ui.hydration !is CraftHydration.Error
        Row(Modifier.fillMaxWidth().padding(top = if (primary.price != null) 14.dp else 0.dp), verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (stepper) QtyStepper(groupDigits(qty), "of ${groupDigits(max)}", { on.buy.onQty(-1L) }, { on.buy.onQty(1L) },
                ui.items[offer.itemId]?.name ?: "units", minusEnabled = qty > min, plusEnabled = qty < max)
            CraftPrimaryButton(primary, { action ->
                when (action) {
                    PrimaryAction.START -> on.buy.onBuy(offer.offerId, qty)
                    PrimaryAction.LINK_WALLET -> on.onLinkWallet()
                    PrimaryAction.NEED_MORE -> primary.price?.let(on.onNeedMore)
                    PrimaryAction.RETRY -> on.onRetry()
                    else -> Unit
                }
            }, Modifier.weight(1f))
        }
    }
    val error = (ui.hydration as? CraftHydration.Error)?.message
    when {
        error != null -> FooterNote(error, danger = true)
        offer?.currency == Currency.SOL -> FooterNote("Paid from your wallet in SOL. Arrives in this kingdom's stores.")
        else -> FooterNote("Paid from your wallet. Arrives in this kingdom's stores.")
    }
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Preview(name = "Market › BUY (market-buy.png)", widthDp = 412, heightDp = 811)
@Composable private fun BuyPreview() = MarketPreviewHost(CraftSamples.market(buy = CraftSamples.buy))

@Preview(name = "Market › BUY Seal (market-seal.png)", widthDp = 412, heightDp = 811)
@Composable private fun BuySealPreview() {
    Box {
        MarketPreviewHost(CraftSamples.market(buy = CraftSamples.buy))
        val offer = CraftSamples.buy.offers.first()
        Seal(buySeal(offer, 10, CraftSamples.items[offer.itemId], armedAtMs = 0L), onConfirm = {}, onCancel = {})
    }
}

@Preview(name = "Market › BUY sending (money sequence)", widthDp = 412, heightDp = 811)
@Composable private fun BuySendingPreview() = MarketPreviewHost(CraftSamples.market(buy = CraftSamples.buy.copy(money = MoneyStage.SENDING)))

@Preview(name = "Market › BUY bought (after the receipt)", widthDp = 412, heightDp = 811)
@Composable private fun BuyBoughtPreview() = MarketPreviewHost(CraftSamples.market(buy = CraftSamples.buy.copy(money = MoneyStage.SENT)))

@Preview(name = "Market › BUY short of KEEP", widthDp = 412, heightDp = 811)
@Composable private fun BuyShortPreview() = MarketPreviewHost(CraftSamples.market(buy = CraftSamples.buy.copy(
    wallet = CraftSamples.buy.wallet.copy(keepBaseUnits = 5_000_000_000L))))

@Preview(name = "Market › BUY no wallet linked", widthDp = 412, heightDp = 811)
@Composable private fun BuyNoWalletPreview() = MarketPreviewHost(CraftSamples.market(buy = CraftSamples.buy.copy(wallet = MarketWalletUi(false))))

@Preview(name = "Market › BUY payments unavailable", widthDp = 412, heightDp = 811)
@Composable private fun BuyUnavailablePreview() = MarketPreviewHost(CraftSamples.market(buy = CraftSamples.buy.copy(paymentsAvailable = false)))

@Preview(name = "Market › BUY loading the next page", widthDp = 412, heightDp = 811)
@Composable private fun BuyLoadingPreview() = MarketPreviewHost(CraftSamples.market(buy = CraftSamples.buy.copy(loadingMore = true)))

@Preview(name = "Market › BUY empty category", widthDp = 412, heightDp = 811)
@Composable private fun BuyEmptyPreview() = MarketPreviewHost(CraftSamples.market(buy = CraftSamples.buy.copy(offers = emptyList(), category = "tools")))

@Preview(name = "Market › BUY error", widthDp = 412, heightDp = 811)
@Composable private fun BuyErrorPreview() = MarketPreviewHost(CraftSamples.market(buy = CraftSamples.buy.copy(
    hydration = CraftHydration.Error("The Market can't reach the server. Try again."))))
