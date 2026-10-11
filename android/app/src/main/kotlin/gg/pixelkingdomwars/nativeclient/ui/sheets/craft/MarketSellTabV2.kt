package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyName
import gg.pixelkingdomwars.nativeclient.ui.kit.tileCount
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileState
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import java.util.Locale

/*
 * Design component: Market › SELL, RE-DONE (design/final/craft/market-sell.png; SPEC "Part two: SELL without the fee"
 * and "Round 2 critic fixes": the realm's cut named in game words). Replaces `MarketSellTab.kt`'s body: the item card
 * drops "Lowest lot now" and reads "You hold 14." + a blue tag "Others sell it for about 1.8" (hidden when nobody sells
 * it; "…" inside while loading), and the earnings card reads "You get 18.0 KEEP / the realm's cut is 1.0 of 19.0"
 * (server-formatted `earnLine` / `cutLine`; derived from the server's feeBps until they arrive). LIST raises the LIST
 * Seal ([listSeal] → [MarketSealV2]) that repeats the cut in its fine print, instead of the review half sheet. The
 * stepper wells are unchanged; the "10 bars on a stall slot" idea was not drawn (left for the owner).
 *
 * Pointer rule: drawn inside the Market sheet's painted panel; only the stores tiles, the steppers and the footer
 * primary take touches. The LIST Seal's scrim is the OverlayHost's, only while it shows.
 */

/** Market › SELL round-2 state: the round-1 [MarketSellUi] plus the critic-fix fields (SPEC names kept). */
@Immutable data class MarketSellV2Ui(
    /** Everything the round-1 SELL tab draws (stores, quantity, price, slots, submit, hydration). */
    val sell: MarketSellUi,
    /** Server-formatted "You get 18.0 KEEP"; null = derive it ([realmCutLines]). */
    val earnLine: String? = null,
    /** Server-formatted "the realm's cut is 1.0 of 19.0"; null = derive it ([realmCutLines]). */
    val cutLine: String? = null,
    /** "1.8" (others' recent price for this item), drawn as "Others sell it for about 1.8"; null hides the tag. */
    val othersPriceHint: String? = null,
    /** True while the hint reloads (keeps the last good value; "…" inside the tag when there is none). */
    val othersPriceLoading: Boolean = false,
    /** The LIST Seal while it is up ([listSeal]); composed by the OverlayHost. */
    val listSeal: MarketSealUi? = null,
    /** The typed PRICE EACH, as typed, when the server has no price tick (the KEEP policy has none): the price well
     *  becomes a decimal entry and the − / + stay off, so no step is ever invented. Null draws the stepper. */
    val priceEntry: String? = null,
)

/** Market › SELL round-2 callbacks: the LIST Seal's. The round-1 ones stay on `MarketSheetActions.sell`, whose
 *  `onList` now raises the LIST Seal ([listSeal]) instead of the review half sheet. */
@Immutable data class MarketSellV2Actions(
    /** The LIST Seal's armed LIST: submit the listing (no wallet step). */
    val onListConfirm: () -> Unit = {},
    /** The LIST Seal's BACK / scrim / system Back. */
    val onListBack: () -> Unit = {},
    /** A PRICE EACH edit in the typed entry ([MarketSellV2Ui.priceEntry]); the host filters and keeps the text. */
    val onPriceText: (String) -> Unit = {},
)

/** The SELL body (re-done). [on] is the Market's actions (the steppers and tiles route through `on.sell`); [onPriceText]
 *  receives typed PRICE EACH edits. */
@Composable internal fun ColumnScope.MarketSellV2Body(ui: MarketSellV2Ui, on: MarketSheetActions, onPriceText: (String) -> Unit = {}) {
    val c = PkwTokens.Colors
    val sell = ui.sell
    if (sell.sellable.isEmpty() && sell.hydration != CraftHydration.Loading) {
        EmptyState(EmptyStateUi("ui:market-menu", "Nothing to list yet", "Refined materials and kits you hold can be listed here.", null, null), onGo = {})
        return
    }
    val known = sell.hydration != CraftHydration.Loading
    val selected = selectedSellable(sell)
    SectionLabel("YOUR STORES", "tap one to list it")
    TileStrip(sell.sellable.map { s ->
        val item = sell.items[s.itemId]
        val available = if (known) s.available else null
        RecipeTile(ItemTileUi(s.itemId, item?.icon ?: craftItemIcon(s.itemId), available?.let { "x" + tileCount(it) } ?: "…",
            "${item?.name ?: s.itemId}, ${available ?: "count unknown"} free to list",
            if (s.itemId == selected?.itemId) ItemTileState.SELECTED else ItemTileState.OWNED), false)
    }, on.sell.onSelectItem)
    if (selected == null) return
    val item = sell.items[selected.itemId]
    val name = item?.name ?: selected.itemId
    CreamCard(Modifier.fillMaxWidth().heightIn(min = 76.dp), contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 8.dp, bottom = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Well(64.dp) { CraftIcon(item?.icon ?: craftItemIcon(selected.itemId), 64.dp) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                PkwText(name.uppercase(Locale.US), PkwTokens.Type.label, color = c.textOnParch)
                PkwText("You hold ${groupDigits(if (known) selected.available else null)}.", PkwTokens.Type.small, color = c.textOnParch2)
                othersTagText(ui.othersPriceHint, ui.othersPriceLoading)?.let { Tag(it, Verb.BLUE) }
            }
        }
    }
    val qty = sellQuantity(sell)
    val available = selected.available
    SectionLabel("HOW MANY")
    WideStepper(item?.icon ?: craftItemIcon(selected.itemId), groupDigits(qty), "of ${groupDigits(if (known) available else null)}",
        { on.sell.onQty(-1L) }, { on.sell.onQty(1L) }, "quantity", minusEnabled = qty > 1L, plusEnabled = available != null && qty < available)
    SectionLabel("PRICE EACH")
    val tick = sell.tick
    val typed = ui.priceEntry
    if (typed != null && tick == null) PriceEntry(typed, sell, onPriceText)
    else WideStepper(currencyIcon(sell.currency), formatUnits(sell.unitPrice, sell.decimals), currencyName(sell.currency),
        { on.sell.onPrice(-1) }, { on.sell.onPrice(1) }, "price", repeat = true,
        minusEnabled = tick != null && (sell.unitPrice ?: 0L) > tick, plusEnabled = tick != null)
    val (earn, cut) = realmCutLines(ui)
    CreamCard(Modifier.fillMaxWidth().heightIn(min = 52.dp), rim = CardRim.NOTE, contentPadding = PaddingValues(start = 8.dp, top = 4.dp, end = 8.dp, bottom = 6.dp)) {
        Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PkwIcon(currencyIcon(sell.currency), 24.dp)
            Column {
                PkwText(earn, PkwTokens.Type.body, color = c.textOnParch)
                PkwText(cut, PkwTokens.Type.small, color = c.textOnParch2)
            }
        }
    }
}

/** The SELL footer (unchanged look): LIST, which now raises the LIST Seal through `on.sell.onList`. [primary] lets an
 *  owner's command mode add its own gates (paused orders, a saved request) to the designed [sellPrimary]. */
@Composable internal fun ColumnScope.MarketSellV2Footer(ui: MarketSellV2Ui, on: MarketSheetActions, primary: CraftPrimaryUi? = sellPrimary(ui.sell)) {
    MarketSellFooter(ui.sell, on, primary)
}

/**
 * The PRICE EACH well as a typed decimal entry (no server tick): the same stone − / + squares, OFF (a step would be
 * invented), around a cream well with the currency 32 + the typed price (PS 14) + the VT 18 unit. A price the owner
 * would refuse (zero, too precise, too large) reads in the short colour; LIST then explains "Set a price first.".
 * Keyboard: decimal. Styled like the kit's TextField (ink caret, parchment text), inside the stepper's own well.
 */
@Composable private fun PriceEntry(text: String, sell: MarketSellUi, onText: (String) -> Unit) {
    val c = PkwTokens.Colors
    val unit = currencyName(sell.currency)
    val invalid = text.isNotEmpty() && sell.unitPrice == null
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        StepSquare("shape:minus", {}, "Lower the price", Modifier.size(48.dp, 56.dp), enabled = false)
        CreamCard(Modifier.weight(1f).height(56.dp), contentPadding = PaddingValues(start = 10.dp, top = 2.dp, end = 10.dp, bottom = 2.dp)) {
            Row(Modifier.fillMaxWidth().align(Alignment.Center), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CraftIcon(currencyIcon(sell.currency), 32.dp)
                BasicTextField(text, onText, Modifier.weight(1f).semantics { contentDescription = "Price each in $unit" },
                    singleLine = true,
                    textStyle = PkwTokens.Type.primary.copy(color = if (invalid) c.shortText else c.textOnParch, textAlign = TextAlign.Center),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Done),
                    cursorBrush = SolidColor(c.ink),
                    decorationBox = { inner ->
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                            if (text.isEmpty()) PkwText(UNKNOWN, PkwTokens.Type.primary, color = c.textOnParch2)
                            inner()
                        }
                    })
                PkwText(unit, PkwTokens.Type.small, color = c.textOnParch2)
            }
        }
        StepSquare("shape:plus", {}, "Raise the price", Modifier.size(48.dp, 56.dp), enabled = false)
    }
}

// ---------------------------------------------------------------------------------------------------------------- previews

private fun sellSheet(v2: MarketSellV2Ui) = CraftR2Samples.marketR2(MarketTab.SELL).copy(sellV2 = v2)

@Preview(name = "Market › SELL (market-sell.png, re-done)", widthDp = 412, heightDp = 811)
@Composable private fun SellV2Preview() = MarketR2PreviewHost(sellSheet(CraftR2Samples.sellV2))

@Preview(name = "Market › SELL, LIST Seal with the realm's cut", widthDp = 412, heightDp = 811)
@Composable private fun SellV2SealPreview() = MarketR2PreviewHost(sellSheet(CraftR2Samples.sellV2.copy(listSeal = listSeal(CraftSamples.sell, 0L))), seals = true)

@Preview(name = "Market › SELL, hint loading (…) / nobody sells it", widthDp = 412, heightDp = 811)
@Composable private fun SellV2HintPreview() = MarketR2PreviewHost(sellSheet(CraftR2Samples.sellV2.copy(othersPriceHint = null, othersPriceLoading = true)))

@Preview(name = "Market › SELL, cut derived (server lines not yet sent)", widthDp = 412, heightDp = 811)
@Composable private fun SellV2DerivedPreview() = MarketR2PreviewHost(sellSheet(CraftR2Samples.sellV2.copy(earnLine = null, cutLine = null, othersPriceHint = null)))

@Preview(name = "Market › SELL, loading", widthDp = 412, heightDp = 811)
@Composable private fun SellV2LoadingPreview() = MarketR2PreviewHost(sellSheet(CraftR2Samples.sellV2.copy(sell = CraftSamples.sell.copy(hydration = CraftHydration.Loading))))

@Preview(name = "Market › SELL, refused (authoritative)", widthDp = 412, heightDp = 811)
@Composable private fun SellV2RefusedPreview() = MarketR2PreviewHost(sellSheet(CraftR2Samples.sellV2.copy(sell = CraftSamples.sell.copy(
    submit = SubmitUi(SubmitStage.REFUSED, message = "The price moved under the market floor. Nothing was listed.")))))

@Preview(name = "Market › SELL, uncertain (being checked)", widthDp = 412, heightDp = 811)
@Composable private fun SellV2CheckingPreview() = MarketR2PreviewHost(sellSheet(CraftR2Samples.sellV2.copy(sell = CraftSamples.sell.copy(
    submit = SubmitUi(SubmitStage.CHECKING)))))
