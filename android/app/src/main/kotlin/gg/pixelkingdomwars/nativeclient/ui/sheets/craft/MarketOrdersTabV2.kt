package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay

/*
 * Design component: Market › OFFERS, RE-DONE (design/final/craft/market-orders.png; SPEC "Part two: Market OFFERS as a
 * stall" + "Round 2 critic fixes"). Replaces `MarketOrdersTab.kt` (an order-book list) with YOUR STALL: what you offer,
 * on the table — two rows of three stall places, each row on a wooden counter. A place is a 52 × 44 dark ware well (item
 * 32 + outlined count), the name, a notched #FFF3C8 price tag (currency 24 + PS 11), its state line and one 44 dp action:
 * SOLD (green rim, moss SOLD, "14.4 to wallet"), ON THE TABLE ("4 of 10 sold" + stone backpack "BACK"), BEING PAID (gold
 * PAYING, no take-back), FREE (dashed #C9A86A, plus, "Free place / from SELL"). Footer: gold SELL MORE "2 free places".
 * Copy rule: "an order is your offer"; the tab reads OFFERS (`marketTabsR2`).
 *
 * Motion: places pop with a 30 ms stagger on tab open; a SOLD flip is 160 ms `pop`; a place that turns FREE cross-fades
 * in 120 ms. Reduced motion: no pop, no flip, 120 ms cross-fades only.
 *
 * Pointer rule: drawn inside the Market sheet's painted panel; only the places (details), their action buttons and the
 * footer primary take touches (each ≥ 48 dp, a scene-input region). No scrim.
 */

/** A stall place's state (SPEC `state: SOLD|ON_TABLE|PAYING|FREE`). */
enum class StallPlaceState { SOLD, ON_TABLE, PAYING, FREE }

/** One stall place (SPEC `StallPlaceUi(item, icon, count, price, state, line, action)`; fields after `action` added). */
@Immutable data class StallPlaceUi(
    /** VT 18 item name ("Frostglass"); blank for FREE. */
    val item: String,
    /** The item's 64 px art drawn at 32 (`craftItemIcon`). */
    val icon: String,
    /** The outlined count in the ware well ("x6"); blank for FREE. */
    val count: String,
    /** The price tag (KEEP or SOL); CHECKING shows "…" (loading keeps the last good view); null for FREE. */
    val price: PriceUi?,
    /** SOLD · ON_TABLE · PAYING · FREE. */
    val state: StallPlaceState,
    /** VT 18 state line ("14.4 to wallet", "4 of 10 sold", "none yet", "being paid"). */
    val line: String,
    /** The place's 44 dp action: TAKE BACK (caption "BACK", icon "backpack"), or null (SOLD, PAYING, FREE). A non-ENABLED
     *  state explains through `onExplain`. */
    val action: CommandUi?,
    /** Added: the listing id (handed back by `onTakeBack`, `onPlace`, `onCheck`). */
    val listingId: String = "",
    /** Added: TAKE BACK is in flight (stone dots "Taking back"). */
    val takingBack: Boolean = false,
    /** Added: the take-back answer was lost: "Being checked" + stone CHECK (never "nothing was spent"). */
    val checking: Boolean = false,
)

/** Market › OFFERS state (SPEC `MarketOffersUi(places, freePlaces, maxPlaces, load)`). */
@Immutable data class MarketOffersUi(
    /** The taken places (FREE ones are filled in by [stallGrid] up to [maxPlaces]). */
    val places: List<StallPlaceUi>,
    /** Free places for SELL MORE; null = unknown ("…"). */
    val freePlaces: Int?,
    /** Places on the stall; null = no server limit (only the listed FREE places are drawn). */
    val maxPlaces: Int?,
    /** SPEC `load: LoadState` = the cluster's [CraftHydration] (loading keeps the last good view, prices "…"). */
    val load: CraftHydration = CraftHydration.Ready,
    /** The VT 18 line under the stall (server currency word). */
    val note: String = "Buyers across the realm see your table. KEEP from a sale goes to your wallet.",
    /** Added: the stall is read from a public book page that may not hold every lot (where to see the rest); null = none. */
    val partialNotice: String? = null,
    /** Added: false when no details half sheet exists for a place, so a tap on its body is not a door that does nothing
     *  (its BACK button stays the place's one action). */
    val placeDetails: Boolean = true,
)

/** Market › OFFERS callbacks (SPEC: onTakeBack, onFreePlace / onSellMore, onPlace, onHistory; the rest were added). */
@Immutable data class MarketOffersActions(
    /** TAKE BACK on a place (the confirm flow is unchanged: `takeBackReview`). */
    val onTakeBack: (listingId: String) -> Unit = {},
    /** A FREE place → SELL tab. */
    val onFreePlace: () -> Unit = {},
    /** SELL MORE → SELL tab. */
    val onSellMore: () -> Unit = {},
    /** A taken place → its details half sheet. */
    val onPlace: (listingId: String) -> Unit = {},
    /** History → WalletHistory(market). */
    val onHistory: () -> Unit = {},
    /** CHECK on a place whose take-back answer was lost (by-key read). */
    val onCheck: (listingId: String) -> Unit = {},
    /** RETRY on the error row / primary. */
    val onRetry: () -> Unit = {},
    /** Called when OFFERS leaves the screen: the SOLD places are now seen. */
    val onMarkSoldSeen: () -> Unit = {},
    /** A refused action: toast the reason. */
    val onExplain: (String?) -> Unit = {},
)

/** The OFFERS body: YOUR STALL, the counters, the note. */
@Composable internal fun ColumnScope.MarketOffersBody(ui: MarketOffersUi, on: MarketOffersActions) {
    val c = PkwTokens.Colors
    val markSeen by rememberUpdatedState(on.onMarkSoldSeen)
    DisposableEffect(Unit) { onDispose { markSeen() } }
    if (ui.load is CraftHydration.Loading) Box(Modifier.fillMaxWidth().height(2.dp).background(c.stone.face))
    if (ui.load is CraftHydration.Error) {
        CreamCard(Modifier.fillMaxWidth(), rim = CardRim.MISSING, contentPadding = PaddingValues(start = 8.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText((ui.load as CraftHydration.Error).message, PkwTokens.Type.body, Modifier.weight(1f), color = c.shortText, maxLines = 2)
                SecondaryButton("RETRY", on.onRetry, contentDescription = "Retry loading your stall")
            }
        }
    }
    SectionLabel("YOUR STALL", "what you offer, on the table")
    ui.partialNotice?.let { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, maxLines = 2) }
    // A partial book page never proves an empty stall.
    if (stallIsEmpty(ui) && ui.partialNotice == null) PkwText("Nothing on your stall yet", PkwTokens.Type.body, color = c.textOnParch)
    val grid = stallGrid(ui.places, ui.maxPlaces)
    var index = 0
    grid.forEach { row ->
        Column(Modifier.fillMaxWidth()) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                row.forEach { place ->
                    if (place == null) Spacer(Modifier.weight(1f))
                    else StallPlace(place, index++, on, Modifier.weight(1f), ui.placeDetails)
                }
            }
            Counter()
        }
    }
    PkwText(ui.note, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 2)
}

/** The OFFERS footer: gold SELL MORE "2 free places" (→ SELL) and the note. With no server place limit there is no
 *  free-places count to name, so SELL MORE carries no sub line (never a permanent "…"). */
@Composable internal fun ColumnScope.MarketOffersFooter(ui: MarketOffersUi, on: MarketOffersActions, onOpenSell: () -> Unit) {
    val primary = offersPrimary(ui).let { if (ui.maxPlaces == null && ui.freePlaces == null && it.action == PrimaryAction.OPEN_SELL) it.copy(sub = null) else it }
    CraftPrimaryButton(primary, { action ->
        when (action) {
            PrimaryAction.OPEN_SELL -> { on.onSellMore(); onOpenSell() }
            PrimaryAction.RETRY -> on.onRetry()
            else -> Unit
        }
    }, Modifier.fillMaxWidth())
    FooterNote(offersFootnote(ui.places))
}

/** The wooden counter strip under each row of places: 12 dp wood face + 2 dp highlight. Paint only. */
@Composable private fun Counter() {
    val c = PkwTokens.Colors
    Box(Modifier.fillMaxWidth().height(12.dp).drawBehind {
        drawRect(c.ink)
        val i = 2.dp.toPx()
        drawRect(c.wood, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
        drawRect(c.woodHi, Offset(i, i), Size(size.width - 2 * i, 2.dp.toPx()))
    })
}

/** One stall place (flex × ~164): pops in with a 30 ms stagger, flips on SOLD (160 ms pop), cross-fades to FREE. */
@Composable private fun StallPlace(place: StallPlaceUi, index: Int, on: MarketOffersActions, modifier: Modifier, details: Boolean = true) {
    val reduced = LocalReducedMotion.current
    val still = reduced || LocalInspectionMode.current
    val pop = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (!still) {
            delay(index * PkwTokens.Motion.COMMAND_STAGGER.toLong())
            pop.animateTo(1f, tween(PkwTokens.Motion.PLATE_IN, easing = PkwTokens.Motion.Pop))
        }
    }
    val flip = remember { Animatable(1f) }
    var lastState by remember { mutableStateOf(place.state) }
    LaunchedEffect(place.state) {
        if (place.state == StallPlaceState.SOLD && lastState != StallPlaceState.SOLD && !still) {
            flip.snapTo(0f)
            flip.animateTo(1f, tween(PkwTokens.Motion.DECK_SWAP, easing = PkwTokens.Motion.Pop))
        }
        lastState = place.state
    }
    Box(modifier.graphicsLayer {
        alpha = pop.value.coerceIn(0f, 1f)
        val s = 0.9f + 0.1f * pop.value
        scaleX = s; scaleY = s
        rotationY = 90f * (1f - flip.value)
    }) {
        Crossfade(place.state == StallPlaceState.FREE, Modifier.fillMaxWidth(),
            tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TAB_SWITCH), label = "stallPlace") { free ->
            if (free) FreePlace(on.onFreePlace) else TakenPlace(place, on, details)
        }
    }
}

/** A FREE place: dashed #C9A86A, plus 24, "Free place / from SELL"; the whole place opens SELL. */
@Composable private fun FreePlace(onClick: () -> Unit) {
    val c = PkwTokens.Colors
    Box(Modifier.fillMaxWidth().heightIn(min = 164.dp).sceneInputRegion()
        .clearAndSetSemantics { contentDescription = "Free place. Sell something from SELL"; role = Role.Button
            this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Button, onClick = onClick)) {
        DashedBox(Modifier.fillMaxSize().heightIn(min = 164.dp)) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwIcon("shape:plus", 24.dp, tint = c.gold.face)
                PkwText("Free place", PkwTokens.Type.small, color = c.textOnParch2)
                PkwText("from SELL", PkwTokens.Type.small, color = c.textOnParch2)
            }
        }
    }
}

/** A taken place: ware well, name, price tag, state line, then SOLD / PAYING tag or the take-back button. */
@Composable private fun TakenPlace(place: StallPlaceUi, on: MarketOffersActions, details: Boolean) {
    val c = PkwTokens.Colors
    val sold = place.state == StallPlaceState.SOLD
    CreamCard(Modifier.fillMaxWidth().heightIn(min = 164.dp).sceneInputRegion()
        .semantics { contentDescription = "${place.item}, ${place.count}, ${place.price?.let(::priceDescription) ?: ""}, ${place.line}" }
        .then(if (details) Modifier.clickable(onClickLabel = "Details") { if (place.listingId.isNotBlank()) on.onPlace(place.listingId) } else Modifier),
        rim = if (sold) CardRim.READY else CardRim.NONE, contentPadding = PaddingValues(start = 4.dp, top = 6.dp, end = 4.dp, bottom = 6.dp)) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            WareWell(place.icon, place.count)
            PkwText(place.item, PkwTokens.Type.small, color = c.textOnParch)
            place.price?.let { PriceTag(it) }
            PkwText(place.line, PkwTokens.Type.small, color = c.textOnParch2)
            PlaceAction(place, on)
        }
    }
}

/** The bottom slot of a taken place (44 dp action area, each button ≥ 48 dp tall). */
@Composable private fun PlaceAction(place: StallPlaceUi, on: MarketOffersActions) {
    val c = PkwTokens.Colors
    when {
        place.state == StallPlaceState.SOLD -> Tag("SOLD", Verb.MOSS)
        place.state == StallPlaceState.PAYING -> Tag("PAYING", Verb.GOLD)
        place.checking -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
            PkwText("Being checked", PkwTokens.Type.small, color = c.textOnParch2)
            SecondaryButton("CHECK", { on.onCheck(place.listingId) }, Modifier.fillMaxWidth(), contentDescription = "Check the take-back of ${place.item}")
        }
        place.takingBack -> Row(Modifier.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            BusyDots()
            PkwText("Taking back", PkwTokens.Type.small, color = c.textOnParch2)
        }
        else -> place.action?.let { cmd ->
            val enabled = commandDrawState(cmd) == CommandState.ENABLED
            SecondaryButton(cmd.caption, { if (enabled) on.onTakeBack(place.listingId) else on.onExplain(cmd.reason) }, Modifier.fillMaxWidth(),
                icon = cmd.icon, enabled = enabled, contentDescription = "Take back ${place.item}")
        }
    }
}

/** The 52 × 44 dark ware well: the item at 32 and the outlined count at its bottom right. Paint only. */
@Composable private fun WareWell(icon: String, count: String) {
    val c = PkwTokens.Colors
    Box(Modifier.size(52.dp, 44.dp).drawBehind {
        val w = size.width; val h = size.height; val i = 2.dp.toPx()
        fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
        insideStepped(i, i, w - i, h - i, CornerProfiles.S) { drawRect(WELL_DARK) }
    }) {
        CraftIcon(icon, 32.dp, Modifier.align(Alignment.Center))
        if (count.isNotBlank()) PkwText(count, PkwTokens.Type.caption, Modifier.align(Alignment.BottomEnd).padding(end = 2.dp), color = c.label, outline = 1.dp)
    }
}

/** The price tag: 24 dp, ink rim, notched (pointed) left end, #FFF3C8 body, currency 24 + PS 11. Paint only. */
@Composable private fun PriceTag(price: PriceUi) {
    val c = PkwTokens.Colors
    Row(Modifier.heightIn(min = 24.dp).drawBehind {
        val w = size.width; val h = size.height; val n = 6.dp.toPx(); val i = 2.dp.toPx()
        val outer = Path().apply { moveTo(0f, h / 2f); lineTo(n, 0f); lineTo(w, 0f); lineTo(w, h); lineTo(n, h); close() }
        drawPath(outer, c.ink)
        val inner = Path().apply { moveTo(i * 1.5f, h / 2f); lineTo(n + i / 2f, i); lineTo(w - i, i); lineTo(w - i, h - i); lineTo(n + i / 2f, h - i); close() }
        drawPath(inner, c.selectedTint)
    }.padding(start = 8.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        PkwIcon(currencyIcon(price.currency, price.icon), 24.dp)
        PkwText(priceText(price), PkwTokens.Type.caption, color = c.textOnParch)
    }
}

// ---------------------------------------------------------------------------------------------------------------- previews

private fun offersSheet(offers: MarketOffersUi) = CraftR2Samples.marketR2(MarketTab.ORDERS).copy(offers = offers)

@Preview(name = "Market › OFFERS (market-orders.png, re-done)", widthDp = 412, heightDp = 811)
@Composable private fun OffersPreview() = MarketR2PreviewHost(offersSheet(CraftR2Samples.offers))

@Preview(name = "Market › OFFERS, taking back (busy) + being checked", widthDp = 412, heightDp = 811)
@Composable private fun OffersBusyPreview() = MarketR2PreviewHost(offersSheet(CraftR2Samples.offers.copy(places = CraftR2Samples.offers.places.mapIndexed { i, p ->
    when (i) { 1 -> p.copy(takingBack = true); 2 -> p.copy(checking = true); else -> p } })))

@Preview(name = "Market › OFFERS, loading (prices …)", widthDp = 412, heightDp = 811)
@Composable private fun OffersLoadingPreview() = MarketR2PreviewHost(offersSheet(CraftR2Samples.offers.copy(load = CraftHydration.Loading,
    places = CraftR2Samples.offers.places.map { p -> p.copy(price = p.price?.copy(amount = null, status = gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.CHECKING)) })))

@Preview(name = "Market › OFFERS, error", widthDp = 412, heightDp = 811)
@Composable private fun OffersErrorPreview() = MarketR2PreviewHost(offersSheet(CraftR2Samples.offers.copy(load = CraftHydration.Error("The Market can't reach the server. Try again."))))

@Preview(name = "Market › OFFERS, empty stall", widthDp = 412, heightDp = 811)
@Composable private fun OffersEmptyPreview() = MarketR2PreviewHost(offersSheet(MarketOffersUi(emptyList(), 6, 6)))
