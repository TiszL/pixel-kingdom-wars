package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi

/*
 * Design component: the Market tall sheet (craft/SPEC.md §3; UX-ARCHITECTURE §7.3 `Destination.Market(tab, section)`),
 * tabs BUY · SELL · ORDERS · OWNED (ids BUY · SELL · MY ORDERS · COLLECTION). The same composable is the Keep › STORES ›
 * TRADE fallback while no Market is built (arch Q3): pass that frame's title and no header sprite.
 */

/** Everything the Market sheet draws. Only the selected tab's state is needed. */
@Immutable data class MarketSheetUi(
    /** Title "MARKET", "LV n", live chip ("2 lots listed" / green "1 lot sold"), History on, `marketTabs(…)`. */
    val frame: CraftFrameUi,
    /** `marketHeader(tier, appliedAwningTier)`. */
    val header: CraftHeaderUi,
    val buy: MarketBuyUi? = null,
    val sell: MarketSellUi? = null,
    val orders: MarketOrdersUi? = null,
    val owned: MarketOwnedUi? = null,
    /** The LIST / TAKE BACK review half sheet (`listReview`, `takeBackReview`); null = closed. */
    val review: CraftReviewUi? = null,
    /** The KEEP row shown top-right while the sheet is open (SPEC §3 header; hidden without a wallet). Drawn by the host. */
    val spend: ResourceChipUi? = null,
)

/** The Market sheet's callbacks. */
@Immutable data class MarketSheetActions(
    val onClose: () -> Unit = {},
    /** A tab tap (BUY, SELL, MY ORDERS, COLLECTION); the sheet also calls it for SELL MORE / GO TO SELL / slots-full. */
    val onTab: (String) -> Unit = {},
    /** → `WalletHistory(market)`. */
    val onHistory: () -> Unit = {},
    val onRetry: () -> Unit = {},
    /** A SHORT price → Need-more (default: no buy-KEEP door, SPEC §7 Q4). */
    val onNeedMore: (PriceUi) -> Unit = {},
    /** "Link a wallet to buy" → `Profile(WALLET)`. */
    val onLinkWallet: () -> Unit = {},
    val onReviewBack: () -> Unit = {},
    /** The review's confirm: LIST submits the listing; TAKE BACK takes the lot back. */
    val onReviewConfirm: () -> Unit = {},
    val buy: MarketBuyActions = MarketBuyActions(),
    val sell: MarketSellActions = MarketSellActions(),
    val orders: MarketOrdersActions = MarketOrdersActions(),
    val owned: MarketOwnedActions = MarketOwnedActions(),
)

/**
 * The Market tall sheet. [modifier] must give it a bounded height (SheetHost: y 104 to the bottom edge).
 *
 * Pointer rule: the root is the painted wood frame (a scene-input region), never full-screen, with no scrim of its own
 * (the TALL 40 % scrim is the SheetHost's; the BUY Seal and its 55 % scrim are the OverlayHost's, only while shown). The
 * review half sheet has no scrim.
 */
@Composable fun MarketSheet(ui: MarketSheetUi, on: MarketSheetActions, modifier: Modifier = Modifier) {
    val tab = ui.frame.selectedTab
    val primary: CraftPrimaryUi? = when (tab) {
        MarketTab.BUY -> ui.buy?.let(::buyPrimary)
        MarketTab.SELL -> ui.sell?.let(::sellPrimary)
        MarketTab.ORDERS -> ordersPrimary()
        else -> null
    }
    CraftSheetFrame(ui.frame, on.onClose, on.onTab, on.onHistory, modifier,
        headerArt = { HeaderStage(ui.header, null, null, 180.dp, (-28).dp, "The Market") },
        footer = {
            when (tab) {
                MarketTab.BUY -> ui.buy?.let { MarketBuyFooter(it, on, primary) } ?: PendingMarketFooter()
                MarketTab.SELL -> ui.sell?.let { MarketSellFooter(it, on, primary) } ?: PendingMarketFooter()
                MarketTab.ORDERS -> ui.orders?.let { MarketOrdersFooter(it, on) } ?: PendingMarketFooter()
                else -> Unit
            }
        },
        panelOverlay = { ReviewHalfSheet(ui.review, emptyList(), null, on.onReviewBack, on.onReviewConfirm) },
    ) {
        when (tab) {
            MarketTab.BUY -> ui.buy?.let { MarketBuyBody(it, on) } ?: PendingMarketBody()
            MarketTab.SELL -> ui.sell?.let { MarketSellBody(it, on) } ?: PendingMarketBody()
            MarketTab.ORDERS -> ui.orders?.let { MarketOrdersBody(it, on) } ?: PendingMarketBody()
            MarketTab.OWNED -> ui.owned?.let { MarketOwnedBody(it, on) } ?: PendingMarketBody()
            else -> PendingMarketBody()
        }
    }
}

@Composable private fun PendingMarketBody() {
    PkwText(CHECKING_TEXT, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2)
}

@Composable private fun PendingMarketFooter() {
    CraftPrimaryButton(busyPrimary(CHECKING_TEXT), {})
}

/** Renders a Market sheet the way the SheetHost does on the 412 × 915 phone (y 104 → bottom). */
@Composable internal fun MarketPreviewHost(ui: MarketSheetUi) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        MarketSheet(ui, MarketSheetActions(), Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp))
    }
}

@Preview(name = "Market sheet, nothing loaded yet", widthDp = 412, heightDp = 811)
@Composable private fun MarketPendingPreview() = MarketPreviewHost(CraftSamples.market())
